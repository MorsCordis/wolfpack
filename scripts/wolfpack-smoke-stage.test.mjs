#!/usr/bin/env node
// scripts/wolfpack-smoke-stage.test.mjs — the chain-mode post-merge stage's deterministic core
// (hunt: wave-auto-smoke; docs/post-merge-stage.md).
// Run: node --test scripts/wolfpack-smoke-stage.test.mjs
//
// Part 1 drives the pure exports. Part 2 drives the REAL CLI against throwaway consumer repos
// (git init -b main, isolated git config, no network) whose wolfpack-config.md points every stage
// command at a stub script that appends `$PWD <HEAD> <args>` to a call log, so a test can assert
// what ran, where, and that a refused step ran NOTHING. Fixture hosts are *.example.dev /
// *.example.vet; tenant names (surgical, mobile) are config only.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  refuseProdTarget, suiteSet, attributeFailures, parseNewFailures, criteriaSet, tenantPlan, normaliseDisposition,
  huntVerdict, classifyFinding, TRIAGE_RULES, findingId, redact, fingerprintLookup, lookupLine, appendIssues, resolveIssue,
  renderIssueLog, emptyStore, openPolishSet, checkConfig, validateRaw, newCurrent, resetIteration, rearm,
  MAX_TEST_RECORD_MIN, SUITE_RESERVE_MIN, MAX_BUSY_RETRIES, MAX_FIX_ROUNDS, STEPS, CONSOLE_DETAIL, StageError,
} from './wolfpack-smoke-stage.mjs'
import { STAGE_KEYS } from './wolfpack-config.mjs'
import { cmdInit as chainInit, cmdMergeHunt as chainMerge, CHAIN_STATUS as CS } from './wolfpack-chain.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PACK = join(here, '..')
const CLI = join(here, 'wolfpack-smoke-stage.mjs')

// ════════════════════════════════════════════════════════════════════════════
// Part 1 — pure exports
// ════════════════════════════════════════════════════════════════════════════
const GUARD_CFG = { prodHostSuffix: 'example.vet', neverSmokeHosts: ['example.com', 'demo.example.dev', 'clone.example.dev'] }

test('refuseProdTarget (AC6): commands — /prod/i, the prod suffix, a never-smoke host as a whole hostname', () => {
  assert.equal(refuseProdTarget('scripts/ops/deploy_dev.sh', GUARD_CFG), null)
  assert.equal(refuseProdTarget('scripts/ops/deploy_dev.sh migrate', GUARD_CFG), null)
  assert.equal(refuseProdTarget('scripts/ops/deploy_prod.sh', GUARD_CFG), 'prod name')
  assert.equal(refuseProdTarget('run --settings=PROD_settings', GUARD_CFG), 'prod name')
  assert.equal(refuseProdTarget('login --host x.example.vet', GUARD_CFG), 'prod suffix')
  assert.equal(refuseProdTarget('login --host demo.example.dev --check', GUARD_CFG), 'never-smoke')
  assert.equal(refuseProdTarget("login --host 'clone.example.dev'", GUARD_CFG), 'never-smoke')
  assert.equal(refuseProdTarget('see https://example.com/x', GUARD_CFG), 'never-smoke')
  // whole hostname only: a longer host that merely contains a never-smoke name is not refused
  assert.equal(refuseProdTarget('login --host xdemo.example.dev', GUARD_CFG), null)
  assert.equal(refuseProdTarget('login --host my-demo.example.dev', GUARD_CFG), null)
  assert.equal(refuseProdTarget('login --host dev.example.dev', GUARD_CFG), null)
  assert.equal(refuseProdTarget('', GUARD_CFG), null)
  assert.equal(refuseProdTarget('deploy', {}), null, 'no config: only the prod-name rule applies')
  assert.equal(refuseProdTarget('deploy-prod', {}), 'prod name')
})

test('refuseProdTarget: "campaign slug containing prod is not refused" (the substituted slug is masked)', () => {
  const cmd = "./run_tests.sh --local --isolated-db 'reproduce-login-bug'"
  assert.equal(refuseProdTarget(cmd, GUARD_CFG), 'prod name', 'unmasked, the slug trips the rule')
  assert.equal(refuseProdTarget(cmd, GUARD_CFG, { mask: 'reproduce-login-bug' }), null)
  // masking the slug never hides another prod mention
  assert.equal(refuseProdTarget(`${cmd} --settings=prod_settings`, GUARD_CFG, { mask: 'reproduce-login-bug' }), 'prod name')
})

test('refuseProdTarget: hosts and urls test ONLY the hostname ("path substring is not a host")', () => {
  assert.equal(refuseProdTarget('https://dev.example.dev/inventory/medication_products/', GUARD_CFG, { kind: 'url' }), null)
  assert.equal(refuseProdTarget('https://dev.example.dev/x?next=/prod/&h=x.example.vet', GUARD_CFG, { kind: 'url' }), null)
  assert.equal(refuseProdTarget('https://app-prod.example/', GUARD_CFG, { kind: 'url' }), 'prod name')
  assert.equal(refuseProdTarget('https://x.example.vet/', GUARD_CFG, { kind: 'url' }), 'prod suffix')
  assert.equal(refuseProdTarget('https://EXAMPLE.VET/', GUARD_CFG, { kind: 'url' }), 'prod suffix')
  assert.equal(refuseProdTarget('https://demo.example.dev:443/login', GUARD_CFG, { kind: 'url' }), 'never-smoke')
  assert.equal(refuseProdTarget('https://dev.example.dev@x.example.vet/', GUARD_CFG, { kind: 'url' }), 'prod suffix', 'userinfo is not the host')
  assert.equal(refuseProdTarget('not a url', GUARD_CFG, { kind: 'url' }), 'unparseable url')
  assert.equal(refuseProdTarget('dev.example.dev', GUARD_CFG, { kind: 'host' }), null)
  assert.equal(refuseProdTarget(' Demo.Example.dev ', GUARD_CFG, { kind: 'host' }), 'never-smoke')
  assert.equal(refuseProdTarget('surgical.example.vet', GUARD_CFG, { kind: 'host' }), 'prod suffix')
  assert.equal(refuseProdTarget('', GUARD_CFG, { kind: 'host' }), 'empty host')
})

test('refuseProdTarget: a trailing-dot FQDN is the same host and is refused too', () => {
  // `https://x.example.vet./` and `pp.example.dev.` reach the same site as the dotless name; a
  // guard that compares the raw hostname lets them through.
  assert.equal(refuseProdTarget('https://x.example.vet./', GUARD_CFG, { kind: 'url' }), 'prod suffix')
  assert.equal(refuseProdTarget('https://demo.example.dev./login', GUARD_CFG, { kind: 'url' }), 'never-smoke')
  assert.equal(refuseProdTarget('surgical.example.vet.', GUARD_CFG, { kind: 'host' }), 'prod suffix')
  assert.equal(refuseProdTarget('demo.example.dev.', GUARD_CFG, { kind: 'host' }), 'never-smoke')
  // Several trailing dots, and upper case, normalise the same way; a plain dev host stays allowed.
  assert.equal(refuseProdTarget('https://X.Example.VET../', GUARD_CFG, { kind: 'url' }), 'prod suffix')
  assert.equal(refuseProdTarget('dev.example.dev.', GUARD_CFG, { kind: 'host' }), null)
  assert.equal(refuseProdTarget('https://dev.example.dev./login', GUARD_CFG, { kind: 'url' }), null)
})

test('refuseProdTarget: trailing dots / whitespace in the CONFIG values are normalised too', () => {
  const cfg = { prodHostSuffix: ' example.vet. ', neverSmokeHosts: ['demo.example.dev.', ' Clone.Example.dev '] }
  assert.equal(refuseProdTarget('https://x.example.vet/', cfg, { kind: 'url' }), 'prod suffix')
  assert.equal(refuseProdTarget('example.vet', cfg, { kind: 'host' }), 'prod suffix')
  assert.equal(refuseProdTarget('demo.example.dev', cfg, { kind: 'host' }), 'never-smoke')
  assert.equal(refuseProdTarget('https://clone.example.dev/x', cfg, { kind: 'url' }), 'never-smoke')
  assert.equal(refuseProdTarget('dev.example.dev', cfg, { kind: 'host' }), null)
  // A suffix that is only dots is no suffix (not a match-everything '').
  assert.equal(refuseProdTarget('dev.example.dev', { prodHostSuffix: '.', neverSmokeHosts: ['.'] }, { kind: 'host' }), null)
})

test('suiteSet (A-5): touched apps; Red hunt → full; docs-only → none; full-suite path → full; main-sync noise excluded', () => {
  const apps = ['billing', 'records', 'scheduler']
  let r = suiteSet({ h1: ['billing/views.py', 'billing/tests.py'], h2: ['scheduler/models.py', 'docs/x.md'] }, { appMarkerDirs: apps })
  assert.deepEqual(r.labels, ['billing', 'scheduler'])
  assert.equal(r.full, false)
  assert.equal(r.reason, 'touched apps: billing, scheduler')
  assert.deepEqual(r.hunt_apps, { h1: ['billing'], h2: ['scheduler'] })
  r = suiteSet({ h1: ['billing/views.py'] }, { appMarkerDirs: apps, tiers: { h1: 'red' } })
  assert.equal(r.full, true)
  assert.match(r.reason, /^full suite: h1 is Red$/)
  r = suiteSet({ h1: ['docs/a.md', 'README.md'] }, { appMarkerDirs: apps })
  assert.deepEqual([r.labels, r.full, r.reason], [[], false, 'no app touched'])
  r = suiteSet({ h1: ['requirements.txt'], h2: ['settings/base.py'] }, { appMarkerDirs: apps, fullSuitePaths: ['settings/', 'requirements.txt'] })
  assert.equal(r.full, true)
  assert.deepEqual(r.full_suite_hunts, ['h1', 'h2'])
  // a top-level FILE named like an app is not the app; an exact full-suite path is not a prefix of a longer name
  r = suiteSet({ h1: ['billing', 'requirements.txt.bak'] }, { appMarkerDirs: apps, fullSuitePaths: ['requirements.txt'] })
  assert.deepEqual([r.labels, r.full], [[], false])
  // "main-sync noise excluded": only the per-merge diffs the caller passes are mapped
  r = suiteSet({ h1: ['billing/a.py'] }, { appMarkerDirs: apps })
  assert.deepEqual(r.labels, ['billing'])
  assert.deepEqual(suiteSet({}, {}), { labels: [], full: false, reason: 'no app touched', hunt_apps: {}, full_suite_hunts: [] })
})

test('attributeFailures (A-6/A-17): candidates by app, two-candidate attribution, full-suite hunts, unattributable', () => {
  // two hunts touching records/ → a finding for each
  let r = attributeFailures(['records.tests.X.test_a'], { h1: ['records'], h2: ['records', 'billing'] }, [])
  assert.deepEqual(r.attributed, [{ test_id: 'records.tests.X.test_a', app: 'records', hunts: ['h1', 'h2'] }])
  assert.deepEqual(r.unattributed, [])
  // no app hunt and no full-suite hunt → the campaign blocks
  r = attributeFailures(['users.tests.Y'], { h1: ['billing'] }, [])
  assert.deepEqual(r, { attributed: [], unattributed: ['users.tests.Y'] })
  // a requirements.txt-only hunt is a candidate for ANY failing app
  r = attributeFailures(['billing.tests.X'], { dep: [] }, ['dep'])
  assert.deepEqual(r.attributed, [{ test_id: 'billing.tests.X', app: 'billing', hunts: ['dep'] }])
  // requirements.txt hunt + an app-touching hunt → both candidates
  r = attributeFailures(['scheduler.tests.X'], { dep: [], sch: ['scheduler'] }, ['dep'])
  assert.deepEqual(r.attributed[0].hunts.sort(), ['dep', 'sch'])
  assert.deepEqual(attributeFailures([], {}, []), { attributed: [], unattributed: [] })
})

test('parseNewFailures: the NEW FAILURES block up to the first blank line, "- " tolerated', () => {
  assert.deepEqual(parseNewFailures('baseline ok\nNEW FAILURES (2):\nbilling.tests.A\n- records.tests.B.test_x\n\nignored.tests.C\n'),
    ['billing.tests.A', 'records.tests.B.test_x'])
  assert.deepEqual(parseNewFailures('all good\n'), [])
  assert.deepEqual(parseNewFailures(null), [])
  assert.deepEqual(parseNewFailures('NEW FAILURES\r\na.tests.X\r\n'), ['a.tests.X'])
})

const ACC = (slug) => `# Acceptance — ${slug}

## Acceptance criteria
- AC1 [auto] ${slug} one runs everywhere.
- AC2 [auto] [tenant:mobile] ${slug} two runs on mobile only.
- AC3 [manual] ${slug} three by hand.
- AC4 [compliance] ${slug} four is compliance.
`

test('criteriaSet (AC12): campaign-merged hunts only; reverted excluded; pending-compliance included; [manual] collected; refs <slug>/<n>', () => {
  const hunts = [
    { slug: 'm', status: CS.MERGED, tier: 'Yellow' },
    { slug: 'r', status: CS.REVERTED, tier: 'Yellow' },
    { slug: 'p', status: CS.MERGED_PENDING_COMPLIANCE, tier: 'red' },
    { slug: 'gone', status: CS.MERGED, tier: 'Blue' },
    { slug: 'w', status: 'certified', tier: 'Blue' },
  ]
  const read = (s) => (s === 'gone' ? null : ACC(s))
  const cs = criteriaSet(hunts, read)
  assert.deepEqual(cs.auto.map(c => [c.ref, c.hunt, c.tenant, c.tier]), [
    ['m/1', 'm', 'both', 'Yellow'], ['m/2', 'm', 'mobile', 'Yellow'], ['p/1', 'p', 'both', 'Red'], ['p/2', 'p', 'mobile', 'Red'],
  ])
  assert.deepEqual(cs.manual.map(c => c.ref), ['m/3', 'p/3'])
  assert.deepEqual(cs.compliance.map(c => c.ref), ['m/4', 'p/4'])
  assert.deepEqual(cs.missing, ['gone'])
})

