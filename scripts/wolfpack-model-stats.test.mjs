#!/usr/bin/env node
// scripts/wolfpack-model-stats.test.mjs — unit tests for the [06] AC3 meter.
// Run: node --test scripts/wolfpack-model-stats.test.mjs
//
// PROVIDER-NEUTRAL fixtures: model_assignments tokens use routing's family vocabulary
// (judgment / work-horse / reviewer-a / reviewer-b). providerFamily() in
// wolfpack-routing.mjs resolves them by substring, and the meter only ever stores the
// resolved family name. A real project maps these onto concrete models via
// wolfpack-config.md → "Model Pool"; the tokens here carry a ":variant" suffix in a few
// fixtures to prove the substring resolution still works.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeHunt, summarizeFingerprints, aggregateModelStats, spendFor,
  scoreOf, mergeHuntSources,
} from './wolfpack-model-stats.mjs'
import { recommendModels } from './wolfpack-routing.mjs'

test('normalizeHunt: old-format card (model_assignments + execution_scores, no ledger)', () => {
  const h = normalizeHunt({
    predicted_dimensions: { frontend_complexity: 1 },
    model_assignments: { shepherd: 'work-horse:fast', bloodhound: 'reviewer-b:medium', watchdog: 'reviewer-a:flash-3.5' },
    execution_scores: { code_quality: 5, plan_adherence: 4 },
    certifier_verdict: 'pass',
  })
  assert.equal(h.domain, 'backend')
  assert.equal(h.models.shepherd, 'work-horse')
  assert.equal(h.models.bloodhound, 'reviewer-b')
  assert.equal(h.models.watchdog, 'reviewer-a')
  assert.equal(h.quality, 4.5)
  assert.equal(h.ledger, null)   // no review_fingerprints
  assert.equal(h.byModel, null)  // no timing
  assert.equal(h.miss, null)
})

test('scoreOf tolerates flat number, {score} object, and absent', () => {
  assert.equal(scoreOf(5), 5)
  assert.equal(scoreOf({ score: 4, rationale: 'x', tags: [] }), 4)
  assert.equal(scoreOf(null), null)
  assert.equal(scoreOf({ nope: 1 }), null)
})

test('normalizeHunt: modern execution_scores ({score} objects) yield real quality (#2)', () => {
  const h = normalizeHunt({
    predicted_dimensions: { frontend_complexity: 1 },
    model_assignments: { bloodhound: 'reviewer-a' },
    execution_scores: {
      code_quality: { score: 4, rationale: 'x', tags: [] },
      plan_adherence: { score: 5, rationale: 'y', tags: [] },
    },
  })
  assert.equal(h.quality, 4.5)   // NOT null — objects unwrapped via scoreOf
})

test('mergeHuntSources: metadata supplies review_fingerprints, pedigree wins on scores', () => {
  const meta = { review_fingerprints: { bloodhound: [{ round: 1, raised: 2, grounded: 2, dropped: 0 }] },
    predicted_dimensions: { frontend_complexity: 1 }, execution_scores: { code_quality: 3 } }
  const ped = { execution_scores: { code_quality: { score: 5 } }, certifier_verdict: 'pass' }
  const merged = mergeHuntSources(meta, ped)
  assert.ok(merged.review_fingerprints.bloodhound)          // from metadata
  assert.equal(scoreOf(merged.execution_scores.code_quality), 5)  // pedigree wins
  const h = normalizeHunt(merged)
  assert.ok(h.ledger.bloodhound)                            // ledger survives the merge
})

test('normalizeHunt falls back to shepherd_model when model_assignments absent', () => {
  const h = normalizeHunt({ predicted_dimensions: {}, shepherd_model: 'judgment:high', execution_scores: {} })
  assert.equal(h.models.shepherd, 'judgment')
  assert.equal(h.quality, null)
})

test('summarizeFingerprints tallies per-role raised/grounded/dropped (role-keyed schema)', () => {
  const led = summarizeFingerprints({
    bloodhound: [
      { round: 1, raised: 4, grounded: 3, dropped: 1, findings: [] },
      { round: 2, raised: 2, grounded: 2, dropped: 0, findings: [] },
    ],
    pointer: [{ round: 1, raised: 2, grounded: 2, dropped: 0, findings: [] }],
  })
  assert.equal(led.bloodhound.raised, 6)
  assert.equal(led.bloodhound.grounded, 5)
  assert.equal(led.bloodhound.dropped, 1)
  assert.equal(led.pointer.raised, 2)
})

test('summarizeFingerprints returns null on empty/garbage + legacy array-of-arrays', () => {
  assert.equal(summarizeFingerprints(null), null)
  assert.equal(summarizeFingerprints({}), null)
  assert.equal(summarizeFingerprints([]), null)               // legacy role-blind → no signal
  assert.equal(summarizeFingerprints([[{ fp: 'x' }]]), null)  // legacy array-of-arrays → no signal
})

