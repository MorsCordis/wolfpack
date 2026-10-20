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
import { spawnSync, execFileSync } from 'node:child_process'
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
      // scripts-unfork: --stats joins --config — each flag at most once, a value required
      [fx.planDir, '--stats'],
      [fx.planDir, '--stats', '--config', 'a'],
      [fx.planDir, '--stats', 'a', '--stats', 'b'],
      [fx.planDir, '--config', 'a', '--config', 'b'],
      ['--stats', 'a', fx.planDir],
      [],
    ]) {
      const r = routeCli(args)
      assert.equal(r.status, 2, JSON.stringify(args))
      assert.match(r.stderr, /usage: node "\$WOLFPACK_HOME\/scripts\/wolfpack-routing\.mjs" <planDir> \[--config <path to wolfpack-config\.md>\] \[--stats <path to model-stats\.json>\]/, JSON.stringify(args))
      assert.equal(r.stdout, '')
    }
  } finally { fx.cleanup() }
})

// ════════════════════════════════════════════════════════════════════════════
// scripts-unfork (AC3 / AC4 / AC12): the consumer's hand-forked router is gone. Every behaviour
// it hard-coded (a brand-literal glm → mistral → claude chain, env kill switches, a claude
// last-resort link) survives here CONFIG-DRIVEN: a fixture Model Pool + `gate=<ENV>` words.
// GPOOL is the consumer's shape (claude implements, glm/mistral review, glm also codes); the
// router code itself never names a brand (AC3 grep below).
// ════════════════════════════════════════════════════════════════════════════
import { gateOn, enabledFromGates, defaultStatsPath } from './wolfpack-routing.mjs'
import * as ROUTER from './wolfpack-routing.mjs'
import { realpathSync } from 'node:fs'

const GPOOL = { judgment: 'claude', workHorse: 'claude', reviewerA: 'glm', reviewerB: 'mistral', coderAlt: 'glm' }
const GGATES = { glm: 'WOLFPACK_ENABLE_GLM', mistral: 'WOLFPACK_ENABLE_MISTRAL_AUTO' }
const POOL_TEXT = ({ a = 'glm:5.3', b = 'mistral:large-4', alt = 'glm:5.3', gateA = 'WOLFPACK_ENABLE_GLM', gateB = 'WOLFPACK_ENABLE_MISTRAL_AUTO', extra = '' } = {}) => `# Config

## Project Identity
- **Name:** demo
- **Test command:** \`make test\`

## Model Pool
### Family → model mapping
- judgment    → claude:opus:high
- work-horse  → claude:sonnet
- reviewer-a  → ${a}${gateA ? ` gate=${gateA}` : ''}   # first examiner (prose: ${gateA}=0 disables)
- reviewer-b  → ${b}${gateB ? ` gate=${gateB}` : ''}   # second examiner
- coder-alt   → ${alt}${gateA ? ` gate=${gateA}` : ''}
${extra}
## Deployment Notes
- Dev deploy command: none
`
// The CLI with a hermetic gate env: the caller's own WOLFPACK_ENABLE_* never leaks in.
const cleanEnv = (extra = {}) => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('WOLFPACK_ENABLE_')) delete env[k]
  return { ...env, ...extra }
}
const routeEnv = (args, extra = {}) => spawnSync(process.execPath, [ROUTER_CLI, ...args], { encoding: 'utf8', env: cleanEnv(extra) })
const planRoot = ({ config = POOL_TEXT(), meta = { tier: 'Orange', predicted_dimensions: { frontend_complexity: 0 } } } = {}) => {
  const fx = routerRoot({ config })
  writeFileSync(join(fx.planDir, 'metadata.json'), JSON.stringify(meta))
  return fx
}