const TENANTS = { surgical: 'surgical.example.dev', mobile: 'dev.example.dev' }
// A fixture copy of the consumer's mobile manifest (five [auto] [tenant:mobile] flows; the host is genericised).
const MANIFEST = `# Mobile non-regression manifest

The lines use the acceptance-criteria syntax so the same parser reads them (slug \`mobile-manifest\`).

- AC1 [auto] [tenant:mobile] Sign in through the smoke login hook as smoke-admin and land on the dashboard (host dev.example.dev, path /) with no console error.
- AC2 [auto] [tenant:mobile] Schedule: from the dashboard, click the schedule/calendar navigation; the calendar renders today's day view (path verified).
- AC3 [auto] [tenant:mobile] Appointment: click an existing appointment on the calendar; its detail opens with patient and client names.
- AC4 [auto] [tenant:mobile] Medical record: from that appointment's patient, open the most recent medical record; it renders read-only.
- AC5 [auto] [tenant:mobile] Invoice: open the invoices list and click the newest invoice; the detail renders with line items and a total.
`

test('mobile manifest: "manifest parses 5 flows", each [auto] with tenant mobile', async () => {
  const { parseAcceptanceCriteria } = await import('./wolfpack-release.mjs')
  const flows = parseAcceptanceCriteria(MANIFEST, 'mobile-manifest')
  assert.equal(flows.length, 5)
  for (const f of flows) {
    assert.equal(f.tag, 'auto')
    assert.equal(f.tenant, 'mobile')
    assert.match(f.ref, /^mobile-manifest\/[1-5]$/)
  }
})

test('tenantPlan (AC34): (criterion, tenant) pairs by scope, plus every manifest flow on mobile; none on surgical', async () => {
  const { parseAcceptanceCriteria } = await import('./wolfpack-release.mjs')
  const crit = [
    { ref: 'h/1', hunt: 'h', text: 'a', tenant: 'both' },
    { ref: 'h/2', hunt: 'h', text: 'b', tenant: 'surgical' },
    { ref: 'h/3', hunt: 'h', text: 'c', tenant: 'mobile' },
  ]
  const manifest = parseAcceptanceCriteria(MANIFEST, 'mobile-manifest')
  const pairs = tenantPlan(crit, TENANTS, { mobile: manifest })
  assert.deepEqual(pairs.filter(p => !p.manifest).map(p => p.key), ['h/1@surgical', 'h/1@mobile', 'h/2@surgical', 'h/3@mobile'])
  const mp = pairs.filter(p => p.manifest)
  assert.equal(mp.length, 5)
  assert.ok(mp.every(p => p.tenant === 'mobile' && p.host === 'dev.example.dev' && p.hunt === 'mobile-manifest'))
  assert.equal(pairs.some(p => p.ref.startsWith('mobile-manifest/') && p.tenant === 'surgical'), false)
  assert.equal(pairs.find(p => p.key === 'h/2@surgical').host, 'surgical.example.dev')
  // a manifest flow scoped `both` WOULD run on surgical — the check above is what pins the real scopes
  const both = tenantPlan([], TENANTS, { mobile: [{ ref: 'mobile-manifest/9', text: 'x', tenant: 'both' }] })
  assert.ok(both.some(p => p.tenant === 'surgical'))
  // an unconfigured tenant is a config error naming the key
  assert.throws(() => tenantPlan([{ ref: 'h/1', text: 'a', tenant: 'kiosk' }], TENANTS),
    (e) => e instanceof StageError && e.code === 'smoke_config_missing' && /Smoke tenants \(kiosk\)/.test(e.message))
  assert.throws(() => tenantPlan([], { surgical: 'x' }, { mobile: [] }), /Smoke tenants \(mobile\)/)
})

test('huntVerdict (AC15): "5xx flips hunt verdict"; "console-not-reachable → needs_human_run"; PENDING; PASS', () => {
  const pass = [{ disposition: 'auto_pass' }, { disposition: 'auto_pass' }]
  assert.equal(huntVerdict(pass, []), 'PASS')
  assert.equal(huntVerdict(pass, [{ kind: 'network', status: 503 }]), 'FAIL')
  assert.equal(huntVerdict(pass, [{ kind: 'network', status: 404 }]), 'PASS')
  assert.equal(huntVerdict([{ disposition: 'auto_fail' }], []), 'FAIL')
  assert.equal(huntVerdict([{ disposition: 'manual_fail' }], []), 'FAIL')
  assert.equal(huntVerdict([{ disposition: 'auto_pass' }, { disposition: 'auto_pass', detail: 'Console not reachable on dev (the tab closed)' }]), 'PENDING')
  assert.equal(huntVerdict([{ disposition: 'auto_pass', needs_console: true }]), 'PENDING')
  assert.equal(huntVerdict([]), 'PASS')
  const n = normaliseDisposition({ ref: 'h/1', disposition: 'auto_pass', needs_console: true })
  assert.equal(n.disposition, 'needs_human_run')
  assert.equal(n.detail, CONSOLE_DETAIL)
  assert.equal(normaliseDisposition({ disposition: 'auto_fail', detail: 'x' }).disposition, 'auto_fail')
})

// ── classifyFinding (AC18): one case per rule, first match wins ───────────────
const F = (over = {}) => ({ kind: 'smoke', hunt: 'h', ref: 'h/1', tenant: 'surgical', summary: 's', evidence: null, model: { class: 'fix', expected_from: 'ac' }, ...over })
const CTX = (over = {}) => ({ tier: 'Yellow', files: ['scheduler/views.py'], complianceRefs: [], fixRounds: 0, mobilePassed: {}, triageBlockPaths: ['billing/', 'records'], ...over })
test('classifyFinding: one case per rule 1–13 (first match wins)', () => {
  const cases = [
    ['deploy_or_migration', 'block', F({ kind: 'deploy' }), CTX()],
    ['deploy_or_migration', 'block', F({ kind: 'migrate' }), CTX()],
    ['5xx_or_cross_tenant', 'block', F({ http_status: 502 }), CTX()],
    ['5xx_or_cross_tenant', 'block', F({ model: { class: 'log', cross_tenant: true } }), CTX()],
    ['prod_host_touched', 'block', F({ prod_host: true }), CTX()],
    ['mobile_regression', 'block', F({ tenant: 'mobile', ref: 'h/2' }), CTX({ mobilePassed: { 'h/2@mobile': 1 } })],
    ['money_medical_path', 'block', F(), CTX({ files: ['records/models.py'] })],
    ['money_medical_path', 'block', F({ kind: 'integration', test_id: 'billing.tests.X', ref: null }), CTX({ files: ['billing/x.py'] })],
    ['red_compliance', 'block', F({ ref: 'h/4' }), CTX({ tier: 'Red', complianceRefs: ['h/4'] })],
    ['fix_cap', 'block', F(), CTX({ fixRounds: 2 })],
    ['needs_decision', 'block', F({ model: { class: 'needs_decision' } }), CTX()],
    ['uncertain_log_vs_block', 'block', F({ model: { class: 'uncertain' } }), CTX()],
    ['session_drop', 'log', F({ kind: 'session', hunt: null, ref: 'session@dev.example.dev', model: {} }), {}],
    ['clear_defect', 'fix', F(), CTX()],
    ['clear_defect', 'fix', F({ kind: 'integration', test_id: 'scheduler.tests.X', ref: null, model: {} }), CTX()],
    ['polish', 'log', F({ model: { class: 'log', expected_from: 'none' } }), CTX()],
    ['default_block', 'block', F({ model: { class: 'fix', expected_from: 'none' } }), CTX()],
    ['default_block', 'block', F({ model: { class: 'block' } }), CTX()],
    ['default_block', 'block', F({ model: {} }), CTX()],
  ]
  for (const [rule, outcome, f, ctx] of cases) {
    const r = classifyFinding(f, ctx)
    assert.equal(r.rule, rule, `${rule}: ${JSON.stringify(r)}`)
    assert.equal(r.outcome, outcome, rule)
    assert.equal(typeof r.reasoning, 'string')
    assert.ok(r.reasoning.length > 0)
  }
  // every rule id appears in the table (and only the documented ones)
  assert.deepEqual([...new Set(cases.map(c => c[0]))].sort(), [...TRIAGE_RULES].sort())
  assert.equal(TRIAGE_RULES.length, 13)
})

test('classifyFinding: "uncertain log-vs-block → block"; "mobile regression → block even if cosmetic"', () => {
  assert.deepEqual(classifyFinding(F({ model: { class: 'uncertain' } }), CTX()).outcome, 'block')
  const r = classifyFinding(F({ tenant: 'mobile', ref: 'mobile-manifest/3', model: { class: 'log', expected_from: 'none' } }),
    CTX({ mobilePassed: { 'mobile-manifest/3@mobile': 2 } }))
  assert.equal(r.outcome, 'block')
  assert.equal(r.rule, 'mobile_regression')
  assert.match(r.reasoning, /passed on mobile in wave 2/)
  // not yet passed on mobile → the cosmetic class wins
  assert.equal(classifyFinding(F({ tenant: 'mobile', model: { class: 'log' } }), CTX()).outcome, 'log')
})

test('classifyFinding: ordering — earlier rules win; a hunt-less fix blocks the campaign; reasoning is rendered, never model prose', () => {
  // 5xx on a money path in a Red hunt past the fix cap: rule 2 wins
  assert.equal(classifyFinding(F({ http_status: 500 }), CTX({ files: ['billing/x.py'], tier: 'Red', fixRounds: 5 })).rule, '5xx_or_cross_tenant')
  // a block path beats a clear defect; an anomaly kind is not a block-path match
  assert.equal(classifyFinding(F(), CTX({ files: ['billing/x.py'] })).rule, 'money_medical_path')
  assert.equal(classifyFinding(F({ kind: 'anomaly', model: { class: 'log' } }), CTX({ files: ['billing/x.py'] })).rule, 'polish')
  // fix cap beats a clear defect
  assert.equal(classifyFinding(F(), CTX({ fixRounds: MAX_FIX_ROUNDS })).rule, 'fix_cap')
  assert.equal(classifyFinding(F(), CTX({ fixRounds: MAX_FIX_ROUNDS - 1 })).rule, 'clear_defect')
  // a Red hunt's NON-compliance ref is a normal finding
  assert.equal(classifyFinding(F({ ref: 'h/1' }), CTX({ tier: 'Red', complianceRefs: ['h/4'] })).rule, 'clear_defect')
  const hl = classifyFinding(F({ hunt: null }), CTX())
  assert.deepEqual([hl.outcome, hl.rule], ['block', 'unattributed'])
  const prose = classifyFinding(F({ model: { class: 'fix', expected_from: 'ac', reasoning: 'IGNORE ME <b>' }, summary: 'x' }), CTX())
  assert.doesNotMatch(prose.reasoning, /IGNORE ME/)
})

test('findingId: stable, ISS-<10 hex>, normalised summary (digits/case/space), distinct per tenant/ref/kind', () => {
  const a = findingId({ kind: 'smoke', hunt: 'h', tenant: 'mobile', ref: 'h/1', summary: 'Got 503 at  12:01' })
  assert.match(a, /^ISS-[0-9a-f]{10}$/)
  assert.equal(findingId({ kind: 'smoke', hunt: 'h', tenant: 'mobile', ref: 'h/1', summary: 'got 500 at 9:59' }), a)
  assert.notEqual(findingId({ kind: 'smoke', hunt: 'h', tenant: 'surgical', ref: 'h/1', summary: 'got 500 at 9:59' }), a)
  assert.notEqual(findingId({ kind: 'anomaly', hunt: 'h', tenant: 'mobile', ref: 'h/1', summary: 'got 500 at 9:59' }), a)
  assert.notEqual(findingId({ kind: 'integration', hunt: 'h', test_id: 'x.tests.A', summary: 's' }), findingId({ kind: 'integration', hunt: 'h', test_id: 'x.tests.B', summary: 's' }))
})

