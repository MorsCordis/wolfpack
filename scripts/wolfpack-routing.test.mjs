#!/usr/bin/env node
// scripts/wolfpack-routing.test.mjs — unit tests for the [06] router.
// Run: node --test scripts/wolfpack-routing.test.mjs
//
// PROVIDER-NEUTRAL fixtures: families are referenced by their pipeline ROLE, not by
// brand — 'judgment'/'work-horse' are the implementer families (may not review),
// 'reviewer-a'/'reviewer-b' are the reviewer families. A real project maps these to
// concrete models via wolfpack-config.md → "Model Pool".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recommendModels, tierDefaults, deriveDomain, isCompliance, exploreEligible,
  bestReviewerByData, providerFamily, assertConstraints, MIN_RUNS, DEFAULT_POOL,
  reviewerChain, reviewerOrder, pinsFromMeta,
} from './wolfpack-routing.mjs'

const dims = (o) => ({ file_spread: 1, logic_complexity: 1, domain_sensitivity: 1,
  multi_tenancy_risk: 1, test_authoring: 1, api_surface: 1, frontend_complexity: 1, ...o })

test('deriveDomain: frontend_complexity ≥3 → frontend, else backend', () => {
  assert.equal(deriveDomain(dims({ frontend_complexity: 4 })), 'frontend')
  assert.equal(deriveDomain(dims({ frontend_complexity: 3 })), 'frontend')
  assert.equal(deriveDomain(dims({ frontend_complexity: 2 })), 'backend')
  assert.equal(deriveDomain({}), 'backend')
})

test('isCompliance: domain_sensitivity ≥3', () => {
  assert.equal(isCompliance(dims({ domain_sensitivity: 3 })), true)
  assert.equal(isCompliance(dims({ domain_sensitivity: 2 })), false)
})

test('exploreEligible: Green/Blue/Yellow non-compliance only', () => {
  assert.equal(exploreEligible('Yellow', dims()), true)
  assert.equal(exploreEligible('Green', dims()), true)
  assert.equal(exploreEligible('Orange', dims()), false)
  assert.equal(exploreEligible('Red', dims()), false)
  assert.equal(exploreEligible('Yellow', dims({ domain_sensitivity: 4 })), false) // compliance
})

test('tierDefaults: backend Yellow → work-horse shepherd, reviewer-a review, reviewer-a thin verify', () => {
  const d = tierDefaults('Yellow', dims({ frontend_complexity: 1 }))
  assert.equal(d.shepherd, 'work-horse')
  // Domain no longer splits the reviewer; backend reviewer is reviewer-a (the
  // autonomous reviewer; reviewer-b is stripped from the pipeline).
  assert.equal(d.reviewer, 'reviewer-a')
  assert.equal(d.watchdog, 'reviewer-a')
  assert.equal(d.watchdogMode, 'thin')
})

test('tierDefaults: frontend → reviewer-a review + thorough verify (AC5)', () => {
  const d = tierDefaults('Yellow', dims({ frontend_complexity: 4 }))
  assert.equal(d.reviewer, 'reviewer-a')
  assert.equal(d.watchdogMode, 'thorough')
})

test('tierDefaults: Red/compliance → judgment shepherd (judgment)', () => {
  assert.equal(tierDefaults('Red', dims()).shepherd, 'judgment')
  assert.equal(tierDefaults('Yellow', dims({ domain_sensitivity: 4 })).shepherd, 'judgment')
  assert.equal(tierDefaults('Orange', dims()).shepherd, 'judgment')
})

test('recommend: Alpha always judgment family, pin ignored', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims(), pins: { alpha: 'reviewer-b' } })
  assert.equal(r.assignments.alpha.model, 'judgment')
  assert.ok(r.warnings.some(w => /alpha pin/.test(w)))
})

test('recommend: reviewers never an implementer family (pin coerced + warned)', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims(), pins: { bloodhound: 'judgment' } })
  assert.ok(!['judgment', 'work-horse'].includes(r.assignments.bloodhound.model))
  assert.ok(r.warnings.some(w => /reviewer family/.test(w)))
})