test('recommend: a pin naming a family outside the Model Pool is never routed — writer seats included', () => {
  // "retired" = absent from the pool: such a pin resolves to null, warns "unrecognized" (not
  // "disabled"), and the seat keeps its config-order default — Shepherd, Tracker and reviewers alike.
  const r = recommendModels({ tier: 'Yellow', dimensions: dims(), pool: GPOOL,
    pins: { shepherd: 'gemini:3-pro', tracker: 'gemini:3-pro', bloodhound: 'gemini:3-pro', pointer: 'gemini:flash', watchdog: 'gemini:3-pro' } })
  const fams = new Set(Object.values(GPOOL))
  for (const [role, a] of Object.entries(r.assignments)) {
    assert.ok(fams.has(a.model), `${role} = ${a.model}`)
    assert.notEqual(a.source, 'pin', role)
    for (const link of a.chain || []) assert.ok(fams.has(link), `${role} chain ${link}`)
  }
  for (const role of ['shepherd', 'tracker', 'bloodhound', 'pointer', 'watchdog']) {
    assert.ok(r.warnings.some(w => w.startsWith(`unrecognized ${role} pin "gemini`)), `${role}: ${r.warnings}`)
  }
  assert.ok(!r.warnings.some(w => /disabled/.test(w)), 'never phrased as an env-gate disable')
})

test('recommend: trusted stats flip a reviewer to best-by-data (exploit, fixture pool)', () => {
  // Exploit-only tier + trusted pedigree-v2 reward: the better-scoring reviewer-b family takes the
  // Bloodhound seat over the reviewer-a default, and its chain still carries the other family.
  const stats = { glm: { bloodhound: { backend: { runs: 5, reward_n: 5, reward_mean: 0.2 } } },
    mistral: { bloodhound: { backend: { runs: 5, reward_n: 5, reward_mean: 0.9 } } } }
  const r = recommendModels({ tier: 'Red', dimensions: dims(), stats, pool: GPOOL })
  assert.equal(r.assignments.bloodhound.model, 'mistral')
  assert.equal(r.assignments.bloodhound.source, 'exploit')
  assert.deepEqual(r.assignments.bloodhound.chain, ['mistral', 'glm'])
  // under-sampled cells never flip an exploit-only seat
  const thin = { mistral: { bloodhound: { backend: { runs: 1, reward_n: 1, reward_mean: 0.99 } } } }
  assert.equal(recommendModels({ tier: 'Red', dimensions: dims(), stats: thin, pool: GPOOL }).assignments.bloodhound.model, 'glm')
})

test("providerFamily (fixture pool): a reviewer-a label carrying reviewer-b's brand resolves to reviewer-a", () => {
  // e.g. reviewer-a's model served through reviewer-b's API: the label names both brands.
  assert.equal(providerFamily('mistral:zai-glm-5-3', GPOOL), 'glm')
  assert.equal(providerFamily('vibe/glm-5.3', GPOOL), 'glm')
  assert.equal(providerFamily('mistral:large-4', GPOOL), 'mistral')
})

test('enabledFromGates: Model Pool gate= env vars — unset/""/1/true on, 0/false off, ungated families always on', () => {
  for (const v of [undefined, null, '', '  ', '1', 'true', 'TRUE', ' True ']) assert.equal(gateOn(v), true, JSON.stringify(v))
  for (const v of ['0', 'false', 'FALSE', 'no', 'off', '2', 'yes']) assert.equal(gateOn(v), false, JSON.stringify(v))
  assert.deepEqual([...enabledFromGates(GPOOL, GGATES, {})].sort(), ['claude', 'glm', 'mistral'])
  assert.deepEqual([...enabledFromGates(GPOOL, GGATES, { WOLFPACK_ENABLE_GLM: '0' })].sort(), ['claude', 'mistral'])
  assert.deepEqual([...enabledFromGates(GPOOL, GGATES, { WOLFPACK_ENABLE_MISTRAL_AUTO: 'false' })].sort(), ['claude', 'glm'])
  assert.deepEqual([...enabledFromGates(GPOOL, GGATES, { WOLFPACK_ENABLE_GLM: '0', WOLFPACK_ENABLE_MISTRAL_AUTO: '0' })], ['claude'],
    'the implementer family is never gated')
  assert.deepEqual([...enabledFromGates(GPOOL, {}, { WOLFPACK_ENABLE_GLM: '0' })].sort(), ['claude', 'glm', 'mistral'],
    'an env var with no gate= word in the pool gates nothing')
  assert.deepEqual([...enabledFromGates(GPOOL, null, {})].sort(), ['claude', 'glm', 'mistral'])
})