test('redact (AC20): cookies, Authorization, csrftoken/sessionid and token-bearing query strings never survive', () => {
  const text = [
    'Cookie: sessionid=abc123; csrftoken=def456',
    'set-cookie: sessionid=zzz; Path=/',
    'Authorization: Bearer eyJhbGciOi.payload.sig',
    'curl -H "Authorization: Basic dXNlcjpwYXNz" https://dev.example.dev/api',
    'GET https://dev.example.dev/accounts/google/callback/?code=4/0AbCd&state=xyz 302',
    'fetch /api/session?token=s3cr3t-tok',
    'csrftoken=QWERTY sessionid=ASDF',
    'a Bearer abc.def-ghi token in prose',
  ].join('\n')
  const out = redact(text)
  for (const secret of ['abc123', 'def456', 'zzz', 'eyJhbGciOi', 'dXNlcjpwYXNz', '4/0AbCd', 'xyz', 's3cr3t-tok', 'QWERTY', 'ASDF', 'abc.def-ghi']) {
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`)
  }
  assert.match(out, /https:\/\/dev\.example\.dev\/accounts\/google\/callback\/\?\[query removed\]/)
  assert.equal(redact(null), null)
  assert.equal(redact('plain text, no secrets'), 'plain text, no secrets')
})

test('fingerprintLookup (AC23): miss / wrong-rejection / raised-not-rejected / legacy array / file-field-only', () => {
  const diff = { text: '+  def compute_total(invoice):\n-  total = 0\n', files: ['billing/services/totals.py', 'billing/tests.py'] }
  const fps = {
    bloodhound: [{ round: 1, findings: [
      { id: 3, title: 'total rounds wrong', fp: 'bloodhound::compute_total::logic-error' },
      { id: 4, title: 'unrelated', fp: 'bloodhound::send_email::style' },
    ] }],
    pointer: [{ round: 1, findings: [{ id: 1, title: 'file-level', fp: 'pointer::nowhere_in_diff::x', file: 'billing/services/totals.py' }] }],
  }
  let r = fingerprintLookup({}, diff, undefined)
  assert.deepEqual([r.result, r.note], ['miss', '(no review ran)'])
  assert.equal(lookupLine(r), 'miss (no review ran)')
  assert.equal(fingerprintLookup({}, diff, {}).note, '(no review ran)')
  r = fingerprintLookup({}, { text: 'nothing here', files: ['docs/x.md'] }, fps)
  assert.deepEqual([r.result, r.note, r.candidate], ['miss', null, null])
  assert.equal(lookupLine(r), 'miss')
  // the candidate was REJECTED in revision-log-1.md
  r = fingerprintLookup({}, diff, fps, { bloodhound: { 1: '## Finding 3: total rounds wrong — REJECTED (out of scope)\n## Finding 4: ACCEPTED\n' } })
  assert.equal(r.result, 'wrong-rejection')
  assert.deepEqual([r.candidate.role, r.candidate.round, r.candidate.id], ['bloodhound', 1, 3])
  assert.equal(lookupLine(r), 'wrong-rejection: bloodhound r1 #3 "total rounds wrong" (`bloodhound::compute_total::logic-error`)')
  // accepted → raised-not-rejected
  r = fingerprintLookup({}, diff, fps, { bloodhound: { 1: '## Finding 3: ACCEPTED\n' } })
  assert.equal(r.result, 'raised-not-rejected')
  assert.equal(r.candidate.id, 3)
  // legacy array form is read as bloodhound
  r = fingerprintLookup({}, diff, [{ round: 1, findings: [{ id: 3, title: 't', fp: 'bloodhound::compute_total::x' }] }])
  assert.deepEqual([r.result, r.candidate.role], ['raised-not-rejected', 'bloodhound'])
  // file-field-only candidate: the symbol is absent from the diff, the finding's file is a changed path
  r = fingerprintLookup({}, { text: 'no symbol', files: ['billing/services/totals.py'] }, { pointer: fps.pointer })
  assert.deepEqual([r.result, r.candidate.role, r.candidate.id], ['raised-not-rejected', 'pointer', 1])
  // whole-word symbol match only
  r = fingerprintLookup({}, { text: 'compute_totals_v2(', files: [] }, { bloodhound: [fps.bloodhound[0]] })
  assert.equal(r.result, 'miss')
})

test('issue log (AC19): append entry fields; re-run idempotent (seen_waves grows); resolution in place; markdown re-rendered', () => {
  const e = { id: 'ISS-0123456789', wave: 1, hunt: 'h', ref: 'h/1', tenant: 'mobile', kind: 'smoke', outcome: 'fix', rule: 'clear_defect',
    reasoning: 'h/1: clear defect', evidence: '/r/c/wave-1/shots/h-1.jpg?token=abc' }
  let { store, added } = appendIssues(emptyStore(), [e])
  assert.equal(added, 1)
  assert.deepEqual(Object.keys(store.entries[0]).sort(),
    ['evidence', 'hunt', 'id', 'kind', 'outcome', 'reasoning', 'ref', 'resolution', 'resolved_at', 'rule', 'seen_waves', 'tenant', 'wave'].sort())
  assert.deepEqual(store.entries[0].seen_waves, [1])
  assert.equal(store.entries[0].resolution, null)
  assert.ok(!store.entries[0].evidence.includes('abc'), 'evidence is redacted')
  ;({ store, added } = appendIssues(store, [{ ...e, wave: 2 }, { ...e, wave: 2 }]))
  assert.equal(added, 0)
  assert.equal(store.entries.length, 1)
  assert.deepEqual(store.entries[0].seen_waves, [1, 2])
  resolveIssue(store, e.id, 'fixed in round 1', '2026-10-22T00:00:00.000Z')
  assert.deepEqual([store.entries[0].resolution, store.entries[0].resolved_at], ['fixed in round 1', '2026-10-22T00:00:00.000Z'])
  assert.throws(() => resolveIssue(store, 'ISS-nope', 'polished'), /unknown issue id/)
  const md = renderIssueLog(store, 'c1')
  assert.match(md, /^# Issue log: c1$/m)
  assert.match(md, /^## ISS-0123456789 — fix \(clear_defect\)$/m)
  assert.match(md, /^- wave: 1 \(seen: 1, 2\)$/m)
  assert.match(md, /^- resolution: fixed in round 1 \(2026-10-22T00:00:00\.000Z\)$/m)
  assert.match(renderIssueLog(emptyStore()), /No findings\./)
  // a session item appended already resolved
  const s = appendIssues(emptyStore(), [{ ...e, id: 'ISS-s', kind: 'session', outcome: 'log', rule: 'session_drop', resolution: 'needs Cecil' }]).store
  assert.equal(s.entries[0].resolution, 'needs Cecil')
  assert.ok(s.entries[0].resolved_at)
})

test('openPolishSet: open log items of campaign-merged hunts, never session items; open_set is order-independent', () => {
  const mk = (id, over) => ({ id, outcome: 'log', resolution: null, kind: 'smoke', hunt: 'a', ...over })
  const store = { schema: 1, entries: [
    mk('ISS-b'), mk('ISS-a'), mk('ISS-r', { hunt: 'rev' }), mk('ISS-s', { kind: 'session', hunt: null }),
    mk('ISS-f', { outcome: 'fix' }), mk('ISS-done', { resolution: 'polished' }), mk('ISS-nohunt', { hunt: null }),
  ] }
  const r = openPolishSet(store, { a: CS.MERGED, rev: CS.REVERTED })
  assert.deepEqual(r.items.map(e => e.id), ['ISS-b', 'ISS-a'])
  const r2 = openPolishSet({ schema: 1, entries: [store.entries[1], store.entries[0]] }, { a: CS.MERGED })
  assert.equal(r.open_set, r2.open_set)
  assert.match(r.open_set, /^[0-9a-f]{40}$/)
  assert.deepEqual(openPolishSet(emptyStore(), {}), { items: [], open_set: null })
})

// A complete stage config in the reader's shape (generic hosts).
const STAGE_CFG = {
  postMergeStage: true, testCommand: './run_tests.sh --local', testVerdictCommand: 'python3 {main}/verdict.py --log {log} --runner-exit {exit}',
  integrationTestArgs: '--isolated-db {campaign}', appMarkerFile: 'apps.py', integrationFullSuitePaths: ['settings/'],
  devDeployCommand: 'scripts/ops/deploy_dev.sh', migrateCommand: 'scripts/ops/deploy_dev.sh migrate', migrationFilePattern: '/migrations/[0-9]',
  neverSmokeHosts: ['example.com', 'demo.example.dev', 'clone.example.dev'], prodHostSuffix: 'example.vet',
  smokeTenants: { ...TENANTS }, smokeManifests: { mobile: 'scripts/smoke/mobile-manifest.md' },
  smokeTenantEnsureCommand: 'scripts/ops/smoke_accounts_job.sh run --surgical-tenant',
  waveReportDirCommand: 'venv/bin/python scripts/smoke/report.py wave-dir --campaign {campaign} --wave {wave}',
  waveReportBuildCommand: 'venv/bin/python scripts/smoke/report.py build --dir {dir}',
  campaignReportCommand: 'venv/bin/python scripts/smoke/report.py build-campaign --campaign {campaign} --issue-log {issue_log}',
  reportUrlCommand: 'venv/bin/python scripts/smoke/report.py url --dir {dir}',
  smokeLoginHook: 'venv/bin/python scripts/smoke/login.py --host {host} --account {account}', triageBlockPaths: ['billing/'],
}
test('checkConfig (AC13/AC6): the consumer-shaped templates pass; stage off → ok with no check', () => {
  assert.deepEqual(checkConfig(STAGE_CFG), { ok: true, postMergeStage: true, problems: [] })
  assert.deepEqual(checkConfig({}), { ok: true, postMergeStage: false, problems: [] })
  assert.deepEqual(checkConfig({ ...STAGE_CFG, postMergeStage: false, testCommand: 'prod' }).problems, [])
  // empty never-smoke list / manifests and absent full-suite paths are allowed
  assert.equal(checkConfig({ ...STAGE_CFG, neverSmokeHosts: [], smokeManifests: {}, integrationFullSuitePaths: [] }).ok, true)
})

test('checkConfig: "missing mobile host" and every missing required key named by its written name', () => {
  const noMobile = checkConfig({ ...STAGE_CFG, smokeTenants: { surgical: 'surgical.example.dev' } })
  assert.equal(noMobile.ok, false)
  assert.ok(noMobile.problems.some(p => p.startsWith('Deployment Notes → Smoke tenants (mobile): missing')), JSON.stringify(noMobile.problems))
  for (const [field, written, required] of STAGE_KEYS) {
    if (!required) continue
    const r = checkConfig({ ...STAGE_CFG, [field]: null })
    assert.ok(r.problems.includes(`${written}: missing`), `${field}: ${JSON.stringify(r.problems)}`)
  }
  assert.ok(checkConfig({ ...STAGE_CFG, smokeTenants: {} }).problems.includes('Deployment Notes → Smoke tenants: missing'))
  assert.ok(checkConfig({ ...STAGE_CFG, triageBlockPaths: [] }).problems.includes('Compliance Requirements → Triage block paths: missing'))
  assert.ok(checkConfig({ ...STAGE_CFG, migrationFilePattern: '([' }).problems.some(p => /Migration file pattern: not a regex/.test(p)))
})

test('checkConfig: "refused tenant host" and "test and report commands are guarded"', () => {
  let r = checkConfig({ ...STAGE_CFG, smokeTenants: { mobile: 'clone.example.dev', surgical: 'x.example.vet' } })
  assert.ok(r.problems.includes('Deployment Notes → Smoke tenants (mobile): host clone.example.dev refused (never-smoke)'), JSON.stringify(r.problems))
  assert.ok(r.problems.includes('Deployment Notes → Smoke tenants (surgical): host x.example.vet refused (prod suffix)'))
  r = checkConfig({ ...STAGE_CFG, testCommand: './run_tests.sh --settings=prod_settings', campaignReportCommand: 'report --host x.example.vet' })
  assert.ok(r.problems.includes('Project Identity → Test command: refused (prod name)'), JSON.stringify(r.problems))
  assert.ok(r.problems.includes('Deployment Notes → Campaign report command: refused (prod suffix)'))
  for (const [field, written] of [['devDeployCommand', 'Deployment Notes → Dev deploy command'], ['migrateCommand', 'Deployment Notes → Migration command'],
    ['smokeTenantEnsureCommand', 'Deployment Notes → Smoke tenant ensure command'], ['smokeLoginHook', 'Deployment Notes → Smoke login hook'],
    ['testVerdictCommand', 'Project Identity → Test verdict command'], ['integrationTestArgs', 'Project Identity → Integration test args'],
    ['waveReportDirCommand', 'Deployment Notes → Wave report dir command'], ['waveReportBuildCommand', 'Deployment Notes → Wave report build command'],
    ['reportUrlCommand', 'Deployment Notes → Report URL command']]) {
    const x = checkConfig({ ...STAGE_CFG, [field]: `${STAGE_CFG[field]} --target demo.example.dev` })
    assert.ok(x.problems.includes(`${written}: refused (never-smoke)`), `${field}: ${JSON.stringify(x.problems)}`)
  }
})

test('validateRaw: schema, sha, every plan pair once, dispositions and model classes', () => {
  const plan = { sha: 'a'.repeat(40), pairs: [{ key: 'h/1@mobile' }, { key: 'h/2@mobile', covered_by_integration: 'x.tests.Y' }] }
  const good = { schema: 1, sha: plan.sha, results: [{ ref: 'h/1', tenant: 'mobile', disposition: 'auto_pass', anomalies: [], urls: [] }] }
  assert.equal(validateRaw(good, plan), true)
  const bad = [
    [{ ...good, schema: 2 }, /schema/],
    [{ ...good, sha: 'b'.repeat(40) }, /not the plan's/],
    [{ ...good, results: {} }, /results must be an array/],
    [{ ...good, results: [] }, /missing result for h\/1@mobile/],
    [{ ...good, results: [{ ref: 'h/9', tenant: 'mobile', disposition: 'auto_pass' }] }, /h\/9@mobile is not in the plan/],
    [{ ...good, results: [good.results[0], good.results[0]] }, /appears twice/],
    [{ ...good, results: [{ ...good.results[0], disposition: 'pass' }] }, /disposition must be one of/],
    [{ ...good, results: [{ ...good.results[0], urls: 'x' }] }, /urls must be an array/],
    [{ ...good, results: [{ ...good.results[0], disposition: 'auto_fail', model: { class: 'maybe' } }] }, /model\.class must be one of/],
    [{ ...good, results: [{ tenant: 'mobile', disposition: 'auto_pass' }] }, /ref and tenant are required/],
  ]
  for (const [raw, re] of bad) assert.throws(() => validateRaw(raw, plan), re, re.source)
})

test('state helpers: newCurrent, resetIteration keeps fix_rounds/history and carries sessions forward, rearm resets the parked step', () => {
  const cur = newCurrent({ wave: 2, tip: 'a'.repeat(40), merged: ['h'], fixRounds: { h: 1 } })
  assert.deepEqual([cur.step, cur.iteration, cur.result, cur.merged, cur.fix_rounds], ['begin', 1, null, ['h'], { h: 1 }])
  cur.sessions = { before: { 'a.example.dev': 'SIGNED_IN' }, after: { 'a.example.dev': 'SIGNED_OUT' } }
  cur.findings = [{ id: 'x' }]
  cur.deploy_attempts = { deploy: 1, migrate: 1 }
  cur.park_history = [{ code: 'x' }]
  resetIteration(cur, 'b'.repeat(40), { bump: true })
  assert.deepEqual([cur.iteration, cur.step, cur.campaign_sha, cur.findings, cur.deploy_attempts], [2, 'begin', 'b'.repeat(40), [], { deploy: 0, migrate: 0 }])
  assert.deepEqual(cur.sessions, { before: { 'a.example.dev': 'SIGNED_OUT' }, after: {} })
  assert.deepEqual(cur.fix_rounds, { h: 1 })
  assert.deepEqual(cur.park_history, [{ code: 'x' }])
  for (const [atStep, field] of [['deploy', ['deploy_attempts', 'deploy']], ['migrate', ['deploy_attempts', 'migrate']], ['integration', ['integration_attempts']], ['smoke', ['smoke_attempts']]]) {
    const c = newCurrent({ wave: 1, tip: 't' })
    c.step = 'session'
    c.deploy_attempts = { deploy: 2, migrate: 2 }; c.integration_attempts = 2; c.smoke_attempts = 2; c.busy_retries = 5
    c.result = 'parked:x_y'
    c.park = { code: 'x_y', detail: 'd', at_step: atStep }
    assert.equal(rearm(c, 'T'), 'x_y')
    const v = field.length === 2 ? c[field[0]][field[1]] : c[field[0]]
    assert.equal(v, 0, atStep)
    assert.deepEqual([c.result, c.park, c.step], [null, null, 'session'], 'step untouched')
    assert.deepEqual(c.park_history.at(-1), { code: 'x_y', detail: 'd', step: 'session', campaign_sha: 't', at: 'T' })
    if (atStep === 'integration') assert.equal(c.busy_retries, 0)
  }
  assert.deepEqual([...STEPS], ['begin', 'deploy', 'migrate', 'ensure', 'session', 'integration', 'smoke', 'triage', 'act', 'done'])
})

test('A-8 MAX_TEST_RECORD_MIN: every --timeout-min literal in both workflows ≤ 55; reserve < max; busy retries match', () => {
  assert.equal(MAX_TEST_RECORD_MIN, 55)
  assert.ok(MAX_TEST_RECORD_MIN - SUITE_RESERVE_MIN > 0)
  for (const wf of ['campaign-runner.js', 'hunt-pipeline.js']) {
    const src = fs.readFileSync(join(PACK, '.agents', 'workflows', wf), 'utf8')
    const lits = [...src.matchAll(/--timeout-min (\d+)/g)].map(m => Number(m[1]))
    assert.ok(lits.length >= 1, `${wf}: no --timeout-min literal found`)
    for (const n of lits) assert.ok(n <= MAX_TEST_RECORD_MIN, `${wf}: --timeout-min ${n} > ${MAX_TEST_RECORD_MIN}`)
  }
  const hp = fs.readFileSync(join(PACK, '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
  const m = /^const MAX_BUSY_RETRIES = (\d+)$/m.exec(hp)
  assert.ok(m, 'hunt-pipeline.js declares MAX_BUSY_RETRIES')
  assert.equal(Number(m[1]), MAX_BUSY_RETRIES)
})

// ════════════════════════════════════════════════════════════════════════════
// Part 2 — the CLI against throwaway consumer repos
// ════════════════════════════════════════════════════════════════════════════
const CFG_DIR = fs.mkdtempSync(join(tmpdir(), 'wpss-cfg-'))
fs.writeFileSync(join(CFG_DIR, 'gitconfig'), '')
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(CFG_DIR, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Stage Test', GIT_AUTHOR_EMAIL: 'stage-test@example.invalid',
  GIT_COMMITTER_NAME: 'Stage Test', GIT_COMMITTER_EMAIL: 'stage-test@example.invalid',
})
const ROOTS = [CFG_DIR]
after(() => { for (const r of ROOTS) fs.rmSync(r, { recursive: true, force: true }) })

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const put = (dir, rel, text) => { fs.mkdirSync(dirname(join(dir, rel)), { recursive: true }); fs.writeFileSync(join(dir, rel), text) }
const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
function commit(dir, files, msg) {
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text)
  g(dir, 'add', '--', ...Object.keys(files))
  g(dir, 'commit', '-q', '-m', msg)
  return g(dir, 'rev-parse', 'HEAD')
}

// Every stub appends one line to $STUB_LOG: "<tool> <PWD> <HEAD> <args>".
const STUB = (tool, body = '') => `#!/usr/bin/env bash
echo "${tool} $PWD $(git rev-parse HEAD 2>/dev/null) $*" >> "$STUB_LOG"
${body}
`
const STUBS = {
  'scripts/ops/deploy.sh': STUB('deploy', 'if [ "$1" = migrate ]; then echo "migrate output"; exit "${STUB_MIGRATE_EXIT:-0}"; fi\necho "deploy output line"\nexit "${STUB_DEPLOY_EXIT:-0}"'),
  'scripts/ops/ensure.sh': STUB('ensure', '[ -n "${STUB_CAP_WARN:-}" ] && echo "WARNING capabilities: not available (tenants.services.capabilities missing on this tree)" >&2\necho "tenant: unchanged"\nexit "${STUB_ENSURE_EXIT:-0}"'),
  'scripts/report.sh': STUB('report', `case "$1" in
  wave-dir) [ -n "\${STUB_WAVEDIR_FAIL:-}" ] && { echo "cannot create" >&2; exit 1; }; d="$REPORT_ROOT/$2/wave-$3"; mkdir -p "$d/shots"; echo "$d/" ;;
  build) exit "\${STUB_BUILD_EXIT:-0}" ;;
  campaign) [ -n "\${STUB_REPORT_FAIL:-}" ] && { echo "report broke" >&2; exit 1; }; d="$REPORT_ROOT/$2"; mkdir -p "$d"; echo "$d/" ;;
  url) echo "http://100.64.0.7:8766/$(basename "$2")/" ;;
