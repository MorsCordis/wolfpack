#!/usr/bin/env node
// scripts/wolfpack-hunt-pipeline.test.mjs — scenario tests for the examiner CHAIN, the
// GLM Shepherd seat, and the cross-family runtime invariant in hunt-pipeline.js.
// Run: node --test scripts/wolfpack-hunt-pipeline.test.mjs
//
// The workflow runs for real (the whole script body), with the harness globals stubbed:
// agent() answers by label prefix from a per-scenario table and RECORDS every call
// (label, prompt, opts), so a test can assert which seats ran, on which model, with
// which commands — without any model, podman or git.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const WT = '/repo/.agents/worktrees/h'
const PD = `${WT}/.wolfpack/plans/h`

// Default happy-path answers; a scenario overrides by label prefix (value or fn(prompt, opts, n)).
const BASE = {
  'resume-probe': { fresh: true },
  scaffold: { worktreePath: WT, planDir: PD, adcValid: true },
  spec: { modeForBuild: 'autonomous', confidence: 'high', complianceCritical: false },
  alpha: { verdict: 'PLANNED', tier: 'Yellow', bloodhoundRounds: 1, pointerRounds: 1, trackerRounds: 1, bloodhoundModel: 'glm' },
  bloodhound: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'glm', status: 'glm' },
  debrief: {},
  'shepherd-seat': { shepherdPin: '', complianceCritical: false, shepherdFamilies: [] },
  'shepherd-glm': { outcome: 'done', exitCode: 0, changedFiles: ['app/x.py'], committed: true },
  shepherd: { verdict: 'DONE' },
  pointer: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'mistral', status: 'mistral' },
  tracker: { verdict: 'TESTS_PASS' },
  watchdog: { verdict: 'PASS', provider: 'mistral', status: 'mistral' },
  'compliance-gate': { determined: true, complianceTouched: false, alreadySignedOff: false },
  verify: { verdict: 'PASS' },
  park: {},
}

async function runHunt({ env = {}, answers = {}, args = {}, rawArgs } = {}) {
  const calls = []
  const logs = []
  const table = { ...BASE, ...answers }
  const counts = {}
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt, opts })
    // longest matching prefix wins (shepherd-glm before shepherd)
    const key = Object.keys(table).filter(k => label === k || label.startsWith(`${k}:`) || label.startsWith(`${k}-`))
      .sort((a, b) => b.length - a.length)[0]
    if (!key) return {}
    counts[key] = (counts[key] || 0) + 1
    const v = table[key]
    return typeof v === 'function' ? v(prompt, opts, counts[key]) : JSON.parse(JSON.stringify(v))
  }
  const parallel = async (fns) => Promise.all(fns.map(f => f()))
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'process', SRC)
  const result = await fn(
    rawArgs !== undefined ? rawArgs : { slug: 'h', description: 'd', ...args }, agent, parallel,
    (m) => logs.push(String(m)), () => {}, { total: 1e12, remaining: () => 1e12 }, { env })
  return { result, calls, logs, find: (p) => calls.filter(c => c.label.startsWith(p)) }
}

