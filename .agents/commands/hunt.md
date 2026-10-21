---
name: hunt
description: Scaffold a new Wolfpack hunt — creates plan directory, metadata.json, and isolated git worktree (default) or in-place feature branch (--no-worktree). Asks 3-4 scope-envelope questions before scaffolding. No LLM planning phases run here. Usage: /hunt [--no-worktree] [--shepherd=<model>] [--bloodhound=<model>] [--watchdog=<model>] <slug> "<description>"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

Scaffold a new Wolfpack hunt.

## ⚠ Finishing message is MANDATORY VERBATIM
Your final response MUST end with the exact block in "## Finishing message" below. Do NOT paraphrase, reformat, or drop `/clear` or the `cd` line. It's the user's copy-paste handoff — dropping steps forces them to reconstruct the cadence themselves.

## Resolve first (pack + worktree root)
Before any step below, from the main checkout:

**Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.

**Worktree root (`WT_ROOT`).** In the main checkout run `node "$PACK/scripts/wolfpack-config.mjs" --json` and take `worktreeRoot` (wolfpack-config.md → Project Identity → Worktree root, repo-relative). If the reader exits 2 or `worktreeRoot` is null, STOP with the fix: "add ``- **Worktree root:** `<repo-relative dir, e.g. .agents/worktrees>` `` under ## Project Identity in wolfpack-config.md". Never assume a default location.

## Input
Parse `$ARGUMENTS` as: `[--no-worktree] [--shepherd=<model>] [--bloodhound=<model>] [--watchdog=<model>] [--campaign=<campaign-slug>] <slug> "<description>"`.
- **Default behavior:** Create an isolated git worktree at `$WT_ROOT/<slug>/` with branch `feat/<slug>`. Keeps hunt artifacts out of the main working tree and enables parallel work on main while the hunt proceeds.
- Optional flag: `--no-worktree` — branch in the current working tree instead (`git checkout -b feat/<slug>` from `main`). Use when the hunt is tiny and worktree ceremony isn't worth it.
- Optional flag: `--shepherd=<model>` — pin the Shepherd model for this hunt, overriding the tier-based default.
- Optional flag: `--bloodhound=<model>` — pin the Bloodhound (reviewer) model.
- Optional flag: `--watchdog=<model>` — pin the Watchdog (certifier) model.
- Optional flag: `--campaign=<campaign-slug>` — see "Campaign mode" below.
- **Model values** come from the `## Model Pool` section of the project's `wolfpack-config.md`. Accept any family or model name listed there.
- **Adversarial defaults (auto-applied if flags not provided):** Bloodhound defaults to a reviewer-family model that is cross-model from the planner; Watchdog defaults to the judgment-family model. Read both from `wolfpack-config.md` → `## Model Pool`. Never default the reviewer to the same model family as the planner — see PEDIGREE.md on adversarial pairing.
- Pin flags are written to `metadata.models.architect_recommended`, `metadata.models.reviewer`, and `metadata.models.certifier` respectively. Alpha respects these when writing the debrief.
- Slug: kebab-case, no spaces (e.g. `ticket17-shift-notes`)
- Description: one sentence in quotes (e.g. `"Fix 400/500 when saving shift notes with &"`)

If slug or description is missing or malformed (and `--campaign` was not provided), tell the user the correct usage and stop.

## Campaign mode (`--campaign=<slug>`)

When `$ARGUMENTS` contains `--campaign=<slug>` WITHOUT a hunt slug/description:

1. Read `.wolfpack/campaigns/<slug>/campaign.md`.
2. Parse the hunt list from `## Proposed Hunts` and the wave/track assignments.
3. For each hunt in wave order, check completion status:
   - Look for `.wolfpack/plans/<hunt-slug>/metadata.json` — if `status: "merged"`, mark done.
   - Look for `$WT_ROOT/<hunt-slug>/.wolfpack/plans/<hunt-slug>/metadata.json` — if exists, mark in-progress (show its current `phase`).
   - If neither exists, mark unstarted.
4. Find the first unstarted hunt in wave order. If all hunts in the current wave are done or in-progress, advance to the next wave.
5. Print campaign progress:
   ```
   Campaign: <slug> — <done>/<total> hunts complete
   Current wave: <N>
   Next hunt: <hunt-slug> (Wave <N>, Track <X>) — <tier> <mode>
   ```