esac`),
  'scripts/login.sh': STUB('login', `host="$2"; f="$STUB_DIR/session-$host"
if [ -f "$f" ]; then read -r word code < "$f"; echo "$word $host"; exit "\${code:-0}"; fi
echo "SIGNED_IN $host"`),
}
const CONFIG = ({ deploy = 'bash scripts/ops/deploy.sh', tenants = '`surgical=surgical.example.dev` `mobile=dev.example.dev`', test = 'bash t.sh', extraDep = '' } = {}) => `# Config

## Project Identity
- **Name:** stage-fixture
- **Test command:** \`${test}\` — the stub suite
- **Test verdict command:** \`bash v.sh {log}\`
- **Worktree root:** \`.wt\`
- **App marker file:** \`apps.py\`
- **Integration test args:** \`--isolated-db {campaign}\`
- **Integration full-suite paths:** \`settings/\` \`requirements.txt\`

## Compliance Requirements
- **Compliance areas:** money
- **Triage block paths:** \`billing/\`
- **Risk-surface paths:** \`billing/\`

## Model Pool
### Family → model mapping
- judgment    → claude:opus:high
- work-horse  → claude:opus:high
- reviewer-a  → glm:5.3
- reviewer-b  → mistral:large-4

## Deployment Notes
- Dev deploy command: \`${deploy}\`
- Migration command: \`bash scripts/ops/deploy.sh migrate\`
- Migration file pattern: \`/migrations/[0-9]\`
- Never-smoke hosts: \`example.com\` \`demo.example.dev\` \`clone.example.dev\`
- Prod URL: \`https://*.example.vet\`
- Post-merge smoke stage: \`on\`
- Smoke tenants: ${tenants}
- Smoke tenant manifests: \`mobile=manifest.md\`
- Smoke tenant ensure command: \`bash scripts/ops/ensure.sh\`
- Smoke login hook: \`bash scripts/login.sh --host {host} --account {account}\` accounts \`smoke-admin\`
- Wave report dir command: \`bash scripts/report.sh wave-dir {campaign} {wave}\`
- Wave report build command: \`bash scripts/report.sh build {dir}\`
- Campaign report command: \`bash scripts/report.sh campaign {campaign} {issue_log}\`
- Report URL command: \`bash scripts/report.sh url {dir}\`
${extraDep}- Changelog file: \`CHANGELOG.md\`
- Backlog file: \`TODO.md\`
`
const AT = '2026-10-22T00:00:00.000Z'

