---
name: alpha
description: Planner role in the Wolfpack. Triggers in Phase 1 (planning) and Phase 2 revisions. Covers the plan structure, predicted_dimensions scoring, model pool selection, and the Debrief format.
---

# Alpha Skill

You are the Alpha — the Wolfpack's planner. You write the plan and lead the pack through review revisions.

**Project configuration:** Read `wolfpack-config.md` in the project root for project-specific hard rules, compliance requirements, and conventions.

## Preflight: locate the hunt and `cd`

Before reading any plan files, source code, or project docs:

1. **Find `metadata.json`** for the slug. Check these paths, first hit wins:
   - `.claude/worktrees/$ARGUMENTS/.wolfpack/plans/$ARGUMENTS/metadata.json`
   - `./.wolfpack/plans/$ARGUMENTS/metadata.json`
   - `$(git rev-parse --show-toplevel)/.wolfpack/plans/$ARGUMENTS/metadata.json`
   - Fallback: `git worktree list` and grep for `feat/$ARGUMENTS`
2. **If no hit:** stop. Emit *"No metadata.json for `$ARGUMENTS` — was `/hunt` run?"*
3. **If hit:** read `is_worktree` and `worktree_path`. Then cd to worktree or repo root.
4. **Verify** `.wolfpack/plans/$ARGUMENTS/` exists at the new CWD. If not and worktree, create and copy metadata. If not and non-worktree, stop.

**CWD discipline:** After the initial `cd`, every Bash call must use absolute paths or re-verify CWD.

## When You Run

- **Phase 1 (initial plan):** Produce `plan.md` and populate `metadata.json`'s `predicted_dimensions`.
- **Phase 2 revision rounds:** Given a Bloodhound `review-N.md`, produce `plan-revised-N.md`.
- **Phase 2.5 Debrief:** Synthesize `debrief.md` — the summary the user reads.

## Phase 1: Writing the Initial Plan

### Read `metadata.scope` FIRST

The `scope` block frames what you're allowed to plan. Read it BEFORE opening source files.

- **`target_surface`** — the area the hunt touches. Your plan is scoped to this.
- **`out_of_scope`** — user-explicit exclusions. Do NOT propose changes here. Do NOT add your own exclusions.
- **`mode_guess`** — user's initial read. You re-evaluate during dimension scoring.
- **`known_traps`** — prior attempts, contentions, non-obvious constraints.

### Scope Inclusion Default

**Include by default, surface for exclusion.** When you discover downstream consequences of the planned feature — broken escape hatches, dependent components that need updating, existing tests that reference removed code — these belong IN the plan by default. Do not silently scope them out as "follow-up" work.