6. If other unstarted hunts exist in the same wave, print:
   ```
   Can also start in parallel (same wave):
     Track <X>: /hunt --campaign=<slug> <other-slug> "<desc>"
     Track <Y>: /hunt --campaign=<slug> <other-slug> "<desc>"
   ```
7. Extract the slug and description from the hunt's `Trigger:` line. Proceed with the normal scaffolding flow (scope-envelope, preflight, setup steps) as if the user had typed that trigger directly.
8. Write `campaign: "<campaign-slug>"` to the hunt's `metadata.json` for traceability.

When `--campaign=<slug>` is provided WITH a specific hunt slug, use that slug instead of auto-selecting. This lets the user pick a specific parallel track from the "Can also start" list.

**Wave gate:** Do NOT auto-select a hunt from Wave N+1 if any Wave N hunts are still in-progress (not merged). Print: "Wave <N> still has in-progress hunts: <list>. Complete or cancel them before advancing to Wave <N+1>." The user can override by providing the slug explicitly.

## Scope context (show before asking questions)

Before asking any scope questions, surface all available context so the user can see what the hunt is working from:

```
Hunt scope context:
  Slug: <slug>
  Description: <full description text>
```

If `--campaign` was used, also show the campaign entry:
```
  Campaign: <campaign-slug>
  Campaign entry: <tier>, <mode>, <backlog items>, <dependencies>
```

Then grep the project's backlog file (`wolfpack-config.md` → `## Deployment Notes` → "Backlog file", commonly `TODO.md`) for lines matching the slug or key terms from the description. If matches found:
```
  Matching backlog items:
  - <line from backlog>
  - <line from backlog>
```

Show this block BEFORE the pre-fill results and any AskUserQuestion calls. The user needs to see the source material to answer scope questions accurately.

### Capture ticket IDs (so the hunt can be flipped closed on merge)

Scan the description, any `--campaign` entry, and the matching backlog lines for ticket
references. If the project's tickets are scoped per environment or per tenant, ticket IDs are
**not globally unique** (`dev #22` ≠ `prod #22`), so store them qualified as `"<scope> #<n>"`.
Write every match to `metadata.ticket_ids` (the field added in step 3). Empty list is fine for
non-ticket hunts.

Why: campaigns built FROM a ticket list otherwise ship without ever flipping the source ticket
closed, because the ID never rode along in metadata. Threading it here lets `/merge` surface
"closes <ids>" at ship time. If the description clearly derives from a ticket but no ID is
present, ask for it in the scope-envelope batch rather than guessing.

## Scope-envelope clarification (pre-fill, then ask gaps)

Before creating any files, determine scope for `metadata.scope`. Two paths depending on description richness:

### Pre-fill heuristics

Parse the hunt description (and campaign metadata if `--campaign` was used) to pre-fill scope fields:

1. **`target_surface`**: Extract module/area references from the description using the
   **`## Module Map`** in the project's `wolfpack-config.md`, which maps each module to the
   words a human would actually use for it. Also recognize any literal path fragment in the
   description (`scripts/`, `.agents/`, a filename) as a surface.
   - If one clear area → pre-fill. If multiple → pre-fill as comma-separated.
   - **Confident** when the description names a module from the map, one of its listed synonyms, a file path, or a feature area named in the map.
   - If the project has no `## Module Map`, fall back to literal path/module names in the description and treat a bare feature description as not confident.

2. **`mode_guess`**: Infer from action verbs:
   - `update` signals: "fix", "patch", "repair", "correct", "resolve", "clean up", "polish", "remove", "refactor"
   - `feature` signals: "add", "create", "implement", "build", "wire up", "introduce", "new"
   - **Confident** when the primary verb is unambiguous.

3. **`out_of_scope`**: Default `""` for well-scoped descriptions. **Confident** when description is specific enough that over-scoping is unlikely (names exact files/features, not vague goals).

4. **`known_traps`**: Default `""`. **Confident** unless description mentions prior failed attempts, "contentious", or references a rework hunt.

### Campaign mode (`--campaign`)

When the campaign's `## Proposed Hunts` entry provides Tier, Mode, Description, and backlog items:
- Pre-fill all 4 scope fields from the campaign metadata (target_surface from Description using the Module Map, mode_guess from Mode field, out_of_scope and known_traps as empty).
- If the campaign entry includes a `Bump:` field (e.g., `Bump: PATCH`), pre-fill `proposed_version.bump` too (with `set_by: null` — a campaign bump is not a human-set version, so seats may revise it).
- **Skip all scope questions.** If bump was also pre-filled, skip Q5 (version tag) entirely — compute the tag from the bump type using the claimed-tag-aware logic from Q5. Only ask Q5 when the campaign doesn't include bump metadata.

