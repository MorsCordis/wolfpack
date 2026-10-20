---
description: Run/resume a Wolfpack campaign IN-SESSION via the Workflow tool (no headless `claude -p` container). Keeps Alpha/Shepherd/Tracker on your interactive session's billing; GLM/Mistral still run in their pods. Usage: /run-campaign-local [--no-prespec | --prespec=all | --prespec=wave] [--chain] <slug> [max-parallel]
---

Launch (or resume) a Wolfpack campaign using the built-in **Workflow tool from THIS interactive
session** — NOT the `claude -p` sandbox container that `/run-campaign` uses.

**Why this exists:** the orchestration (`campaign-runner.js` → `workflow('hunt-pipeline')` →
`agent()` subagents) is already 100% Workflow-tool-native; the *only* `claude -p` in the system
is the container launch wrapper (`run-pipeline-sandbox.sh`). Running the same workflow in-session
keeps the Claude roles on **this session's** billing (your subscription when the session is
interactive) instead of headless `-p`. This matters if/while Anthropic meters headless `-p`
against the Agent-SDK credit pool (the June 2026 billing split — verify against your own Anthropic
usage page; news reports have flip-flopped). Even if `-p` is NOT metered, this path is simpler:
no container, no podman-in-podman for the reviewer shims, and worktree git registration uses host
paths (no `/workspace` mismatch).

Parse `$ARGUMENTS` as `[--no-prespec | --prespec=all | --prespec=wave] [--chain] <campaign-slug> [max-parallel]`
(default max-parallel **2**). `--chain` may appear in any position; strip it before the positional parse; with it
max-parallel defaults to 1 (see § Chain mode). The pre-spec flag picks Step 1.5's scope:
- *(no flag)* or `--prespec=all` — **whole-campaign sweep (the default):** the pending hunts of every wave.
- `--prespec=wave` — the resume wave only (the old behaviour).
- `--no-prespec` — skip Step 1.5; hunts self-spec headlessly in-run and may park mid-wave.

Refuse before doing anything else, naming the problem:
- more than one of these flags → *"Pick one of --no-prespec, --prespec=all, --prespec=wave (got: <flags>)."*
- any other `--prespec=<v>` → *"Unknown --prespec value '<v>' — use all or wave."*

Note: a plain `/run-campaign-local <slug>` now sweeps every wave. Use `--prespec=wave` for the old behaviour.

**Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.

## Preconditions — state them, then proceed
1. **This must be an interactive session.** That's what keeps the workflow's subagents on the
   subscription. If you are yourself running headless (`-p`), STOP and say so — running in-session
   from a headless parent defeats the purpose.
2. **Permission mode.** An autonomous campaign does many edits, `git` ops, and `podman` calls.
   Tell the user to run this session in an auto-accepting mode (bypass-permissions, or
   accept-edits + pre-approved bash) or it will prompt throughout. Note it — do not change their
   settings yourself.
3. **Campaign exists:** verify `.wolfpack/campaigns/<slug>/campaign.md`. If not, stop — tell the
   user to `/expedition` first.

## Step 1 — RESUME PLAN preflight (READ-ONLY)
Run the **exact** RESUME PLAN preflight from `"$PACK/.agents/commands/run-campaign.md"` **Step 2** — read
that file and follow it verbatim: parse the hunts in wave order, resolve each hunt's live status
via the worktree-first dual path, classify with `campaign-runner.js`'s own rules
(`DONE_STATUSES`, `parked:model_quota` auto-resumes, other `parked:`/`needs_spec` are
human-gated, `compliance_review`+signed-off is runnable), walk the waves to find the one the
runner will actually touch, render the one-glance plan, and **confirm before launching**. Do not
duplicate or drift from that logic — it must mirror the runner.

## Step 1.5 — Pre-spec sweep (default: whole campaign; `--prespec=wave` = resume wave; `--no-prespec` skips)
The in-run Spec phase is **headless** — it can't `AskUserQuestion`, so a hunt with a
load-bearing ambiguity **parks** (`needs_spec`) mid-wave instead of asking. This step
front-loads those questions NOW, in this interactive session (which CAN ask), in one batched
sitting, so the autonomous build sails through Spec instead of parking. **Skip entirely** if
`--no-prespec` was passed. Run it AFTER the user confirms Step 1 and BEFORE the Workflow launch
in Step 2. Run it from the main checkout.

