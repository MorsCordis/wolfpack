// Tests for wolfpack-pedigree.mjs — run: node --test scripts/wolfpack-pedigree.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOverall, gradeConvergence, gradeCatchRate, applyOutcome, validate,
} from './wolfpack-pedigree.mjs';

test('computeOverall: geometric mean of numeric dims', () => {
  const all1 = { correctness: { score: 1 }, completeness: { score: 1 }, convergence: { score: 1 }, catch_rate: { score: 1 } };
  assert.equal(computeOverall(all1).overall, 1);
  // geo mean of 0.9 and 0.4 = sqrt(0.36) = 0.6
  assert.equal(computeOverall({ correctness: { score: 0.9 }, completeness: { score: 0.4 } }).overall, 0.6);
});

test('computeOverall: a zero dimension forces overall to 0 (no trading off a failure)', () => {
  assert.equal(computeOverall({ correctness: { score: 0 }, completeness: { score: 1 } }).overall, 0);
});

test('computeOverall: compliance fail is a VETO (blocked, null overall)', () => {
  const r = computeOverall({ correctness: { score: 1 }, compliance: { status: 'fail' } });
  assert.equal(r.overall, null);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'compliance_veto');
});

test('computeOverall: compliance pass does not enter the mean', () => {
  const withPass = computeOverall({ correctness: { score: 0.8 }, compliance: { status: 'pass' } });
  const without = computeOverall({ correctness: { score: 0.8 } });
  assert.equal(withPass.overall, without.overall);
});

test('gradeCatchRate: caught vs slipped; clean run = 1.0', () => {
  assert.equal(gradeCatchRate({ caught: 2, slipped: 0 }), 1);
  assert.equal(gradeCatchRate({ caught: 1, slipped: 1 }), 0.5);
  assert.equal(gradeCatchRate({ caught: 0, slipped: 0 }), 1);
  assert.equal(gradeCatchRate({ caught: 0, slipped: 3 }), 0);
});

test('gradeConvergence: fewer rounds better, tier-aware', () => {
  assert.equal(gradeConvergence({ rounds: 0, tier: 'Green' }), 1);
  assert.equal(gradeConvergence({ rounds: 1, tier: 'Yellow' }), 1); // at floor
  assert.ok(gradeConvergence({ rounds: 3, tier: 'Yellow' }) < 1);
  assert.equal(gradeConvergence({ rounds: 99, tier: 'Yellow' }), 0);
});

test('applyOutcome: a slipped smoke finding lowers catch_rate, clears provisional, recomputes overall', () => {
  const rec = {
    schema_version: 2, hunt_id: 'h', routing: {}, provisional: true,
    dimensions: {
      correctness: { score: 1 }, completeness: { score: 1 }, convergence: { score: 1 },
      catch_rate: { score: 1, caught: 2, slipped_smoke: 0 },
    },
  };
  const after = applyOutcome(rec, { slippedSmoke: 1 });
  assert.equal(after.provisional, false);
  assert.equal(after.dimensions.catch_rate.score, 0.667); // 2/(2+1)
  assert.ok(after.overall < 1);
  assert.equal(rec.provisional, true); // input not mutated
});

test('applyOutcome: a revert zeroes correctness -> overall 0', () => {
  const rec = { schema_version: 2, hunt_id: 'h', routing: {}, dimensions: { correctness: { score: 1 }, completeness: { score: 1 } } };
  const after = applyOutcome(rec, { reverted: true });
  assert.equal(after.dimensions.correctness.score, 0);
  assert.equal(after.overall, 0);
});

test('validate: accepts a good record, rejects bad ones', () => {
  assert.equal(validate({ schema_version: 2, hunt_id: 'h', routing: {}, dimensions: {} }).ok, true);
  assert.equal(validate({ schema_version: 1, hunt_id: 'h', routing: {}, dimensions: {} }).ok, false);
  assert.equal(validate({ schema_version: 2, hunt_id: 'h', routing: {}, dimensions: { correctness: { score: 5 } } }).ok, false);
  assert.equal(validate({ schema_version: 2, hunt_id: 'h', routing: {}, dimensions: { compliance: { status: 'maybe' } } }).ok, false);
});