test('default gates: Claude Shepherd; Bloodhound/Pointer chain = glm → mistral; a glm review of Claude code is accepted', async () => {
  const { result, find } = await runHunt({ answers: { pointer: { verdict: 'APPROVED', findingsList: [], provider: 'glm' } } })
  assert.notEqual(result.status, 'parked:cross_family_violation')
  const bh = find('bloodhound:')[0].prompt
  assert.match(bh, /Vibe\/GLM → Vibe\/Mistral Large 4/)
  assert.match(bh, /podman-vibe\.sh' 'wolfpack-bloodhound-glm'/)
  assert.match(bh, /podman-vibe\.sh' 'wolfpack-bloodhound'/)   // mistral is default-ON now
  // Alpha (Claude) wrote the plan, so the claude last-resort link is filtered out
  assert.doesNotMatch(bh, /Claude \(last resort\)/)
  const ptr = find('pointer:')[0].prompt
  assert.doesNotMatch(ptr, /Claude \(last resort\)/)   // a Claude Shepherd wrote the code
  assert.match(ptr, /podman-vibe\.sh' 'wolfpack-pointer-glm'/)
  assert.equal(find('shepherd-glm').length, 0)
  assert.equal(find('shepherd:')[0].opts.model, 'sonnet')
})

test('glm Shepherd pin (Yellow): GLM implements via --implement; glm is REMOVED from the Pointer + Watchdog chains', async () => {
  const { find, logs } = await runHunt({ answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  const g = find('shepherd-glm')
  assert.equal(g.length, 1)
  assert.match(g[0].prompt, /podman-vibe\.sh' --implement wolfpack-shepherd-glm '/)
  assert.match(g[0].prompt, /git rebase origin\/main/)
  assert.equal(find('shepherd:').length + find('shepherd-fallback').length, 0, 'no Claude Shepherd when GLM succeeds')
  const ptr = find('pointer:')[0].prompt
  assert.doesNotMatch(ptr, /-glm'/, 'Pointer must not offer a GLM link for GLM-written code')
  assert.match(ptr, /podman-vibe\.sh' 'wolfpack-pointer'/)
  // no Claude has written yet, so the last-resort link IS live for Pointer round 1
  assert.match(ptr, /Claude \(last resort\)/)
  const wd = find('watchdog:')[0].prompt
  assert.doesNotMatch(wd, /wolfpack-watchdog-glm/)
  assert.match(wd, /podman-vibe\.sh' wolfpack-watchdog /)
  // the Claude Tracker wrote tests before Certify, so the Watchdog loses the claude link
  assert.doesNotMatch(wd, /Claude \(last resort\)/)
  assert.ok(logs.some(l => /Code-writer families after Implement: glm \(last writer: glm\)/.test(l)))
  assert.ok(logs.some(l => /Code-writer families after Test: glm, claude/.test(l)))
})

test('runtime invariant: a GLM Pointer review of GLM-written code PARKS cross_family_violation', async () => {
  const { result, find } = await runHunt({ answers: {
    'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] },
    pointer: { verdict: 'APPROVED', findingsList: [], provider: 'Vibe/GLM' },
  } })
  assert.equal(result.status, 'parked:cross_family_violation')
  assert.ok(find('park:').some(c => /SAME family that wrote the artifact/.test(c.prompt)))
  assert.equal(find('tracker:').length, 0, 'never proceeds past a same-family review')
})

test('runtime invariant: a GLM certification of GLM-written code PARKS (Watchdog)', async () => {
  const { result } = await runHunt({ answers: {
    'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] },
    watchdog: { verdict: 'PASS', provider: 'zai-glm-5-3' },
  } })
  assert.equal(result.status, 'parked:cross_family_violation')
})

test('runtime invariant: an unattributable review PARKS (cannot prove cross-family)', async () => {
  const { result } = await runHunt({ answers: { bloodhound: { verdict: 'APPROVED', findingsList: [] } } })
  assert.equal(result.status, 'parked:cross_family_violation')
})

test('runtime invariant: a Claude-produced review PARKS', async () => {
  const { result } = await runHunt({ answers: { bloodhound: { verdict: 'APPROVED', findingsList: [], provider: 'claude:sonnet' } } })
  assert.equal(result.status, 'parked:cross_family_violation')
})

test('GLM Shepherd rate-limited → Claude fallback (sonnet), logged; glm still excluded from code review', async () => {
  const { find, logs } = await runHunt({ answers: {
    'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] },
    'shepherd-glm': { outcome: 'rate_limited', exitCode: 75, evidence: 'WOLFPACK_RATE_LIMITED:glm', changedFiles: ['app/x.py'] },
  } })
  const fb = find('shepherd-fallback')
  assert.equal(fb.length, 1)
  assert.equal(fb[0].opts.model, 'sonnet')
  assert.match(fb[0].prompt, /FALLBACK ENTRY/)
  assert.match(fb[0].prompt, /"primary":"glm","fallback":"claude:sonnet","reason":"rate_limited"/)
  assert.doesNotMatch(fb[0].prompt, /CRITICAL FIRST STEP: Rebase/)
  assert.ok(logs.some(l => /WOLFPACK_FALLBACK: shepherd r1 glm→claude:sonnet reason=rate_limited/.test(l)))
  assert.doesNotMatch(find('pointer:')[0].prompt, /-glm'/)
})

test('glm pin ignored on Red / Orange / compliance — Claude Opus Shepherd, GLM stays a reviewer', async () => {
  for (const [tier, compliance] of [['Red', false], ['Orange', false], ['Yellow', true]]) {
    const { find } = await runHunt({ answers: {
      alpha: { ...BASE.alpha, tier },
      'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: compliance, shepherdFamilies: [] },
      ...(compliance ? { 'compliance-gate': { determined: true, complianceTouched: false, alreadySignedOff: true } } : {}),
    } })
    assert.equal(find('shepherd-glm').length, 0, tier)
    const shep = find('shepherd:')[0]
    assert.equal(shep.opts.model, (tier === 'Red' || tier === 'Orange') ? 'opus' : 'sonnet', tier)
    assert.match(find('pointer:')[0].prompt, /wolfpack-pointer-glm/, `${tier}: GLM may review Claude code`)
  }
})

test('WOLFPACK_ENABLE_GLM=0: no seat probe, no GLM links anywhere', async () => {
  const { find } = await runHunt({ env: { WOLFPACK_ENABLE_GLM: '0' },
    answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  assert.equal(find('shepherd-seat').length, 0)
  assert.equal(find('shepherd-glm').length, 0)
  for (const c of [...find('bloodhound:'), ...find('pointer:'), ...find('watchdog:')]) {
    assert.doesNotMatch(c.prompt, /-glm'/)
  }
})

test('glm Shepherd: code-review chain = mistral → claude(last resort) (never glm)', async () => {
  const { find } = await runHunt({
    answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  const ptr = find('pointer:')[0].prompt
  assert.match(ptr, /Vibe\/Mistral Large 4 → Claude \(last resort\)/)
  assert.match(ptr, /podman-vibe\.sh' 'wolfpack-pointer'/)
  assert.doesNotMatch(ptr, /-glm'/)
})

test('resume: metadata.shepherd_families=["glm"] keeps glm out of the chain even without a pin', async () => {
  const { find } = await runHunt({ answers: { 'shepherd-seat': { shepherdPin: '', complianceCritical: false, shepherdFamilies: ['glm', 'claude'] } } })
  assert.doesNotMatch(find('pointer:')[0].prompt, /-glm'/)
  assert.doesNotMatch(find('watchdog:')[0].prompt, /wolfpack-watchdog-glm/)
})

test('Pointer rework goes back to the GLM Shepherd (same family that wrote the code)', async () => {
  const finding = { id: 1, severity: 'MEDIUM', title: 't', file: 'app/x.py', line: 1, claim: 'c', evidence: 'e', fingerprint: 'app/x.py:null-deref' }
  const { find } = await runHunt({ answers: {
    'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] },
    pointer: (_p, _o, n) => (n === 1
      ? { verdict: 'ISSUES_FOUND', findings: 1, findingsList: [finding], provider: 'mistral' }
      : { verdict: 'APPROVED', findingsList: [], provider: 'mistral' }),
    'shepherd-glm': (p) => (/Pointer round 1 rework/.test(p)
      ? { outcome: 'done', exitCode: 0, committed: true, findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'fixed' }], allAddressed: true }
      : BASE['shepherd-glm']),
  } })
  const glm = find('shepherd-glm')
  assert.equal(glm.length, 2, 'implement + rework both on GLM')
  assert.match(glm[1].prompt, /<dispositions>/)
  assert.equal(find('shepherd-rewrite').length, 0, 'no Claude rewrite when GLM reworks successfully')
})

const GLM_SEAT = { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] }
const FINDING = { id: 1, severity: 'MEDIUM', title: 't', file: 'app/x.py', line: 1, claim: 'c', evidence: 'e', fingerprint: 'app/x.py:null-deref' }
// mistral answers: it is cross-family for BOTH a Claude writer and a GLM writer, so the same
// fixture is a LEGAL accepted review in every scenario below (a glm answer would correctly
// park cross_family_violation on a GLM-written diff).
const issuesThenApprove = (_p, _o, n) => (n === 1
  ? { verdict: 'ISSUES_FOUND', findings: 1, findingsList: [FINDING], provider: 'mistral' }
  : { verdict: 'APPROVED', findingsList: [], provider: 'mistral' })

test('writer tracking: GLM rate-limited BEFORE writing → Claude writes → rework goes to Claude; reviewers may include glm', async () => {
  const { find } = await runHunt({ answers: {
    'shepherd-seat': GLM_SEAT,
    'shepherd-glm': { outcome: 'rate_limited', exitCode: 75, evidence: 'WOLFPACK_RATE_LIMITED:glm', changedFiles: [] },
    'shepherd-rewrite': { findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true },
    pointer: issuesThenApprove,
  } })
  assert.equal(find('shepherd-glm').length, 1, 'only the initial GLM attempt — rework is NOT routed by the pin')
  assert.equal(find('shepherd-fallback').length, 1)
  assert.equal(find('shepherd-rewrite').length, 1, 'rework goes to the Claude family that actually wrote')
  for (const c of find('pointer:')) assert.match(c.prompt, /'wolfpack-pointer-glm'/, 'glm wrote nothing → glm may review')
  assert.match(find('watchdog:')[0].prompt, /wolfpack-watchdog-glm/)
})

test('writer tracking: GLM rate-limited AFTER partial edits → Claude finishes; glm stays excluded (it wrote code)', async () => {
  const { find } = await runHunt({ answers: {
    'shepherd-seat': GLM_SEAT,
    'shepherd-glm': { outcome: 'rate_limited', exitCode: 75, changedFiles: ['app/x.py'] },
  } })
  assert.match(find('shepherd-fallback')[0].prompt, /"glm" \(GLM left edits\)/)
  assert.doesNotMatch(find('pointer:')[0].prompt, /-glm'/)
  assert.doesNotMatch(find('watchdog:')[0].prompt, /wolfpack-watchdog-glm/)
})

test('writer tracking: GLM writes → rework on GLM → every Pointer round excludes glm', async () => {
  const { find } = await runHunt({ answers: {
    'shepherd-seat': GLM_SEAT,
    pointer: issuesThenApprove,
    'shepherd-glm': (p) => (/Pointer round 1 rework/.test(p)
      ? { outcome: 'done', exitCode: 0, committed: true, changedFiles: ['app/x.py'], findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'fixed' }], allAddressed: true }
      : BASE['shepherd-glm']),
  } })
  assert.equal(find('shepherd-glm').length, 2)
  const ptrs = find('pointer:')
  assert.equal(ptrs.length, 2)
  for (const c of ptrs) assert.doesNotMatch(c.prompt, /-glm'/)
})

test('GLM Shepherd timeout → Claude fallback logged as timeout (not rate_limited)', async () => {
  const { find, logs } = await runHunt({ answers: {
    'shepherd-seat': GLM_SEAT,
    'shepherd-glm': { outcome: 'timeout', exitCode: 76, evidence: 'WOLFPACK_TIMEOUT:glm', changedFiles: [] },
  } })
  assert.match(find('shepherd-fallback')[0].prompt, /"reason":"timeout"/)
  assert.ok(logs.some(l => /glm→claude:sonnet reason=timeout/.test(l)))
})

test('seat probe treats models.architect_recommended as ADVISORY (binding = model_assignments.shepherd)', async () => {
  const { find } = await runHunt({})
  const probe = find('shepherd-seat')[0].prompt
  assert.match(probe, /metadata\.model_assignments\.shepherd/)
  assert.match(probe, /IGNORE metadata\.models\.architect_recommended/)
})

test('slug charset is validated fail-loud at hunt start', async () => {
  for (const bad of ['bad slug', 'x;rm -rf /', "a'b", 'Upper', '-lead', '']) {
    await assert.rejects(runHunt({ args: { slug: bad } }), /invalid slug/, bad)
  }
})

test('args: a bare slug string resumes an existing hunt (the auto-generated invocation)', async () => {
  const probe = { fresh: false, status: 'ready_for_alpha', resumePhase: 'Spec', worktreePath: WT, planDir: PD,
    worktreeExists: true, branchExists: true }
  const { result, find } = await runHunt({ rawArgs: 'h', answers: { 'resume-probe': probe } })
  assert.equal(find('scaffold').length, 0, 'existing hunt is adopted, not re-scaffolded')
  assert.notEqual(result.status, undefined)
})

test('args: a JSON string still parses; a bare slug on a FRESH hunt fails loud (no description)', async () => {
  const { find } = await runHunt({ rawArgs: '{"slug": "h", "description": "d"}' })
  assert.equal(find('scaffold').length, 1)
  await assert.rejects(runHunt({ rawArgs: 'h' }), /no description was passed/)
  await assert.rejects(runHunt({ rawArgs: 'bad slug' }), /invalid slug/)
})

test('shell commands single-quote interpolated paths (worktree with a space and a quote)', async () => {
  const wt = "/re po/it's/.agents/worktrees/h"
  const { find } = await runHunt({ answers: { scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  const bh = find('bloodhound:')[0].prompt
  assert.ok(bh.includes(`'/re po/it'\\''s/.agents/worktrees/h'`), 'worktree path is POSIX single-quoted')
  assert.ok(bh.includes(`'/re po/it'\\''s/scripts/podman-vibe.sh'`), 'shim path is quoted too')
})

test('resume: a Tracker-bounce re-entry goes to the LAST writer (claude), not the glm pin', async () => {
  const probe = { fresh: false, status: 'test_rewrite_needed', resumePhase: 'Implement', tier: 'Yellow',
    worktreePath: WT, planDir: PD, worktreeExists: true, branchExists: true, trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }
  const { find } = await runHunt({ answers: {
    'resume-probe': probe,
    'shepherd-seat': { ...GLM_SEAT, shepherdFamilies: ['glm', 'claude'], lastShepherdFamily: 'claude' },
  } })
  assert.equal(find('shepherd-glm').length, 0, 'last writer was Claude → no GLM step')
  assert.match(find('shepherd:')[0].prompt, /REWRITE ENTRY — Tracker round 1/)
  // glm wrote earlier on this branch (shepherd_families) → still excluded from review
  assert.doesNotMatch(find('pointer:')[0].prompt, /-glm'/)
})

test('resume: a Tracker-bounce re-entry goes back to GLM when GLM was the last writer', async () => {
  const probe = { fresh: false, status: 'test_rewrite_needed', resumePhase: 'Implement', tier: 'Yellow',
    worktreePath: WT, planDir: PD, worktreeExists: true, branchExists: true, trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }
  const { find } = await runHunt({ answers: {
    'resume-probe': probe,
    'shepherd-seat': { ...GLM_SEAT, shepherdFamilies: ['glm'], lastShepherdFamily: 'glm' },
  } })
  assert.equal(find('shepherd-glm').length, 1)
  assert.match(find('shepherd-glm')[0].prompt, /REWRITE ENTRY — Tracker round 1/)
})

// ─── campaign-runner: stale runtime pipeline guard ──────────────────────────
const RUNNER = readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')
async function runRunner({ env = {}, protocol }) {
  const calls = []
  const agent = async (_p, opts = {}) => {
    calls.push(opts.label)
    if (opts.label === 'parse-campaign') return { waves: [] }
    if (opts.label === 'pipeline-capability') return { path: '.claude/workflows/hunt-pipeline.js', protocol }
    return {}
  }
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'process', 'workflow', RUNNER)
  await fn({ campaign: 'c' }, agent, async (f) => Promise.all(f.map(x => x())), () => {}, () => {},
    { total: 0, remaining: () => 1e12 }, { env }, async () => ({}))
  return calls
}

test('campaign-runner: stale runtime pipeline (no examiner protocol) fails loud before any hunt', async () => {
  await assert.rejects(runRunner({ protocol: 0 }), /STALE .*wolfpack-sync-runtime\.sh/)
})

test('campaign-runner: current runtime pipeline passes the capability preflight', async () => {
  const calls = await runRunner({ protocol: 3 })
  assert.ok(calls.includes('pipeline-capability'))
})

test('campaign-runner: the preflight ALWAYS runs — there is no gemini-only skip case', async () => {
  const calls = await runRunner({ env: { WOLFPACK_ENABLE_GLM: '0' }, protocol: 3 })
  assert.ok(calls.includes('pipeline-capability'))
})

test('hunt-pipeline carries the capability marker the runner greps for', () => {
  assert.match(SRC, /WOLFPACK_EXAMINER_PROTOCOL=3/)
})

// ─── Round 2: durable writer record (crash between GLM commit and metadata write) ───
const RESUME_AT_CODE_REVIEW = { fresh: false, status: 'implemented', resumePhase: 'Code Review', tier: 'Yellow',
  worktreePath: WT, planDir: PD, worktreeExists: true, branchExists: true, trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }

test('crash after GLM commit, before metadata: git trailer keeps glm out of review (union, loud mismatch)', async () => {
  const { find, logs } = await runHunt({ answers: {
    'resume-probe': RESUME_AT_CODE_REVIEW,
    // metadata lost the glm record; git still carries the Wolfpack-Writer: glm trailer
    'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: ['claude'],
      lastShepherdFamily: 'claude', gitWriterFamilies: ['glm'], gitHeadWriter: 'glm', glmWritePending: false },
    pointer: issuesThenApprove,
    'shepherd-glm': { outcome: 'done', exitCode: 0, committed: true, changedFiles: ['a'],
      findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true },
  } })
  assert.equal(find('shepherd:').length, 0, 'resumed past Implement')
  for (const c of find('pointer:')) assert.doesNotMatch(c.prompt, /-glm'/, 'GLM must not review its own commit')
  assert.doesNotMatch(find('watchdog:')[0].prompt, /wolfpack-watchdog-glm/)
  assert.ok(logs.some(l => /WRITER RECORD MISMATCH/.test(l)))
  assert.equal(find('shepherd-glm').length, 1, 'git HEAD trailer (glm) routes the rework back to GLM')
})

test('crash mid-GLM-step (glm_write_pending, no trailer yet): glm excluded even without a pin', async () => {
  const { find, logs } = await runHunt({ answers: {
    'resume-probe': RESUME_AT_CODE_REVIEW,
    'shepherd-seat': { shepherdPin: '', complianceCritical: false, shepherdFamilies: [], lastShepherdFamily: '',
      gitWriterFamilies: [], gitHeadWriter: '', glmWritePending: true, uncommittedChanges: true },
  } })
  assert.doesNotMatch(find('pointer:')[0].prompt, /-glm'/)
  assert.ok(logs.some(l => /glm_write_pending=true/.test(l)))
})

test('writer record: seat probe cross-checks git trailers; GLM wrapper pre-marks before the shim and trailers its commit', async () => {
  const { find } = await runHunt({ answers: { 'shepherd-seat': GLM_SEAT } })
  const probe = find('shepherd-seat')[0].prompt
  assert.match(probe, /trailers:key=Wolfpack-Writer,valueonly/)
  const w = find('shepherd-glm')[0].prompt
  const pre = w.indexOf('"glm_write_pending" = true'), shim = w.indexOf('4. Run the shim')
  assert.ok(pre > 0 && pre < shim, 'pending marker is written BEFORE the shim runs')
  assert.match(w, /--trailer "Wolfpack-Writer: glm"/)
  assert.match(find('pointer:')[0].prompt, /Pointer/)   // sanity: pipeline continued
})

test('node helper invocations quote repo/plan paths (space + quote)', async () => {
  const wt = "/re po/it's/.agents/worktrees/h"
  const { find } = await runHunt({ answers: { scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  const q = (x) => `'${x.replace(/'/g, `'\\''`)}'`
  assert.ok(find('alpha:')[0].prompt.includes(`node ${q("/re po/it's/scripts/wolfpack-routing.mjs")} ${q(`${wt}/.wolfpack/plans/h`)}`))
  const wd = find('watchdog:')[0].prompt
  assert.ok(wd.includes(`node ${q("/re po/it's/scripts/wolfpack-timing.mjs")} ${q(`${wt}/.wolfpack/plans/h`)}`))
  assert.ok(wd.includes(`node ${q("/re po/it's/scripts/wolfpack-model-stats.mjs")} --stamp`))
})

// ─── Tracker coverage (retire-gemini-glm-large4) ─────────────────────────────
// The realized-writer record (AC22/AC23), the claude-ANSWERED review paths (AC17/AC18)
// and the merge→sync protocol window (AC25). Specified in plan-final.md §
// `scripts/wolfpack-hunt-pipeline.test.mjs`.

const RESUME_AT_CERTIFY = { fresh: false, status: 'tests_pass', resumePhase: 'Certify', tier: 'Yellow',
  worktreePath: WT, planDir: PD, worktreeExists: true, branchExists: true,
  trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }

test('AC22: a Claude Tracker joins the writer record — Pointer keeps the claude link, Watchdog loses it', async () => {
  const { find, logs } = await runHunt({ answers: { 'shepherd-seat': GLM_SEAT } })
  // Implement: only GLM has written — the claude last-resort link is still live
  assert.ok(logs.some(l => /Code-writer families after Implement: glm \(last writer: glm\)/.test(l)),
    `after-Implement log missing: ${logs.filter(l => /Code-writer/.test(l))}`)
  assert.match(find('pointer:')[0].prompt, /Claude \(last resort\)/)
  // Test: the Tracker's tests are code on the branch, so claude joins the record
  assert.ok(logs.some(l => /Code-writer families after Test: glm, claude/.test(l)),
    `after-Test log missing: ${logs.filter(l => /Code-writer/.test(l))}`)
  assert.doesNotMatch(find('watchdog:')[0].prompt, /Claude \(last resort\)/,
    'a Claude Watchdog must never certify Claude-written tests')
  // the trailer the probe reads back must be stamped on the Tracker's own commits
  const trk = find('tracker:')[0].prompt
  assert.match(trk, /WRITER RECORD/)
  assert.match(trk, /Wolfpack-Writer: claude/)
  assert.doesNotMatch(trk, /Wolfpack-Writer: undefined/)
  assert.match(trk, /append "claude" to the test_writer_families array/)
})

test('AC23: Claude Shepherd + Claude Tracker ⇒ no claude link on ANY code-review seat', async () => {
  const { find, logs } = await runHunt({})
  assert.ok(logs.some(l => /Code-writer families after Implement: claude \(last writer: claude\)/.test(l)))
  assert.ok(logs.some(l => /Code-writer families after Test: claude$/.test(l)))
  assert.doesNotMatch(find('pointer:')[0].prompt, /Claude \(last resort\)/)
  assert.doesNotMatch(find('watchdog:')[0].prompt, /Claude \(last resort\)/)
})

test('AC18: a FIRED Claude Shepherd fallback costs the hunt its last-resort link', async () => {
  const { find, logs } = await runHunt({ answers: {
    'shepherd-seat': GLM_SEAT,
    'shepherd-glm': { outcome: 'rate_limited', exitCode: 75, evidence: 'WOLFPACK_RATE_LIMITED:glm', changedFiles: ['app/x.py'] },
  } })
  assert.ok(logs.some(l => /Code-writer families after Implement: glm, claude \(last writer: claude\)/.test(l)),
    `${logs.filter(l => /Code-writer/.test(l))}`)
  assert.doesNotMatch(find('pointer:')[0].prompt, /Claude \(last resort\)/)
  assert.doesNotMatch(find('watchdog:')[0].prompt, /Claude \(last resort\)/)
})

test('AC18: resumed PAST Implement with an empty writer record → loud warning, no claude link', async () => {
  const { find, logs } = await runHunt({ answers: {
    'resume-probe': RESUME_AT_CODE_REVIEW,
    'shepherd-seat': { shepherdPin: '', complianceCritical: false, shepherdFamilies: [],
      lastShepherdFamily: '', gitWriterFamilies: [], gitHeadWriter: '', glmWritePending: false },
    pointer: issuesThenApprove,
  } })
  assert.ok(logs.some(l => /no code-writer record at code-review dispatch/.test(l)),
    'an unprovable writer record must be announced, never silently assumed')
  for (const c of find('pointer:')) assert.doesNotMatch(c.prompt, /Claude \(last resort\)/)
})

test('AC18: resumed AT Implement with an empty writer record → the phase itself seeds claude', async () => {
  // Distinct from the row above: here the Implement phase RUNS, so the record is seeded by
  // noteClaudeWrote() rather than by the dispatch-site guard. Either way the claude link must
  // be gone by the time Pointer dispatches — that is the guarantee, not which guard fired.
  const probe = { fresh: false, status: 'debriefed', resumePhase: 'Implement', tier: 'Yellow',
    worktreePath: WT, planDir: PD, worktreeExists: true, branchExists: true,
    trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }
  const { find, logs } = await runHunt({ answers: {
    'resume-probe': probe,
    'shepherd-seat': { shepherdPin: '', complianceCritical: false, shepherdFamilies: [],
      lastShepherdFamily: '', gitWriterFamilies: [], gitHeadWriter: '', glmWritePending: false },
  } })
  assert.ok(logs.some(l => /Code-writer families: \(none yet\)/.test(l)), 'the probe found no record')
  assert.ok(logs.some(l => /Code-writer families after Implement: claude/.test(l)), 'the phase seeded it')
  assert.doesNotMatch(find('pointer:')[0].prompt, /Claude \(last resort\)/)
})

test('AC22 (metadata channel): resume at Certify reads test_writer_families back', async () => {
  const { find, logs } = await runHunt({ answers: {
    'resume-probe': RESUME_AT_CERTIFY,
    'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: ['glm'],
      testWriterFamilies: ['claude'], lastShepherdFamily: 'glm',
      gitWriterFamilies: [], gitHeadWriter: '', glmWritePending: false },
  } })
  assert.equal(find('tracker:').length, 0, 'resumed past Test')
  assert.ok(logs.some(l => /Watchdog chain: .*\(code writers: glm, claude\)/.test(l)),
    `union not {glm,claude}: ${logs.filter(l => /Watchdog chain/.test(l))}`)
  assert.doesNotMatch(find('watchdog:')[0].prompt, /Claude \(last resort\)/)
  assert.ok(!logs.some(l => /no test-writer record at Certify dispatch/.test(l)),
    'the metadata channel satisfied the record — no over-seed warning')
})

test('AC22 (trailer channel, POSITIVE): a Tracker Wolfpack-Writer trailer is read back at Certify', async () => {
  // The Shepherd was GLM and its metadata channel says so, so a `claude` trailer on
  // main..HEAD could only have been produced by a Tracker commit.
  const { find, logs } = await runHunt({ answers: {
    'resume-probe': RESUME_AT_CERTIFY,
    'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: ['glm'],
      lastShepherdFamily: 'glm', gitWriterFamilies: ['glm', 'claude'], gitHeadWriter: 'claude',
      glmWritePending: false },
  } })
  assert.ok(logs.some(l => /Watchdog chain: .*\(code writers: glm, claude\)/.test(l)),
    `union not {glm,claude}: ${logs.filter(l => /Watchdog chain/.test(l))}`)
  assert.doesNotMatch(find('watchdog:')[0].prompt, /Claude \(last resort\)/,
    'a dead trailer key would show up here as a live claude link')
})

test('Risk 6: resume at Certify with BOTH Tracker channels lost → loud over-seed, no claude link', async () => {
  const { find, logs } = await runHunt({ answers: {
    'resume-probe': RESUME_AT_CERTIFY,
    'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: ['glm'],
      lastShepherdFamily: 'glm', gitWriterFamilies: ['glm'], gitHeadWriter: 'glm', glmWritePending: false },
  } })
  assert.ok(logs.some(l => /no test-writer record at Certify dispatch — assuming claude wrote the tests/.test(l)))
  assert.doesNotMatch(find('watchdog:')[0].prompt, /Claude \(last resort\)/)
})

test('AC17: a claude-ANSWERED review is ACCEPTED, logged loud, and durably recorded', async () => {
  const { result, find, logs } = await runHunt({ answers: {
    'shepherd-seat': GLM_SEAT,
    pointer: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'claude' },
  } })
  assert.notEqual(result.status, 'parked:cross_family_violation', 'claude is a LEGAL final link here')
  // the prompt mandates the operator-visible marker…
  assert.match(find('pointer:')[0].prompt, /WOLFPACK_CLAUDE_FALLBACK: pointer/)
  assert.match(find('pointer:')[0].prompt, /no shim — YOU are Claude/)
  // …and the PIPELINE writes the durable row itself rather than trusting the examiner
  assert.ok(logs.some(l => /was answered by the CLAUDE LAST-RESORT examiner \(provider "claude"\)/.test(l)))
  const rec = find('claude-fallback-record:')
  assert.equal(rec.length, 1, 'exactly one claude_fallback_reviews row')
  assert.match(rec[0].prompt, /"claude_fallback_reviews"/)
  assert.match(rec[0].prompt, /"role": "pointer"/)
  assert.match(rec[0].prompt, /"round": 1/)
  assert.match(rec[0].prompt, /"reason": "every cross-family link in \[mistral, claude\] was unavailable"/)
})

test('AC18: a claude-ANSWERED review when CLAUDE wrote code PARKS cross_family_violation', async () => {
  const { result, find, logs } = await runHunt({ answers: {
    'shepherd-seat': { ...GLM_SEAT, shepherdFamilies: ['glm', 'claude'] },
    pointer: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'claude' },
  } })
  assert.equal(result.status, 'parked:cross_family_violation',
    'deleting the "never Claude" special case must not weaken the writer-family check')
  assert.equal(find('claude-fallback-record:').length, 0, 'a rejected review is never recorded as accepted')
  assert.equal(find('tracker:').length, 0, 'never proceeds past a same-family review')
  assert.ok(logs.some(l => /CROSS-FAMILY VIOLATION/.test(l)))
})

// AC25 — the merge→sync window: a protocol-2 runtime pipeline must WARN, never throw.
async function runRunnerLogged({ env = {}, protocol }) {
  const calls = []
  const logs = []
  const agent = async (_p, opts = {}) => {
    calls.push(opts.label)
    if (opts.label === 'parse-campaign') return { waves: [] }
    if (opts.label === 'pipeline-capability') return { path: '.claude/workflows/hunt-pipeline.js', protocol }
    return {}
  }
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'process', 'workflow', RUNNER)
  await fn({ campaign: 'c' }, agent, async (f) => Promise.all(f.map(x => x())), (m) => logs.push(String(m)),
    () => {}, { total: 0, remaining: () => 1e12 }, { env }, async () => ({}))
  return { calls, logs }
}

test('AC25: a protocol-2 runtime pipeline (merge→sync window) WARNS and continues', async () => {
  const { calls, logs } = await runRunnerLogged({ protocol: 2 })
  assert.ok(calls.includes('pipeline-capability'))
  assert.ok(logs.some(l => /STALE PIPELINE/.test(l)), `no STALE PIPELINE warning: ${logs}`)
  assert.ok(logs.some(l => /wolfpack-sync-runtime\.sh/.test(l)), 'the warning names the fix command')
})

test('AC25: protocol 1 and 0 are still BELOW the floor and fail loud', async () => {
  await assert.rejects(runRunnerLogged({ protocol: 1 }), /STALE .*examiner protocol/)
  await assert.rejects(runRunnerLogged({ protocol: 0 }), /STALE .*examiner protocol/)
})

// ════════════════════════════════════════════════════════════════════════════
// usage-limit-gate (AC6–AC10): usage offload seat, Claude final review, usage stamping,
// offload record, infra signal.
// ════════════════════════════════════════════════════════════════════════════
const OFFLOAD_SEAT = { shepherdPin: '', complianceCritical: false, shepherdFamilies: [], usageOffload: true }
const isFinalPrompt = (p) => /CLAUDE FINAL REVIEW \(usage offload, Red\/compliance\) — not a fallback/.test(p)
const pointerRoundOf = (c) => Number((c.label.match(/:r(\d+)/) || [])[1])
// Cross-family rounds answer from mistral; the forced-claude final round from claude.
const pointerBy = ({ finalVerdicts = ['APPROVED'] } = {}) => {
  let finalN = 0
  return (p) => {
    if (isFinalPrompt(p)) {
      const v = finalVerdicts[Math.min(finalN++, finalVerdicts.length - 1)]
      return v === 'APPROVED'
        ? { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'claude' }
        : { verdict: 'ISSUES_FOUND', findings: 1, findingsList: [FINDING], provider: 'claude' }
    }
    return { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'mistral' }
  }
}

test('offload AC6: Red + usage offload ⇒ GLM Shepherd (judgment override suspended), Claude final review after the cross-family approval', async () => {
  const { result, find, logs } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 },
    'shepherd-seat': OFFLOAD_SEAT,
    pointer: pointerBy(),
  } })
  assert.notEqual(result.status, 'parked:cross_family_violation', JSON.stringify(result))
  assert.equal(find('shepherd-glm').length, 1, 'GLM implements on Red under offload')
  assert.equal(find('shepherd:').length, 0, 'no Claude Shepherd')
  assert.ok(logs.some(l => /⚖ Shepherd seat: Vibe\/GLM — USAGE OFFLOAD \(weekly pace\) on tier Red; Claude opus is the fallback\. A Claude final review follows/.test(l)), logs.join('\n'))
  assert.equal(logs.some(l => /IGNORED/.test(l)), false)
  const ptr = find('pointer:')
  assert.equal(ptr.length, 2, 'one cross-family round + one Claude final round')
  assert.equal(isFinalPrompt(ptr[0].prompt), false)
  assert.doesNotMatch(ptr[0].prompt, /-glm'/, 'golden rule: glm never reviews GLM-written code')
  assert.match(ptr[0].prompt, /podman-vibe\.sh' 'wolfpack-pointer'/)
  assert.ok(isFinalPrompt(ptr[1].prompt))
  assert.match(ptr[1].prompt, /claude_final_reviews/)
  assert.doesNotMatch(ptr[1].prompt, /podman-vibe\.sh/, 'the final round forces the claude link only')
  assert.ok(logs.some(l => /CLAUDE FINAL REVIEW passed/.test(l)))
  assert.equal(find('tracker:').length, 1, 'proceeds to Test after the final review')
  // the cross-family Watchdog still excludes glm
  assert.doesNotMatch(find('watchdog:')[0].prompt, /wolfpack-watchdog-glm/)
})

test('offload AC6: Claude final review ISSUES_FOUND ⇒ GLM rework ⇒ cross-family round ⇒ Claude final again', async () => {
  const { result, find, logs } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 6 },
    'shepherd-seat': OFFLOAD_SEAT,
    pointer: pointerBy({ finalVerdicts: ['ISSUES_FOUND', 'APPROVED'] }),
    'shepherd-glm': (p) => (/rework/i.test(p)
      ? { outcome: 'done', exitCode: 0, committed: true, findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'fixed' }], allAddressed: true }
      : BASE['shepherd-glm']),
  } })
  assert.notEqual(result.status && result.status.startsWith('parked'), true, JSON.stringify(result))
  const ptr = find('pointer:')
  assert.deepEqual(ptr.map(c => isFinalPrompt(c.prompt)), [false, true, false, true], 'cross → final(issues) → cross → final(approve)')
  assert.deepEqual(ptr.map(pointerRoundOf), [1, 2, 3, 4])
  const glm = find('shepherd-glm')
  assert.equal(glm.length, 2, 'implement + one GLM rework for the Claude final findings')
  assert.equal(find('shepherd-rewrite').length + find('shepherd-fallback').length, 0, 'rework stays on GLM')
  for (const c of ptr) assert.doesNotMatch(c.prompt, /-glm'/)
  assert.ok(logs.some(l => /CLAUDE FINAL REVIEW passed/.test(l)))
  assert.equal(find('tracker:').length, 1)
})

test('offload AC6: Orange + compliance-critical ⇒ Claude final round runs; plain Orange offload ⇒ it does NOT', async () => {
  const cc = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange', pointerRounds: 3 },
    'shepherd-seat': { ...OFFLOAD_SEAT, complianceCritical: true },
    'compliance-gate': { determined: true, complianceTouched: false, alreadySignedOff: true },
    pointer: pointerBy(),
  } })
  assert.equal(cc.find('shepherd-glm').length, 1)
  assert.deepEqual(cc.find('pointer:').map(c => isFinalPrompt(c.prompt)), [false, true])

  const plain = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange', pointerRounds: 3 },
    'shepherd-seat': OFFLOAD_SEAT,
    pointer: pointerBy(),
  } })
  assert.equal(plain.find('shepherd-glm').length, 1, 'GLM Shepherd on Orange under offload')
  assert.deepEqual(plain.find('pointer:').map(c => isFinalPrompt(c.prompt)), [false])
  assert.equal(plain.logs.some(l => /A Claude final review follows/.test(l)), false)
})

test('offload: light tier (Yellow) offload ⇒ GLM Shepherd, no Claude final round', async () => {
  const { find } = await runHunt({ answers: { 'shepherd-seat': OFFLOAD_SEAT, pointer: pointerBy() } })
  assert.equal(find('shepherd-glm').length, 1)
  assert.deepEqual(find('pointer:').map(c => isFinalPrompt(c.prompt)), [false])
})

test('offload: NO offload on Red ⇒ unchanged — Claude opus Shepherd, single cross-family Pointer round, no final review', async () => {
  const { find, logs } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 },
    'shepherd-seat': { ...OFFLOAD_SEAT, usageOffload: false },
    pointer: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'glm' },
  } })
  assert.equal(find('shepherd-glm').length, 0)
  assert.equal(find('shepherd:')[0].opts.model, 'opus')
  assert.equal(find('pointer:').length, 1)
  assert.equal(logs.some(l => /USAGE OFFLOAD|CLAUDE FINAL/.test(l)), false)
})

test('offload: Claude fallback Shepherd fired ⇒ Claude final review SKIPPED (claude cannot review claude), logged + recorded', async () => {
  const { find, logs } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 },
    'shepherd-seat': OFFLOAD_SEAT,
    'shepherd-glm': { outcome: 'rate_limited', exitCode: 75, evidence: 'WOLFPACK_RATE_LIMITED:glm', changedFiles: [] },
    pointer: pointerBy(),
  } })
  assert.equal(find('shepherd-fallback').length, 1)
  assert.equal(find('shepherd-fallback')[0].opts.model, 'opus', 'Red fallback is the judgment model')
  assert.deepEqual(find('pointer:').map(c => isFinalPrompt(c.prompt)), [false])
  assert.ok(logs.some(l => /⚠ Claude final review SKIPPED — claude wrote code on this branch; cross-family review stands/.test(l)), logs.join('\n'))
  const rec = find('claude-final-skip-record')
  assert.equal(rec.length, 1)
  assert.match(rec[0].prompt, /claude_final_review_skipped/)
  assert.match(rec[0].prompt, /preserve every field you did not compute/)
})

test('offload record: args.usageOffload ⇒ record-offload agent runs once (quoted), logs ⚖; absent ⇒ no agent', async () => {
  const withIt = await runHunt({ args: { usageOffload: { reason: "weekly pace +16.4 — it's ahead" } },
    answers: { 'usage-offload': { ok: true, reason: "weekly pace +16.4 — it's ahead" } } })
  const rec = withIt.find('usage-offload:')
  assert.equal(rec.length, 1)
  assert.equal(rec[0].opts.model, 'sonnet')
  assert.match(rec[0].prompt, /node '\/repo\/scripts\/wolfpack-usage\.mjs' record-offload --plan-dir '\/repo\/\.agents\/worktrees\/h\/\.wolfpack\/plans\/h' --reason 'weekly pace \+16\.4 — it'\\''s ahead'/)
  assert.ok(withIt.logs.some(l => /⚖ usage offload: weekly pace \+16\.4/.test(l)))
  // the record runs BEFORE the seat probe reads metadata.usage_offload
  const idx = (p) => withIt.calls.findIndex(c => c.label.startsWith(p))
  assert.ok(idx('usage-offload:') < idx('shepherd-seat'))
  const failed = await runHunt({ args: { usageOffload: { reason: 'x' } }, answers: { 'usage-offload': { ok: false, error: 'metadata unparseable' } } })
  assert.ok(failed.logs.some(l => /⚠ usage offload NOT recorded for h \(metadata unparseable\)/.test(l)))
  const without = await runHunt()
  assert.equal(without.find('usage-offload').length, 0)
})

test('usage stamp AC7/AC8: every timed phase heartbeat carries the GUARDED stamp (absolute CLI, -f and -w, --plan-dir); Scaffold uses -f only', async () => {
  const { find } = await runHunt()
  const timedStamp = `if [ -f "/repo/scripts/wolfpack-usage.mjs" ] && [ -w "${WT}/.wolfpack/plans/h" ]; then node "/repo/scripts/wolfpack-usage.mjs" stamp --heartbeat .wolfpack/heartbeats/h.json --plan-dir "${WT}/.wolfpack/plans/h"; fi`
  for (const p of ['alpha:', 'bloodhound:', 'shepherd:', 'pointer:', 'tracker:', 'watchdog:']) {
    const c = find(p)[0]
    assert.ok(c, p)
    const n = c.prompt.split(timedStamp).length - 1
    assert.equal(n, 2, `${p} prompt: stamp after the JSON write AND after "done" (found ${n})`)
    assert.match(c.prompt, /preserve every other heartbeat field/)
    assert.match(c.prompt, /expected in a sandboxed seat/)
  }
  const sc = find('scaffold:')[0].prompt
  assert.match(sc, /if \[ -f "scripts\/wolfpack-usage\.mjs" \]; then node "scripts\/wolfpack-usage\.mjs" stamp --heartbeat \.wolfpack\/heartbeats\/h\.json; fi/)
  assert.doesNotMatch(sc, /stamp --heartbeat[^\n]*--plan-dir/, 'Scaffold never stamps metadata (no plan dir yet)')
})

test('metadata preserve clause: the Plan prompt and every "update metadata.json" prompt carry it', async () => {
  const { find, calls } = await runHunt()
  const alpha = find('alpha:')[0].prompt
  assert.match(alpha, /preserve every field you did not compute, including `usage_delta`, `usage_offload` and `mistral_rate_limits`/)
  assert.match(alpha, /EXCEPTION: if metadata\.usage_offload is set, the\s+router assigns glm:5\.3 on every tier \(usage offload\)\. Adopt it\./)
  for (const c of calls) {
    for (const m of c.prompt.matchAll(/^.*[Uu]pdate[^\n]*metadata\.json.*$/gm)) {
      // a line that tells the agent to update metadata.json must carry the preserve note
      // somewhere in the same prompt (it is shared, so it may be on the same line or appended)
      assert.match(c.prompt, /read-modify-write: preserve every field you did not compute/, `${c.label}: ${m[0].trim()}`)
    }
  }
  assert.equal(/WOLFPACK_USAGE_PROTOCOL=1/.test(SRC), true, 'capability marker the runner greps for')
})

test('AC10: review prompts carry the INFRA SIGNAL note; infra_error is NOT a quota status', async () => {
  const { find } = await runHunt()
  for (const p of ['bloodhound:', 'pointer:']) {
    const pr = find(p)[0].prompt
    assert.match(pr, /INFRA SIGNAL: exit code 77 OR a line starting with `WOLFPACK_INFRA_ERROR:`/)
    assert.match(pr, /return status `infra_error`,\s+never `model_quota`/)
    assert.match(pr, /incl\. exit 77 \/ WOLFPACK_INFRA_ERROR/)
  }
  const line = SRC.split('\n').find(l => /^const isQuotaStatus = /.test(l))
  const isQuotaStatus = new Function(`${line}; return isQuotaStatus`)()
  assert.equal(isQuotaStatus('infra_error'), false)
  assert.equal(isQuotaStatus('model_quota'), true)
  assert.equal(isQuotaStatus('rate_limited'), true)
})

test('AC10: a Pointer that fails with status infra_error parks review_error — never model_quota', async () => {
  const { result } = await runHunt({ answers: { pointer: { verdict: 'ERROR', status: 'infra_error', findingsList: [] } } })
  assert.equal(result.verdict, 'PARKED')
  assert.notEqual(result.reason, 'model_quota')
  assert.notEqual(result.status, 'parked:model_quota')
})

test('seat probe: the schema and prompt carry usageOffload', async () => {
  const { find } = await runHunt()
  const seat = find('shepherd-seat')[0]
  assert.equal(seat.opts.schema.properties.usageOffload.type, 'boolean')
  assert.match(seat.prompt, /usageOffload: true if metadata\.usage_offload is set/)
})
