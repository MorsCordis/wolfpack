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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { loadConfig } from './wolfpack-config.mjs'

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

// ════════════════════════════════════════════════════════════════════════════
// wolfpack-self-hosting (AC3): the router reads the consuming project's Model Pool through
// scripts/wolfpack-config.mjs. With an EMPTY public pedigree every seat falls back to the
// config pool's order (tier defaults), never to data it does not have.
// ════════════════════════════════════════════════════════════════════════════

const HERE_CFG = dirname(fileURLToPath(import.meta.url))
const REAL_CONFIG = join(HERE_CFG, '..', 'wolfpack-config.md')
const ROUTER_CLI = join(HERE_CFG, 'wolfpack-routing.mjs')
const TIERS = ['Green', 'Blue', 'Yellow', 'Orange', 'Red']

test('AC3 (a): empty pedigree + the REAL config pool → every seat is the config-order tier default, per tier', () => {
  const { pool } = loadConfig(REAL_CONFIG)
  assert.ok(pool, 'the real config has a usable pool')
  const order = reviewerOrder(pool)
  assert.equal(order[0], 'glm', 'reviewer-a is the first examiner')
  for (const tier of TIERS) {
    const rec = recommendModels({ tier, dimensions: { frontend_complexity: 0 }, stats: {}, pool })
    const A = rec.assignments
    assert.equal(A.alpha.model, pool.judgment, `${tier} alpha`)
    const heavy = tier === 'Orange' || tier === 'Red'
    assert.equal(A.shepherd.model, heavy ? pool.judgment : pool.workHorse, `${tier} shepherd`)
    assert.equal(A.tracker.model, pool.judgment, `${tier} tracker`)
    assert.equal(A.bloodhound.model, order[0], `${tier} bloodhound`)
    const firstNotShepherd = order.find(f => f !== A.shepherd.model)
    assert.equal(A.pointer.model, firstNotShepherd, `${tier} pointer`)
    assert.equal(A.watchdog.model, firstNotShepherd, `${tier} watchdog`)
    for (const [role, a] of Object.entries(A)) {
      assert.ok(['fixed', 'default', 'explore'].includes(a.source), `${tier} ${role} source ${a.source}`)
      assert.notEqual(a.source, 'exploit', `${tier} ${role}: nothing to exploit in an empty pedigree`)
    }
    // concrete pool families, never the neutral DEFAULT_POOL role names
    for (const a of Object.values(A)) assert.ok(!Object.values(DEFAULT_POOL).includes(a.model), `${tier}: ${a.model}`)
  }
})