### Asking remaining gaps

After pre-fill, check which fields are NOT confidently inferred. Batch ONLY the unresolved questions plus the version tag (Q5, always asked unless pre-filled from campaign) into ONE `AskUserQuestion` call.

If ALL scope fields (Q1-Q4) are confidently pre-filled and version bump is pre-filled from campaign, the hunt scaffolds with NO interactive questions.

If ALL scope fields (Q1-Q4) are confidently pre-filled but no campaign bump, the AskUserQuestion call contains only the version tag question.

If ZERO fields are confidently pre-filled (vague description like "improve the system"), ask all 5 questions.

5. **Version tag.** (Asked unless pre-filled from campaign. Skip entirely when `node "$PACK/scripts/wolfpack-config.mjs" --json` → `releaseTags` is `false` — wolfpack-config.md → Deployment Notes → Tag pattern: `none`.) A version the human answers here is human-set (`set_by: "human"`) and immutable to seats; a seat that disagrees can only record a SEAT NOTE via `wolfpack-version.mjs set`. Before asking, scan for context:
   - Run `git fetch --tags --quiet` to ensure local tags are up to date with the remote.
   - Run `git describe --tags --abbrev=0 --match 'v[0-9]*'` to get the latest release tag on main. The `--match` matters: it skips non-release tags (rollback markers like `pre-hunt-*`), which otherwise win `--abbrev=0` and poison the bump math. Adjust the pattern if the project's release tags use a different prefix.
   - **Claimed-tag scan:** Scan BOTH `.wolfpack/plans/*/metadata.json` AND `$WT_ROOT/*/.wolfpack/plans/*/metadata.json` for `proposed_version.tag` values from hunts whose status is NOT `merged` — any hunt that hasn't landed yet holds a live claim on its tag.
   - **Compute suggested next:** The "next" version is NOT simply latest-git-tag + bump. It must account for claimed tags from in-progress hunts. Find the highest version among {latest git tag, all claimed in-progress tags}, then increment from THAT. Example: if the latest git tag is `v0.22.1` and an in-progress hunt claims `v0.22.2`, the next PATCH is `v0.22.3`, not `v0.22.2`.
   - Present: "Version tag? Current: `<latest-tag>`. Claimed by in-progress hunts: `<list or 'none'>`. Suggested next: `<computed>`. Bump type: PATCH / MINOR / skip?" — The user can reply with an exact tag, a bump type, or `skip` to defer to Alpha.

When pre-filling succeeds, show the user what was inferred in the AskUserQuestion preamble or in the finishing message:
```
Pre-filled from description:
  Target: <target_surface>
  Mode: <mode_guess>
  Out of scope: <out_of_scope or "(none)">
  Known traps: <known_traps or "(none)">
```

Record all values (pre-filled or user-answered) for writing to `metadata.scope` (Q1-Q4) and `metadata.proposed_version` (Q5) in step 3.

## Preflight: clean main

Before scaffolding, verify main is clean. Uncommitted edits on main won't carry into worktrees — they're silently lost at branch point.

1. Verify on main: `git branch --show-current`. If not on main, stop: "Switch to main before scaffolding (`git checkout main`)."
2. Check for dirty state: `git status --porcelain`.
3. If clean: proceed to step 0.
4. If dirty: show the list of modified/untracked files and ask via `AskUserQuestion`:
   - "Uncommitted changes on main — these won't carry into the worktree."
   - Option 1: **"Commit as chore"** — stage the dirty files by name, commit with `chore: pre-hunt cleanup — <brief summary>`, push to origin.
   - Option 2: **"Stash and continue"** — `git stash push -m "pre-hunt: <slug>"`.
   - Option 3: **"Continue anyway"** — proceed knowing the edits won't be in the worktree.
5. After handling dirty state (or if clean), proceed to step 0.

## Setup steps

