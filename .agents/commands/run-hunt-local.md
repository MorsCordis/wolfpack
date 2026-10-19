---
description: Run/resume ONE Wolfpack hunt autonomously IN-SESSION via the Workflow tool — the single-hunt counterpart of /run-campaign-local. Scaffolds if needed, front-loads the Spec interview, then drives Spec → … → Certify → Verify unattended. Usage: /run-hunt-local [--no-prespec] <slug> ["<description>"]
---

Run a single Wolfpack hunt end-to-end with the **`hunt-pipeline` workflow from THIS interactive
session** — the same orchestration a campaign hunt gets from `/run-campaign-local`, minus the
campaign. No `claude -p`, no container.

**Why this exists:** before this command a one-off hunt had only two launch paths — the manual
`/spec → /alpha → … → /watchdog` handoff chain, or `/run-hunt` (container, refuses an
already-scaffolded hunt). There was no supported way to say "this hunt is scaffolded and spec'd —
now run it autonomously", and invoking the workflow by hand with a bare slug crashed
(`hunt-pipeline` expects an args OBJECT). This command is that path.

Parse `$ARGUMENTS` as `[--no-prespec] <slug> ["<description>"]`.
- `<slug>`: kebab-case, `^[a-z0-9][a-z0-9-]*$`.
- `<description>`: required ONLY if the hunt is not scaffolded yet. For a scaffolded hunt it is
  read from metadata (an argument, if given, is ignored — metadata is the record).
- `--no-prespec`: skip Step 2 (the hunt then self-specs headlessly and may park `needs_spec`).

## Preconditions — state them, then proceed
1. **Interactive session.** If you are running headless (`-p`), STOP and say so.
2. **Permission mode.** An autonomous hunt does many edits, `git` ops and `podman` calls. Tell the
   user to run in an auto-accepting mode or it will prompt throughout. Note it — do not change
   their settings.
3. **One pipeline at a time.** If another hunt/campaign workflow is already running in this
   session (or a container run is live — `./scripts/wolfpack-watch.sh` shows it), STOP: pipeline
   runs are strictly sequential (usage window).

## Step 1 — Resolve the hunt (READ-ONLY, then scaffold only if absent)
Find metadata worktree-first:
`.agents/worktrees/<slug>/.wolfpack/plans/<slug>/metadata.json`, else
`.wolfpack/plans/<slug>/metadata.json`.

- **Not found** → need a description (stop with usage if none). Run `/hunt <slug> "<description>"`
  (its scope + version questions are interactive — answer them now). Do NOT print `/hunt`'s
  manual-chain handoff as the next step; continue to Step 2.
- **Found** → classify `status`:
  - `certified` / `done` / `merged` → STOP: nothing to run (`/merge <slug>` if not yet merged).
  - `parked:<reason>` (except `parked:model_quota`) → STOP: human-gated — `/resolve <slug>` first.
  - `needs_spec` → runnable after Step 2's interview.
  - anything else (`ready_for_alpha`, `planning`, `implementing`, `parked:model_quota`, …) →
    runnable; the workflow's resume probe picks up at the durable phase.

Show a one-glance plan and **confirm before launching**:
```
Hunt: <slug>   status: <status>  phase: <phase>  tier: <tier or "(Alpha decides)">
Worktree: <worktree_path>
Spec: <acceptance.md present → "done — will be skipped" | "will interview now" | "--no-prespec: headless">
Runs: Spec → Plan → Review → Debrief → Implement → Code Review → Test → Certify → Verify (surfaces dev deploy + smoke steps)
```

## Step 2 — Pre-launch Spec interview (default ON; skip with `--no-prespec`)
The in-run Spec phase is headless — it cannot ask, so a load-bearing ambiguity **parks** the hunt.
Front-load it here, exactly as `/run-campaign-local` Step 1.5 does:
- If `acceptance.md` already exists in the worktree plan dir → skip (the resume probe skips Spec).
- Otherwise run `/spec <slug>` interactively, answer its `AskUserQuestion` batch, let it write
  `acceptance.md` + the `spec` metadata block to the **worktree** plan dir. Do NOT emit `/spec`'s
  manual handoff (`/clear → /alpha`) — continue to Step 3.
- Still low-confidence after the interview → it stays `needs_spec`; STOP and say why. Never force
  a hunt past a real ambiguity.

## Step 3 — Launch IN-SESSION via the Workflow tool
Surface the watcher first (own line, copies cleanly):
```
Live progress — paste into a separate terminal:
./scripts/wolfpack-watch.sh --loop 5
```

Build the args **object** from the (worktree-first) metadata — never a bare string:
- `slug` — the slug
- `description` — `metadata.description`, VERBATIM
- `ticketRefs` — `metadata.ticket_ids` (omit if empty)
- `tier` / `mode` — only if metadata already carries them (a campaign-sourced or re-run hunt);
  otherwise omit and let Alpha score.

```
Workflow({ name: "hunt-pipeline", args: { slug: "<slug>", description: "<verbatim>", ticketRefs: [...] } })
```

It runs as a background task. Tell the user it is running, that it parks (never pushes through) on
non-convergence / open criticals / compliance, and that `/parked` + `/resolve <slug>` handle a park.
When the task notification arrives, relay the verdict.

## Step 4 — After the workflow completes
- **Certified** → the Verify phase does NOT deploy: it surfaces the feature-branch dev deploy
  commands (user-run — from wolfpack-config.md → Deployment Notes; a project's main-repo deploy
  function may ship MAIN, not the branch, from a worktree) and lists the smoke steps. If the
  project declares no deploy step, Verify reports "certified" and the next step is `/merge <slug>`. Relay those, then
  hand off: user deploys feat branch to dev → `/smoke <slug>` → `/merge <slug>` (tags
  `proposed_version.tag`) → push. Prod deploy is USER-ONLY.
- **Parked** → show `parked.md`'s reason + the `/resolve <slug>` handoff; re-run
  `/run-hunt-local <slug>` after resolving (the resume probe continues from the durable phase).
- **Workflow error** (not a park) → report the error text and the run's resume line
  (`Workflow({scriptPath, resumeFromRunId})`); do not hand-drive the remaining phases.

## What NOT to do
- Do NOT `exec run-pipeline-sandbox.sh` or call `claude -p` (that is `/run-hunt`).
- Do NOT pass `args` as a bare slug string.
- Do NOT deploy, push, or merge — the workflow stops after Verify surfaces the deploy; the user drives release.
- Do NOT start a second pipeline while one is running.