test('recommend: backend Yellow default lineup', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims({ frontend_complexity: 1 }) })
  const a = r.assignments
  assert.equal(a.shepherd.model, 'work-horse')
  // backend reviewer is reviewer-a (reviewer-b stripped from autonomous routing)
  assert.equal(a.bloodhound.model, 'reviewer-a')
  assert.equal(a.watchdog.model, 'reviewer-a')
  assert.equal(a.watchdog.mode, 'thin')
  assert.equal(a.tracker.model, 'judgment')
  assert.equal(r.domain, 'backend')
})

test('recommend: cross-family — reviewer-b Shepherd forces non-reviewer-b Pointer/Watchdog', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims({ frontend_complexity: 1 }), pins: { shepherd: 'reviewer-b' } })
  const a = r.assignments
  assert.equal(a.shepherd.model, 'reviewer-b')
  assert.notEqual(providerFamily(a.pointer.model), 'reviewer-b')
  assert.notEqual(providerFamily(a.watchdog.model), 'reviewer-b')
  // and still a reviewer family (not an implementer family)
  assert.ok(!['judgment', 'work-horse'].includes(a.pointer.model))
})

test('recommend: reviewer-a Shepherd forces reviewer-b reviewers (cross-family, reviewer family)', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims({ frontend_complexity: 4 }), pins: { shepherd: 'reviewer-a' } })
  const a = r.assignments
  assert.equal(providerFamily(a.shepherd.model), 'reviewer-a')
  assert.equal(a.pointer.model, 'reviewer-b')
  assert.equal(a.watchdog.model, 'reviewer-b')
})

test('recommend: Red exploits (no explore tag) even with thin data', () => {
  const r = recommendModels({ tier: 'Red', dimensions: dims({ domain_sensitivity: 4 }) })
  assert.equal(r.explore, false)
  assert.equal(r.assignments.shepherd.model, 'judgment')
  assert.notEqual(r.assignments.shepherd.source, 'explore')
})

test('recommend: explore-eligible tier with thin data tags explore', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims() })
  assert.equal(r.explore, true)
  assert.equal(r.assignments.shepherd.source, 'explore')
})

test('recommend: trusted stats confirm a reviewer by-data (exploit)', () => {
  const stats = {
    'reviewer-a': { bloodhound: { backend: { runs: 5, signal: 0.9, noise: 0.1, miss_rate: 0.0 } } },
    'reviewer-b': { bloodhound: { backend: { runs: 5, signal: 0.4, noise: 0.3, miss_rate: 0.2 } } },
  }
  const r = recommendModels({ tier: 'Yellow', dimensions: dims({ frontend_complexity: 1 }), stats })
  // backend default reviewer is reviewer-a; trusted data confirms it (exploit, not explore)
  assert.equal(r.assignments.bloodhound.model, 'reviewer-a')
  assert.equal(r.assignments.bloodhound.source, 'exploit')
})

test('bestReviewerByData ignores provisional (under MIN_RUNS) cells', () => {
  const stats = { 'reviewer-a': { bloodhound: { backend: { runs: MIN_RUNS - 1, signal: 1, noise: 0, miss_rate: 0 } } } }
  assert.equal(bestReviewerByData(stats, 'bloodhound', 'backend'), null)
})

test('assertConstraints throws on an implementer-family reviewer', () => {
  const A = {
    alpha: { model: 'judgment' }, shepherd: { model: 'work-horse' },
    bloodhound: { model: 'judgment' }, pointer: { model: 'reviewer-a' },
    watchdog: { model: 'reviewer-b' }, tracker: { model: 'judgment' },
  }
  assert.throws(() => assertConstraints(A, []), /reviewers must be a reviewer family/)
})

test('assertConstraints throws when Pointer shares Shepherd family', () => {
  const A = {
    alpha: { model: 'judgment' }, shepherd: { model: 'reviewer-b' },
    bloodhound: { model: 'reviewer-a' }, pointer: { model: 'reviewer-b' },
    watchdog: { model: 'reviewer-a' }, tracker: { model: 'judgment' },
  }
  assert.throws(() => assertConstraints(A, []), /Pointer shares Shepherd family/)
})