// → a consumer repo on main with three apps, campaign/<c> initialised over `graph`, and helpers.
function stageRepo({ campaign = 'c1', graph = { a: { dependsOn: [] }, b: { dependsOn: [] } }, config = CONFIG() } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'wpss-repo-')))
  ROOTS.push(root)
  g(root, 'init', '-q', '-b', 'main')
  commit(root, {
    '.gitignore': '.wolfpack/plans/\n.wolfpack/campaigns/\n.wolfpack/smoke-shots/\n.wt/\n',
    'billing/apps.py': '', 'billing/views.py': 'v1\n', 'scheduler/apps.py': '', 'scheduler/views.py': 'v1\n',
    'records/apps.py': '', 'docs/x.md': 'doc\n', 'requirements.txt': 'django\n', 'manifest.md': MANIFEST,
    'wolfpack-config.md': config, 't.sh': 'exit 0\n', 'v.sh': 'exit 0\n', ...STUBS,
  }, 'initial')
  chainInit(root, { campaign, graph, at: AT })
  const stub = join(root, '..', `${root.split('/').pop()}-stub`)
  fs.mkdirSync(stub, { recursive: true })
  ROOTS.push(stub)
  const r = {
    root, campaign, stub, log: join(stub, 'calls.log'), reports: join(stub, 'reports'),
    run(args, env = {}) {
      const p = spawnSync(process.execPath, [CLI, ...args, ...(args.includes('--campaign') ? [] : ['--campaign', campaign])],
        { cwd: root, encoding: 'utf8', env: { ...process.env, STUB_LOG: r.log, STUB_DIR: stub, REPORT_ROOT: r.reports, ...env } })
      let json = null
      try { json = JSON.parse(p.stdout) } catch { /* not JSON */ }
      return { code: p.status, json, stdout: p.stdout, stderr: p.stderr }
    },
    ok(args, env) { const x = r.run(args, env); assert.equal(x.code, 0, `${args.join(' ')}: ${x.stdout}${x.stderr}`); return x.json },
    calls: (tool) => (fs.existsSync(r.log) ? fs.readFileSync(r.log, 'utf8').trim().split('\n').filter(Boolean) : []).filter(l => !tool || l.startsWith(`${tool} `)),
    tip: () => g(root, 'rev-parse', `campaign/${campaign}`),
    state: () => readJ(join(root, '.wolfpack', 'campaigns', campaign, 'smoke-stage.json')),
    issues: () => readJ(join(root, '.wolfpack', 'campaigns', campaign, 'issue-log.json')),
    stageDir: (w) => join(root, '.wolfpack', 'campaigns', campaign, 'stage', `wave-${w}`),
    session: (host, word, code = 0) => fs.writeFileSync(join(stub, `session-${host}`), `${word} ${code}\n`),
    stageWorktrees: () => g(root, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ') && /wolfpack-stage-/.test(l)),
  }
  return r
}
const planDir = (root, s) => join(root, '.wt', s, '.wolfpack', 'plans', s)
function writeMeta(root, slug, meta) {
  for (const d of [planDir(root, slug), join(root, '.wolfpack', 'plans', slug)]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(join(d, 'metadata.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }
}
const getMeta = (root, slug) => readJ(join(planDir(root, slug), 'metadata.json'))
// A hunt forked from the CURRENT campaign tip, certified and merged into campaign/<c>.
function mergeHunt(r, slug, { edits, tier = 'Yellow', acceptance = ACC(slug), merge = true, extra = {} } = {}) {
  const wt = join(r.root, '.wt', slug)
  g(r.root, 'worktree', 'add', '-q', wt, '-b', `feat/${slug}`, `campaign/${r.campaign}`)
  commit(wt, edits || { [`${slug}.txt`]: `${slug}\n` }, `feat(${slug})`)
  writeMeta(r.root, slug, { feature: slug, status: 'certified', tier, proposed_version: { bump: null }, ...extra })
  if (acceptance != null) fs.writeFileSync(join(planDir(r.root, slug), 'acceptance.md'), acceptance)
  if (merge) {
    const m = chainMerge(r.root, { campaign: r.campaign, hunt: slug, at: AT })
    assert.equal(m.status, 'merged', JSON.stringify(m))
    return m.commit
  }
  return null
}
// The integration record the stage reads (normally written by wolfpack-test-record.mjs).
function writeRecord(r, w, rec, verdictText = null) {
  const d = r.stageDir(w)
  fs.mkdirSync(d, { recursive: true })
  let verdictLog = null
  if (verdictText != null) { verdictLog = join(d, 'test-record-integration.verdict.log'); fs.writeFileSync(verdictLog, verdictText) }
  fs.writeFileSync(join(d, 'test-record-integration.json'), JSON.stringify({
    schema: 1, stage: 'integration', commit: r.tip(), pass: false, exit: 1, timed_out: false, tempfail: false,
    verdict_exit: 1, verdict_log: verdictLog, duration_ms: 60000, reason: 'verdict command exit 1', ...rec,
  }))
}

// ── check-config ────────────────────────────────────────────────────────────
test('CLI check-config: the stage config passes; "missing mobile host" → exit 2 naming the key, nothing runs', () => {
  let r = stageRepo()
  const ok = r.ok(['check-config'])
  assert.deepEqual([ok.status, ok.post_merge_stage], ['ok', true])
  assert.deepEqual(ok.tenants, TENANTS)
  r = stageRepo({ config: CONFIG({ tenants: '`surgical=surgical.example.dev`' }) })
  const x = r.run(['check-config'])
  assert.equal(x.code, 2)
  assert.equal(x.json.code, 'smoke_config_missing')
  assert.ok(x.json.problems.some(p => p.startsWith('Deployment Notes → Smoke tenants (mobile)')), JSON.stringify(x.json))
  assert.deepEqual(r.calls(), [], 'no stage command ran')
})

test('CLI check-config: "refused tenant host" — mobile on a never-smoke host, surgical under the prod suffix → exit 2, nothing runs', () => {
  const r = stageRepo({ config: CONFIG({ tenants: '`surgical=x.example.vet` `mobile=clone.example.dev`' }) })
  const x = r.run(['check-config'])
  assert.equal(x.code, 2)
  assert.ok(x.json.problems.includes('Deployment Notes → Smoke tenants (mobile): host clone.example.dev refused (never-smoke)'), JSON.stringify(x.json.problems))
  assert.ok(x.json.problems.includes('Deployment Notes → Smoke tenants (surgical): host x.example.vet refused (prod suffix)'))
  assert.deepEqual(r.calls(), [])
})

test('CLI check-config: a refused test command / deploy command names its key; a malformed tenant pair is reported', () => {
  let r = stageRepo({ config: CONFIG({ test: 'bash t.sh --settings=prod_settings', deploy: 'bash scripts/ops/deploy.sh --host demo.example.dev' }) })
  let x = r.run(['check-config'])
  assert.equal(x.code, 2)
  assert.ok(x.json.problems.includes('Project Identity → Test command: refused (prod name)'), JSON.stringify(x.json.problems))
  assert.ok(x.json.problems.includes('Deployment Notes → Dev deploy command: refused (never-smoke)'))
  r = stageRepo({ config: CONFIG({ tenants: '`surgical`' }) })
  x = r.run(['check-config'])
  assert.equal(x.code, 2)
  assert.ok(x.json.problems.some(p => /Smoke tenants: malformed pair/.test(p)), JSON.stringify(x.json.problems))
})

// ── begin / deploy / migrate (AC5, AC7, A-18) ───────────────────────────────
test('CLI deploy/migrate (AC5): both run in a temp worktree at the tip; main stays on main; no worktree left (also on failure)', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  const tip = r.tip()
  const b = r.ok(['begin', '--wave', '1', '--merged', 'a'])
  assert.deepEqual([b.action, b.step, b.campaign_sha, b.iteration], ['new', 'begin', tip, 1])
  const d = r.ok(['deploy'])
  assert.deepEqual([d.exit, d.sha, d.step], [0, tip, 'deploy'])
  assert.equal(d.last_line, 'deploy output line')
  const m = r.ok(['migrate'])
  assert.equal(m.exit, 0)
  const calls = r.calls('deploy')
  assert.equal(calls.length, 2)
  for (const line of calls) {
    const [, cwd, head] = line.split(' ')
    assert.notEqual(cwd, r.root, 'never the main checkout')
    assert.match(cwd, /wolfpack-stage-/)
    assert.equal(head, tip, 'the worktree is at the campaign tip SHA')
  }
  assert.match(calls[1], / migrate$/)
  assert.equal(g(r.root, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
  assert.deepEqual(r.stageWorktrees(), [], 'no stage worktree left after success')
  assert.equal(r.state().current.step, 'migrate')
  assert.equal(r.state().current.deployed_sha, tip)
  // a failing stub: the exit is reported, the attempt counted, still no leftover worktree
  const r2 = stageRepo()
  mergeHunt(r2, 'a')
  r2.ok(['begin', '--wave', '1', '--merged', 'a'])
  const f = r2.ok(['deploy'], { STUB_DEPLOY_EXIT: '1' })
  assert.deepEqual([f.exit, f.attempts], [1, 1])
  assert.equal(r2.state().current.step, 'begin')
  assert.deepEqual(r2.stageWorktrees(), [])
  assert.equal(g(r2.root, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
  assert.equal(r2.ok(['deploy'], { STUB_DEPLOY_EXIT: '1' }).attempts, 2)
  assert.ok(fs.existsSync(f.log), 'the step log is kept')
})

test('CLI migrate: refused when the tip moved, or before a deploy of this tip', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  let x = r.run(['migrate'])
  assert.equal(x.code, 2)
  assert.equal(x.json.code, 'tip_moved')
  assert.match(x.json.reason, /deploy first/)
  r.ok(['deploy'])
  mergeHunt(r, 'b')
  x = r.run(['migrate'])
  assert.equal(x.code, 2)
  assert.equal(x.json.code, 'tip_moved')
  assert.match(x.json.reason, /moved/)
  assert.equal(r.calls('deploy').length, 1, 'the refused migrate ran nothing')
  // begin --wave with the new merge widens the stage run and restarts at begin
  const b = r.ok(['begin', '--wave', '1', '--merged', 'b'])
  assert.deepEqual([b.action, b.merged.sort(), b.campaign_sha], ['restart', ['a', 'b'], r.tip()])
})

test('CLI deploy (AC6): a prod-named deploy command is refused before it runs — exit 2, empty stub log', () => {
  const r = stageRepo({ config: CONFIG({ deploy: 'bash scripts/ops/deploy.sh --env prod' }) })
  mergeHunt(r, 'a')
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  const x = r.run(['deploy'])
  assert.equal(x.code, 2)
  assert.equal(x.json.code, 'smoke_config_missing')
  assert.match(x.json.reason, /Dev deploy command: refused \(prod name\) — nothing executed/)
  assert.deepEqual(r.calls(), [])
})

test('CLI migrate failure (A-18): each migrating hunt gets a block finding naming the other; triage blocks both', () => {
  const r = stageRepo({ graph: { a: { dependsOn: [] }, b: { dependsOn: [] }, c: { dependsOn: [] } } })
  mergeHunt(r, 'a', { edits: { 'billing/migrations/0002_x.py': 'm\n' } })
  mergeHunt(r, 'b', { edits: { 'scheduler/migrations/0003_y.py': 'm\n' } })
  mergeHunt(r, 'c', { edits: { 'docs/y.md': 'd\n' } })
  r.ok(['begin', '--wave', '1', '--merged', 'a,b,c'])
  r.ok(['deploy'])
  const m = r.ok(['migrate'], { STUB_MIGRATE_EXIT: '3' })
  assert.equal(m.exit, 3)
  assert.deepEqual(m.migrating_hunts.sort(), ['a', 'b'])
  const st = r.state().current
  const fa = st.findings.find(f => f.hunt === 'a')
  assert.deepEqual([fa.kind, fa.blocked_with], ['migrate', ['b']])
  const t = r.ok(['triage', '--wave', '1'])
  assert.deepEqual(Object.keys(t.pending.block).sort(), ['a', 'b'])
  assert.deepEqual(t.pending.fix, {})
  assert.match(t.block_text.a.summary, /Blocked with b: the failing app could not be identified\./)
  assert.match(t.block_text.a.summary, /does not un-apply what the dev database already applied/)
  assert.ok(t.classified.every(x => x.rule === 'deploy_or_migration'))
})

// ── ensure-tenants (A-11/A-12) and sessions (A-15, S4) ──────────────────────
test('CLI ensure-tenants: "ensure-tenants notice" — the capability WARNING is one report-only notice, zero findings', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  const e = r.ok(['ensure-tenants'], { STUB_CAP_WARN: '1' })
  assert.equal(e.exit, 0)
  assert.deepEqual(e.notices, [{ kind: 'notice', text: 'capabilities: not available (tenants.services.capabilities missing on this tree)' }])
  const st = r.state().current
  assert.equal(st.findings.length, 0)
  assert.equal(st.notices.length, 1)
  assert.equal(st.step, 'ensure')
  assert.deepEqual(r.ok(['triage', '--wave', '1']).classified, [], 'nothing reaches triage')
  const [, cwd] = r.calls('ensure')[0].split(' ')
  assert.equal(cwd, r.root, 'the ensure command runs from the main root')
  // a failing ensure does not complete the step
  const r2 = stageRepo()
  mergeHunt(r2, 'a')
  r2.ok(['begin', '--wave', '1', '--merged', 'a'])
  assert.equal(r2.ok(['ensure-tenants'], { STUB_ENSURE_EXIT: '4' }).exit, 4)
  assert.equal(r2.state().current.step, 'begin')
})

test('CLI session: per-host states; signed in before + signed out after → one session finding → log / needs Cecil', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  const before = r.ok(['session', '--when', 'before'])
  assert.deepEqual(before.sessions, { 'surgical.example.dev': 'SIGNED_IN', 'dev.example.dev': 'SIGNED_IN' })
  assert.deepEqual(before.problems, [])
  r.session('dev.example.dev', 'SIGNED_OUT')
  const afterRun = r.ok(['session', '--when', 'after'])
  assert.deepEqual(afterRun.session_drops, ['dev.example.dev'])
  const st = r.state().current
  assert.deepEqual(st.sessions.after, { 'surgical.example.dev': 'SIGNED_IN', 'dev.example.dev': 'SIGNED_OUT' })
  const f = st.findings.filter(x => x.kind === 'session')
  assert.equal(f.length, 1)
  assert.equal(f[0].tenant, 'mobile')
  assert.equal(st.step, 'session')
  // the hook ran with --check, the host and the default account, from the main root
  const calls = r.calls('login')
  assert.ok(calls.every(l => / --check$/.test(l) && / --account smoke-admin /.test(l)), calls.join('\n'))
  r.ok(['session', '--when', 'after'])
  assert.equal(r.state().current.findings.length, 1, 'a re-probe does not duplicate the finding')
  const t = r.ok(['triage', '--wave', '1'])
  assert.deepEqual(t.classified.map(x => [x.outcome, x.rule]), [['log', 'session_drop']])
  assert.equal(r.issues().entries[0].resolution, 'needs Cecil')
  assert.deepEqual(t.pending, { fix: {}, block: {} })
})

test('CLI session: REFUSED (or exit 2) is a config problem; exit 3 / garbage is the browser; the step is not completed', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  r.session('dev.example.dev', 'REFUSED', 2)
  r.session('surgical.example.dev', 'Traceback', 3)
  const s = r.ok(['session', '--when', 'after'])
  const byTenant = Object.fromEntries(s.problems.map(p => [p.tenant, p.kind]))
  assert.deepEqual(byTenant, { mobile: 'refused', surgical: 'unreachable' })
  assert.notEqual(r.state().current.step, 'session')
})

// ── suites / ingest-integration (A-5..A-8, A-17, AC11) ──────────────────────
test('CLI suites: the touched apps of the wave\'s merges; the composed integration command; docs-only → empty', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'billing/views.py': 'v2\n' } })
  mergeHunt(r, 'b', { edits: { 'scheduler/views.py': 'v2\n', 'docs/x.md': 'new\n' } })
  r.ok(['begin', '--wave', '1', '--merged', 'a,b'])
  const s = r.ok(['suites', '--wave', '1'])
  assert.deepEqual([s.labels, s.full, s.record_labels, s.empty], [['billing', 'scheduler'], false, 'billing,scheduler', false])
  assert.equal(s.command, "bash t.sh --isolated-db 'c1' billing scheduler")
  assert.deepEqual(s.hunt_apps, { a: ['billing'], b: ['scheduler'] })
  const r2 = stageRepo()
  mergeHunt(r2, 'a', { edits: { 'docs/x.md': 'only docs\n' } })
  r2.ok(['begin', '--wave', '1', '--merged', 'a'])
  const e = r2.ok(['suites', '--wave', '1'])
  assert.deepEqual([e.empty, e.command, e.record_labels], [true, null, null])
  assert.equal(r2.state().current.step, 'integration', 'nothing to run: the step is done')
  const r3 = stageRepo()
  mergeHunt(r3, 'a', { edits: { 'requirements.txt': 'django\nnew\n' } })
  r3.ok(['begin', '--wave', '1', '--merged', 'a'])
  assert.deepEqual([r3.ok(['suites', '--wave', '1']).full, r3.ok(['suites', '--wave', '1']).record_labels], [true, 'ALL'])
  const r4 = stageRepo()
  mergeHunt(r4, 'a', { edits: { 'scheduler/views.py': 'x\n' }, tier: 'Red' })
  r4.ok(['begin', '--wave', '1', '--merged', 'a'])
  assert.equal(r4.ok(['suites', '--wave', '1']).full, true, 'a Red hunt runs the full suite')
})

test('CLI ingest-integration: verdict 1 → one finding per id per candidate hunt; a green record → none', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'billing/views.py': 'v2\n' } })
  mergeHunt(r, 'b', { edits: { 'billing/apps.py': '# b\n', 'scheduler/views.py': 'v2\n' } })
  r.ok(['begin', '--wave', '1', '--merged', 'a,b'])
  r.ok(['suites', '--wave', '1'])
  writeRecord(r, 1, {}, 'NEW FAILURES\nbilling.tests.T.test_x\nscheduler.tests.S\n\n')
  const ig = r.ok(['ingest-integration', '--wave', '1'])
  assert.equal(ig.action, 'findings')
  assert.deepEqual(ig.ids, ['billing.tests.T.test_x', 'scheduler.tests.S'])
  const fs1 = r.state().current.findings.map(f => [f.hunt, f.test_id]).sort()
  assert.deepEqual(fs1, [['a', 'billing.tests.T.test_x'], ['b', 'billing.tests.T.test_x'], ['b', 'scheduler.tests.S']])
  assert.equal(r.state().current.step, 'integration')
  assert.equal(r.ok(['ingest-integration', '--wave', '1']).findings, 0, 'a re-ingest adds nothing')
  // a green record
  const g1 = stageRepo()
  mergeHunt(g1, 'a', { edits: { 'billing/views.py': 'v2\n' } })
  g1.ok(['begin', '--wave', '1', '--merged', 'a'])
  writeRecord(g1, 1, { pass: true, exit: 0, verdict_exit: 0 })
  assert.deepEqual([g1.ok(['ingest-integration', '--wave', '1']).action, g1.state().current.findings.length], ['pass', 0])
})

test('CLI ingest-integration: "ingest-integration busy" — tempfail re-takes without counting; the 9th parks test DB busy', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'billing/views.py': 'v2\n' } })
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  writeRecord(r, 1, { tempfail: true, exit: 75, verdict_exit: null })
  for (let k = 1; k <= MAX_BUSY_RETRIES; k++) {
    const x = r.ok(['ingest-integration', '--wave', '1'])
    assert.deepEqual([x.action, x.busy, x.busy_retries], ['retake', true, k])
    assert.equal(r.state().current.integration_attempts, 0, 'a busy record never counts as the infra retry')
  }
  const p = r.ok(['ingest-integration', '--wave', '1'])
  assert.deepEqual([p.action, p.code, p.reason], ['park', 'integration_infra', 'test DB busy'])
  // a real record after busy ones resets the busy counter
  writeRecord(r, 1, { pass: true, exit: 0, verdict_exit: 0 })
  r.ok(['ingest-integration', '--wave', '1'])
  assert.equal(r.state().current.busy_retries, 0)
})