// A temp consuming root: <root>/wolfpack-config.md (optional) + <root>/.wolfpack/plans/x/metadata.json
function routerRoot({ config, tier = 'Orange' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wp-route-'))
  const planDir = join(root, '.wolfpack', 'plans', 'x')
  mkdirSync(planDir, { recursive: true })
  writeFileSync(join(planDir, 'metadata.json'), JSON.stringify({ tier, predicted_dimensions: { frontend_complexity: 0 } }))
  if (config !== undefined) writeFileSync(join(root, 'wolfpack-config.md'), config)
  return { root, planDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const routeCli = (args) => spawnSync(process.execPath, [ROUTER_CLI, ...args], { encoding: 'utf8' })
const REAL_TEXT = readFileSync(REAL_CONFIG, 'utf8')

test('AC3 (b): CLI with <root>/wolfpack-config.md → pool_source config + concrete families', () => {
  const fx = routerRoot({ config: REAL_TEXT })
  try {
    const r = routeCli([fx.planDir])
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /DEFAULT_POOL/)
    const j = JSON.parse(r.stdout)
    assert.equal(j.pool_source, 'config')
    assert.equal(j.config, resolve(fx.root, 'wolfpack-config.md'))
    assert.equal(j.assignments.alpha.model, 'claude')
    assert.equal(j.assignments.shepherd.model, 'claude')
    for (const r2 of ['bloodhound', 'pointer', 'watchdog']) assert.equal(j.assignments[r2].model, 'glm', r2)
    assert.deepEqual(j.assignments.pointer.chain, ['glm', 'mistral'])
    assert.ok(!(j.warnings || []).some(w => /DEFAULT_POOL/.test(w)))
  } finally { fx.cleanup() }
})

test('AC3 (c): CLI with NO config → pool_source default, stderr warning, the warning also in warnings (disclosed)', () => {
  const fx = routerRoot()
  try {
    const r = routeCli([fx.planDir])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /⚠ wolfpack-routing: no wolfpack-config\.md at .* — using the neutral DEFAULT_POOL/)
    const j = JSON.parse(r.stdout)
    assert.equal(j.pool_source, 'default')
    assert.equal('config' in j, false)
    assert.ok(j.warnings.some(w => /no wolfpack-config\.md at .*DEFAULT_POOL/.test(w)), JSON.stringify(j.warnings))
    assert.equal(j.assignments.alpha.model, DEFAULT_POOL.judgment)
  } finally { fx.cleanup() }
})

for (const role of ['judgment', 'reviewer-a']) {
  test(`AC3 (d): a config with no ${role} line → exit 2 "Model Pool unusable", no assignments JSON`, () => {
    const fx = routerRoot({ config: REAL_TEXT.replace(new RegExp(`^- ${role} .*\\n`, 'm'), '') })
    try {
      const r = routeCli([fx.planDir])
      assert.equal(r.status, 2)
      assert.match(r.stderr, new RegExp(`✗ wolfpack-routing: .*Model Pool unusable — Model Pool: missing required role\\(s\\) ${role}`))
      assert.equal(r.stdout, '')
    } finally { fx.cleanup() }
  })
}

test('AC3 (d): no Model Pool section at all → exit 2, while a non-pool missing key (Test command) does NOT block routing', () => {
  const noPool = REAL_TEXT.replace(/^## Model Pool[\s\S]*?(?=^## )/m, '')
  assert.doesNotMatch(noPool, /^## Model Pool/m)
  const fx = routerRoot({ config: noPool })
  try {
    const r = routeCli([fx.planDir])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /Model Pool unusable — Model Pool: section absent/)
  } finally { fx.cleanup() }
  const fx2 = routerRoot({ config: REAL_TEXT.replace(/^- \*\*Test command:\*\*.*\n/m, '') })
  try {
    const r = routeCli([fx2.planDir])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).pool_source, 'config')
  } finally { fx2.cleanup() }
})

test('AC3 (e): --config <path> outside the default location → used (pool_source config, config = that path)', () => {
  const fx = routerRoot()   // nothing at <root>/wolfpack-config.md
  const elsewhere = mkdtempSync(join(tmpdir(), 'wp-route-cfg-'))
  try {
    const p = join(elsewhere, 'custom-config.md')
    writeFileSync(p, REAL_TEXT)
    const r = routeCli([fx.planDir, '--config', p])
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /DEFAULT_POOL/)
    const j = JSON.parse(r.stdout)
    assert.equal(j.pool_source, 'config')
    assert.equal(j.config, p)
    assert.equal(j.assignments.bloodhound.model, 'glm')
  } finally { fx.cleanup(); rmSync(elsewhere, { recursive: true, force: true }) }
})

test('AC3 (e): CLI argument discipline — --config before <planDir>, a dangling --config, or an unknown flag → usage, exit 2', () => {
  const fx = routerRoot({ config: REAL_TEXT })
  try {
    for (const args of [
      ['--config', join(fx.root, 'wolfpack-config.md'), fx.planDir],
      [fx.planDir, '--config'],
      [fx.planDir, '--bogus', 'x'],
      [fx.planDir, '--config', 'a', 'b'],
      [],
    ]) {
      const r = routeCli(args)
      assert.equal(r.status, 2, JSON.stringify(args))
      assert.match(r.stderr, /usage: node scripts\/wolfpack-routing\.mjs <planDir> \[--config/, JSON.stringify(args))
      assert.equal(r.stdout, '')
    }
  } finally { fx.cleanup() }
})