test('no tier → fail-closed Red + warning', () => {
  const r = recommendModels({ dimensions: dims() })
  assert.equal(r.explore, false)
  assert.ok(r.warnings.some(w => /defaulting to Red/.test(w)))
})

test('every produced assignment satisfies constraints (fuzz over tiers/domains)', () => {
  for (const tier of ['Green', 'Blue', 'Yellow', 'Orange', 'Red']) {
    for (const fe of [1, 4]) {
      for (const ds of [1, 4]) {
        for (const shep of [null, 'reviewer-b', 'reviewer-a', 'work-horse', 'judgment']) {
          const r = recommendModels({ tier, dimensions: dims({ frontend_complexity: fe, domain_sensitivity: ds }),
            pins: shep ? { shepherd: shep } : {} })
          // recommendModels calls assertConstraints internally; reaching here = no throw
          assert.equal(providerFamily(r.assignments.alpha.model), 'judgment')
          for (const role of ['bloodhound', 'pointer', 'watchdog']) {
            assert.ok(['reviewer-a', 'reviewer-b'].includes(r.assignments[role].model), `${tier}/${fe}/${ds}/${shep} ${role}=${r.assignments[role].model}`)
          }
        }
      }
    }
  }
})

// ─── Optional reviewer-c / coder-alt slots (the examiner CHAIN rule) ──────────
// POOL3 adds a third reviewer family that can also implement (coder-alt) — the shape
// of e.g. GLM-via-Vibe in a concrete pool. DEFAULT_POOL omits both slots, so every
// test above proves the two-reviewer behaviour is unchanged.
const POOL3 = { ...DEFAULT_POOL, reviewerC: 'reviewer-c', coderAlt: 'reviewer-c' }

test('reviewerOrder/reviewerChain: a → c → b, env filter, writer exclusion, prefer', () => {
  assert.deepEqual(reviewerOrder(DEFAULT_POOL), ['reviewer-a', 'reviewer-b'])
  assert.deepEqual(reviewerOrder(POOL3), ['reviewer-a', 'reviewer-c', 'reviewer-b'])
  assert.deepEqual(reviewerChain({ pool: POOL3 }), ['reviewer-a', 'reviewer-c', 'reviewer-b'])
  assert.deepEqual(reviewerChain({ pool: POOL3, enabled: new Set(['reviewer-a', 'reviewer-c']) }), ['reviewer-a', 'reviewer-c'])
  assert.deepEqual(reviewerChain({ pool: POOL3, exclude: ['reviewer-c:5.3'] }), ['reviewer-a', 'reviewer-b'])
  assert.deepEqual(reviewerChain({ pool: POOL3, prefer: 'reviewer-c' }), ['reviewer-c', 'reviewer-a', 'reviewer-b'])
  assert.deepEqual(reviewerChain({ pool: POOL3, exclude: ['reviewer-c'], prefer: 'reviewer-c' }), ['reviewer-a', 'reviewer-b'])
  assert.deepEqual(reviewerChain({ pool: POOL3, exclude: ['reviewer-a'], enabled: new Set(['reviewer-a']) }), [])
})

test('providerFamily: reviewer-c resolves before reviewer-b', () => {
  const P = { ...DEFAULT_POOL, reviewerB: 'mistral', reviewerC: 'glm', coderAlt: 'glm' }
  assert.equal(providerFamily('glm:5.3', P), 'glm')
  assert.equal(providerFamily('mistral:zai-glm-5-3', P), 'glm')
  assert.equal(providerFamily('mistral:medium', P), 'mistral')
})

test('recommend: coder-alt Shepherd on Yellow → fallback work-horse; its family leaves the code-review chain', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims(), pins: { shepherd: 'reviewer-c' }, pool: POOL3 })
  const a = r.assignments
  assert.equal(a.shepherd.model, 'reviewer-c')
  assert.equal(a.shepherd.fallback, 'work-horse')
  for (const role of ['pointer', 'watchdog']) {
    assert.notEqual(a[role].model, 'reviewer-c')
    assert.ok(!a[role].chain.includes('reviewer-c'), role)
  }
  assert.ok(a.bloodhound.chain.includes('reviewer-c'))   // plan written by judgment, c may review it
})

