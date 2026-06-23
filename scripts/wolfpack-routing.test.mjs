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