test('spendFor tolerates {role:{model}} and {model} shapes', () => {
  assert.equal(spendFor({ bloodhound: { 'reviewer-b': 120 } }, 'bloodhound', 'reviewer-b'), 120)
  assert.equal(spendFor({ 'reviewer-b': 90 }, 'bloodhound', 'reviewer-b'), 90)
  assert.equal(spendFor(null, 'bloodhound', 'reviewer-b'), null)
  assert.equal(spendFor({ bloodhound: { 'reviewer-a': 5 } }, 'bloodhound', 'reviewer-b'), null)
})

test('aggregate: counts runs + averages quality, nulls absent metrics (honest thinness)', () => {
  const hunts = [
    normalizeHunt({ predicted_dimensions: { frontend_complexity: 1 },
      model_assignments: { bloodhound: 'reviewer-b' }, execution_scores: { code_quality: 4, plan_adherence: 4 } }),
    normalizeHunt({ predicted_dimensions: { frontend_complexity: 1 },
      model_assignments: { bloodhound: 'reviewer-b' }, execution_scores: { code_quality: 5, plan_adherence: 5 } }),
  ]
  const { model_stats, provisional } = aggregateModelStats(hunts)
  const c = model_stats['reviewer-b'].bloodhound.backend
  assert.equal(c.runs, 2)
  assert.equal(c.quality, 4.5)
  assert.equal(c.signal, null)     // no ledger → null, not fabricated 0
  assert.equal(c.spend_s, null)
  assert.equal(c.miss_rate, null)
  // runs<MIN_RUNS AND no signal → provisional
  assert.ok(provisional.some(p => /reviewer-b\/bloodhound\/backend/.test(p)))
})

test('aggregate: ledger present → signal/noise computed (grounded/raised)', () => {
  const mk = () => normalizeHunt({
    predicted_dimensions: { frontend_complexity: 1 },
    model_assignments: { bloodhound: 'reviewer-a' },
    review_fingerprints: { bloodhound: [{ round: 1, raised: 4, grounded: 4, dropped: 0, findings: [] }] },
    timing: { by_model: { bloodhound: { 'reviewer-a': 60 } } },
    execution_scores: { code_quality: 5, plan_adherence: 5 },
    smoke_escape: false,
  })
  const { model_stats } = aggregateModelStats([mk(), mk(), mk()])
  const c = model_stats['reviewer-a'].bloodhound.backend
  assert.equal(c.runs, 3)
  assert.equal(c.signal, 1)        // 12 grounded / 12 raised
  assert.equal(c.noise, 0)
  assert.equal(c.spend_s, 180)
  assert.equal(c.miss_rate, 0)
})

test('aggregate: noise from dropped findings; miss_rate over runs WITH smoke data only (#3)', () => {
  // 2 runs with smoke data (1 escape), 1 run with NO smoke data → miss_rate = 1/2, not 1/3
  const withSmoke = (esc) => normalizeHunt({
    predicted_dimensions: { frontend_complexity: 1 },
    model_assignments: { bloodhound: 'reviewer-b' },
    review_fingerprints: { bloodhound: [{ round: 1, raised: 4, grounded: 3, dropped: 1, findings: [] }] },
    smoke_escape: esc,
  })
  const noSmoke = normalizeHunt({
    predicted_dimensions: { frontend_complexity: 1 },
    model_assignments: { bloodhound: 'reviewer-b' },
    review_fingerprints: { bloodhound: [{ round: 1, raised: 4, grounded: 3, dropped: 1, findings: [] }] },
  })
  const { model_stats } = aggregateModelStats([withSmoke(true), withSmoke(false), noSmoke])
  const c = model_stats['reviewer-b'].bloodhound.backend
  assert.equal(c.runs, 3)
  assert.equal(c.noise, 0.25)             // 3 dropped / 12 raised
  assert.equal(c.miss_rate, 0.5)          // 1 escape / 2 runs-with-smoke (NOT 1/3)
})