### Select the hunts (script, not by hand)
```
node "$PACK/scripts/wolfpack-prespec.mjs" list .wolfpack/campaigns/<slug>/campaign.md          # --prespec=all (default)
node "$PACK/scripts/wolfpack-prespec.mjs" list .wolfpack/campaigns/<slug>/campaign.md --wave   # --prespec=wave
```
The JSON `selected` list is the scope, in wave order. It holds every hunt with no `acceptance.md`, or
`needs_spec`. Shipped/certified, `parked:<reason>` and past-Spec hunts land in `skipped`. `--wave` keeps only
the resume wave, the first wave with an unfinished hunt (the runner's rule). Each entry carries `plan_dir` (the
worktree plan dir the in-run probe reads) and `spec_plan`. A non-zero exit means STOP: show the error and don't
guess the list. An empty `selected` means: say "Pre-spec: nothing to sweep" and go to Step 2. Re-running is
safe: hunts that already have a contract drop out, and a `needs_spec` hunt whose answers are already recorded
(`redraft: false`) is never re-drafted. Only its unanswered questions are asked again.

`spec_plan` is the source plan: the Trigger's `Spec: <path>.md`, else a campaign-level `Plan: <path>.md` line,
else `null` (answers go in `acceptance.md` only; `spec_plan_note` says why).

### Phase A — Draft every hunt (no questions)
1. **Scaffold** every selected hunt that has no worktree first:
   `/hunt --campaign=<slug> <hunt> "<Trigger description>"`, carrying the campaign tier. `/hunt` may ask
   its own version-tag question; that's scaffolding, not Spec, so do all scaffolds before the first draft.
   Already-scaffolded hunts keep their worktree.
2. **Draft** each hunt with `redraft: true` with the Spec skill in **draft-only (sweep) mode** (spec SKILL.md
   § The interview interface). Pass the absolute main-checkout path of `spec_plan` as the source plan. If the
   hunt already has an `acceptance.md`, Spec revises it in place: its § Source lines and any criterion text that
   records a user answer are kept, never discarded.
   - **No `AskUserQuestion` call happens anywhere in Phase A** after the step-1 scaffolds (`/hunt`'s own
     scaffolding question is the one exception), from Spec or from you. Questions go to
     `<plan_dir>/spec-questions.json`.
   - A `redraft: false` hunt is **not** drafted: its `acceptance.md` and `spec-questions.json` stay as they
     are. Its questions with no `answer` field go to Phase B. If it has none, it is named in the summary as
     still parked (`gate: answered, needs /resolve`).
   - A hunt with no load-bearing question finishes here, but only if it clears the Spec confidence gate. A
     no-question draft that doesn't clear it stays `needs_spec` and is named in the summary as still parked
     (`gate: <reason>`).
   - You may draft each hunt in its own subagent, one at a time.
3. **Lint** each draft: `node "$PACK/scripts/wolfpack-prespec.mjs" lint <plan_dir>/acceptance.md`. Fix (rewrite or
   re-tag) and re-lint. A hunt whose `acceptance.md` still fails is **not ready**: set it `needs_spec` and name
   it in the summary.

### Phase B — One sitting: ask every question
1. Collect every hunt's `spec-questions.json`.
2. Drop any question the source plan already answers (a principle or a **Decided** D# row) and list it in the
   summary as a Spec defect. A dropped question is **resolved, not open**: set
   `"answer": "per D<n> — already decided"` (or `per P<n>`) on it in `spec-questions.json`. It counts as answered
   for the Phase C gate, so a hunt whose only questions were dropped goes straight to Phase C. Phase C cites the row in `acceptance.md`; it
   adds nothing to the `Interview answers` line and runs no `record-decision` for it.
3. Ask ALL remaining questions back to back, in consecutive `AskUserQuestion` calls (≤4 questions per call),
   in hunt order, then rank. Nothing else happens between the calls: no drafting, no file writes.
   - Each question's text starts `[<hunt-slug> · <AC ids> · plan|hunt]`, and its header is the slug (cut to
     12 chars).
   - Options are Spec's options, with `(recommended)` on the recommended one, plus a last option
     `Skip — leave <hunt-slug> parked`.
   - Keep the wording short enough for a phone screen.
4. The **last question of the sitting**, asked only when at least one `plan`-scope answer will edit the plan
   (and the plan file had no uncommitted changes before the sweep; otherwise skip the offer and say why).
   Also run `git branch --show-current` in the main checkout first. If it isn't `main`, skip the offer, leave
   the plan modified, and print the Phase C commands with the note "main checkout is on `<branch>` — switch to
   main before running these":
   *"Commit the new decision rows in <plan>?"*
   - Yes: docs branch + local `--no-ff` merge to main, no push.
   - No: leave the file modified and print the commands.

### Phase C — Apply the answers
- **Unanswered stays parked.** A skipped or dismissed load-bearing question, or an "Other" answer that defers
  ("later", "skip", empty), leaves that hunt `needs_spec`, with `spec.ambiguity_open: true` in its
  `metadata.json`. It is **never** collapsed into the recommended option. The summary names the hunt and the
  question.
