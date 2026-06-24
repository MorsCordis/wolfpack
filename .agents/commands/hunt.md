---
name: hunt
description: Scaffold a new Wolfpack hunt — creates plan directory, metadata.json, and isolated git worktree (default) or in-place feature branch (--no-worktree). Usage: /hunt [--no-worktree] [--shepherd=opus|sonnet|mistral|gemini] <slug> "<description>"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

Scaffold a new Wolfpack hunt.

## Input
Parse `$ARGUMENTS` as: `[--no-worktree] [--shepherd=<model>] [--bloodhound=<model>] [--watchdog=<model>] [--campaign=<slug>] <slug> "<description>"`.

Default: create an isolated git worktree at `.claude/worktrees/<slug>/` with branch `feat/<slug>`.

## Scope context (show before asking questions)

Before asking scope questions, surface all available context:

```
Hunt scope context:
  Slug: <slug>
  Description: <full description>
```

If `--campaign` used, show the campaign entry. Grep `TODO.md` for matching lines.

## Scope-envelope clarification

Determine scope for `metadata.scope`. Parse the description for pre-fill, then ask remaining gaps via `AskUserQuestion`:

1. **target_surface** — what area does this touch?
2. **mode_guess** — update (fix/polish) or feature (new capability)?
3. **out_of_scope** — user-explicit exclusions only
4. **known_traps** — prior attempts, contentions
5. **Version tag** — scan existing tags, in-progress hunts, suggest next

## Preflight: clean main

1. Verify on main branch
2. Check for dirty state — offer commit, stash, or continue
3. Proceed to setup

## Setup steps

0. **Worktree mode (default):** `git worktree add .claude/worktrees/<slug> -b feat/<slug>`. Capture absolute path.
1. Verify `.wolfpack/plans/<slug>/` does NOT exist
2. Create `.wolfpack/plans/<slug>/`
3. Write `metadata.json`:
   ```json
   {
     "feature": "<slug>",
     "description": "<description>",
     "created": "<ISO8601>",
     "status": "ready_for_alpha",
     "phase": "plan",
     "review_round": 0,
     "pointer_round": 0,
     "tracker_round": 0,
     "branch": "feat/<slug>",
     "is_worktree": true,
     "worktree_path": "<absolute path or null>",
     "scope": { "target_surface": "", "out_of_scope": "", "mode_guess": "", "known_traps": "" },
     "predicted_dimensions": { "file_spread": 0, "logic_complexity": 0, "domain_sensitivity": 0, "multi_tenancy_risk": 0, "test_authoring": 0, "api_surface": 0, "frontend_complexity": 0 },
     "tier": null,
     "review_strategy": null,
     "bloodhound_rounds": 0,
     "pointer_rounds": 0,
     "tracker_rounds": 0,
     "smoke_tests_required": null,
     "mode": null,
     "models": {
       "planner": "claude:opus:high",
       "reviewer": "<flag or mistral:medium>",
       "architect": "claude:sonnet:medium",
       "architect_recommended": "<flag or null>",
       "code_reviewer": null,
       "test_writer": "claude:opus:high",
       "certifier": "<flag or claude:opus:high>"
     },
     "proposed_version": { "bump": null, "tag": null },
     "model_assignments": { "alpha": null, "bloodhound": null, "shepherd": null, "pointer": null, "tracker": null, "watchdog": null }
   }
   ```
4. **Branch (--no-worktree only):** `git checkout -b feat/<slug>` from main
5. **Parallel hunt awareness:** Check other in-progress hunts

## Finishing message

```
Hunt scaffolded: <slug> (<worktree|in-place>)
  .claude/worktrees/<slug>/  |  branch feat/<slug>
  Scope: <target-surface>
  Pipeline: /alpha -> /bloodhound -> /debrief -> /shepherd -> /pointer -> /tracker -> /watchdog -> /merge
  Fixed models: Alpha=opus, Tracker=opus | Others assigned by Alpha during Debrief

Next: /clear -> /model opus -> /alpha <slug>

Use model: opus with /alpha <slug>
```

## What NOT to do
- Do NOT invoke any LLM phases
- Do NOT read project source files
- Do NOT commit anything

Begin.