test('recommend: a reviewer-a pin is honored for a judgment Shepherd', () => {
  const r = recommendModels({ tier: 'Orange', dimensions: dims(), pool: GPOOL, pins: { pointer: 'glm:5.3', watchdog: 'glm:5.3' } })
  assert.equal(r.assignments.shepherd.model, 'claude')
  for (const role of ['pointer', 'watchdog']) {
    assert.equal(r.assignments[role].model, 'glm', role)
    assert.equal(r.assignments[role].source, 'pin', role)
    assert.deepEqual(r.assignments[role].chain, ['glm', 'mistral'], role)
  }
})

test('the router exports no brand-named family constants (pool-driven only)', () => {
  for (const name of Object.keys(ROUTER)) {
    assert.doesNotMatch(name, /glm|mistral|gemini|claude|opus|sonnet|NON_CLAUDE|REVIEWER_ORDER|EXAMINER_ORDER/i, name)
  }
  // AC3: no brand literal in code — brand names may appear only in comments.
  const src = readFileSync(ROUTER_CLI, 'utf8').split('\n')
  const hits = src.filter(l => /^[^/]*('glm'|'mistral'|'gemini')/.test(l))
  assert.deepEqual(hits, [])
  assert.equal(Object.values(DEFAULT_POOL).some(v => /glm|mistral|gemini|claude/.test(v)), false)
})

test("chains never contain the writer's or any implementer family; a reviewer-z / last-resort pool line is ignored with a warning, never routed", () => {
  // The last-resort examiner (the judgment family) is hunt-pipeline's to append — the router
  // never routes it, on any tier, for any Shepherd (sole survivor or not).
  for (const tier of ['Green', 'Blue', 'Yellow', 'Orange', 'Red']) {
    for (const shep of [null, 'glm:5.3', 'claude:opus:high']) {
      for (const enabled of [null, new Set(['claude', 'glm', 'mistral']), new Set(['claude', 'mistral'])]) {
        let r
        try {
          r = recommendModels({ tier, dimensions: dims(), pool: GPOOL, enabled, pins: shep ? { shepherd: shep } : {} })
        } catch (e) {
          // the only legal failure: no cross-family examiner left — loud, never a same-family seat
          assert.match(e.message, /routing constraint violation/)
          continue
        }
        const a = r.assignments
        const writer = [a.shepherd.model, a.shepherd.fallback].filter(Boolean)
        for (const role of ['bloodhound', 'pointer', 'watchdog']) {
          assert.notEqual(a[role].model, 'claude', `${tier}/${shep} ${role}`)
          for (const link of a[role].chain) {
            assert.notEqual(link, 'claude', `${tier}/${shep} ${role} chain`)
            if (role !== 'bloodhound') assert.ok(!writer.includes(link), `${tier}/${shep} ${role} chain has the writer ${link}`)
            if (enabled) assert.ok(enabled.has(link), `${tier}/${shep} ${role} chain has a gated-off ${link}`)
          }
        }
      }
    }
  }
  // the consumer config's reviewer-z → claude (LAST RESORT) line: parsed as an unknown role, not a slot
  const cfg = loadConfig(writeTmp(POOL_TEXT({ extra: '- reviewer-z  → claude:opus:high   # LAST RESORT (appended by hunt-pipeline)' })))
  assert.deepEqual(cfg.unknownRoles, ['reviewer-z'])
  assert.deepEqual(cfg.problems.filter(p => p.startsWith('Model Pool:')), [])
  assert.equal(Object.values(cfg.pool).filter(f => f === 'claude').length, 2, 'only judgment + work-horse are claude')
})
function writeTmp(text) {
  const d = mkdtempSync(join(tmpdir(), 'wp-route-cfgtxt-'))
  const p = join(d, 'wolfpack-config.md')
  writeFileSync(p, text)
  process.on('exit', () => rmSync(d, { recursive: true, force: true }))
  return p
}

