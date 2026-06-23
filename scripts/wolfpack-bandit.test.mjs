// Tests for wolfpack-bandit.mjs — run: node --test scripts/wolfpack-bandit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ucbSelect } from './wolfpack-bandit.mjs';
import { recommendModels } from './wolfpack-routing.mjs';

test('floor: explores the least-sampled under-sampled cell', () => {
  const r = ucbSelect([
    { model: 'work-horse', runs: 5, rewardMean: 0.9 },
    { model: 'judgment', runs: 1, rewardMean: 0.95 },
  ], { minRuns: 3 });
  assert.equal(r.model, 'judgment');
  assert.equal(r.source, 'floor');
});

test('exploit: all sampled, low uncertainty → highest mean wins', () => {
  const r = ucbSelect([
    { model: 'work-horse', runs: 100, rewardMean: 0.9 },
    { model: 'judgment', runs: 100, rewardMean: 0.7 },
  ], { minRuns: 3 });
  assert.equal(r.model, 'work-horse');
  assert.equal(r.source, 'exploit');
});

test('explore: a high-uncertainty (low-n) cell can overtake a slightly-better high-n mean', () => {
  const r = ucbSelect([
    { model: 'work-horse', runs: 500, rewardMean: 0.85 },
    { model: 'judgment', runs: 4, rewardMean: 0.80 },
  ], { minRuns: 3, C: Math.SQRT2 });
  assert.equal(r.model, 'judgment');
  assert.equal(r.source, 'explore');
});

test('exploit-only: never explores; best trusted mean, else null', () => {
  const r = ucbSelect([
    { model: 'reviewer-a', runs: 10, rewardMean: 0.8 },
    { model: 'reviewer-b', runs: 4, rewardMean: 0.9 },
  ], { exploreAllowed: false, minRuns: 3 });
  assert.equal(r.model, 'reviewer-b');
  assert.equal(r.source, 'exploit');
  assert.equal(ucbSelect([{ model: 'reviewer-a', runs: 1, rewardMean: 0.9 }], { exploreAllowed: false, minRuns: 3 }), null);
});

test('deterministic: same input → same output; ties break by order', () => {
  const cands = [{ model: 'a', runs: 10, rewardMean: 0.8 }, { model: 'b', runs: 10, rewardMean: 0.8 }];
  assert.deepEqual(ucbSelect(cands, { minRuns: 3 }), ucbSelect(cands, { minRuns: 3 }));
  assert.equal(ucbSelect(cands, { minRuns: 3 }).model, 'a');
});

test('empty candidates → null', () => {
  assert.equal(ucbSelect([], {}), null);
});

// ─── Integration with the router ─────────────────────────────────
test('router: no reward stats → legacy path (bandit dormant), no constraint violations', () => {
  const rec = recommendModels({ tier: 'Yellow', dimensions: { frontend_complexity: 0 }, stats: {} });
  assert.ok(['default', 'explore', 'exploit'].includes(rec.assignments.shepherd.source));
});

test('router: reward stats on a cheap tier → bandit drives the Shepherd pick', () => {
  const stats = {
    'work-horse': { shepherd: { backend: { runs: 50, reward_mean: 0.92 } } },
    'judgment':   { shepherd: { backend: { runs: 50, reward_mean: 0.60 } } },
  };
  const rec = recommendModels({ tier: 'Yellow', dimensions: { frontend_complexity: 0, domain_sensitivity: 0 }, stats });
  assert.equal(rec.assignments.shepherd.model, 'work-horse');
  assert.match(rec.assignments.shepherd.rationale, /bandit/);
});

test('router: heavy/compliance tier ignores the implementer bandit (forces judgment)', () => {
  const stats = {
    'work-horse': { shepherd: { backend: { runs: 50, reward_mean: 0.99 } } }, // tempting
    'judgment':   { shepherd: { backend: { runs: 50, reward_mean: 0.50 } } },
  };
  const rec = recommendModels({ tier: 'Red', dimensions: { domain_sensitivity: 4 }, stats });
  assert.equal(rec.assignments.shepherd.model, 'judgment');
});