test('recommend: coder-alt pin ignored on heavy/compliance tiers (judgment forced)', () => {
  for (const [tier, d] of [['Red', dims()], ['Orange', dims()], ['Yellow', dims({ domain_sensitivity: 4 })]]) {
    const r = recommendModels({ tier, dimensions: d, pins: { shepherd: 'reviewer-c' }, pool: POOL3 })
    assert.equal(r.assignments.shepherd.model, 'judgment', tier)
    assert.ok(r.warnings.some(w => /heavy\/compliance/.test(w)), tier)
  }
})

test('recommend: coder-alt pin ignored when its family is disabled', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims(), pins: { shepherd: 'reviewer-c' }, pool: POOL3,
    enabled: new Set(['reviewer-a', 'reviewer-b']) })
  assert.equal(r.assignments.shepherd.model, 'work-horse')
})

test('recommend: same-family reviewer pin against a coder-alt Shepherd is refused', () => {
  const r = recommendModels({ tier: 'Yellow', dimensions: dims(), pool: POOL3,
    pins: { shepherd: 'reviewer-c', pointer: 'reviewer-c', watchdog: 'reviewer-c' } })
  assert.notEqual(r.assignments.pointer.model, 'reviewer-c')
  assert.notEqual(r.assignments.watchdog.model, 'reviewer-c')
  assert.ok(r.warnings.some(w => /cross-family rule/.test(w)))
})