test('end-to-end: aggregate feeds the router and confirms the reviewer by data (exploit)', () => {
  // The backend default reviewer is reviewer-a. A trusted (≥MIN_RUNS) ledger with real
  // signal on reviewer-a/bloodhound/backend should flip the recommendation from a thin-data
  // EXPLORE to a data-confirmed EXPLOIT. reviewer-b accrues runs but stays provisional and
  // is stripped from autonomous routing, so it never becomes the pick.
  const good = (n) => Array.from({ length: n }, () => normalizeHunt({
    predicted_dimensions: { frontend_complexity: 1 },
    model_assignments: { bloodhound: 'reviewer-a' },
    review_fingerprints: { bloodhound: [{ round: 1, raised: 5, grounded: 5, dropped: 0, findings: [] }] },
  }))
  const meh = (n) => Array.from({ length: n }, () => normalizeHunt({
    predicted_dimensions: { frontend_complexity: 1 },
    model_assignments: { bloodhound: 'reviewer-b' },
    review_fingerprints: { bloodhound: [{ round: 1, raised: 5, grounded: 2, dropped: 3, findings: [] }] },
  }))
  const { model_stats } = aggregateModelStats([...good(3), ...meh(3)])
  const r = recommendModels({ tier: 'Yellow', dimensions: { frontend_complexity: 1 }, stats: model_stats })
  assert.equal(r.assignments.bloodhound.model, 'reviewer-a')
  assert.equal(r.assignments.bloodhound.source, 'exploit')   // data-confirmed, not exploring
})

test('provisional cell with runs≥MIN_RUNS but null signal is NOT exploited by-data', () => {
  // Pile runs WITHOUT a ledger onto reviewer-b (the non-default competitor). It clears
  // MIN_RUNS but has null signal, so bestReviewerByData must NOT promote it over the
  // backend default reviewer-a — and with no trusted cell on reviewer-a either, the
  // recommendation stays the thin-data EXPLORE path on the default, not a by-data flip.
  const noLedger = (n) => Array.from({ length: n }, () => normalizeHunt({
    predicted_dimensions: { frontend_complexity: 1 },
    model_assignments: { bloodhound: 'reviewer-b' },
    execution_scores: { code_quality: 5, plan_adherence: 5 },
  }))
  const { model_stats } = aggregateModelStats(noLedger(5))
  const r = recommendModels({ tier: 'Yellow', dimensions: { frontend_complexity: 1 }, stats: model_stats })
  assert.equal(r.assignments.bloodhound.model, 'reviewer-a')
  assert.equal(r.assignments.bloodhound.source, 'explore')   // not flipped to the provisional reviewer-b cell
})

// ─── pedigree-v2 reward → bandit (closing the loop) ──────────────
test('normalizeHunt: pedigree-v2 reward (overall) + routing → per-role models and reward', () => {
  const h = normalizeHunt({
    schema_version: 2,
    predicted_dimensions: { frontend_complexity: 0 },
    routing: { shepherd: 'work-horse', pointer: 'reviewer-a' },
    overall: 0.84,
  })
  assert.equal(h.models.shepherd, 'work-horse')
  assert.equal(h.models.pointer, 'reviewer-a')
  assert.equal(h.reward, 0.84)
  assert.equal(h.blocked, false)
})

test('normalizeHunt: a compliance veto (overall null + compliance fail) is blocked, reward null', () => {
  const h = normalizeHunt({
    schema_version: 2,
    predicted_dimensions: { domain_sensitivity: 4 },
    routing: { shepherd: 'judgment' },
    overall: null,
    dimensions: { compliance: { status: 'fail' } },
  })
  assert.equal(h.reward, null)
  assert.equal(h.blocked, true)
})

test('aggregate: pedigree-v2 reward → reward_mean / reward_n / blocked_n (veto excluded from mean)', () => {
  const mk = (overall) => normalizeHunt({
    schema_version: 2, predicted_dimensions: { frontend_complexity: 0 },
    routing: { shepherd: 'work-horse' }, overall,
  })
  const veto = normalizeHunt({
    schema_version: 2, predicted_dimensions: { frontend_complexity: 0 },
    routing: { shepherd: 'work-horse' }, overall: null, dimensions: { compliance: { status: 'fail' } },
  })
  const { model_stats } = aggregateModelStats([mk(0.9), mk(0.7), veto])
  const c = model_stats['work-horse'].shepherd.backend
  assert.equal(c.runs, 3)            // total observations
  assert.equal(c.reward_n, 2)        // scored observations
  assert.equal(c.reward_mean, 0.8)   // (0.9 + 0.7) / 2 — veto NOT averaged in
  assert.equal(c.blocked_n, 1)
})

test('end-to-end: v2 reward stats drive the bandit via the real aggregation path', () => {
  const mk = (model, overall, n) => Array.from({ length: n }, () => normalizeHunt({
    schema_version: 2, predicted_dimensions: { frontend_complexity: 0, domain_sensitivity: 0 },
    routing: { shepherd: model }, overall,
  }))
  const { model_stats } = aggregateModelStats([...mk('work-horse', 0.92, 5), ...mk('judgment', 0.6, 5)])
  const r = recommendModels({ tier: 'Yellow', dimensions: { frontend_complexity: 0, domain_sensitivity: 0 }, stats: model_stats })
  assert.equal(r.assignments.shepherd.model, 'work-horse')
  assert.match(r.assignments.shepherd.rationale, /bandit/)
})