test('providerFamily: every label containing a pool family token resolves to it (claude:opus:high, claude:sonnet → judgment family)', () => {
  for (const l of ['claude:opus:high', 'claude:sonnet', 'claude-opus-5-5', 'CLAUDE:Opus']) assert.equal(providerFamily(l, GPOOL), 'claude', l)
  for (const l of ['glm:5.3', 'glm-5.3', 'zai-glm-5-3']) assert.equal(providerFamily(l, GPOOL), 'glm', l)
  for (const l of ['mistral:large-4', 'mistral-medium']) assert.equal(providerFamily(l, GPOOL), 'mistral', l)
})

test('an unrecognized label resolves to null; as a pin it warns and is never eligible', () => {
  for (const l of ['gpt:5', 'gemini:3-pro', '', null, undefined]) assert.equal(providerFamily(l, GPOOL), null, String(l))
  assert.deepEqual(reviewerChain({ pool: GPOOL, prefer: 'gpt:5' }), ['glm', 'mistral'], 'an unknown prefer never enters the chain')
  const r = recommendModels({ tier: 'Yellow', dimensions: dims(), pool: GPOOL, pins: { pointer: 'gpt:5' } })
  assert.equal(r.assignments.pointer.model, 'glm')
  assert.ok(!r.assignments.pointer.chain.includes('gpt:5'))
  assert.ok(r.warnings.some(w => w === 'unrecognized pointer pin "gpt:5" — using default'), r.warnings.join('; '))
})

test('chain exhausted (every pool reviewer gated off or the writer) → recommendModels throws; CLI exits 3 naming the gates', () => {
  // both gates off + a judgment-family writer: no examiner left → loud, never a disabled seat
  assert.throws(() => recommendModels({ tier: 'Orange', dimensions: dims(), pool: GPOOL, enabled: new Set(['claude']) }),
    /routing constraint violation: bloodhound has no eligible examiner .*bloodhound model glm is disabled by its env gate/)
  // reviewer-b gated off + a coder-alt (reviewer-a family) Shepherd: Pointer has nobody cross-family
  assert.throws(() => recommendModels({ tier: 'Yellow', dimensions: dims(), pool: GPOOL, enabled: new Set(['claude', 'glm']), pins: { shepherd: 'glm:5.3' } }),
    /routing constraint violation: Pointer has no cross-family reviewer left/)
  const fx = planRoot()
  try {
    const r = routeEnv([fx.planDir], { WOLFPACK_ENABLE_GLM: '0', WOLFPACK_ENABLE_MISTRAL_AUTO: 'false' })
    assert.equal(r.status, 3, r.stderr)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^✗ wolfpack-routing: routing constraint violation: .*no eligible examiner.* — enable a reviewer family \(its gate env\) or change the Shepherd; the pipeline parks no_cross_family_reviewer$/m)
    // one gate on → routes again
    assert.equal(routeEnv([fx.planDir], { WOLFPACK_ENABLE_GLM: '0' }).status, 0)
  } finally { fx.cleanup() }
})