0. **Worktree mode (DEFAULT — skip this ONLY if `--no-worktree` was passed):**
   - Verify `$WT_ROOT/<slug>/` does NOT exist (run `git worktree list` and grep for it). If it does, stop — pick a different slug.
   - From the main repo (not a sibling worktree), run:
     ```bash
     git worktree add "$WT_ROOT/<slug>" -b feat/<slug>
     ```
   - **Chain-mode campaign:** if `--campaign=<c>` and `.wolfpack/campaigns/<c>/metadata.json` has
     `chain.mode == "chain"`, fork from the campaign branch: `git worktree add "$WT_ROOT/<slug>" -b feat/<slug> campaign/<c>`;
     if `campaign/<c>` is missing, STOP: run `node "$PACK/scripts/wolfpack-chain.mjs" init --campaign <c>` first.
   - Capture the ABSOLUTE path via `cd "$WT_ROOT/<slug>" && pwd`. Store this as `$WORKTREE_ABS`. This value is written to `metadata.worktree_path` in step 3 — it's how every downstream skill self-navigates.
   - All remaining setup steps run inside the new worktree.
   - **CWD assertion:** Before writing ANY file in steps 1-3, verify with `pwd` that you are inside the worktree. If not, `cd "$WORKTREE_ABS"` first. All `mkdir` and `Write` calls in steps 1-3 MUST use absolute paths prefixed with `$WORKTREE_ABS`:
     ```bash
     mkdir -p "$WORKTREE_ABS/.wolfpack/plans/<slug>"
     ```
     and Write tool calls MUST use `$WORKTREE_ABS/.wolfpack/plans/<slug>/metadata.json` as the file_path — NOT a relative path.
1. Verify `.wolfpack/plans/<slug>/` does NOT already exist. If it does, tell the user to pick a different slug or use `/alpha <slug>` to continue.
2. Create `.wolfpack/plans/<slug>/`.
3. Write `.wolfpack/plans/<slug>/metadata.json`. Substitute the real `<worktree-absolute-path>` from step 0 (or `null` for `--no-worktree`), and the real scope answers from the clarification step:
   ```json
   {
     "feature": "<slug>",
     "description": "<description>",
     "ticket_ids": [],
     "created": "<ISO8601 now>",
     "status": "ready_for_alpha",
     "phase": "plan",
     "review_round": 0,
     "pointer_round": 0,
     "tracker_round": 0,
     "branch": "feat/<slug>",
     "is_worktree": true,
     "worktree_path": "<absolute path from step 0, or null for --no-worktree>",
     "scope": {
       "target_surface": "<user answer or empty>",
       "out_of_scope": "<user answer or empty>",
       "mode_guess": "<update|feature>",
       "known_traps": "<user answer or empty>"
     },
     "predicted_dimensions": {
       "file_spread": 0,
       "logic_complexity": 0,
       "domain_sensitivity": 0,
       "multi_tenancy_risk": 0,
       "test_authoring": 0,
       "api_surface": 0,
       "frontend_complexity": 0
     },
     "tier": null,
     "review_strategy": null,
     "bloodhound_rounds": 0,
     "pointer_rounds": 0,
     "tracker_rounds": 0,
     "smoke_tests_required": null,
     "mode": null,
     "models": {
       "planner": "<judgment-family model from wolfpack-config.md>",
       "reviewer": "<bloodhound flag value, or reviewer-family default>",
       "architect": "<work-horse-family model>",
       "architect_recommended": "<shepherd flag value or null>",
       "code_reviewer": null,
       "test_writer": "<judgment-family model>",
       "certifier": "<watchdog flag value, or judgment-family default>"
     },
     "proposed_version": {
       "bump": "<PATCH|MINOR|MAJOR|null — from user's Q5 answer>",
       "tag": "<computed from bump + latest tag, or exact user input, or null if skipped>",
       "set_by": "<\"human\" when the user answered Q5 with a bump or tag; null when Q5 was skipped or the bump was pre-filled from the campaign>"
     },
     "model_assignments": {
       "alpha": null,
       "bloodhound": null,
       "shepherd": null,
       "pointer": null,
       "tracker": null,
       "watchdog": null
     }
   }
   ```
   For a chain-mode campaign hunt (step 0), also add `"base_branch": "campaign/<c>"` (otherwise omit the key).
   Set `is_worktree: false` and `worktree_path: null` when `--no-worktree` was passed. Dimensions stay 0 — Alpha fills them during `/alpha`. Round caps (`bloodhound_rounds`, `pointer_rounds`, `tracker_rounds`) stay 0 — Alpha sets them based on tier scoring.

   - **No alias links in the worktree:** the pack's skills and commands are installed user-level by the pack's `install.sh` (`~/.claude/skills`, `~/.claude/commands`), and the pipeline reads role skills from `$WOLFPACK_HOME/.agents/skills`, so a fresh worktree needs no `.agents/` ↔ `.claude/` alias links. A project that still tracks such links should remove them (they check out as text files under `core.symlinks=false`).

   - **Convenience symlinks (optional, non-blocking):** A worktree does not inherit gitignored files from the main repo, so anything untracked the tooling expects at the repo root (a virtualenv, a `.env`, a local settings file) will be missing. Symlink those from `$MAIN_REPO` (the main checkout: `MAIN_REPO="$(cd "$WORKTREE_ABS" && dirname "$(git rev-parse --git-common-dir)")"`) into `$WORKTREE_ABS` if the project has any. If a symlink fails (permissions, missing target), log a warning and continue — none of these are blocking.

   **Model defaults:** read from `wolfpack-config.md` → `## Model Pool`. If `--bloodhound=` or `--watchdog=` flags were passed, use those values instead.
