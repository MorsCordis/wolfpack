---
name: run-campaign
description: "Launch (or resume) a Wolfpack campaign inside the sandboxed Podman container. Shows a RESUME PLAN — which wave and hunts run next, what's parked/shipped — and confirms before kicking off. Usage: /run-campaign <slug> [max-parallel]"
allowed-tools: Bash, Read, Grep, Glob
---

Launch the automated Wolfpack campaign pipeline inside a sandboxed Podman container.

Parse `$ARGUMENTS` as: `<campaign-slug> [max-parallel]`. Default max-parallel is 2.

## Steps

1. Verify the campaign exists: check `.wolfpack/campaigns/$SLUG/campaign.md` exists. If not, stop and tell the user to run `/expedition` first.

2. **Build the RESUME PLAN and confirm — READ-ONLY, before any launch.** The point of this step
   is that you (and the user) see *exactly* which wave and hunts will run — or what's blocking —
   before kicking off. It must mirror the runner's selection logic (`.claude/workflows/campaign-runner.js`)
   exactly; a divergence here would mislead. Never `exec` blind.

   **2a. Parse the campaign.** Read `.wolfpack/campaigns/$SLUG/campaign.md`. From "## Proposed Hunts"
   extract every hunt in campaign wave order: `slug`, `wave` (`**Wave:** N`; "BLOCKED" → blocked),
   `tier`, and the one-line Trigger description.

   **2b. Resolve each hunt's LIVE status (dual-path, worktree first — main metadata is frozen until
   /merge).** For each hunt:
   ```bash
   WT=".claude/worktrees/$slug/.wolfpack/plans/$slug/metadata.json"
   MAIN=".wolfpack/plans/$slug/metadata.json"
   F=$([ -f "$WT" ] && echo "$WT" || echo "$MAIN")
   if [ -f "$F" ]; then jq -r '[.status, (.park.reason // ""), (.park.compliance_signed_off // false)] | @tsv' "$F"; else echo $'not_scaffolded\t\tfalse'; fi
   ```

   **2c. Classify EXACTLY as the runner does** (`DONE_STATUSES`, `isQuotaPark`, `isHumanGated` in
   campaign-runner.js), reading `status` VERBATIM (it is the authoritative log — don't re-derive):
   - **shipped** — `status: "merged"` (carries `merge_commit`/`released_version`). Legacy fallback:
     `certified` with feat/<slug> gone AND its merge commit on main.
   - **certified — awaiting release** — `certified` / `certified_not_merged` (branch still present).
     In `DONE_STATUSES`, so the runner does NOT re-run it — but it is NOT shipped; it needs
     `/merge-wave`. Give it its own bucket so the unmerged state is visible.
   - **quota — auto-resumes** — `parked:model_quota` (NOT human-gated; the runner re-runs it next pass).
   - **parked — needs a human** — `needs_spec` or any other `parked:<reason>`; the runner skips it
     until `/resolve`. EXCEPTION: `parked:compliance_review` with `compliance_signed_off == true`
     is signed off → treat as **pending/runnable**, not parked.
   - **pending — will run** — anything else (`not_scaffolded`, `ready_for_alpha`, `reviewing`,
     `reviewed`, `implementing`, … are mid-pipeline/resumable), plus quota parks.
   - **blocked** — Wave BLOCKED; excluded, never runs.

   **2d. Find the wave the runner will actually touch** (it walks waves IN ORDER; both `shipped` and
   `certified-awaiting-release` are in `DONE_STATUSES`, so the runner skips past them):
   - A wave where every non-blocked hunt is **shipped** → skip; already done.
   - A wave with **certified-awaiting-release** hunts but NO pending/parked → the runner skips it too
     (it's "done" for re-run purposes) but it is **NOT merged**. Flag it loudly: the user should
     `/merge-wave <campaign> <wave>` before a later wave builds on unmerged main.
   - The FIRST wave with any `pending` OR `parked` hunt is the resume point:
     - **has pending** → that wave **RUNS now**; its pending hunts are "next." Parked / certified hunts
       in the same wave are skipped this pass (surface them — `/resolve` / `/merge-wave`).
     - **all-parked, zero pending** → the runner **HALTS at that wave's barrier immediately** with no
       work done, and will NOT reach later waves. The next action is `/resolve`, not a launch.

   **2e. Display the RESUME PLAN** (one glance = where we are, what's next, what blocks):
   ```
   RESUME PLAN — $SLUG   (parallel: $MAX_PARALLEL)
   ✔ Wave 1  shipped (3/3 merged)
   ⊘ Wave 2  certified, NOT merged (2/2) — release first:  /merge-wave $SLUG 2
   ▶ Wave 3  NEXT — runs 2 hunt(s):
       ▸ <slug-a>   Yellow   [ready_for_alpha]
           intent: <one plain-English sentence — what it accomplishes>
           source: <ticket dev#22 | deferral from <hunt> (finding) | TODO.md | ad-hoc>
       ▸ <slug-b>   Green    [reviewed — resumes mid-pipeline]
           intent: …
           source: …
     ⏸ also in Wave 3, skipped (need /resolve):
       ⏸ <slug-c>   parked:compliance_review   → /resolve <slug-c>
     ⏳ quota (auto-resumes this pass): <slug or none>
   ◻ Wave 4  queued (5 hunts) — not reached until Wave 3 clears
   ```
   For each hunt in the **NEXT (resuming) wave**, surface its **`intent`** (the plain-English
   `Intent`/`Description` from `campaign.md`) and **`source`** (the `Source` field — env-qualify
   ticket refs: `dev#N` ≠ `prod#N`) BEFORE the confirm, so the user reviews the wave's specs and can
   reconcile their ticketing system in one glance. If a hunt predates the `Source` field (older
   `campaign.md`), show `source: (not recorded)` and fall back to its `TODO items cleared`.

   Each hunt's `[status]` is read verbatim from its metadata — `merged` (shipped),
   `certified`/`certified_not_merged` (awaiting `/merge-wave`), `parked:*` / `needs_spec`
   (awaiting `/resolve`), or a mid-pipeline rung. If an EARLIER wave shows ⊘ certified-not-merged,
   lead the summary with that — running the next wave on top of unmerged code is the trap.
   If the resume point is an ALL-PARKED wave, lead with the halt, loudly, and do NOT offer launch:
   ```
   ⛔ Wave 2 is fully parked — the run would HALT at its barrier with zero work done.
      Resolve first:  /resolve <slug> [, …]   then re-run /run-campaign $SLUG.
   ```

   **2f. Confirm before launch.** With a runnable resume point, ask and WAIT:
   `Launch the container and run Wave <N>'s <K> pending hunt(s)? [Y/n]`
   Proceed to Step 3 only on an affirmative. On `n`, stop. (If everything is shipped, say
   "Campaign complete — nothing to run" and stop.) The live watcher command is surfaced at
   launch in Step 3.

3. Run the sandboxed pipeline (only after the user confirms in 2f). **First surface the live
   watcher** so the user can paste it into a separate terminal — print the label and the command
   on its OWN line (no prefix on the command line, so it copies cleanly), then exec. Do NOT
   auto-run the watcher (an in-process `--loop` just creates an endless scroll):
   ```bash
   echo "Live progress — paste into a separate terminal:"
   echo "watch -c -n5 'WOLFPACK_WATCH_COLOR=1 ./scripts/wolfpack-watch.sh'"
   exec ./scripts/run-pipeline-sandbox.sh --campaign $SLUG $MAX_PARALLEL
   ```

   The `exec` replaces this Claude process with the containerized one — no double billing. The container runs Claude in `--permission-mode auto` with sandboxed filesystem access.

4. The pipeline STOPS at every wave barrier (e.g. `WAVE_PARTIAL_AWAITING_RELEASE`,
   `WAVE_AWAITING_HUMAN`, `WAVE_PAUSED_QUOTA/BUDGET`). It prints the release queue itself; the
   wave-release sequence is the two wave commands, not a per-hunt loop:
   - `/merge-wave $SLUG <wave>` — sequential `--no-ff` merges → ONE wave tag → push
   - `deploy-dev` (+ `migrate-dev` if it flags migrations) — ONE deploy for the wave
   - `/smoke-wave $SLUG <wave>` — consolidated per-hunt smoke
   - Any hunt parked for a human → `/resolve <slug>` first (compliance holds included).
   - Re-run `/run-campaign $SLUG` to resume — Step 2's RESUME PLAN will show the next wave.

## What NOT to do

- Do NOT run the workflow directly (without the container). Always use the sandbox script.
- Do NOT modify campaign.md during execution.
- Do NOT attempt to deploy or push — the container handles code, the user handles deploy.