- **Answered hunts:**
  - apply the answers to `acceptance.md` (criteria and assumptions);
  - append the answers to § Source as an `Interview answers (<who>, <YYYY-MM-DD>): …` line, and set
    `"answer": "<label or text>"` on each answered question in `spec-questions.json`;
  - do those two steps for every given answer, even in a hunt that also has a skipped question. The steps
    below run only once all of a hunt's questions are answered; a hunt with a skipped one stays `needs_spec`
    + `ambiguity_open: true`, and a re-run asks only the skipped one;
  - re-rate on the Spec confidence gate and rewrite the spec block (`ambiguity_open: false`);
  - re-lint, which must pass;
  - status: if the gate lets it build (autonomous/flagged), `needs_spec` → `ready_for_alpha`, so the in-run
    probe returns `Plan` and Spec is skipped. Otherwise it stays `needs_spec`.
- **Plan-level answers → the plan's decisions table** (`hunt`-scope answers go to `acceptance.md` only):
  `node "$PACK/scripts/wolfpack-prespec.mjs" record-decision <main-checkout spec_plan> --hunt <hunt> --question "<question>" --answer "<answer>"`
  - This appends the next `D<n>` row, `**Decided <date>** (pre-spec sweep, <hunt>): <answer>`. Re-asking the
    same question is a no-op.
  - A non-zero exit (no recognisable table, a conflicting earlier answer) means: show the error, don't touch
    the plan, keep the answer in `acceptance.md`, and name it in the summary.
  - `spec_plan` null means: "No source plan for <hunt>; answers recorded in acceptance.md only."
- **Commit (only on the Phase B yes, which is only offered when the main checkout is on `main`).** Run from the
  main checkout, in this order, as separate commands:
  ```
  git switch -c docs/<campaign>-prespec-answers   # FIRST, on its own: a hook blocks git add/commit while on main
  git add <plan path>                              # by name only
  git commit -m "docs(<campaign>): record pre-spec sweep answers (D<a>–D<b>)"
  git switch main
  git merge --no-ff docs/<campaign>-prespec-answers
  ```
  - Never `git add .`/`-A`, never `git push`.
  - If the branch already exists, stop and print the commands with a `-2` suffix instead.
  - **On no:** leave the plan modified and print exactly those commands. The sweep never commits without that
    yes.

### Summary (then Step 2)
```
Pre-spec complete — N ready, M still parked
  Wave <w>: <n> ready, <m> still parked
Still parked: <hunt> — <Q id> "<question>" (unanswered) | lint: <message> | gate: <reason>
Spec defects (already decided, not asked): <hunt> <Q id> → D<n>
Plan: D<a>–D<b> added to <path> — committed + merged on docs/<campaign>-prespec-answers | left modified (commands above) | no source plan for <hunts>
```

**This is a LAUNCH-PATH step only** — no `campaign-runner.js`/`hunt-pipeline.js` changes. The
headless `/run-campaign` (container) path can't do this (no interactive channel); pre-spec is
exclusive to `/run-campaign-local`.

## Step 2 — Launch IN-SESSION via the Workflow tool (only after the user confirms)
Do **NOT** `exec run-pipeline-sandbox.sh` and do **NOT** call `claude -p`. Surface the watcher,
then invoke the Workflow tool directly.

Surface first (own line, copies cleanly):
```
Live progress — paste into a separate terminal:
./scripts/wolfpack-watch.sh --loop 5
```

Then call the **Workflow tool**:
- `Workflow({ name: "campaign-runner", args: { campaignSlug: "<slug>", maxParallel: <N> } })`
- With --chain: args: { campaignSlug, maxParallel: <N, default 1 when --chain>, chain: true } — see § Chain mode.

It runs as a **background task in this session**: `campaign-runner` → `workflow('hunt-pipeline')`
per hunt → `agent()` Claude subagents (this-session billing) → `podman-vibe.sh`
for the GLM/Mistral reviewer pods (host podman, unaffected by Claude billing). It stops at each
wave barrier exactly like the container path. Relay the barrier verdict when the task completes.

## Differences from the container path (`/run-campaign`)
- **Billing:** Claude work bills to this interactive session (your subscription). Plan rate limits
  apply; `parked:model_quota` + the resume loop still handle exhaustion. No Agent-SDK-credit / API
  spend.
- **Sandbox:** the Claude agents run with THIS session's permissions on the host repo — no
  container FS isolation for *them* (worktrees still isolate parallel hunts; the prod/`git add`
  hooks still block; the GLM/Mistral pods keep their own isolation). For full isolation, run
  this session inside a workspace pod (then the reviewer shims need host-podman-socket passthrough
  or rootless podman-in-podman).
