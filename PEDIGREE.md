# Pedigree v2 — the reward signal

Each completed hunt emits one pedigree record. It is **the reward signal** an adaptive router /
learned coordinator trains on (see DevDen architecture §16). v1 collapsed to a model-opined `1-5`
that inflated to `5/5/5`; a flat reward has zero training gradient. v2 fixes the reward while keeping
v1's useful parts.

Three roles in one record:
- **`task_features`** — what the work *is* (the coordinator's INPUT). Carried over from v1's
  `predicted_dimensions`.
- **`routing`** — which model held each role (the ACTION the coordinator took). Needed to attribute
  outcomes to routing choices.
- **`dimensions` + `overall`** — how it *went* (the REWARD). Computed/outcome-anchored, not opined.

## Schema

```jsonc
{
  "schema_version": 2,
  "hunt_id": "feat-customers-service-layer",
  "timestamp": "2026-06-23T00:00:00Z",
  "tier": "Yellow",

  // INPUT — task shape (was v1 predicted_dimensions). The features a coordinator routes on.
  "task_features": {
    "file_spread": 2, "logic_complexity": 3, "domain_sensitivity": 4,
    "multi_tenancy_risk": 1, "test_authoring": 2, "api_surface": 1, "frontend_complexity": 2
  },

  // ACTION — model (and quant) per role. Use neutral families; concrete model from wolfpack-config.
  "routing": {
    "alpha": "judgment", "shepherd": "work-horse", "pointer": "reviewer-a",
    "tracker": "judgment", "watchdog": "reviewer-b"
  },

  // REWARD — per-dimension 0-1, COMPUTED from logged facts where possible. `source` ∈
  // {computed, review, gate, outcome}. These per-dim scores are the training signal.
  "dimensions": {
    "correctness":  { "score": 0.95, "source": "computed", "evidence": "tests 23/23" },
    "completeness": { "score": 0.80, "source": "review",   "evidence": "1 edge case missed (pointer-review-1)" },
    "convergence":  { "score": 0.70, "source": "computed", "rounds": 3, "wall_clock_s": 1800 },
    "catch_rate":   { "score": 1.00, "source": "computed", "caught": 2, "slipped_smoke": 0 },
    "compliance":   { "status": "pass", "source": "gate", "evidence": "DEA retention check passed" }
  },

  "overall": 0.84,        // geometric mean of the numeric dims; null if compliance veto. HUMAN-FACING.
  "provisional": true,    // true until the smoke/post-merge window closes; then outcome-anchored
  "verdict": "pass",      // pass | rework | flawed_plan
  "outcome": "merged",    // merged | reverted | hotfixed | parked
  "notes": "..."
}
```

## Scoring rules (`wolfpack-pedigree.mjs`)

- **`overall` = geometric mean** of the numeric dimensions (`correctness`, `completeness`,
  `convergence`, `catch_rate`). Any dimension at 0 drives `overall` to 0 — you can't trade a failure
  in one dimension for excellence in another.
- **Compliance is a VETO, not a dimension to average.** `compliance.status === "fail"` →
  `overall: null`, `blocked: true`. A real compliance failure blocks; it is never diluted by a mean.
- **`convergence`** — fewer review/rework rounds is better, relative to a tier floor (Green 0 … Red 2);
  bottoms out `floor + 4` rounds past. Captures cost-to-converge (iteration is expensive on a
  bandwidth-bound box).
- **`catch_rate`** — `caught / (caught + slipped_to_smoke)`; a clean run (no failures) = 1.0. This is
  the key local-model signal: *failing is fine if the verifier catches it; slipping is the danger.*
- **Outcome-anchoring** — records are `provisional` at certification. When smoke / post-merge reality
  lands, `applyOutcome()` folds slipped findings into `catch_rate`, zeroes `correctness` on a revert,
  clears `provisional`, and recomputes `overall`. (v1 did this manually once — the `4/3/3`
  retrospective downgrade on `referring-clinics-polish`. v2 systematizes it.)

## What's computed vs supplied

| Dimension | How it's derived | Status |
|---|---|---|
| correctness | test pass ratio | computed (test logs) |
| completeness | review findings of "missing" class | review-assisted |
| convergence | `rounds` (rework count) + `wall_clock_s` (`wolfpack-timing.mjs`) | computed |
| catch_rate | in-pipeline findings vs smoke findings linked via `metadata.parent_hunt` | computed — **bootstrap by hand-grading 50–100 hunts first to validate** |
| compliance | the deterministic compliance gate (pass/fail) | gate |

The raw-fact extraction (reading `.wolfpack` logs, linking `parent_hunt` smoke findings) is the
runtime integration layer, wired where the pipeline runs. This module owns scoring + validation.