4. **Branch (ONLY if `--no-worktree` was passed):** Read the git conventions from the project's `wolfpack-config.md` (`## Hard Rules`). If clean and on `main`, run `git checkout -b feat/<slug>`. If on a different branch with uncommitted changes, stop and tell the user to commit/stash first — do not switch branches with dirty state. In worktree mode (default) the branch was created in step 0 by `git worktree add -b`.
5. **Parallel hunt awareness.** Read all `.wolfpack/plans/*/metadata.json` where `status` is not `merged` and not `ready_for_alpha`. If any other hunts are in progress, include a note in the finishing message:
   ```
   ⚠ Other hunts in progress: <list of slugs with status>
   ```
6. Tell the user the scaffold is complete and list the slug + path.

## Finishing message (mandatory last line)

If created in a worktree (default), end with EXACTLY:
```
✓ Hunt scaffolded: <slug> (worktree)
  $WT_ROOT/<slug>/  |  branch feat/<slug>
  Scope: <target-surface-from-answer>
  Pipeline: /spec → /alpha → /bloodhound → /debrief → /shepherd → /pointer → /tracker → /watchdog → /merge
  Fixed models: Alpha and Tracker on the judgment family | Others assigned by Alpha during Debrief

Next: /clear → /spec <slug>

Use the judgment-family model with /spec <slug>

Or run it autonomously (spec interview now, then Spec → … → Certify unattended): /run-hunt-local <slug>
```

(In the message you print, `$WT_ROOT/<slug>/` is rendered as the resolved absolute path, `$WORKTREE_ABS` from step 0.)

If branched in-place (`--no-worktree`), end with EXACTLY:
```
✓ Hunt scaffolded: <slug> (in-place)
  .wolfpack/plans/<slug>/  |  branch feat/<slug>
  Scope: <target-surface-from-answer>
  Pipeline: /spec → /alpha → /bloodhound → /debrief → /shepherd → /pointer → /tracker → /watchdog → /merge
  Fixed models: Alpha and Tracker on the judgment family | Others assigned by Alpha during Debrief

Next: /clear → /spec <slug>

Use the judgment-family model with /spec <slug>

Or run it autonomously (spec interview now, then Spec → … → Certify unattended): /run-hunt-local <slug>
```

Both finishing messages are identical in the "Next" line because `/spec`'s (and `/alpha`'s) preflight reads `metadata.worktree_path` and self-navigates — no manual `cd` needed from the user. `/spec` is Phase 0 (intent → `acceptance.md` + confidence gate) and runs before `/alpha`; a hunt that parks `needs_spec` does not advance to `/alpha` until the spec is resolved. The last line offers the autonomous path: `/run-hunt-local <slug>` front-loads the `/spec` interview in this session, then drives the whole pipeline via the `hunt-pipeline` workflow — the single-hunt equivalent of a campaign run. If `--shepherd=`, `--bloodhound=`, or `--watchdog=` was passed, add one more line above "Next": `Model pins: Shepherd=<value>, Bloodhound=<value>, Watchdog=<value>`.

## What NOT to do
- Do NOT invoke any LLM phases (that's what `/spec` and `/alpha` are for)
- Do NOT read project source files or agent instruction files (no planning happens here)
- Do NOT commit anything
- Do NOT switch branches if the working tree is dirty

Begin.
