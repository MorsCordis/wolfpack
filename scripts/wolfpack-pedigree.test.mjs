// Tests for wolfpack-pedigree.mjs — run: node --test scripts/wolfpack-pedigree.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOverall, gradeConvergence, gradeCatchRate, applyOutcome, validate, buildRecord,
} from './wolfpack-pedigree.mjs';

test('gradeConvergence: configurable floor/span calibrates for local models', () => {
  assert.equal(gradeConvergence({ rounds: 5, tier: 'Yellow' }), 0);            // frontier default annihilates a 5-round hunt
  assert.ok(gradeConvergence({ rounds: 5, tier: 'Yellow', span: 10 }) > 0.5);  // wide span → 5 rounds is par for local, not broken
  assert.equal(gradeConvergence({ rounds: 4, tier: 'Yellow', floor: 4 }), 1);  // raised floor → 4 rounds is "expected"
});

test('buildRecord: convergenceSpan flows through (slow-but-correct local hunt not zeroed)', () => {
  const r = buildRecord({ huntId: 'h', routing: { a: 'x' }, tier: 'Yellow', rounds: 5, caught: 2, convergenceSpan: 10 });
  assert.ok(r.dimensions.convergence.score > 0.5);
  assert.ok(r.overall > 0.7);   // correct + caught + slow ≠ broken
});

test('buildRecord: clean run → computed dims, geometric overall, provisional, valid', () => {
  const r = buildRecord({ huntId: 'h', tier: 'Yellow', routing: { shepherd: 'work-horse' }, rounds: 1, caught: 2, slipped: 0 });
  assert.equal(r.schema_version, 2);
  assert.equal(r.dimensions.convergence.score, 1.0);   // rounds 1 ≤ Yellow floor 1
  assert.equal(r.dimensions.catch_rate.score, 1.0);
  assert.equal(r.dimensions.convergence.source, 'computed');
  assert.equal(r.provisional, true);
  assert.equal(validate(r).ok, true);
});

test('buildRecord: rework + a slip differentiate (the anti-5/5/5 gradient)', () => {
  const r = buildRecord({ huntId: 'h', tier: 'Yellow', routing: { a: 'x' }, rounds: 3, caught: 1, slipped: 1 });
  assert.equal(r.dimensions.convergence.score, 0.5);   // 1 - (3-1)/4
  assert.equal(r.dimensions.catch_rate.score, 0.5);    // 1 of 2 caught
  assert.ok(r.overall < 1);                            // no longer a flat 5
});

test('buildRecord: compliance fail vetoes — overall null + blocked, never a stamp', () => {
  const r = buildRecord({ huntId: 'h', routing: { a: 'x' }, complianceStatus: 'fail' });
  assert.equal(r.overall, null);
  assert.equal(r.blocked_reason, 'compliance_veto');
});

test('buildRecord: revert forces correctness 0 → overall 0', () => {
  const r = buildRecord({ huntId: 'h', routing: { a: 'x' }, reverted: true, caught: 1 });
  assert.equal(r.dimensions.correctness.score, 0);
  assert.equal(r.overall, 0);
});

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