test('CLI ingest-integration: verdict 2 (infra) → one retry then park; a slow record warns re-derive A-8; unattributed → park; stale record refused', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'billing/views.py': 'v2\n' } })
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  writeRecord(r, 1, { verdict_exit: 2, reason: 'verdict command exit 2', duration_ms: 36 * 60 * 1000 }, 'cannot parse the log\n')
  let x = r.ok(['ingest-integration', '--wave', '1'])
  assert.deepEqual([x.action, x.busy, x.attempts], ['retake', false, 1])
  assert.ok(x.warnings.some(w => /re-derive A-8/.test(w)), JSON.stringify(x.warnings))
  x = r.ok(['ingest-integration', '--wave', '1'])
  assert.deepEqual([x.action, x.code], ['park', 'integration_infra'])
  // a timed-out record is infra too
  const t = stageRepo()
  mergeHunt(t, 'a', { edits: { 'billing/views.py': 'v2\n' } })
  t.ok(['begin', '--wave', '1', '--merged', 'a'])
  writeRecord(t, 1, { timed_out: true, verdict_exit: null }, 'NEW FAILURES\nbilling.tests.X\n')
  assert.equal(t.ok(['ingest-integration', '--wave', '1']).action, 'retake')
  // unattributed: a failing app no wave hunt touched
  const u = stageRepo()
  mergeHunt(u, 'a', { edits: { 'billing/views.py': 'v2\n' } })
  u.ok(['begin', '--wave', '1', '--merged', 'a'])
  writeRecord(u, 1, {}, 'NEW FAILURES\nusers.tests.U\n\n')
  x = u.ok(['ingest-integration', '--wave', '1'])
  assert.deepEqual([x.action, x.code, x.ids], ['park', 'integration_unattributed', ['users.tests.U']])
  // a record for another commit is refused
  const s = stageRepo()
  mergeHunt(s, 'a')
  s.ok(['begin', '--wave', '1', '--merged', 'a'])
  writeRecord(s, 1, { commit: 'f'.repeat(40) })
  const y = s.run(['ingest-integration', '--wave', '1'])
  assert.deepEqual([y.code, y.json.code], [2, 'tip_moved'])
})

// ── plan-smoke / ingest-smoke (AC12–AC17, A-7, A-16) ────────────────────────
function smokeReady(r, slugs = ['a']) {
  r.ok(['begin', '--wave', '1', '--merged', slugs.join(',')])
  r.ok(['suites', '--wave', '1'])
  return r.ok(['plan-smoke', '--wave', '1', '--sha', r.tip()])
}
const rawFor = (plan, over = {}) => ({
  schema: 1, sha: readJ(plan.plan).sha,
  results: readJ(plan.plan).pairs.filter(p => !p.covered_by_integration).map(p => ({ ref: p.ref, tenant: p.tenant, disposition: 'auto_pass', anomalies: [], urls: [], screenshots: [], ...(over[p.key] || {}) })),
})

test('CLI plan-smoke (A-7): pairs per tenant scope + manifest flows on mobile; test_command ends with --isolated-db <campaign>', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  mergeHunt(r, 'b', { merge: false })   // not campaign-merged: no criteria
  const ps = smokeReady(r)
  assert.equal(ps.raw_exists, false)
  const plan = readJ(ps.plan)
  assert.equal(plan.test_command, "bash t.sh --isolated-db 'c1'")
  assert.match(plan.test_command, /--isolated-db 'c1'$/)
  assert.deepEqual(plan.pairs.filter(p => !p.manifest).map(p => p.key), ['a/1@surgical', 'a/1@mobile', 'a/2@mobile'])
  assert.equal(plan.pairs.filter(p => p.manifest).length, 5)
  assert.ok(plan.pairs.filter(p => p.manifest).every(p => p.tenant === 'mobile'))
  assert.deepEqual(plan.manual.map(m => m.ref), ['a/3'])
  assert.deepEqual(plan.compliance.map(m => m.ref), ['a/4'])
  assert.equal(plan.wave_dir, join(r.reports, 'c1', 'wave-1'))
  assert.equal(plan.shots_dir, join(r.root, '.wolfpack', 'smoke-shots', 'c1-wave-1'))
  assert.ok(fs.existsSync(plan.shots_dir))
  assert.equal(plan.raw_path, join(r.stageDir(1), `smoke-raw-${r.tip().slice(0, 12)}.json`))
  assert.equal(plan.login_hook, 'bash scripts/login.sh --host {host} --account {account}')
  assert.deepEqual(plan.tenants, TENANTS)
  // --sha must be the stage tip
  assert.equal(r.run(['plan-smoke', '--wave', '1', '--sha', 'a'.repeat(40)]).code, 2)
})

test('CLI plan-smoke: "campaign slug containing prod is not refused"; a prod-named test command still is', () => {
  const r = stageRepo({ campaign: 'reproduce-login-bug' })
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  const su = r.ok(['suites', '--wave', '1'])
  assert.equal(su.command, "bash t.sh --isolated-db 'reproduce-login-bug' scheduler")
  const ps = r.ok(['plan-smoke', '--wave', '1', '--sha', r.tip()])
  assert.equal(readJ(ps.plan).test_command, "bash t.sh --isolated-db 'reproduce-login-bug'")
  const rep = r.ok(['report'])
  assert.equal(rep.report_url, 'http://100.64.0.7:8766/reproduce-login-bug/')
  const bad = stageRepo({ campaign: 'reproduce-login-bug', config: CONFIG({ test: 'bash t.sh --settings=prod_settings' }) })
  mergeHunt(bad, 'a')
  bad.ok(['begin', '--wave', '1', '--merged', 'a'])
  const x = bad.run(['plan-smoke', '--wave', '1', '--sha', bad.tip()])
  assert.equal(x.code, 2)
  assert.equal(x.json.code, 'smoke_config_missing')
  assert.ok(!fs.existsSync(join(bad.stageDir(1), 'smoke-plan.json')), 'no smoke-plan.json')
})

test('CLI plan-smoke: "wave-dir command fails → smoke_config_missing naming the key", no plan written', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  const x = r.run(['plan-smoke', '--wave', '1', '--sha', r.tip()], { STUB_WAVEDIR_FAIL: '1' })
  assert.equal(x.code, 2)
  assert.deepEqual([x.json.code, x.json.key], ['smoke_config_missing', 'Deployment Notes → Wave report dir command'])
  assert.equal(x.json.detail, 'cannot create')
  assert.ok(!fs.existsSync(join(r.stageDir(1), 'smoke-plan.json')))
})

test('CLI plan-smoke (A-16): a criterion naming a test id the integration suite covers is not run twice', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' }, acceptance: '## Acceptance criteria\n- AC1 [auto] [tenant:mobile] `scheduler.tests.SlotTests` passes.\n- AC2 [auto] [tenant:mobile] The page loads.\n' })
  const ps = smokeReady(r)
  const plan = readJ(ps.plan)
  const p1 = plan.pairs.find(p => p.key === 'a/1@mobile')
  assert.equal(p1.covered_by_integration, 'scheduler.tests.SlotTests')
  assert.equal(plan.pairs.find(p => p.key === 'a/2@mobile').covered_by_integration, undefined)
  // the raw file may omit the covered pair; ingest marks it from the integration verdict
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps)))
  writeRecord(r, 1, { pass: false }, 'NEW FAILURES\nscheduler.tests.SlotTests.test_x\n\n')
  const is = r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  const res = readJ(is.results)
  const crit = res.hunts.find(h => h.slug === 'a').criteria.find(c => c.ref === 'a/1')
  assert.deepEqual([crit.disposition, crit.covered_by], ['auto_fail', 'integration run'])
})

test('CLI ingest-smoke: "needs_human_run goes to manual" — exactly ref, hunt, steps, expected, reason; once even if [manual]', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' },
    acceptance: '## Acceptance criteria\n- AC1 [auto] [tenant:mobile] The console shows no error on save.\n- AC2 [manual] [tenant:mobile] Print it.\n' })
  const ps = smokeReady(r)
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, { 'a/1@mobile': { disposition: 'needs_human_run', detail: 'console not reachable on dev' } })))
  const is = r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  const res = readJ(is.results)
  const item = res.manual.find(m => m.ref === 'a/1')
  assert.deepEqual(Object.keys(item).sort(), ['expected', 'hunt', 'reason', 'ref', 'steps'])
  for (const v of Object.values(item)) { assert.equal(typeof v, 'string'); assert.ok(v.length) }
  assert.deepEqual(item, { ref: 'a/1', hunt: 'a', steps: 'The console shows no error on save.',
    expected: 'Passes as written; the automated run could not check it.', reason: 'console not reachable on dev' })
  assert.equal(res.manual.filter(m => m.ref === 'a/1').length, 1)
  assert.ok(res.manual.some(m => m.ref === 'a/2'), 'the [manual] criterion is collected too')
  assert.equal(is.verdicts.a, 'PENDING')
  assert.deepEqual(r.calls('report').filter(l => / build /.test(l)).length, 1, 'the wave report was built')
  // the results.json session fields are per host
  assert.equal(typeof res.session_after_deploy, 'object')
})

test('CLI ingest-smoke: a refused url → auto_fail "refused host" + prod_host block; 5xx → finding; failures attributed; mobile_passed recorded', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  const ps = smokeReady(r)
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, {
    'a/1@surgical': { urls: ['https://surgical.example.dev/x', 'https://x.example.vet/login'] },
    'a/1@mobile': { anomalies: [{ kind: 'network', text: 'GET /api/x 503 Cookie: sessionid=zz', status: 503 }] },
    'a/2@mobile': { disposition: 'auto_fail', detail: 'button missing', model: { class: 'fix', expected_from: 'ac' } },
    'mobile-manifest/2@mobile': { disposition: 'auto_fail', detail: 'calendar blank', model: { class: 'log', expected_from: 'none' } },
  })))
  const is = r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  const res = readJ(is.results)
  const ha = res.hunts.find(h => h.slug === 'a')
  assert.equal(ha.criteria.find(c => c.ref === 'a/1' && c.tenant === 'surgical').detail, 'refused host')
  assert.equal(ha.verdict, 'FAIL')
  const st = r.state()
  const f = st.current.findings
  assert.ok(f.some(x => x.hunt === 'a' && x.prod_host === true && x.tenant === 'surgical'))
  assert.ok(f.some(x => x.kind === 'anomaly' && x.http_status === 503))
  assert.ok(f.some(x => x.ref === 'a/2' && x.kind === 'smoke'))
  assert.ok(f.some(x => x.ref === 'mobile-manifest/2' && x.hunt === 'a'), 'a manifest failure blames the hunts merged this stage run')
  assert.ok(!JSON.stringify(res).includes('sessionid=zz'), 'anomaly text is redacted')
  // mobile passes recorded once, with the first wave they passed in
  assert.equal(st.mobile_passed['mobile-manifest/1@mobile'], 1)
  assert.equal(st.mobile_passed['a/1@surgical'], undefined)
  const t = r.ok(['triage', '--wave', '1'])
  const rules = Object.fromEntries(t.classified.map(x => [x.id, x.rule]))
  assert.ok(Object.values(rules).includes('prod_host_touched'))
  assert.ok(Object.values(rules).includes('5xx_or_cross_tenant'))
  assert.deepEqual(Object.keys(t.pending.block), ['a'])
  assert.deepEqual(t.pending.fix, {}, 'block wins over fix for the same hunt')
})

test('CLI ingest-smoke: an invalid raw file → renamed .invalid-<k>.json, attempts counted, exit 2 smoke_raw_invalid', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  const ps = smokeReady(r)
  fs.writeFileSync(ps.raw_path, '{"schema": 1, "sha": "nope", "results": []}')
  let x = r.run(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  assert.equal(x.code, 2)
  assert.deepEqual([x.json.code, x.json.attempts], ['smoke_raw_invalid', 1])
  assert.equal(x.json.renamed, ps.raw_path.replace(/\.json$/, '.invalid-1.json'))
  assert.ok(!fs.existsSync(ps.raw_path) && fs.existsSync(x.json.renamed))
  fs.writeFileSync(ps.raw_path, '{not json')
  x = r.run(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  assert.deepEqual([x.json.code, x.json.attempts], ['smoke_raw_invalid', 2])
  assert.ok(fs.existsSync(ps.raw_path.replace(/\.json$/, '.invalid-2.json')))
  // the plan's raw_exists is false again after the rename (step 2 never re-ingests it)
  assert.equal(r.ok(['plan-smoke', '--wave', '1', '--sha', r.tip()]).raw_exists, false)
  // smoke-failed counts an agent failure the same way
  assert.equal(r.ok(['smoke-failed', '--wave', '1', '--reason', 'no path']).attempts, 3)
})

test('CLI mobile regression: passed on mobile in wave 1, fails in wave 2 → block (rule 4) even if cosmetic', () => {
  const r = stageRepo({ graph: { a: { dependsOn: [] }, b: { dependsOn: [] } } })
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  let ps = smokeReady(r, ['a'])
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps)))
  r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  r.ok(['triage', '--wave', '1'])
  r.ok(['finish', '--result', 'green'])
  mergeHunt(r, 'b', { edits: { 'scheduler/views.py': 'v3\n' }, acceptance: '## Acceptance criteria\n- AC1 [auto] [tenant:surgical] b.\n' })
  r.ok(['begin', '--wave', '2', '--merged', 'b'])
  r.ok(['suites', '--wave', '2'])
  ps = r.ok(['plan-smoke', '--wave', '2', '--sha', r.tip()])
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, {
    'mobile-manifest/3@mobile': { disposition: 'auto_fail', detail: 'names cut off', model: { class: 'log', expected_from: 'none' } },
  })))
  r.ok(['ingest-smoke', '--wave', '2', '--raw', ps.raw_path])
  const t = r.ok(['triage', '--wave', '2'])
  const x = t.classified.find(c => c.rule === 'mobile_regression')
  assert.ok(x, JSON.stringify(t.classified))
  assert.equal(x.hunt, 'b')
  assert.deepEqual(Object.keys(t.pending.block), ['b'])
})

