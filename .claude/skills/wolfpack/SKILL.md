---
name: wolfpack
description: The Wolfpack agentic handoff pipeline — roles, directory layout, metadata, and slash-command sequence. Triggers on "wolfpack", "run the pipeline", "plan a feature with the pipeline".
---

# Wolfpack Skill

Wolfpack is a multi-agent pipeline for planning, reviewing, implementing, code-reviewing, testing, and certifying features. Each role runs in a fresh session with a clean context — information flows between roles only through files.

**Project-specific configuration:** Review checklists, test commands, deployment steps, hard rules, and compliance requirements are defined in your project's `wolfpack-config.md` file. Read it before any phase that needs project context.

## The Pack

| Role | Name | Default Model | When it runs |
|------|------|---------------|--------------|
| Planner | **Alpha** | Claude Opus (fixed) | Phase 1: writes the plan + predicted task dimensions |
| Adversarial plan reviewer | **Bloodhound** | Cross-model from Alpha (pool: Sonnet, Gemini, Mistral) | Phase 2: reviews the plan, explores the codebase |
| Implementer | **Shepherd** | Pedigree-selected from pool (Opus, Sonnet, Gemini, Mistral) | Phase 3: implements the plan (code only — no tests) |
| Adversarial code reviewer | **Pointer** | Cross-model from Shepherd (pool: Opus, Sonnet, Gemini, Mistral) | Phase 4: reviews the code, triggers Shepherd rewrites |
| Test writer | **Tracker** | Claude Opus (fixed) | Phase 5: writes + runs tests, triggers Shepherd rewrites |
| Certifier | **Watchdog** | Cross-model from Shepherd (pool: Opus, Sonnet, Gemini, Mistral) | Phase 6: verifies code + tests, scores pedigree |

**Adversarial Cross-Model Rule:** Review/verification roles MUST use a different model family from the role they review. Bloodhound != Alpha. Pointer != Shepherd. Watchdog != Shepherd.

**Multi-Model Pool:** Four model families available: Opus, Sonnet, Gemini, Mistral. Alpha selects models for each role during the Debrief based on pedigree scores from past hunts. Two roles are fixed (Alpha = Opus, Tracker = Opus).

## Pipeline Shapes by Tier

Pipeline ceremony scales with hunt complexity. Tier is set by Alpha during dimension scoring. Five tiers.

| Tier | Bloodhound | Pointer | Tracker | Watchdog | When to use |
|------|-----------|---------|---------|----------|-------------|
| **Green** | skip | skip | skip | trust-Shepherd (read shepherd-log only) | Typos, config, tiny fixes |
| **Blue** | 1 round | 1 round (one-shot, no loop) | write + run (one-shot, no loop) | checklist (abbreviated) | Small features, polish |
| **Yellow** | 1-2 rounds | 1-2 rounds (can loop) | write + run, can trigger rewrite | full cert | Standard features |
| **Orange** | 2 rounds | 2 rounds (can loop) | write + run, can trigger rewrite | full cert | Multi-component features, API changes |
| **Red** | 2 rounds | 2 rounds + security/compliance lens | full coverage, can trigger rewrite | full cert + manual smoke | Compliance, high-risk, architectural |

### Round caps per tier

```
Green:  { bloodhound: 0, pointer: 0, tracker: 0 }
Blue:   { bloodhound: 1, pointer: 1, tracker: 1 }
Yellow: { bloodhound: 2, pointer: 2, tracker: 2 }
Orange: { bloodhound: 2, pointer: 2, tracker: 2 }
Red:    { bloodhound: 2, pointer: 2, tracker: 2 }
```

### Rewrite cycles

Pointer and Tracker can each trigger Shepherd rewrites:
- **Pointer -> Shepherd:** Pointer writes `pointer-review-N.md` with findings -> Shepherd reads and fixes -> Pointer re-reviews. Max 2 rounds before user escalation.
- **Tracker -> Shepherd:** Tracker writes `tracker-report-N.md` with failing tests and root cause -> Shepherd fixes -> Tracker re-runs. Max 2 rounds before user escalation.
- **Blue tier exception:** Pointer and Tracker run one-shot — report findings but do NOT loop back to Shepherd.

## Sub-Agent Orchestration

Any pipeline phase can spawn sub-agents via the `Agent` tool for parallel work within that phase.

| Phase | Sub-agent role | When | Count |
|-------|---------------|------|-------|
| Alpha | Research scouts (`subagent_type: "Explore"`) | Yellow+ or `file_spread >= 3` | 2-4 |
| Bloodhound | Mini-orchestrator scouts (Blue) or specialist reviewers (Yellow+) | Per `review_strategy` | 2-5 |
| Pointer | Code review lenses (security, compliance, performance) | Orange+ | 2-3 |
| Tracker | Parallel test writers | >=2 independent areas touched | 2-4 |
| Watchdog | Certification lenses | Red tier or `review_strategy == "ultra"` | 2-3 |

## Running the Pipeline

Slash commands drive the pipeline. Fresh session (`/clear`) between phases.

