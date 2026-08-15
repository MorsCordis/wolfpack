---
name: wolfpack
description: The Wolfpack agentic handoff pipeline — roles, directory layout, metadata, and slash-command sequence.
---

# Wolfpack Skill

Multi-agent pipeline for planning, reviewing, implementing, certifying features. Each role runs fresh session. Information flows only through files.

## The Pack

| Role | Name | When it runs |
|------|------|--------------|
| Planner | **Alpha** | Phase 1: writes plan + dimensions |
| Plan Reviewer | **Bloodhound** | Phase 2: reviews plan |
| Implementer | **Shepherd** | Phase 3: implements (code only) |
| Code Reviewer | **Pointer** | Phase 4: reviews code |
| Test Writer | **Tracker** | Phase 5: writes/runs tests |
| Certifier | **Watchdog** | Phase 6: verifies + scores |
| Conflict Resolver | **Integrator** | Phase 3.5: resolves parallel track conflicts |

**Cross-model rule:** Bloodhound ≠ Alpha family. Pointer ≠ Shepherd family. Watchdog ≠ Shepherd family.

## Local Model Configuration
For local models (GB 10):
- Model pool: gemma4-26b + ornith-35b
- KV cache: 128K
- Max concurrent sub-agents: 2 (hard cap for VRAM)
- Enable via: `metadata.local_models.enabled: true`

## Pipeline by Tier

| Tier | Bloodhound | Pointer | Tracker | Watchdog |
|------|-----------|---------|---------|----------|
| Green | skip | skip | skip | trust-Shepherd |
| Blue | 1 round | 1 round | 1-shot | abbreviated |
| Yellow | 1-2 rounds | 1-2 rounds | can loop | full |
| Orange | 2 rounds | 2 rounds | can loop | full |
| Red | 3 rounds | 2+ rounds | can loop | full + manual smoke |

Rounds are FLOOR, not cap. Continues while converging.

## Pipeline Flow
```
/hunt <slug> "<desc>" → /spec <slug>
/spec <slug> → /alpha <slug>
/alpha <slug> → /bloodhound <slug>
/bloodhound <slug> → /alpha OR /debrief
/debrief <slug> → /shepherd <slug>
/shepherd <slug> → /integrator (if parallel conflicts) OR /pointer
/pointer <slug> → /tracker OR /shepherd --pointer-rewrite=N
/tracker <slug> → /watchdog OR /shepherd --tracker-rewrite=N
/watchdog <slug> → /merge <slug>
/merge <slug> → deploy → /smoke <slug>
```

## Local Model Parallel Execution

When `metadata.local_models.enabled: true`:

**Alpha (ALL tiers):** 4-6 parallel scouts (5 min, 2000 tokens each) → structured plan with parallel tracks

**Bloodhound (ALL tiers):** Specialist per track/section, batched 2+2+2 (5 min, 3000 tokens each)

**Shepherd (ALL tiers):** Parallel track execution, max 2 concurrent sub-Shepherds (30 min, 8000 tokens each). Integrator resolves conflicts.

**Tracker (ALL tiers):** 1 writer per independent app, max 2 concurrent (15 min, 6000 tokens each). Green/Blue single-app: MAY use if test suite is large.

**Pointer (ALL tiers):** Specialist per app/track, batched 2+2 (10 min, 4000 tokens each). Green/Blue: SHOULD use for ≥2 apps (2 specialists max).

**Watchdog (ALL tiers):** Red: 3 lenses batched 2+1. Orange/Yellow: SHOULD use parallel (3 lenses). Green/Blue: MAY use abbreviated parallel (2 lenses max).

**All phases:** Hard cap of 2 concurrent sub-agents to prevent VRAM exhaustion.

## Directory Layout
```
.wolfpack/plans/<slug>/
  metadata.json          # phase, status, dimensions, local_models
  plan.md                # initial plan
  review-N.md            # Bloodhound reviews
  plan-final.md          # last accepted plan
  debrief.md             # review summary + model assignments
  shepherd-log.md        # implementation log
  shepherd-track-*.md     # per-track log (parallel mode)
  track-*-status.json    # track status (parallel mode)
  integration-log.md      # Integrator resolutions
  integration-status.json # Integrator status
  pointer-review-N.md    # code reviews
  tracker-log.md         # test log
  tracker-report-N.md    # rewrite requests
  certification.md       # Watchdog verdict
  pedigree.json          # scorecard
```

.wolfpack/pedigree/
  index.md               # completed hunts log

## metadata.json Schema (Key Fields)
```json
{
  "feature": "slug",
  "tier": "Green|Blue|Yellow|Orange|Red",
  "mode": "update|feature",
  "status": "<phase>",
  "phase": "plan|review-N|implement|certify|done",
  "local_models": {
    "enabled": false,
    "kv_cache_size": 128,
    "model_pool": ["gemma4-26b", "ornith-35b"]
  },
  "orchestration": {
    "alpha_scouts": 0,
    "parallel_planning": false,
    "parallel_tracks_count": 0,
    "bloodhound_specialists": 0,
    "pointer_specialists": 0,
    "tracker_test_writers": 0,
    "watchdog_lenses": 0
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
  "bloodhound_rounds": 0,
  "pointer_rounds": 0,
  "tracker_rounds": 0,
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

## Key Invariants
1. Fresh sessions per role
2. Files are the channel (no conversational context)
3. Bloodhound/Pointer read-only
4. Watchdog owns final state transitions
5. Cross-model adversarial pairing mandatory

## Related Skills
- alpha: plan structure, dimensions, parallel planning
- bloodhound: plan review, parallel review mode
- shepherd: implementation, parallel track execution
- pointer: code review, parallel code review
- tracker: test writing, parallel test writing
- watchdog: certification, parallel certification
- integrator: conflict resolution for parallel tracks
- parked: parked hunt management
- spec: intent capture
