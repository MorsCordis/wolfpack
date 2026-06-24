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
// wolfpack-timing.mjs) is the runtime integration layer — the cert-time `emit` CLI below is
// the first wiring of it (the Watchdog supplies objective COUNTS; this module computes scores).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const NUMERIC_DIMENSIONS = ['correctness', 'completeness', 'convergence', 'catch_rate'];

// Defaults calibrated for FRONTIER models. Local models legitimately need MORE review rounds —
// override floor/span per model-tier (wolfpack-config, metadata.convergence_floor/_span, or the
// emit --conv-floor/--conv-span flags) so "more rounds" reads as "par for a local model", not
// "broken". A WIDE span also keeps a slow-but-correct hunt from being annihilated to 0 by the
// geometric mean — the v2 "no trading correctness for speed" invariant has to cut both ways.
export const DEFAULT_TIER_ROUND_FLOOR = { Green: 0, Blue: 1, Yellow: 1, Orange: 2, Red: 2 };
export const DEFAULT_CONVERGENCE_SPAN = 4;

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
export function gradeConvergence({ rounds = 0, tier = 'Yellow', floor = null, span = DEFAULT_CONVERGENCE_SPAN } = {}) {
  const f = floor != null ? floor : (DEFAULT_TIER_ROUND_FLOOR[tier] ?? 1);
  if (rounds <= f) return 1.0;
  return round3(Math.max(0, 1 - (rounds - f) / span));
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
function clamp01(n) { const x = Number(n); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 1; }

/**
 * Assemble a v2 record from OBJECTIVE inputs — the counts/facts a certifier reports, NOT opined
 * 1-5 scores. convergence + catch_rate are COMPUTED; correctness/completeness are outcome facts
 * (fractions, default 1 = clean); compliance is a veto. This is what replaces the 5/5/5 stamp.
 */
export function buildRecord({
  huntId, tier = 'Yellow', routing = {}, task = {},
  rounds = 0, caught = 0, slipped = 0,
  correctness = 1, completeness = 1,
  complianceStatus = 'n/a', reverted = false,
  convergenceFloor = null, convergenceSpan = DEFAULT_CONVERGENCE_SPAN,
} = {}) {
  const dimensions = {
    correctness: reverted
      ? { score: 0, source: 'outcome', evidence: 'reverted' }
      : { score: clamp01(correctness), source: 'cert' },
    completeness: { score: clamp01(completeness), source: 'cert' },
    convergence: { score: gradeConvergence({ rounds, tier, floor: convergenceFloor, span: convergenceSpan }), source: 'computed', rounds, tier },
    catch_rate: { score: gradeCatchRate({ caught, slipped }), caught, slipped_smoke: slipped, source: 'computed' },
    compliance: { status: complianceStatus },
  };
  const { overall, blocked, reason } = computeOverall(dimensions);
  const record = { schema_version: 2, hunt_id: huntId, task, routing, dimensions, overall, provisional: true };
  if (blocked) record.blocked_reason = reason;
  return record;
}

// ─── CLI: emit (cert-time) + outcome (post-smoke/merge) ─────────────────────────
// emit:    node wolfpack-pedigree.mjs emit --plan-dir <dir> [--tier T] [--rounds N]
//            [--caught N] [--slipped N] [--completeness 0-1] [--correctness 0-1]
//            [--compliance pass|fail|n/a] [--reverted]
//          Reads <dir>/metadata.json (routing + task + rounds) + the counts, COMPUTES the v2
//          block, and MERGES it into <dir>/pedigree.json (v1 fields preserved — model-stats reads
//          overall/routing/dimensions from that one file). Validates; prints the scorecard.
// outcome: node wolfpack-pedigree.mjs outcome --plan-dir <dir> [--slipped-smoke N] [--reverted]
//          Folds post-merge reality into the existing record (retroactive downgrade). Run from
//          /merge or /smoke once the hunt's real outcome lands.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reverted') opt.reverted = true;
    else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
  }
  const planDir = opt['plan-dir'];
  if (!planDir) { process.stderr.write('error: --plan-dir required\n'); process.exit(2); }
  const pedPath = path.join(planDir, 'pedigree.json');
  const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

  if (cmd === 'emit') {
    const meta = readJson(path.join(planDir, 'metadata.json')) || {};
    const routing = meta.model_assignments || meta.routing || meta.models || {};
    const task = meta.predicted_dimensions || meta.dimensions || {};
    const tier = opt.tier || meta.tier || 'Yellow';
    const rounds = opt.rounds != null
      ? Number(opt.rounds)
      : Math.max(meta.review_round || 0, meta.pointer_round || 0, meta.tracker_round || 0);
    const rec = buildRecord({
      huntId: meta.slug || path.basename(planDir.replace(/\/$/, '')), tier, routing, task, rounds,
      caught: Number(opt.caught || 0), slipped: Number(opt.slipped || 0),
      correctness: opt.correctness != null ? Number(opt.correctness) : 1,
      completeness: opt.completeness != null ? Number(opt.completeness) : 1,
      complianceStatus: opt.compliance || 'n/a', reverted: !!opt.reverted,
      convergenceFloor: opt['conv-floor'] != null ? Number(opt['conv-floor']) : (meta.convergence_floor ?? null),
      convergenceSpan: opt['conv-span'] != null ? Number(opt['conv-span']) : (meta.convergence_span ?? DEFAULT_CONVERGENCE_SPAN),
    });
    const v = validate(rec);
    if (!v.ok) { process.stderr.write(`invalid v2 record:\n  ${v.errors.join('\n  ')}\n`); process.exit(1); }
    const existing = readJson(pedPath) || {};            // keep v1 fields; add the v2 block
    const merged = {
      ...existing, schema_version: 2, hunt_id: rec.hunt_id,
      task: rec.task, routing: rec.routing, dimensions: rec.dimensions,
      overall: rec.overall, provisional: rec.provisional,
    };
    if (rec.blocked_reason) merged.blocked_reason = rec.blocked_reason; else delete merged.blocked_reason;
    writeFileSync(pedPath, JSON.stringify(merged, null, 2) + '\n');
    const d = rec.dimensions;
    process.stdout.write(`pedigree v2 → ${pedPath}\n`);
    process.stdout.write(`  correctness ${d.correctness.score}  completeness ${d.completeness.score}  convergence ${d.convergence.score} (rounds ${rounds}/${tier})  catch_rate ${d.catch_rate.score} (${d.catch_rate.caught}c/${d.catch_rate.slipped_smoke}s)\n`);
    process.stdout.write(`  compliance ${d.compliance.status}  →  overall ${rec.overall === null ? 'BLOCKED (' + (rec.blocked_reason || '') + ')' : rec.overall}  [provisional]\n`);
    process.exit(0);
  }

  if (cmd === 'outcome') {
    const existing = readJson(pedPath);
    if (!existing) { process.stderr.write(`no pedigree.json at ${pedPath}\n`); process.exit(1); }
    const next = applyOutcome(existing, { slippedSmoke: Number(opt['slipped-smoke'] || 0), reverted: !!opt.reverted });
    writeFileSync(pedPath, JSON.stringify(next, null, 2) + '\n');
    process.stdout.write(`pedigree v2 outcome-anchored → overall ${next.overall === null ? 'BLOCKED' : next.overall} (provisional=${next.provisional})\n`);
    process.exit(0);
  }

  process.stderr.write('usage: wolfpack-pedigree.mjs <emit|outcome> --plan-dir <dir> [...]\n');
  process.exit(2);
}
