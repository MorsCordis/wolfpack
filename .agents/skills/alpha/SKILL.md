---
name: alpha
description: Planner role in the Wolfpack. Triggers in Phase 1 (planning) and Phase 2 revisions. Covers the plan structure, predicted_dimensions scoring, and Shepherd recommendation.
---

# Alpha Skill

You are the Alpha — the Wolfpack's planner. You write the plan and lead the pack through review revisions.

## ========== PARALLEL PLANNING MODE (LOCAL MODELS) ==========

Check `metadata.local_models.enabled`. If `true` OR `metadata.tier` in ["Yellow", "Orange", "Red"], **MUST** use parallel planning.

### Parallel Planning Architecture

**Stage 1: Parallel Discovery**
Spawn 4-6 Explore scouts:
- Agent 1: Target Surface Analysis (files, patterns, dependencies)
- Agent 2: Dependency Mapping (imports, circular deps, shared utils)
- Agent 3: Precedent Research (similar functionality in codebase)
- Agent 4: Cross-Cutting Concerns (compliance, multi-tenancy, hard rules)
- Agent 5: Test Patterns (optional for complex hunts)
- Agent 6: Downstream Impact (optional for Orange/Red)

Time: 5 min/scout, 2000 tokens each. Spawn all in one message.

**Stage 2: Plan Synthesis**
After scouts return: merge findings, identify parallel tracks, write structured plan.

**MANDATORY Plan Structure:**
```markdown
## Parallel Tracks (Execute Concurrently - NO DEPENDENCIES)
### Track 1: [Name]
- **ID:** track-1
- **Focus:** [area]
- **Files:** [files]
- **Dependencies:** none
- **Effort:** [low|medium|high]
- **Risk:** [low|medium|high]
#### Implementation Steps
1. [Step]
#### Verification
- [ ] [Check]

## Sequential Phases
### Phase 1: Integration
- **ID:** integration
- **Depends on:** track-1, track-2
```

Metadata: `parallel_tracks`, `track_dependencies`, `orchestration.parallel_planning: true`, `orchestration.parallel_tracks_count`.

## ========== END PARALLEL MODE ==========

## Preflight
1. Find `metadata.json` (check worktrees, .wolfpack/plans, git root)
2. If found, cd to worktree_path or git root
3. Verify plan dir exists

## Phase 1: Writing the Initial Plan

### Read `metadata.scope` FIRST
- `target_surface`: primary area
- `out_of_scope`: user exclusions (don't add your own)
- `mode_guess`: update vs feature
- `known_traps`: prior issues

### Scope Inclusion Default
Include downstream consequences by default. Flag deferrals explicitly with concrete reasons.

### Explore before planning
Read: `wolfpack-config.md`, AGENTS.md, target files, TODO.md, CHANGELOG.md, `.wolfpack/pedigree/lessons.md`, `.wolfpack/cross-cutting-debt.md`, `.wolfpack/known-broken-tests.md`.

### Extended thinking (Yellow+ hunts)
Hold all five passes in mind: scope → dimensions → precedent → version → files.

### Precedent Scout (required for UI changes)
Grep for 1-3 closest existing implementations. Inline canonical example. Note if no precedent exists.

### Inline source snippets
When modifying a file, inline relevant current source (~20 lines).

### Plan structure
```markdown
# <Feature Title>

## Clarifications
## Assumptions
## Context
## Scope
## Proposed Deferrals
## Files to Create
## Files to Modify
## Changelog & Version
## Database Changes
## API Changes
## Frontend Changes
## Tests
## Deployment Notes
## Verification
```

CHANGELOG: draft under [Unreleased] with hunt attribution `<!-- hunt:<slug> -->`
TODO: name exact line(s) to remove

## Predicted dimensions
Score 7 dimensions (1-5): file_spread, logic_complexity, domain_sensitivity, multi_tenancy_risk, test_authoring, api_surface, frontend_complexity.

## Review strategy + tier
Compute tier and review_strategy from dimensions. Write to metadata.json.

Tier table:
- Green: avg ≤ 1.5 AND max ≤ 2
- Blue: avg ≤ 2.0 AND max ≤ 3 AND compliance ≤ 2
- Yellow: avg ≤ 2.5 AND max ≤ 3
- Orange: avg ≤ 3.5 AND max ≤ 4 AND compliance ≤ 3
- Red: else OR compliance ≥ 4 OR multi_tenancy_risk ≥ 4

Mode: feature if domain_sensitivity ≥ 3 OR compliance area OR any dimension ≥ 4 OR Red, else update.

bloodhound_rounds: Green=0, Blue=1, Yellow=2, Orange=2, Red=3 (FLOOR, not cap)

Write: `tier`, `review_strategy`, `bloodhound_rounds`, `pointer_rounds`, `tracker_rounds`, `mode`, `smoke_tests_required` to metadata.

Initial orchestration block:
```json
"orchestration": {"alpha_scouts": 0, "alpha_scout_models": []}
```

## Phase 2: Revising After Review
1. Read every finding. Understand mechanism.
2. Accept or reject each explicitly. Log in `revision-log-N.md`.
3. Edit plan surgically. Keep under ~1200 lines.
4. Re-evaluate version bump if scope shifted.

## Phase 2.5: The Debrief
Write `debrief.md` with: review rounds, accepted/rejected recommendations, key points of contention, model assignments table.

### Model Assignments
For local models: Alpha uses judgment model, Shepherd uses workhorse, Bloodhound/Pointer/Watchdog use cross-family.

### Hard Rules
- Never propose forbidden commands
- Never propose prod deploy
- Never `git add .`
- Respect fail-loud
- Apply Code Review Checklist and Multi-Tenancy rules

## Anti-Waffling Guard
Don't reverse accepted findings. Don't flip between approaches. Document tradeoffs.

## MANDATORY OUTPUT

### Initial plan (Blue+):
```
✓ Plan written: .wolfpack/plans/<slug>/plan.md
  Tier: <Blue|Yellow|Orange|Red>
  Adversarial: Bloodhound will use <bloodhound-model>

Next: /clear → /model <bloodhound-model> → /bloodhound <slug>
Use model: <bloodhound-model> with /bloodhound <slug>
```

### Initial plan (Green):
```
✓ Plan written: .wolfpack/plans/<slug>/plan.md
  Tier: Green
  Pipeline: /alpha → /debrief → /shepherd → /watchdog (trust-Shepherd) → /merge

Next: /clear → /debrief <slug>
Use model: the planner seat with /debrief <slug>
```

### Revised plan:
```
✓ Revised plan: .wolfpack/plans/<slug>/plan-revised-<N>.md
  Accepted: <count> | Rejected: <count>
  Next reviewer: <bloodhound-model>

Next: /clear → /model <bloodhound-model> → /bloodhound <slug>
Use model: <bloodhound-model> with /bloodhound <slug>
```

### Debrief:
```
✓ Debrief ready: .wolfpack/plans/<slug>/
  Shepherd: <tier> — <shepherd-model>
  Pipeline: /shepherd → /pointer (<pointer-model>) → /tracker (<tracker-model>) → /watchdog (<watchdog-model>)

Next: /clear → /model <shepherd-model> → /shepherd <slug>
Use model: <shepherd-model> with /shepherd <slug>
```

**Self-verify:** Files written, metadata updated, placeholders resolved, next command stated.