test('assertConstraints: a Shepherd-family chain link throws', () => {
  const A = {
    alpha: { model: 'judgment' }, shepherd: { model: 'reviewer-c', fallback: 'work-horse' },
    bloodhound: { model: 'reviewer-a', chain: ['reviewer-a'] },
    pointer: { model: 'reviewer-a', chain: ['reviewer-a', 'reviewer-c'] },
    watchdog: { model: 'reviewer-a', chain: ['reviewer-a'] }, tracker: { model: 'judgment' },
  }
  assert.throws(() => assertConstraints(A, [], POOL3), /pointer chain contains the Shepherd's family/)
})

test('fuzz (POOL3): no reviewer or chain link ever shares the Shepherd family', () => {
  for (const tier of ['Green', 'Blue', 'Yellow', 'Orange', 'Red']) {
    for (const ds of [1, 4]) {
      for (const shep of [null, 'reviewer-c', 'work-horse', 'judgment']) {
        const r = recommendModels({ tier, dimensions: dims({ domain_sensitivity: ds }), pool: POOL3,
          pins: shep ? { shepherd: shep } : {} })
        const a = r.assignments
        const shepFams = [a.shepherd.model, a.shepherd.fallback].filter(Boolean)
        for (const role of ['pointer', 'watchdog']) {
          for (const link of a[role].chain) assert.ok(!shepFams.includes(link), `${tier}/${ds}/${shep} ${role} ${link}`)
        }
      }
    }
  }
})

test('pinsFromMeta: architect_recommended is ADVISORY; model_assignments.shepherd / model_pins bind', () => {
  assert.deepEqual(pinsFromMeta({ models: { architect_recommended: 'reviewer-c' } }), {})
  assert.deepEqual(pinsFromMeta({ models: { architect_recommended: 'reviewer-c' }, model_assignments: { shepherd: 'judgment' } }), { shepherd: 'judgment' })
  assert.deepEqual(pinsFromMeta({ model_assignments: { shepherd: 'reviewer-c' } }), { shepherd: 'reviewer-c' })
  assert.deepEqual(pinsFromMeta({ model_assignments: { shepherd: 'reviewer-c' }, model_pins: { shepherd: 'judgment' } }), { shepherd: 'judgment' })
})

// ─── usage-limit-gate (AC6): usage offload — coder-alt Shepherd on EVERY tier ────
import { complianceCriticalFromMeta } from './wolfpack-routing.mjs'

const noCoderAltReviewer = (a) => {
  for (const role of ['pointer', 'watchdog']) {
    assert.notEqual(a[role].model, 'reviewer-c', role)
    assert.equal(a[role].chain.includes('reviewer-c'), false, `${role} chain: ${a[role].chain}`)
  }
}

test('offload: Red ⇒ coder-alt Shepherd (fallback judgment), claudeFinalReview, no coder-alt reviewer', () => {
  const r = recommendModels({ tier: 'Red', dimensions: dims(), pool: POOL3, offload: true })
  const a = r.assignments
  assert.equal(a.shepherd.model, 'reviewer-c')
  assert.equal(a.shepherd.fallback, 'judgment')
  assert.equal(a.shepherd.source, 'offload')
  assert.match(a.shepherd.rationale, /usage offload/)
  assert.equal(r.claudeFinalReview, true)
  noCoderAltReviewer(a)
  assert.doesNotThrow(() => assertConstraints(a, [], POOL3))
})

test('offload: Orange ⇒ coder-alt; Orange compliance-critical ⇒ claudeFinalReview; plain Orange ⇒ false', () => {
  const o = recommendModels({ tier: 'Orange', dimensions: dims(), pool: POOL3, offload: true })
  assert.equal(o.assignments.shepherd.model, 'reviewer-c')
  assert.equal(o.claudeFinalReview, false)
  assert.equal(recommendModels({ tier: 'Orange', dimensions: dims(), pool: POOL3, offload: true, complianceCritical: true }).claudeFinalReview, true)
  const comp = recommendModels({ tier: 'Yellow', dimensions: dims({ domain_sensitivity: 4 }), pool: POOL3, offload: true })
  assert.equal(comp.assignments.shepherd.model, 'reviewer-c')
  assert.equal(comp.claudeFinalReview, true)
  noCoderAltReviewer(comp.assignments)
})

test('offload: no coder-alt in the pool (DEFAULT_POOL) or coder-alt disabled ⇒ unchanged routing + warning', () => {
  for (const [pool, enabled] of [[DEFAULT_POOL, null], [POOL3, new Set(['reviewer-a', 'reviewer-b'])]]) {
    for (const tier of ['Red', 'Yellow']) {
      const off = recommendModels({ tier, dimensions: dims(), pool, enabled, offload: true })
      const base = recommendModels({ tier, dimensions: dims(), pool, enabled })
      assert.deepEqual(off.assignments, base.assignments, tier)
      assert.ok(off.warnings.some(w => /usage offload requested but no enabled coder-alt/.test(w)), tier)
      assert.equal(off.claudeFinalReview, false)
    }
  }
})

test('offload regression: NO offload ⇒ deep-equal to the default output (Red / Orange / Yellow, both pools)', () => {
  for (const pool of [DEFAULT_POOL, POOL3]) {
    for (const tier of ['Red', 'Orange', 'Yellow']) {
      const a = recommendModels({ tier, dimensions: dims(), pool })
      assert.deepEqual(a, recommendModels({ tier, dimensions: dims(), pool, offload: false }))
      assert.equal(a.claudeFinalReview, false)
      assert.equal(a.assignments.shepherd.model === 'reviewer-c', false)
    }
  }
})

test('offload fuzz (POOL3): constraints hold and no reviewer shares the offloaded Shepherd family', () => {
  for (const tier of ['Green', 'Blue', 'Yellow', 'Orange', 'Red']) {
    for (const ds of [1, 4]) {
      const r = recommendModels({ tier, dimensions: dims({ domain_sensitivity: ds }), pool: POOL3, offload: true })
      assert.equal(r.assignments.shepherd.model, 'reviewer-c')
      noCoderAltReviewer(r.assignments)
      assert.doesNotThrow(() => assertConstraints(r.assignments, [], POOL3))
    }
  }
})

test('complianceCriticalFromMeta: spec flags or domain_sensitivity ≥ 3', () => {
  assert.equal(complianceCriticalFromMeta({}), false)
  assert.equal(complianceCriticalFromMeta({ spec: { compliance_critical: true } }), true)
  assert.equal(complianceCriticalFromMeta({ spec: { compliance_review_required: true } }), true)
  assert.equal(complianceCriticalFromMeta({ predicted_dimensions: { domain_sensitivity: 3 } }), true)
  assert.equal(complianceCriticalFromMeta({ predicted_dimensions: { domain_sensitivity: 2 } }), false)
})