- **Pipeline changes go canonical-first:** change `$PACK/.agents/workflows/<file>` on a pack branch, merge it,
  then `bash "$PACK/install.sh" --consumer <repo>` regenerates this project's stamped copies, then restart
  Claude Code; never hand-edit `.claude/workflows/*.js`. The launch path is the only difference from `/run-campaign`.

## Wave barriers (unchanged)
The run STOPS at every wave barrier. Release a wave the same way: `/merge-wave <slug> <wave>` →
the configured Dev deploy command (+ Migration command if flagged) → `/smoke-wave <slug> <wave>` — or, when wolfpack-config.md declares no deploy step, nothing after `/merge-wave`; `/resolve <slug>` for any
human-parked hunt. Re-run `/run-campaign-local <slug>` to resume — Step 1 shows the next wave.
With `--chain` there are no wave barriers — see § Chain mode.

## Chain mode (--chain)
Opt-in: the campaign runs every wave on a LOCAL `campaign/<slug>` branch with no wave barriers. Hunts fork
from and rebase onto it, certified hunts auto-merge into it (`--no-ff`, no tag, no push), `main` is merged in
at each wave start, and a blocked hunt only holds the hunts that conflict with it. Barrier mode stays the
default.
- `--chain` may appear in any position of `$ARGUMENTS`. Strip it before the positional parse. With it,
  max-parallel defaults to **1**.
- **Preflight** (fail loud — never fall back to barrier mode), from the main checkout:
  `grep -q 'WOLFPACK_CHAIN_RUNNER=1' .claude/workflows/campaign-runner.js && grep -q 'WOLFPACK_CHAIN_PROTOCOL=1' .claude/workflows/hunt-pipeline.js`
  (the project's runtime copies; in the pack itself `.claude/workflows` is the link to the canonical files).
  If either fails → STOP and tell the user to regenerate the stamped copies with
  `bash "$PACK/install.sh" --consumer <repo>`, then restart Claude Code.
- **Before Step 1.5**, run `node "$PACK/scripts/wolfpack-chain.mjs" init --campaign <slug>` from the main checkout
  (creates `campaign/<slug>` from `main`, or adopts it). **Step 1.5 scaffolds in chain mode:** this section (not
  Step 1.5, which stays as it is) says that, with `--chain`, every Step 1.5 scaffold is invoked as
  `/hunt --campaign=<slug> <hunt-slug> "<desc>"` — the `--campaign=<slug>` flag is what makes `/hunt` fork the
  hunt from `campaign/<slug>` and stamp `base_branch`; the init above guarantees that branch exists. A
  pre-spec hunt scaffolded without it (an older run) forks from `main` and is healed by the Shepherd ("set
  `base_branch` if absent" + rebase onto the campaign branch).
- **RESUME PLAN additions:** a header line `Mode: chain mode (campaign/<slug>)`. Classify the chain statuses:
  `merged_to_campaign` / `merged_to_campaign_pending_compliance` → done (campaign-merged; the latter awaits
  sign-off at the release); `certified` / `certified_pending_compliance` / `certified_held_overlap` →
  "merges next pass"; `parked:campaign_merge_conflict` / `parked:reverted_from_campaign` / any other
  `parked:*` / `needs_spec` → blocked, with its `/resolve <hunt>` (or `/spec <hunt>`) command;
  `reverted_with_dependency` → "auto re-merges after <reverted_because>".
- Re-running a chain campaign **without** `--chain` still runs chain mode (the runner logs it — sticky).
- **Ending:** the runner returns
  - `CAMPAIGN_READY_FOR_RELEASE` → `/release-campaign <slug>`.
  - `CAMPAIGN_AWAITING_HUMAN` → the listed `/resolve`s (each blocked hunt names the hunts waiting on it), then re-run.
  - `CAMPAIGN_PARKED_MAIN_CONFLICT` → resolve the main→campaign merge by hand, then re-run.
  - `WAVE_PAUSED_QUOTA` / `WAVE_PAUSED_BUDGET` → re-run later; it resumes mid-chain.
  - Checkpoint (ship what is already campaign-merged, keep the campaign running): `/release-campaign <slug> --checkpoint`.
- A smoke-blocked or rejected hunt is reverted from the campaign branch (never from `main`):
  `node "$PACK/scripts/wolfpack-release.mjs" revert --campaign <slug> --hunt <hunt> --reason "<why>"`.

## What NOT to do
- Do NOT `exec run-pipeline-sandbox.sh` or call `claude -p` — that's the metered/headless path
  this command exists to avoid.
- Do NOT hand-edit `.claude/workflows/campaign-runner.js` / `hunt-pipeline.js` — pipeline changes go canonical-first, then `install.sh --consumer` (above).
- Do NOT deploy or push — the workflow stops at wave barriers; the user drives releases.