test('assertConstraints rejects a review seat whose model is gated off, and an empty examiner chain', () => {
  const A = (over = {}) => ({
    alpha: { model: 'claude' }, shepherd: { model: 'claude' }, tracker: { model: 'claude' },
    bloodhound: { model: 'glm', chain: ['glm', 'mistral'] },
    pointer: { model: 'glm', chain: ['glm', 'mistral'] },
    watchdog: { model: 'glm', chain: ['glm', 'mistral'] }, ...over })
  assert.doesNotThrow(() => assertConstraints(A(), [], GPOOL, new Set(['claude', 'glm', 'mistral'])))
  assert.doesNotThrow(() => assertConstraints(A(), [], GPOOL), 'enabled omitted = every family on')
  assert.throws(() => assertConstraints(A(), [], GPOOL, new Set(['claude', 'mistral'])), /bloodhound model glm is disabled by its env gate/)
  assert.throws(() => assertConstraints(A({ watchdog: { model: 'mistral', chain: [] } }), [], GPOOL),
    /watchdog has no eligible examiner \(every pool reviewer is the writer's family or gated off\)/)
  // a seat with no chain field at all is not an EMPTY chain (pre-chain callers stay legal)
  assert.doesNotThrow(() => assertConstraints(A({ pointer: { model: 'mistral' } }), [], GPOOL))
})

test('offload: light tiers ⇒ coder-alt with the work-horse fallback, no claudeFinalReview', () => {
  for (const tier of ['Green', 'Blue', 'Yellow']) {
    const r = recommendModels({ tier, dimensions: dims(), pool: GPOOL, offload: true })
    assert.equal(r.assignments.shepherd.model, 'glm', tier)
    assert.equal(r.assignments.shepherd.fallback, GPOOL.workHorse, tier)
    assert.equal(r.assignments.shepherd.source, 'offload', tier)
    assert.equal(r.claudeFinalReview, false, tier)
    for (const role of ['pointer', 'watchdog']) assert.deepEqual(r.assignments[role].chain, ['mistral'], `${tier} ${role}`)
  }
})

test('offload: beats a coder-alt pin on heavy tiers (no "pin ignored" warning) and beats a judgment Shepherd pin', () => {
  for (const pin of ['glm:5.3', 'claude:opus:high']) {
    const r = recommendModels({ tier: 'Red', dimensions: dims(), pool: GPOOL, offload: true, pins: { shepherd: pin } })
    assert.equal(r.assignments.shepherd.model, 'glm', pin)
    assert.equal(r.assignments.shepherd.source, 'offload', pin)
    assert.equal(r.assignments.shepherd.fallback, 'claude', pin)
    assert.ok(!r.warnings.some(w => /ignoring shepherd pin/.test(w)), `${pin}: ${r.warnings}`)
    assert.equal(r.claudeFinalReview, true, pin)
  }
})

test('CLI: metadata.usage_offload drives offload + claudeFinalReview from the plan dir (config pool)', () => {
  const fx = planRoot({ meta: { tier: 'Red', predicted_dimensions: { frontend_complexity: 0 }, usage_offload: { reason: 'weekly pace' } } })
  try {
    const r = routeEnv([fx.planDir])
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.assignments.shepherd.model, 'glm')
    assert.equal(j.assignments.shepherd.source, 'offload')
    assert.equal(j.assignments.shepherd.fallback, 'claude')
    assert.equal(j.claudeFinalReview, true)
    assert.deepEqual(j.assignments.pointer.chain, ['mistral'])
    // the coder-alt family gated off → offload refused visibly, routing unchanged
    const off = JSON.parse(routeEnv([fx.planDir], { WOLFPACK_ENABLE_GLM: '0' }).stdout)
    assert.equal(off.assignments.shepherd.model, 'claude')
    assert.equal(off.claudeFinalReview, false)
    assert.ok(off.warnings.some(w => /usage offload requested but no enabled coder-alt/.test(w)))
  } finally { fx.cleanup() }
})

test('CLI: the examiner chain order comes from the Model Pool — swapping reviewer-a/reviewer-b families swaps the Bloodhound/Pointer chains', () => {
  const runWith = (text) => {
    const fx = planRoot({ config: text })
    try {
      const r = routeEnv([fx.planDir, '--config', join(fx.root, 'wolfpack-config.md')])
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(r.stdout)
    } finally { fx.cleanup() }
  }
  const ab = runWith(POOL_TEXT())
  const ba = runWith(POOL_TEXT({ a: 'mistral:large-4', b: 'glm:5.3', alt: 'mistral:large-4', gateA: 'WOLFPACK_ENABLE_MISTRAL_AUTO', gateB: 'WOLFPACK_ENABLE_GLM' }))
  for (const role of ['bloodhound', 'pointer']) {
    assert.deepEqual(ab.assignments[role].chain, ['glm', 'mistral'], `${role} a=glm`)
    assert.deepEqual(ba.assignments[role].chain, ['mistral', 'glm'], `${role} a=mistral`)
    assert.equal(ab.assignments[role].model, 'glm')
    assert.equal(ba.assignments[role].model, 'mistral')
  }
  // a third, never-seen pair of family names routes just the same — nothing is brand-literal
  const xy = runWith(POOL_TEXT({ a: 'famx:1', b: 'famy:2', alt: 'famx:1', gateA: 'WOLFPACK_ENABLE_FAMX', gateB: null }))
  assert.deepEqual(xy.assignments.bloodhound.chain, ['famx', 'famy'])
  assert.deepEqual(xy.gates, { famx: { env: 'WOLFPACK_ENABLE_FAMX', on: true } })
})

test('CLI: Model Pool gates drive the enabled set — 0/false drops that family from every chain; JSON reports gates', () => {
  const fx = planRoot()
  try {
    const on = JSON.parse(routeEnv([fx.planDir]).stdout)
    assert.deepEqual(on.gates, { glm: { env: 'WOLFPACK_ENABLE_GLM', on: true }, mistral: { env: 'WOLFPACK_ENABLE_MISTRAL_AUTO', on: true } })
    const noB = JSON.parse(routeEnv([fx.planDir], { WOLFPACK_ENABLE_MISTRAL_AUTO: 'false' }).stdout)
    assert.deepEqual(noB.gates.mistral, { env: 'WOLFPACK_ENABLE_MISTRAL_AUTO', on: false })
    for (const role of ['bloodhound', 'pointer', 'watchdog']) assert.deepEqual(noB.assignments[role].chain, ['glm'], role)
    const noA = JSON.parse(routeEnv([fx.planDir], { WOLFPACK_ENABLE_GLM: '0' }).stdout)
    for (const role of ['bloodhound', 'pointer', 'watchdog']) {
      assert.equal(noA.assignments[role].model, 'mistral', role)
      assert.deepEqual(noA.assignments[role].chain, ['mistral'], role)
    }
    // "1" / "true" / "" are on
    for (const v of ['1', 'true', '']) assert.deepEqual(JSON.parse(routeEnv([fx.planDir], { WOLFPACK_ENABLE_GLM: v }).stdout).assignments.bloodhound.chain, ['glm', 'mistral'], v)
  } finally { fx.cleanup() }
  // coder-alt Shepherd pin with its family gated off on a light tier → the work horse, warned
  const fy = planRoot({ meta: { tier: 'Yellow', predicted_dimensions: { frontend_complexity: 0 }, model_pins: { shepherd: 'glm:5.3' } } })
  try {
    const pinned = JSON.parse(routeEnv([fy.planDir]).stdout)
    assert.equal(pinned.assignments.shepherd.model, 'glm')
    assert.deepEqual(pinned.assignments.pointer.chain, ['mistral'])
    const r = routeEnv([fy.planDir], { WOLFPACK_ENABLE_GLM: '0' })
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.assignments.shepherd.model, 'claude')
    assert.ok(j.warnings.some(w => /ignoring shepherd pin "glm:5\.3" — glm is disabled/.test(w)), j.warnings.join('; '))
  } finally { fy.cleanup() }
  // DEFAULT_POOL (no config): no gates at all, enabled = null — unchanged behaviour
  const fz = routerRoot()
  try {
    const j = JSON.parse(routeEnv([fz.planDir], { WOLFPACK_ENABLE_GLM: '0' }).stdout)
    assert.equal(j.pool_source, 'default')
    assert.equal('gates' in j, false)
  } finally { fz.cleanup() }
})