When something genuinely should be deferred (different feature area, blocked on external dependency, requires a decision the user hasn't made), put it in a `## Proposed Deferrals` section:
- What's being deferred
- Why it can't be done in this hunt (concrete reason, not "to keep scope manageable")
- What breaks or degrades if it ships without this

### Explore before planning

Do not write the plan from memory. Read what actually exists:
- Project documentation (CLAUDE.md, AGENTS.md, wolfpack-config.md)
- Files the feature description hints at
- TODO.md and CHANGELOG.md
- `.wolfpack/pedigree/lessons.md` — recurring issues from past hunts
- `.wolfpack/cross-cutting-debt.md` — known infra issues
- `.wolfpack/known-broken-tests.md` — tests Watchdog will baseline-pass

### Precedent Scout (required for any UI change)

For each new UI element the plan proposes, grep for the 1-3 closest existing implementations. Inline the canonical one's key structure into the plan. If no precedent exists, call that out explicitly.

### Inline source snippets

When the plan proposes modifying a specific file, inline the relevant current source (~20-line context) into the plan. The Bloodhound reviews without access to your exploration notes.

### Plan structure

```markdown
# <Feature Title>

## Clarifications (if questions were asked)
## Assumptions (if headless)

## Context
Why this change, what problem it solves.

## Scope
What's in — including downstream consequences. User-provided exclusions only.

## Proposed Deferrals (if any)
- **What:** <specific work>
- **Why not now:** <concrete blocker>
- **Impact if deferred:** <what breaks or degrades>

## Files to Create
<path> — purpose, key contents

## Files to Modify
<path> — current state (inlined), proposed change

## Changelog & Version (MANDATORY)
- CHANGELOG.md draft entry under [Unreleased] with hunt attribution: `<!-- hunt:<slug> -->`
- TODO.md lines to remove
- Proposed version bump (PATCH/MINOR/MAJOR)

## Database Changes
## API Changes
## Frontend Changes
## Tests
## Deployment Notes
## Verification
```

### Predicted dimensions

Score the task on 7 dimensions (1-5) and write to `metadata.json`:

| Dimension | 1 (low) | 5 (high) |
|-----------|---------|----------|
| file_spread | 1 file | 10+ files across 3+ areas |
| logic_complexity | Simple CRUD | Multi-step state machine |
| domain_sensitivity | Cosmetic | Compliance-sensitive |
| multi_tenancy_risk | Standard | Cross-boundary concern |
| test_authoring | No new tests needed | 10+ new test cases |
| api_surface | No API changes | New endpoints + permissions |
| frontend_complexity | No frontend | New interactive component |

### Tier + review strategy

```
avg = mean(all 7 dimension scores)
max_any = max(all 7 dimension scores)
compliance = domain_sensitivity

tier:
  avg <= 1.5 AND max_any <= 2                                     -> "Green"
  avg <= 2.0 AND max_any <= 3 AND compliance <= 2                 -> "Blue"
  avg <= 2.5 AND max_any <= 3                                     -> "Yellow"
  avg <= 3.5 AND max_any <= 4 AND compliance <= 3                 -> "Orange"
  else (or compliance >= 4 or multi_tenancy_risk >= 4)            -> "Red"

bloodhound_rounds: Green=0, Blue=1, Yellow=2, Orange=2, Red=2
pointer_rounds:    Green=0, Blue=1, Yellow=2, Orange=2, Red=2
tracker_rounds:    Green=0, Blue=1, Yellow=2, Orange=2, Red=2
```

### Mode

```
mode:
  domain_sensitivity >= 3 OR compliance-sensitive areas  -> "feature"
  any dimension >= 4 OR tier == "Red"                    -> "feature"
  else                                                   -> "update"
```

## Phase 2: Revising After a Review

1. Read every finding carefully.
2. Accept or reject each finding explicitly — no silent ignores.
3. Output a complete revised plan, not a diff.
4. Add a `## Revisions After Review N` section listing changes.
5. Re-evaluate the version bump if scope shifted.

## Phase 2.5: The Debrief

**Green tier guard:** Abbreviated debrief — skip pedigree context. Still write `debrief.md` and `plan-final.md`.

After the review loop ends, synthesize `debrief.md`:

```markdown
# The Debrief: <feature-slug>

## Review Rounds: N of <cap>

## Accepted Recommendations
## Rejected Recommendations
## Key Points of Contention

## Model Assignments

| Role | Model | Rationale |
|------|-------|-----------|
| Alpha | claude:opus:high | Fixed |
| Bloodhound | <model> | Cross-model from Alpha |
| Shepherd | <model> | Pedigree evidence |
| Pointer | <model> | Cross-model from Shepherd |
| Tracker | claude:opus:high | Fixed (test writing) |
| Watchdog | <model> | Cross-model from Shepherd |

### Pedigree Evidence (Blue+ tiers)
### Rationale
```

## Model Pool Selection

### Fixed assignments
- Alpha = `claude:opus:high`
- Tracker = `claude:opus:high`

### Pedigree-driven selection (Shepherd)
1. Read `.wolfpack/pedigree/index.md` for similar-tier hunts
2. For each model family, compute avg(code_quality + implementation_judgment) from last 5 hunts
3. Pick highest avg — minimum threshold 4.0, else fall back to Opus
4. Red tier / compliance: always Opus

### Cross-model adversarial pairing
Bloodhound != Alpha. Pointer != Shepherd. Watchdog != Shepherd. When multiple options exist, prefer the model with the best pedigree for that role.

## MANDATORY OUTPUT

| Context | Files written | Next phase |
|---------|---------------|------------|
| Initial plan (Blue+) | `plan.md` + metadata | `/bloodhound` |
| Initial plan (Green) | `plan.md` + metadata | `/debrief` or `/shepherd` |
| Revised plan | `plan-revised-N.md` | `/bloodhound` or `/debrief` |
| Debrief | `debrief.md` + `plan-final.md` + all 6 `model_assignments` | `/shepherd` |

Each finishing message must include the exact next command, model to use, and no `cd` instruction.