```
/hunt <slug> "<desc>"       -> /alpha <slug>            (Opus — fixed)
/alpha <slug>               -> /bloodhound <slug>       (cross-model from Alpha)
/bloodhound <slug>          -> /alpha <slug> OR /debrief <slug>
/debrief <slug>             -> /shepherd <slug>         (pedigree-selected)
/shepherd <slug>            -> /pointer <slug>          (cross-model from Shepherd)
                              OR /shepherd <slug> --pointer-rewrite=N
/pointer <slug>             -> /tracker <slug>          (Opus — fixed)
/tracker <slug>             -> /watchdog <slug>         (cross-model from Shepherd)
                              OR /shepherd <slug> --tracker-rewrite=N
/watchdog <slug>            -> /merge <slug>
/merge <slug>               -> deploy -> /smoke <slug>
```

## Directory Layout

```
.wolfpack/plans/<feature-slug>/
  metadata.json          # Phase, status, model routing, predicted_dimensions
  plan.md                # Alpha's initial plan (with inlined source snippets)
  review-1.md            # Bloodhound round 1
  plan-revised-1.md      # Alpha revision after round 1
  review-2.md            # (if needed, up to 2 rounds)
  plan-final.md          # Copy of the last accepted plan
  debrief.md             # Review summary + 6-role model assignment
  shepherd-log.md        # Written by Shepherd during implementation (code only)
  pointer-review-1.md    # Pointer code review round 1
  pointer-review-2.md    # (if needed, up to 2 rounds)
  tracker-log.md         # Tracker's test log
  tracker-report-1.md    # Tracker rewrite request (if tests expose bugs)
  certification.md       # Watchdog verdict
  pedigree.json          # Execution + process value-add scorecard

.wolfpack/pedigree/
  index.md               # Rolling table, one line per completed run (tracked in git)
  lessons.md             # Aggregated tag patterns (auto-generated)
```

## metadata.json Schema

```json
{
  "feature": "slug",
  "description": "Short description",
  "created": "ISO8601 timestamp",
  "status": "ready_for_alpha|planning|reviewing|revising|ready|implementing|code_reviewing|code_rewrite_needed|testing|test_rewrite_needed|certifying|certified|done|rework_needed|flawed_plan_restarting|timeout",
  "phase": "plan|review-N|revise-N|ready|implement|code-review-N|code-rewrite-N|test|test-rewrite-N|certify|done",
  "review_round": 0,
  "pointer_round": 0,
  "tracker_round": 0,
  "branch": "feat/slug",
  "is_worktree": false,
  "worktree_path": null,
  "scope": {
    "target_surface": "string",
    "out_of_scope": "string",
    "mode_guess": "update|feature",
    "known_traps": "string"
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
  "tier": "Green|Blue|Yellow|Orange|Red",
  "review_strategy": "sequential|mini_orchestrator|parallel_specialized|ultra",
  "bloodhound_rounds": 0,
  "pointer_rounds": 0,
  "tracker_rounds": 0,
  "smoke_tests_required": null,
  "mode": "update|feature",
  "models": {
    "planner": "claude:opus:high",
    "reviewer": "mistral:medium",
    "architect": "claude:sonnet:medium",
    "architect_recommended": null,
    "code_reviewer": null,
    "test_writer": "claude:opus:high",
    "certifier": "claude:opus:high"
  },
  "proposed_version": {
    "bump": null,
    "tag": null
  },
  "model_assignments": {
    "alpha": null,
    "bloodhound": null,
    "shepherd": null,
    "pointer": null,
    "tracker": null,
    "watchdog": null
  },
  "orchestration": {
    "alpha_scouts": 0,
    "alpha_scout_models": [],
    "bloodhound_specialists": 0,
    "bloodhound_specialist_models": [],
    "pointer_rounds_used": 0,
    "tracker_rounds_used": 0,
    "watchdog_lenses": 0,
    "watchdog_lens_models": []
  }
}
```

## Pedigree System

- `.wolfpack/pedigree/index.md` — one line per completed feature. Alpha reads this for model recommendations.
- `.wolfpack/plans/<feature>/pedigree.json` — individual scorecard per run.
- Alpha owns `predicted_dimensions`; Watchdog only scores `execution_scores` + `process_value_add`.

## Key Invariants

1. **Fresh sessions.** Each role starts with no conversational context from prior roles.
2. **Files are the channel.** Roles communicate only by reading/writing files in the plan directory.
3. **Bloodhound and Pointer are read-only (instruction-enforced).** They may write only their review files and metadata.json.
4. **Watchdog owns final state transitions.** On exit, Watchdog must update `metadata.json` to `certified`, `rework_needed`, `flawed_plan_restarting`, or `timeout`.
5. **wolfpack-config.md is the project adapter.** All project-specific rules, checklists, commands, and conventions live there — not in the framework skills.

## Related Skills

- `alpha` — planner role: plan structure, dimension scoring, model pool selection
- `bloodhound` — adversarial plan reviewer
- `shepherd` — implementer (code only, no tests)
- `pointer` — adversarial code reviewer
- `tracker` — test writer and runner
- `watchdog` — certification checklist + Pedigree scoring (including process value-add)