test('CLI: an unknown Model Pool role warns, never fails', () => {
  // AC12: the consumer-shaped config documents the pipeline's last-resort link as `reviewer-z`.
  const fx = planRoot({ config: POOL_TEXT({ extra: '- reviewer-z  → claude:opus:high   # LAST RESORT — appended by hunt-pipeline' }) })
  try {
    const r = routeEnv([fx.planDir])
    assert.equal(r.status, 0, r.stderr)
    const want = 'Model Pool role(s) reviewer-z not used by the router — ignored (the last-resort examiner link is appended by hunt-pipeline, not routed)'
    assert.ok(r.stderr.includes(`⚠ wolfpack-routing: ${want}`), r.stderr)
    const j = JSON.parse(r.stdout)
    assert.ok(j.warnings.includes(want), j.warnings.join('; '))
    assert.equal(j.assignments.bloodhound.chain[0], 'glm', 'the consumer reviewer-a family is the first Bloodhound link')
    for (const role of ['bloodhound', 'pointer', 'watchdog']) assert.ok(!j.assignments[role].chain.includes('claude'), role)
  } finally { fx.cleanup() }
  // no unknown role → no such warning
  const fy = planRoot()
  try { assert.doesNotMatch(routeEnv([fy.planDir]).stderr, /not used by the router/) } finally { fy.cleanup() }
})