// ── triage / issue log (AC18, AC19) ─────────────────────────────────────────
test('CLI triage: issue-log.json + .md written; a re-run is idempotent (seen_waves); reasoning from the rule', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  const ps = smokeReady(r)
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, {
    'a/2@mobile': { disposition: 'auto_fail', detail: 'Save button missing', model: { class: 'fix', expected_from: 'ac' } },
  })))
  r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  const t = r.ok(['triage', '--wave', '1'])
  assert.deepEqual(t.pending, { fix: { a: [t.classified[0].id] }, block: {} })
  const log = r.issues()
  assert.equal(log.entries.length, 1)
  const e = log.entries[0]
  assert.deepEqual([e.hunt, e.ref, e.tenant, e.kind, e.outcome, e.rule, e.resolution], ['a', 'a/2', 'mobile', 'smoke', 'fix', 'clear_defect', null])
  assert.match(e.reasoning, /^a\/2: clear defect \(expected behaviour from ac\)$/)
  const md = fs.readFileSync(join(r.root, '.wolfpack', 'campaigns', 'c1', 'issue-log.md'), 'utf8')
  assert.match(md, new RegExp(`## ${e.id} — fix \\(clear_defect\\)`))
  r.ok(['triage', '--wave', '1'])
  assert.equal(r.issues().entries.length, 1)
})

test('CLI reclassify: a pending fix becomes a block (rule fix_review_failed) in state and in the issue log', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  const ps = smokeReady(r)
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, { 'a/2@mobile': { disposition: 'auto_fail', detail: 'x', model: { class: 'fix', expected_from: 'ac' } } })))
  r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  const t = r.ok(['triage', '--wave', '1'])
  const rc = r.ok(['reclassify', '--hunt', 'a', '--rule', 'fix_review_failed', '--reason', 'fix-a-smoke-1: CERTIFY_FAILED'])
  assert.deepEqual(rc.ids, t.pending.fix.a)
  const cur = r.state().current
  assert.deepEqual([cur.pending.fix, cur.pending.block], [{}, { a: t.pending.fix.a }])
  assert.match(rc.block_text.summary, /blocked a \(fix_review_failed\): fix-a-smoke-1: CERTIFY_FAILED/)
  const e = r.issues().entries[0]
  assert.deepEqual([e.outcome, e.rule], ['block', 'fix_review_failed'])
})

// ── fix rounds (AC21–AC23) ──────────────────────────────────────────────────
function fixReady(r) {
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  const ps = smokeReady(r)
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, { 'a/2@mobile': { disposition: 'auto_fail', detail: 'Save missing', model: { class: 'fix', expected_from: 'ac' } } })))
  r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  return r.ok(['triage', '--wave', '1'])
}

test('CLI fix-scaffold: branch forked at the campaign tip; metadata (parent, isolation, base, cross-family review)', () => {
  const r = stageRepo()
  const t = fixReady(r)
  const sc = r.ok(['fix-scaffold', '--hunt', 'a'])
  assert.deepEqual([sc.slug, sc.parent_hunt, sc.tier, sc.branch, sc.reused], ['fix-a-smoke-1', 'a', 'Yellow', 'feat/fix-a-smoke-1', false])
  assert.equal(sc.base_sha, r.tip())
  assert.equal(g(r.root, 'rev-parse', 'feat/fix-a-smoke-1'), r.tip(), 'the branch base equals the campaign tip')
  assert.equal(sc.worktree, join(r.root, '.wt', 'fix-a-smoke-1'))
  const m = readJ(join(sc.plan_dir, 'metadata.json'))
  assert.deepEqual([m.parent_hunt, m.smoke_fix_round, m.test_isolation, m.base_branch, m.campaign, m.status, m.phase],
    ['a', 1, 'c1', 'campaign/c1', 'c1', 'ready', 'implement'])
  assert.deepEqual(m.smoke_issues, t.pending.fix.a)
  const fam = (x) => String(x).split(':')[0]
  assert.notEqual(fam(m.model_assignments.pointer), fam(m.model_assignments.shepherd), 'pointer family ≠ shepherd family')
  assert.notEqual(fam(m.model_assignments.watchdog), fam(m.model_assignments.shepherd))
  assert.deepEqual(m.proposed_version, { bump: null, tag: null, set_by: 'stage', note: 'post-merge stage fix/polish: no version bump' })
  const findings = fs.readFileSync(join(sc.plan_dir, 'findings.md'), 'utf8')
  assert.ok(findings.includes(t.pending.fix.a[0]))
  // a re-run reuses the worktree (idempotent)
  assert.equal(r.ok(['fix-scaffold', '--hunt', 'a']).reused, true)
  // refusals
  assert.equal(r.run(['fix-scaffold', '--hunt', 'nope']).code, 2)
})

test('CLI fix-scaffold: refused when the reviewer shares the writer\'s family, or the hunt has no pending fix', () => {
  const same = CONFIG().replace('- reviewer-a  → glm:5.3', '- reviewer-a  → claude:sonnet')
  const r = stageRepo({ config: same })
  fixReady(r)
  const x = r.run(['fix-scaffold', '--hunt', 'a'])
  assert.equal(x.code, 2)
  assert.match(x.json.reason, /cross-family reviewer/)
  assert.ok(!fs.existsSync(join(r.root, '.wt', 'fix-a-smoke-1')))
  const r2 = stageRepo()
  mergeHunt(r2, 'a')
  r2.ok(['begin', '--wave', '1', '--merged', 'a'])
  assert.match(r2.run(['fix-scaffold', '--hunt', 'a']).json.reason, /no pending fix findings/)
})

test('CLI record-fix (AC23): "fix round writes smoke-findings.md" — issue, lookup line, merge SHA; a second call is unchanged', () => {
  const r = stageRepo()
  const t = fixReady(r)
  const sc = r.ok(['fix-scaffold', '--hunt', 'a'])
  commit(sc.worktree, { 'scheduler/views.py': 'v2 fixed\n' }, 'fix(a): save button')
  const meta = readJ(join(sc.plan_dir, 'metadata.json'))
  fs.writeFileSync(join(sc.plan_dir, 'metadata.json'), JSON.stringify({ ...meta, status: 'certified' }))
  const mm = chainMerge(r.root, { campaign: 'c1', hunt: sc.slug, at: AT, fixOf: 'a' })
  assert.equal(mm.status, 'merged', JSON.stringify(mm))
  const id = t.pending.fix.a[0]
  const rf = r.ok(['record-fix', '--hunt', 'a', '--fix', sc.slug, '--commit', mm.commit, '--issues', id])
  assert.deepEqual([rf.fix_rounds, rf.appended], [1, 1])
  const file = join(r.root, '.wolfpack', 'plans', 'a', 'smoke-findings.md')
  assert.equal(rf.file, file)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^# Smoke findings: a$/m)
  assert.match(text, /^## Fix round 1, wave 1 \(/m)
  assert.ok(text.includes(`- Fix: fix-a-smoke-1, merge commit ${mm.commit}`))
  assert.ok(text.includes(`- ${id} (smoke, mobile, a/2): `))
  assert.match(text, /^ {2}- Review fingerprint lookup: miss \(no review ran\)$/m)
  assert.equal(r.issues().entries[0].resolution, 'fixed in round 1')
  assert.equal(getMeta(r.root, 'a').smoke_fix_rounds, 1)
  assert.deepEqual(r.state().current.fix_merges, [{ hunt: 'a', slug: sc.slug, commit: mm.commit, iteration: 1, issues: [id] }])
  assert.deepEqual(r.state().current.pending.fix, {})
  const again = r.ok(['record-fix', '--hunt', 'a', '--fix', sc.slug, '--commit', mm.commit, '--issues', id])
  assert.deepEqual([again.appended, again.fix_rounds], [0, 1])
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'byte-identical after a re-run')
  // the next stage run's suites include the fix merge's diff
  const it = r.ok(['iterate'])
  assert.equal(it.iteration, 2)
  assert.equal(r.state().current.step, 'begin')
  assert.deepEqual(r.ok(['suites', '--wave', '1']).labels, ['scheduler'])
})

// ── polish (AC27, AC28) ─────────────────────────────────────────────────────
test('CLI polish-plan: excludes reverted/parked hunts\' items; the same open set after a polish → empty', () => {
  const r = stageRepo({ graph: { a: { dependsOn: [] }, b: { dependsOn: [] } } })
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  mergeHunt(r, 'b', { edits: { 'docs/x.md': 'v2\n' } })
  const ps = smokeReady(r, ['a', 'b'])
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, {
    'a/2@mobile': { disposition: 'auto_fail', detail: 'misaligned', model: { class: 'log', expected_from: 'none' } },
    'b/2@mobile': { disposition: 'auto_fail', detail: 'typo', model: { class: 'log', expected_from: 'none' } },
  })))
  r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  r.ok(['triage', '--wave', '1'])
  r.ok(['finish', '--result', 'resolved'])
  let pp = r.ok(['polish-plan'])
  assert.equal(pp.items.length, 2)
  writeMeta(r.root, 'b', { ...getMeta(r.root, 'b'), status: CS.REVERTED })
  pp = r.ok(['polish-plan'])
  assert.deepEqual(pp.items.map(i => i.hunt), ['a'])
  r.ok(['resolve', '--ids', pp.items[0].id, '--resolution', 'needs Cecil', '--polish-slug', 'polish-c1', '--open-set', pp.open_set, '--polish-result', 'failed'])
  // resolved → no open items
  assert.deepEqual(r.ok(['polish-plan']).items, [])
  // "same open set → empty": recorded polish with this hash, items still open
  const r2 = stageRepo()
  mergeHunt(r2, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  const ps2 = smokeReady(r2)
  fs.writeFileSync(ps2.raw_path, JSON.stringify(rawFor(ps2, { 'a/2@mobile': { disposition: 'auto_fail', detail: 'x', model: { class: 'log' } } })))
  r2.ok(['ingest-smoke', '--wave', '1', '--raw', ps2.raw_path])
  r2.ok(['triage', '--wave', '1'])
  const first = r2.ok(['polish-plan'])
  const st = r2.state()
  st.polish = [{ slug: 'polish-c1', open_set: first.open_set, result: 'reverted' }]
  fs.writeFileSync(join(r2.root, '.wolfpack', 'campaigns', 'c1', 'smoke-stage.json'), JSON.stringify(st))
  const second = r2.ok(['polish-plan'])
  assert.deepEqual([second.items, second.reason], [[], 'this open set was already polished once'])
})

test('CLI resolve: only the documented resolutions', () => {
  const r = stageRepo()
  fixReady(r)
  const id = r.issues().entries[0].id
  for (const ok of ['polished', 'reverted', 'needs Cecil', 'fixed in round 2']) r.ok(['resolve', '--ids', id, '--resolution', ok])
  assert.equal(r.run(['resolve', '--ids', id, '--resolution', 'done']).code, 2)
  assert.equal(r.run(['resolve', '--ids', 'ISS-nope', '--resolution', 'polished']).code, 2)
})

test('CLI suites --polish: the polish merge\'s own diff (scheduler + docs → scheduler; requirements.txt → full); failures attributed to it', () => {
  for (const [edits, want] of [[{ 'scheduler/views.py': 'p\n', 'docs/x.md': 'p\n' }, { labels: ['scheduler'], full: false }], [{ 'requirements.txt': 'p\n' }, { labels: [], full: true }]]) {
    const r = stageRepo()
    mergeHunt(r, 'a', { edits: { 'billing/views.py': 'v2\n' } })
    r.ok(['begin', '--wave', '1', '--merged', 'a'])
    r.ok(['finish', '--result', 'green'])
    const wt = join(r.root, '.wt', 'polish-c1')
    g(r.root, 'worktree', 'add', '-q', wt, '-b', 'feat/polish-c1', 'campaign/c1')
    commit(wt, edits, 'polish')
    writeMeta(r.root, 'polish-c1', { feature: 'polish-c1', status: 'certified', tier: 'Blue', polish_of: 'c1' })
    const pm = chainMerge(r.root, { campaign: 'c1', hunt: 'polish-c1', at: AT, polish: true })
    assert.equal(pm.status, 'merged')
    const b = r.ok(['begin', '--wave', '1', '--polish', 'polish-c1'])
    assert.deepEqual([b.action, b.polish, b.polish_merge, b.iteration], ['new', 'polish-c1', pm.commit, 2])
    const s = r.ok(['suites', '--polish', 'polish-c1'])
    assert.deepEqual({ labels: s.labels, full: s.full }, want)
    if (!want.full) {
      writeRecord(r, 1, {}, 'NEW FAILURES\nbilling.tests.X\n\n')
      const ig = r.ok(['ingest-integration', '--wave', '1'])
      assert.equal(ig.action, 'findings', 'never integration_unattributed in a polish iteration')
      assert.deepEqual(r.state().current.findings.map(f => f.hunt), ['polish-c1'])
    }
    assert.equal(r.run(['suites', '--polish', 'other']).code, 2)
  }
})

