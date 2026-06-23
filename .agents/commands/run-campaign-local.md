---
description: Run/resume a Wolfpack campaign IN-SESSION via the Workflow tool (no headless `claude -p` container). Keeps Alpha/Shepherd/Tracker on your interactive session's billing; Gemini/Mistral still run in their pods. Usage: /run-campaign-local <slug> [max-parallel]
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

Parse `$ARGUMENTS` as `[--no-prespec] <campaign-slug> [max-parallel]` (default max-parallel **2**).
The optional `--no-prespec` flag skips the Step 1.5 pre-launch Spec interview (hunts then
self-spec headlessly in-run and may park mid-wave for a human).

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
Run the **exact** RESUME PLAN preflight from `.claude/commands/run-campaign.md` **Step 2** — read
that file and follow it verbatim: parse the hunts in wave order, resolve each hunt's live status
via the worktree-first dual path, classify with `campaign-runner.js`'s own rules
(`DONE_STATUSES`, `parked:model_quota` auto-resumes, other `parked:`/`needs_spec` are
human-gated, `compliance_review`+signed-off is runnable), walk the waves to find the one the
runner will actually touch, render the one-glance plan, and **confirm before launching**. Do not
duplicate or drift from that logic — it must mirror the runner.

## Step 1.5 — Pre-launch Spec interview (front-load questions; default ON, `--no-prespec` to skip)
The in-run Spec phase is **headless** — it can't `AskUserQuestion`, so a hunt with a
load-bearing ambiguity **parks** (`needs_spec`) mid-wave instead of asking. This step
front-loads those questions NOW, in this interactive session (which CAN ask), so the
autonomous build sails through Spec instead of parking. **Skip entirely** if `--no-prespec`
was passed.

**Scope:** ONLY the **pending hunts in the wave the runner will actually touch** (the resume
point from Step 1) — never future waves (they may change once this wave ships) and never
hunts already past Spec (acceptance.md present / status beyond `needs_spec`). Run AFTER the
user confirms in Step 1, BEFORE the Workflow launch in Step 2.

For each such pending hunt, in wave order:
1. **Scaffold if needed.** If the hunt has no worktree (`.claude/worktrees/<slug>/`), scaffold
   it with `/hunt <slug> "<the campaign Trigger description>"` (carry the campaign tier). A hunt
   already scaffolded — including the currently-parked `needs_spec` ones — keeps its worktree;
   do NOT recreate it.
2. **Interview with `/spec <slug>`.** The interactive Spec runs its ambiguity pass + the
   `AskUserQuestion` batch, then writes the durable `acceptance.md` contract + spec metadata
   block to the **worktree** plan dir (the single source of truth — worktree-canonical refactor).
   Answer its questions now. For an already-parked `needs_spec` hunt, this is the interview that
   re-arms it; durability is in `acceptance.md` + the worktree status, which the in-run probe reads.
3. **Confidence outcome:**
   - **confident (autonomous/flagged)** → acceptance.md written, status advances past Spec. The
     in-run resume probe sees acceptance.md and **skips Spec** → the hunt builds autonomously.
   - **still low-confidence after the interview** (genuinely needs deeper analysis — e.g. a
     model-drop needing compliance review, or a "premise is false" audit) → it stays
     `needs_spec`. Surface it: it will NOT auto-build this run; the user decides (drop it from the
     wave or `/resolve` later). Do not force it past a real ambiguity.

After every pending hunt is either spec'd (acceptance.md present) or explicitly left parked,
summarize: *"Pre-spec complete — N ready to build autonomously, M still parked (won't build this
run)."* Then proceed to Step 2 and launch.

**This is a LAUNCH-PATH step only** — no `campaign-runner.js`/`hunt-pipeline.js` changes. The
headless `/run-campaign` (container) path can't do this (no interactive channel); pre-spec is
exclusive to `/run-campaign-local`.

## Step 2 — Launch IN-SESSION via the Workflow tool (only after the user confirms)
Do **NOT** `exec run-pipeline-sandbox.sh` and do **NOT** call `claude -p`. Surface the watcher,
then invoke the Workflow tool directly.

Surface first (own line, copies cleanly):
```
Live progress — paste into a separate terminal:
watch -c -n5 'WOLFPACK_WATCH_COLOR=1 ./scripts/wolfpack-watch.sh'
```

Then call the **Workflow tool**:
- `Workflow({ name: "campaign-runner", args: { campaignSlug: "<slug>", maxParallel: <N> } })`

It runs as a **background task in this session**: `campaign-runner` → `workflow('hunt-pipeline')`
per hunt → `agent()` Claude subagents (this-session billing) → `podman-agy.sh` / `podman-vibe.sh`
for the Gemini/Mistral reviewer pods (host podman, unaffected by Claude billing). It stops at each
wave barrier exactly like the container path. Relay the barrier verdict when the task completes.

## Differences from the container path (`/run-campaign`)
- **Billing:** Claude work bills to this interactive session (your subscription). Plan rate limits
  apply; `parked:model_quota` + the resume loop still handle exhaustion. No Agent-SDK-credit / API
  spend.
- **Sandbox:** the Claude agents run with THIS session's permissions on the host repo — no
  container FS isolation for *them* (worktrees still isolate parallel hunts; the prod/`git add`
  hooks still block; the Gemini/Mistral pods keep their own isolation). For full isolation, run
  this session inside a workspace pod (then the reviewer shims need host-podman-socket passthrough
  or rootless podman-in-podman).
- **No pipeline code changes** — `campaign-runner.js` / `hunt-pipeline.js` are already
  Workflow-native; only the launch path differs.

## Wave barriers (unchanged)
The run STOPS at every wave barrier. Release a wave the same way: `/merge-wave <slug> <wave>` →
`deploy-dev` (+ `migrate-dev` if flagged) → `/smoke-wave <slug> <wave>`; `/resolve <slug>` for any
human-parked hunt. Re-run `/run-campaign-local <slug>` to resume — Step 1 shows the next wave.

## What NOT to do
- Do NOT `exec run-pipeline-sandbox.sh` or call `claude -p` — that's the metered/headless path
  this command exists to avoid.
- Do NOT modify `campaign-runner.js` / `hunt-pipeline.js` — they need no changes.
- Do NOT deploy or push — the workflow stops at wave barriers; the user drives releases.