test("CLI: stats default is the invoking repo's main tree, never the script's", () => {
  // A temp consuming repo + a hunt worktree: planDir lives in the WORKTREE, the meter in the MAIN
  // checkout (Watchdog step 8b writes it there). A decoy meter in the worktree must be ignored.
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'wp-route-git-')))
  try {
    g(main, 'init', '-q', '-b', 'main')
    g(main, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    const wt = join(main, '.agents', 'worktrees', 'h')
    g(main, 'worktree', 'add', '-q', '-b', 'feat/h', wt)
    const planDir = join(wt, '.wolfpack', 'plans', 'h')
    mkdirSync(planDir, { recursive: true })
    writeFileSync(join(planDir, 'metadata.json'), JSON.stringify({ tier: 'Red', predicted_dimensions: { frontend_complexity: 0 } }))
    writeFileSync(join(wt, 'wolfpack-config.md'), POOL_TEXT())
    const flip = { model_stats: { mistral: { bloodhound: { backend: { runs: 5, reward_n: 5, reward_mean: 0.9 } } },
      glm: { bloodhound: { backend: { runs: 5, reward_n: 5, reward_mean: 0.1 } } } } }
    const stay = { model_stats: { glm: { bloodhound: { backend: { runs: 5, reward_n: 5, reward_mean: 0.9 } } },
      mistral: { bloodhound: { backend: { runs: 5, reward_n: 5, reward_mean: 0.1 } } } } }
    mkdirSync(join(main, '.wolfpack', 'pedigree'), { recursive: true })
    writeFileSync(join(main, '.wolfpack', 'pedigree', 'model-stats.json'), JSON.stringify(flip))
    mkdirSync(join(wt, '.wolfpack', 'pedigree'), { recursive: true })
    writeFileSync(join(wt, '.wolfpack', 'pedigree', 'model-stats.json'), JSON.stringify(stay))   // decoy
    const mainStats = join(main, '.wolfpack', 'pedigree', 'model-stats.json')
    assert.equal(defaultStatsPath(planDir), mainStats)
    const r = routeEnv([planDir])
    assert.equal(r.status, 0, r.stderr)
    const j = JSON.parse(r.stdout)
    assert.equal(j.stats, mainStats)
    assert.equal(j.stats_source, 'file')
    assert.equal(j.assignments.bloodhound.model, 'mistral', 'the MAIN tree meter was read (it flips Bloodhound)')
    assert.ok(!j.stats.startsWith(realpathSync(join(HERE_CFG, '..')) + '/'), 'never the script\'s own repo')
    // --stats overrides the default (here: the worktree decoy)
    const o = JSON.parse(routeEnv([planDir, '--stats', join(wt, '.wolfpack', 'pedigree', 'model-stats.json')]).stdout)
    assert.equal(o.stats, join(wt, '.wolfpack', 'pedigree', 'model-stats.json'))
    assert.equal(o.assignments.bloodhound.model, 'glm')
    // --stats in either order with --config
    const o2 = JSON.parse(routeEnv([planDir, '--stats', join(wt, '.wolfpack', 'pedigree', 'model-stats.json'), '--config', join(wt, 'wolfpack-config.md')]).stdout)
    assert.equal(o2.assignments.bloodhound.model, 'glm')
    assert.equal(o2.config, join(wt, 'wolfpack-config.md'))
    // a missing --stats file → absent, empty stats (tier defaults), disclosed
    const a = JSON.parse(routeEnv([planDir, '--stats', join(main, 'nope.json')]).stdout)
    assert.equal(a.stats_source, 'absent')
    assert.equal(a.assignments.bloodhound.model, 'glm')
  } finally { rmSync(main, { recursive: true, force: true }) }
  // not a git repo → the root implied by planDir (<planDir>/../../..), disclosed in the JSON
  const fx = routerRoot({ config: POOL_TEXT() })
  try {
    const j = JSON.parse(routeEnv([fx.planDir]).stdout)
    assert.equal(j.stats, join(fx.root, '.wolfpack', 'pedigree', 'model-stats.json'))
    assert.equal(j.stats_source, 'absent')
  } finally { fx.cleanup() }
})