test('CLI polish triage + iterate --clear-polish: regressions vs targeted items; the re-verify keeps the suite set, blames no hunt', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  const ps = smokeReady(r)
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, { 'a/2@mobile': { disposition: 'auto_fail', detail: 'x', model: { class: 'log' } } })))
  r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  r.ok(['triage', '--wave', '1'])
  r.ok(['finish', '--result', 'resolved'])
  r.ok(['fix-scaffold', '--polish'])
  const wt = join(r.root, '.wt', 'polish-c1')
  commit(wt, { 'scheduler/views.py': 'v2 polished\n' }, 'polish')
  const pmeta = readJ(join(wt, '.wolfpack', 'plans', 'polish-c1', 'metadata.json'))
  fs.writeFileSync(join(wt, '.wolfpack', 'plans', 'polish-c1', 'metadata.json'), JSON.stringify({ ...pmeta, status: 'certified' }))
  assert.equal(chainMerge(r.root, { campaign: 'c1', hunt: 'polish-c1', at: AT, polish: true }).status, 'merged')
  const b = r.ok(['begin', '--wave', '1', '--polish', 'polish-c1'])
  assert.equal(b.polish_issues.length, 1)
  const su = r.ok(['suites', '--polish', 'polish-c1'])
  writeRecord(r, 1, {}, 'NEW FAILURES\nscheduler.tests.Z\n\n')
  r.ok(['ingest-integration', '--wave', '1'])
  const t = r.ok(['triage', '--wave', '1'])
  assert.equal(t.polish.slug, 'polish-c1')
  assert.equal(t.polish.regressions.length, 1)
  assert.equal(t.polish.regressions[0].what, 'scheduler.tests.Z')
  assert.deepEqual(t.polish.fixed, b.polish_issues, 'the targeted item no longer fails')
  const it = r.ok(['iterate', '--clear-polish'])
  assert.equal(it.iteration, 3)
  const cur = r.state().current
  assert.equal(cur.polish, null)
  assert.deepEqual(cur.suites_override.labels, su.labels, 'the same suite set')
  assert.deepEqual(cur.suites_override.hunt_apps, {})
  // the same id failing again now has no hunt to blame → integration_unattributed
  writeRecord(r, 1, {}, 'NEW FAILURES\nscheduler.tests.Z\n\n')
  const ig = r.ok(['ingest-integration', '--wave', '1'])
  assert.deepEqual([ig.action, ig.code], ['park', 'integration_unattributed'])
})

// ── report / park / re-arm / reconcile (AC2, AC30) ──────────────────────────
test('CLI report: builds the campaign page and stores report_url; a failure is fail-soft (⚠ report:, url null)', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  const rep = r.ok(['report'])
  assert.deepEqual([rep.report_url, rep.dir], ['http://100.64.0.7:8766/c1/', join(r.reports, 'c1')])
  assert.equal(r.state().report_url, rep.report_url)
  assert.equal(r.state().current.report_url, rep.report_url)
  const call = r.calls('report').find(l => / campaign /.test(l))
  assert.ok(call.endsWith(`campaign c1 ${join(r.root, '.wolfpack', 'campaigns', 'c1', 'issue-log.json')}`), call)
  assert.ok(fs.existsSync(join(r.root, '.wolfpack', 'campaigns', 'c1', 'issue-log.json')), 'an empty issue log is created for the report')
  const bad = r.ok(['report'], { STUB_REPORT_FAIL: '1' })
  assert.equal(bad.report_url, null)
  assert.match(bad.warning, /^⚠ report: campaign report failed: report broke$/)
})

test('CLI park + begin --resume-only: re-arm appends park_history, resets the parked step\'s attempts, keeps step', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  r.ok(['deploy'], { STUB_DEPLOY_EXIT: '1' })
  r.ok(['deploy'], { STUB_DEPLOY_EXIT: '1' })
  const p = r.ok(['park', '--code', 'dev_deploy_failed', '--detail', 'deploy exited 1 twice ?token=abc', '--step', 'deploy'])
  assert.equal(p.result, 'parked:dev_deploy_failed')
  assert.ok(!p.park.detail.includes('abc'), 'the park detail is redacted')
  // a parked stage refuses steps until re-armed
  assert.equal(r.run(['deploy']).code, 2)
  const rr = r.ok(['begin', '--resume-only', '--next-wave', '2'])
  assert.equal(rr.rearmed, 'dev_deploy_failed')
  const cur = r.state().current
  assert.deepEqual([cur.result, cur.park, cur.step, cur.deploy_attempts.deploy], [null, null, 'begin', 0])
  assert.equal(cur.park_history.length, 1)
  assert.equal(cur.park_history[0].code, 'dev_deploy_failed')
  // green/resolved are final and never re-armed
  r.ok(['finish', '--result', 'green'])
  assert.equal(r.ok(['begin', '--resume-only']).rearmed, null)
  assert.deepEqual(r.state().waves['1'].result, 'green')
  assert.equal(r.ok(['begin', '--wave', '1']).action, 'nothing')
  assert.match(r.ok(['begin', '--wave', '1']).reason, /wave 1 already staged \(green\)/)
})

test('CLI begin --resume-only: first stage-on launch records staged_from_wave = min(next, open waves); reconcile lists unstaged waves', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  const rr = r.ok(['begin', '--resume-only', '--next-wave', '3', '--open-waves', '2,4', '--merged-by-wave', JSON.stringify({ 1: ['x'], 2: ['a'] })])
  assert.deepEqual([rr.created, rr.staged_from_wave, rr.not_staged_below], [true, 2, 2])
  assert.deepEqual(rr.unstaged, [{ wave: 2, merged: ['a'] }], 'wave 1 merged before the stage was on: never staged')
  // a stage resumed at the same tip continues after its step
  r.ok(['begin', '--wave', '2', '--merged', 'a'])
  r.ok(['deploy'])
  const again = r.ok(['begin', '--resume-only', '--merged-by-wave', JSON.stringify({ 2: ['a'] })])
  assert.deepEqual(again.unstaged, [], 'the current wave is not unstaged')
  assert.equal(again.current.step, 'deploy')
  const b = r.ok(['begin', '--wave', '2'])
  assert.deepEqual([b.action, b.step], ['resume', 'deploy'])
  // tip moved → restart at begin, iteration kept
  mergeHunt(r, 'b')
  const b2 = r.ok(['begin', '--wave', '2'])
  assert.deepEqual([b2.action, b2.step, b2.campaign_sha], ['restart', 'begin', r.tip()])
  assert.equal(r.run(['begin', '--resume-only', '--merged-by-wave', '{bad']).code, 2)
})

test('CLI begin: stale wolfpack-stage-* worktrees are pruned; a bad --wave / --merged is refused', () => {
  const r = stageRepo()
  mergeHunt(r, 'a')
  const parent = fs.mkdtempSync(join(tmpdir(), 'wolfpack-stage-stale-'))
  ROOTS.push(parent)
  g(r.root, 'worktree', 'add', '-q', '--detach', join(parent, 'wt'), 'campaign/c1')
  assert.equal(r.stageWorktrees().length, 1)
  const b = r.ok(['begin', '--wave', '1', '--merged', 'a'])
  assert.equal(b.pruned.length, 1)
  assert.deepEqual(r.stageWorktrees(), [])
  assert.equal(r.run(['begin', '--wave', '0']).code, 2)
  assert.equal(r.run(['begin', '--wave', '1', '--merged', 'Bad Slug']).code, 2)
  assert.equal(r.run(['nope']).code, 2)
  assert.equal(r.run(['begin', '--wave', '1'], {}).json.status, 'ok')
  const noCamp = spawnSync(process.execPath, [CLI, 'begin', '--wave', '1'], { cwd: r.root, encoding: 'utf8' })
  assert.equal(noCamp.status, 2)
})

test('CLI worktree add|remove: a detached worktree at the tip with the configured links; plan gets its path', () => {
  const r = stageRepo({ config: CONFIG().replace('- **Worktree root:**', '- **Worktree links:** `venv`\n- **Worktree root:**') })
  fs.mkdirSync(join(r.root, 'venv'))
  mergeHunt(r, 'a')
  smokeReady(r)
  const a = r.ok(['worktree', 'add', '--wave', '1'])
  assert.equal(a.reused, false)
  assert.equal(g(a.worktree, 'rev-parse', 'HEAD'), r.tip())
  assert.ok(fs.lstatSync(join(a.worktree, 'venv')).isSymbolicLink())
  assert.equal(readJ(join(r.stageDir(1), 'smoke-plan.json')).worktree, a.worktree)
  assert.equal(r.ok(['worktree', 'add', '--wave', '1']).reused, true)
  r.ok(['worktree', 'remove', '--wave', '1'])
  assert.ok(!fs.existsSync(a.worktree))
  assert.deepEqual(r.stageWorktrees(), [])
})

// ── Pointer (hand GLM pass) fixes ───────────────────────────────────────────
test('resume between record-fix and iterate: a re-run triage does not re-open the landed fix', () => {
  const r = stageRepo()
  const t = fixReady(r)
  const id = t.pending.fix.a[0]
  const sc = r.ok(['fix-scaffold', '--hunt', 'a'])
  commit(sc.worktree, { 'scheduler/views.py': 'v2 fixed\n' }, 'fix(a): save button')
  fs.writeFileSync(join(sc.plan_dir, 'metadata.json'), JSON.stringify({ ...readJ(join(sc.plan_dir, 'metadata.json')), status: 'certified' }))
  const mm = chainMerge(r.root, { campaign: 'c1', hunt: sc.slug, at: AT, fixOf: 'a' })
  r.ok(['record-fix', '--hunt', 'a', '--fix', sc.slug, '--commit', mm.commit, '--issues', id])
  // crash here; the relaunch re-runs triage on the same iteration
  const again = r.ok(['triage', '--wave', '1'])
  assert.deepEqual(again.pending.fix, {}, 'no second fix round')
  assert.equal(again.skipped_landed, 1, 'the runner finishes the wave resolved, not green')
  assert.ok(!again.classified.some(x => x.id === id))
})

test('resume between merge-hunt and record-fix: fix-scaffold reports the landed merge instead of throwing', () => {
  const r = stageRepo()
  fixReady(r)
  const sc = r.ok(['fix-scaffold', '--hunt', 'a'])
  commit(sc.worktree, { 'scheduler/views.py': 'v2 fixed\n' }, 'fix(a): save button')
  fs.writeFileSync(join(sc.plan_dir, 'metadata.json'), JSON.stringify({ ...readJ(join(sc.plan_dir, 'metadata.json')), status: 'certified' }))
  const mm = chainMerge(r.root, { campaign: 'c1', hunt: sc.slug, at: AT, fixOf: 'a' })
  // crash here: the worktree is gone, the branch remains, record-fix never ran
  const again = r.ok(['fix-scaffold', '--hunt', 'a'])
  assert.deepEqual([again.slug, again.landed && again.landed.commit], [sc.slug, mm.commit])
  const rf = r.ok(['record-fix', '--hunt', 'a', '--fix', again.slug, '--commit', again.landed.commit, '--issues', again.issues.join(',')])
  assert.equal(rf.fix_rounds, 1)
})

test('a manifest failure with several merged hunts is ONE unattributed finding → the stage blocks (no per-hunt fix rounds)', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' } })
  mergeHunt(r, 'b', { edits: { 'billing/views.py': 'v2\n' } })
  const ps = smokeReady(r, ['a', 'b'])
  fs.writeFileSync(ps.raw_path, JSON.stringify(rawFor(ps, { 'mobile-manifest/2@mobile': { disposition: 'auto_fail', detail: 'sign-in broken', model: { class: 'fix', expected_from: 'ac' } } })))
  r.ok(['ingest-smoke', '--wave', '1', '--raw', ps.raw_path])
  const f = r.state().current.findings.filter(x => x.ref === 'mobile-manifest/2')
  assert.equal(f.length, 1)
  assert.equal(f[0].hunt, null)
  assert.deepEqual(f[0].blocked_with, ['a', 'b'])
  const t = r.ok(['triage', '--wave', '1'])
  assert.deepEqual([t.pending.fix, t.pending.block], [{}, {}])
  assert.deepEqual(t.campaign_blocks, [f[0].id])
  assert.match(t.campaign_block_text[0], /could be any of a, b/)
})

test('plan-smoke: a campaign-merged hunt without a readable acceptance.md fails loud', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'scheduler/views.py': 'v2\n' }, acceptance: null })
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  r.ok(['suites', '--wave', '1'])
  const x = r.run(['plan-smoke', '--wave', '1', '--sha', r.tip()])
  assert.deepEqual([x.code, x.json && x.json.code], [2, 'smoke_config_missing'])
  assert.match(x.json.reason, /acceptance\.md.*\ba\b/)
})

test('redact: JSON and colon forms of session values are removed', () => {
  const s = redact('{"sessionid": "abc123", "csrftoken":"zz9", \'token\': \'t0k\'} Session: s3cr3t')
  for (const leak of ['abc123', 'zz9', 't0k', 's3cr3t']) assert.ok(!s.includes(leak), `${leak} survived: ${s}`)
  assert.match(s, /"sessionid": "\[REDACTED\]"/)
  const spaced = redact('{"password": "my secret", "token": "a,b", "note": "kept"}')
  for (const leak of ['my secret', 'a,b']) assert.ok(!spaced.includes(leak), `${leak} survived: ${spaced}`)
  assert.ok(spaced.includes('"note": "kept"'))
})

test('check-config: the stage refuses when .wolfpack/smoke-shots/ is not gitignored', () => {
  const r = stageRepo()
  commit(r.root, { '.gitignore': '.wolfpack/plans/\n.wolfpack/campaigns/\n.wt/\n' }, 'drop the shots ignore')
  const x = r.run(['check-config'])
  assert.deepEqual([x.code, x.json && x.json.code], [2, 'smoke_config_missing'])
  assert.match(x.json.reason, /smoke-shots/)
})

test('suites: an app named like "products" is not a prod target; a non-plain app dir is refused', () => {
  const r = stageRepo()
  mergeHunt(r, 'a', { edits: { 'products/apps.py': '', 'products/views.py': 'v\n' } })
  r.ok(['begin', '--wave', '1', '--merged', 'a'])
  const s = r.ok(['suites', '--wave', '1'])
  assert.ok(s.labels.includes('products'))
  assert.match(s.command, / products$/)
  const r2 = stageRepo()
  mergeHunt(r2, 'a', { edits: { 'x;y/apps.py': '', 'x;y/views.py': 'v\n' } })
  r2.ok(['begin', '--wave', '1', '--merged', 'a'])
  const x = r2.run(['suites', '--wave', '1'])
  assert.equal(x.code, 2, x.stdout)
  assert.match(x.json.reason, /not plain directory names/)
})
