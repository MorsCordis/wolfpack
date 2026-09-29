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
  alpha: { verdict: 'PLANNED', tier: 'Yellow', bloodhoundRounds: 1, pointerRounds: 1, trackerRounds: 1, bloodhoundModel: 'gemini' },
  bloodhound: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'gemini', status: 'gemini' },
  debrief: {},
  'shepherd-seat': { shepherdPin: '', complianceCritical: false, shepherdFamilies: [] },
  'shepherd-glm': { outcome: 'done', exitCode: 0, changedFiles: ['app/x.py'], committed: true },
  shepherd: { verdict: 'DONE' },
  pointer: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'gemini', status: 'gemini' },
  tracker: { verdict: 'TESTS_PASS' },
  watchdog: { verdict: 'PASS', provider: 'gemini', status: 'gemini' },
  'compliance-gate': { determined: true, complianceTouched: false, alreadySignedOff: false },
  verify: { verdict: 'PASS' },
  park: {},
}

async function runHunt({ env = {}, answers = {}, args = {} } = {}) {
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
    { slug: 'h', description: 'd', ...args }, agent, parallel,
    (m) => logs.push(String(m)), () => {}, { total: 1e12, remaining: () => 1e12 }, { env })
  return { result, calls, logs, find: (p) => calls.filter(c => c.label.startsWith(p)) }
}

test('default gates: Claude Shepherd; Bloodhound/Pointer chain = gemini → glm; a glm review of Claude code is accepted', async () => {
  const { result, find } = await runHunt({ answers: { pointer: { verdict: 'APPROVED', findingsList: [], provider: 'glm' } } })
  assert.notEqual(result.status, 'parked:cross_family_violation')
  const bh = find('bloodhound:')[0].prompt
  assert.match(bh, /Agy\/Gemini → Vibe\/GLM/)
  assert.match(bh, /podman-vibe\.sh' 'wolfpack-bloodhound-glm'/)
  assert.doesNotMatch(bh, /podman-vibe\.sh' 'wolfpack-bloodhound'/)   // mistral not enabled
  const ptr = find('pointer:')[0].prompt
  assert.match(ptr, /podman-agy\.sh' --review/)
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
  assert.match(ptr, /podman-agy\.sh' --review/)
  const wd = find('watchdog:')[0].prompt
  assert.doesNotMatch(wd, /wolfpack-watchdog-glm/)
  assert.match(wd, /podman-agy\.sh' --certify/)
  assert.ok(logs.some(l => /Code-writer families after Implement: claude, glm \(last writer: glm\)/.test(l)))
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

test('Mistral opted in + glm Shepherd: code-review chain = gemini → mistral (never glm)', async () => {
  const { find } = await runHunt({ env: { WOLFPACK_ENABLE_MISTRAL_AUTO: '1' },
    answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  const ptr = find('pointer:')[0].prompt
  assert.match(ptr, /Agy\/Gemini → Vibe\/Mistral/)
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
      ? { verdict: 'ISSUES_FOUND', findings: 1, findingsList: [finding], provider: 'gemini' }
      : { verdict: 'APPROVED', findingsList: [], provider: 'gemini' }),
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
const issuesThenApprove = (_p, _o, n) => (n === 1
  ? { verdict: 'ISSUES_FOUND', findings: 1, findingsList: [FINDING], provider: 'gemini' }
  : { verdict: 'APPROVED', findingsList: [], provider: 'gemini' })

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

test('shell commands single-quote interpolated paths (worktree with a space and a quote)', async () => {
  const wt = "/re po/it's/.agents/worktrees/h"
  const { find } = await runHunt({ answers: { scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  const bh = find('bloodhound:')[0].prompt
  assert.ok(bh.includes(`'/re po/it'\\''s/.agents/worktrees/h'`), 'worktree path is POSIX single-quoted')
  assert.ok(bh.includes(`'/re po/it'\\''s/scripts/podman-agy.sh' --review`), 'shim path is quoted too')
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
  const calls = await runRunner({ protocol: 2 })
  assert.ok(calls.includes('pipeline-capability'))
})

test('campaign-runner: gemini-only rotation (GLM off, Mistral off) skips the preflight', async () => {
  const calls = await runRunner({ env: { WOLFPACK_ENABLE_GLM: '0' }, protocol: 0 })
  assert.ok(!calls.includes('pipeline-capability'))
})

test('hunt-pipeline carries the capability marker the runner greps for', () => {
  assert.match(SRC, /WOLFPACK_EXAMINER_PROTOCOL=2/)
})
