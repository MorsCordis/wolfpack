#!/usr/bin/env node
// wolfpack-pedigree.mjs — pedigree v2 scoring: outcome-anchored, multi-dimensional,
// model-agnostic. This is the REWARD SIGNAL for the learned coordinator (see DEVDEN §16).
//
// Why v2: v1 collapsed to a model-OPINED 1-5 that inflated to 5/5/5. A flat reward has zero
// training gradient — you cannot learn a coordinator from a flat line. v2 keeps v1's
// `task_features` (the coordinator's INPUT) and the `routing` (the ACTION), but makes the
// REWARD discriminating:
//   - per-dimension 0-1 scores, COMPUTED from logged facts where possible (not opined);
//   - geometric-mean `overall` (any weak dimension drags it — no trading correctness for speed);
//   - compliance is a VETO, never an averaged dimension (a real compliance failure blocks);
//   - per-dimension scores are the TRAINING signal; `overall` is human-facing only;
//   - `provisional` + applyOutcome() do outcome-anchoring (retroactive downgrade on smoke/revert).
//
// Schema: see PEDIGREE.md. This module owns SCORING + validation. Populating the raw counts
// (caught/slipped from parent_hunt smoke links, rounds/wall-clock from .wolfpack logs +
// wolfpack-timing.mjs) is the runtime integration layer, wired Spark-side.

export const NUMERIC_DIMENSIONS = ['correctness', 'completeness', 'convergence', 'catch_rate'];

const TIER_ROUND_FLOOR = { Green: 0, Blue: 1, Yellow: 1, Orange: 2, Red: 2 };
const CONVERGENCE_SPAN = 4; // rounds past the tier floor before the score bottoms out

/**
 * Geometric mean of the numeric dimension scores, with compliance as a hard veto.
 * Returns { overall: number|null, blocked: boolean, reason?: string }.
 * Geometric mean: any dimension at 0 → overall 0 (forces every dimension to be decent).
 */
export function computeOverall(dimensions = {}) {
  const compliance = dimensions.compliance;
  if (compliance && compliance.status === 'fail') {
    return { overall: null, blocked: true, reason: 'compliance_veto' };
  }
  const scores = NUMERIC_DIMENSIONS
    .map((d) => dimensions[d])
    .filter((x) => x && typeof x.score === 'number')
    .map((x) => x.score);
  if (scores.length === 0) return { overall: null, blocked: false, reason: 'no_scored_dimensions' };
  const product = scores.reduce((a, b) => a * b, 1);
  return { overall: round3(Math.pow(product, 1 / scores.length)), blocked: false };
}

/**
 * Convergence: fewer rounds is better, relative to a tier's expectation. Returns 0-1.
 * At/under the tier floor → 1.0; bottoms to 0 once `floor + CONVERGENCE_SPAN` is exceeded.
 * (Cost-to-converge matters on a bandwidth-bound box — iteration is expensive.)
 */
export function gradeConvergence({ rounds = 0, tier = 'Yellow' } = {}) {
  const floor = TIER_ROUND_FLOOR[tier] ?? 1;
  if (rounds <= floor) return 1.0;
  return round3(Math.max(0, 1 - (rounds - floor) / CONVERGENCE_SPAN));
}

/**
 * Catch-rate: of all failures, the fraction CAUGHT in-pipeline vs SLIPPED to smoke/prod.
 * No failures at all → 1.0 (clean run). This is the key local-model quality signal:
 * failing is fine if the verifier catches it; slipping past verification is the danger.
 */
export function gradeCatchRate({ caught = 0, slipped = 0 } = {}) {
  const total = caught + slipped;
  if (total === 0) return 1.0;
  return round3(caught / total);
}

/**
 * Outcome-anchoring. When the post-merge / smoke reality lands, fold newly-discovered slipped
 * failures into catch_rate, mark non-provisional, and recompute `overall`. A revert forces
 * correctness to 0. Returns a NEW record (does not mutate the input).
 */
export function applyOutcome(record, { slippedSmoke = 0, reverted = false } = {}) {
  const next = clone(record);
  next.dimensions = next.dimensions || {};
  const cr = next.dimensions.catch_rate || { caught: 0, slipped_smoke: 0 };
  cr.slipped_smoke = (cr.slipped_smoke || 0) + slippedSmoke;
  cr.score = gradeCatchRate({ caught: cr.caught || 0, slipped: cr.slipped_smoke });
  cr.source = 'computed';
  next.dimensions.catch_rate = cr;
  if (reverted) {
    next.dimensions.correctness = {
      ...(next.dimensions.correctness || {}),
      score: 0, source: 'outcome', evidence: 'reverted post-merge',
    };
  }
  next.provisional = false;
  const { overall, blocked, reason } = computeOverall(next.dimensions);
  next.overall = overall;
  if (blocked) next.blocked_reason = reason;
  return next;
}

/** Minimal schema validation. Returns { ok, errors[] }. */
export function validate(record) {
  const errors = [];
  if (record == null || typeof record !== 'object') return { ok: false, errors: ['record is not an object'] };
  if (record.schema_version !== 2) errors.push('schema_version must be 2');
  if (!record.hunt_id) errors.push('hunt_id required');
  if (!record.routing || typeof record.routing !== 'object') {
    errors.push('routing (model-per-role) required — the action the coordinator took');
  }
  if (!record.dimensions || typeof record.dimensions !== 'object') {
    errors.push('dimensions required');
  } else {
    for (const d of NUMERIC_DIMENSIONS) {
      const dim = record.dimensions[d];
      if (dim && typeof dim.score === 'number' && (dim.score < 0 || dim.score > 1)) {
        errors.push(`dimension ${d}.score must be in [0,1]`);
      }
    }
    const c = record.dimensions.compliance;
    if (c && !['pass', 'fail', 'n/a'].includes(c.status)) {
      errors.push('compliance.status must be one of pass|fail|n/a');
    }
  }
  return { ok: errors.length === 0, errors };
}

function round3(n) { return Math.round(n * 1000) / 1000; }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
