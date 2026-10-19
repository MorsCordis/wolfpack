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
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { TOOL_DENIAL_PATTERN as TOOLCHECK_DENIAL_PATTERN } from './wolfpack-toolcheck.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const WT = '/repo/.agents/worktrees/h'
const PD = `${WT}/.wolfpack/plans/h`

// Default happy-path answers; a scenario overrides by label prefix (value or fn(prompt, opts, n)).
// wolfpack-self-hosting (AC10): the project-config probe relays the reader's JSON. The default
// answer is a GENERIC consumer fixture WITH a deploy step, so the existing scenarios keep their
// Verify path; the wolfpack-shaped scenarios below answer it by REALLY running the reader.
const FIXTURE_CONFIG = { name: 'fixture-project', testCommand: 'bash scripts/test-all.sh', worktreeLinks: [],
  complianceAreas: null, compliancePaths: [], devDeployCommand: 'deploy-x', changelogFile: 'CHANGELOG.md',
  tagPattern: 'v[0-9]*', backlogFile: 'TODO.md', missing: [], problems: [],
  // exec-layer-into-pack: the pack home (Project Identity → Wolfpack home) + the Execution Layer.
  wolfpackHome: '/pack',
  exec: { sandboxImage: 'fx-sandbox:latest', glmImage: 'fx-sandbox-glm:latest', projectLayer: null, seatExtraMounts: [],
    sandboxExtraMounts: [], secretsPaths: [], vibeAgentDir: '/agents', seatTestEnv: [], missing: [], problems: [] } }
const configAnswer = (cfg = FIXTURE_CONFIG) => ({ exitCode: 0, output: JSON.stringify(cfg, null, 2) })

const BASE = {
  'project-config': configAnswer(),
  'resume-probe': { fresh: true },
  // seat-profiles-into-pack: the toolcheck preflight passes by default (a missing answer
  // correctly parks toolcheck_failed — fail closed).
  'toolcheck-preflight': { ok: true, exitCode: 0, output: '✓' },
  scaffold: { worktreePath: WT, planDir: PD },
  spec: { modeForBuild: 'autonomous', confidence: 'high', complianceCritical: false },
  alpha: { verdict: 'PLANNED', tier: 'Yellow', bloodhoundRounds: 1, pointerRounds: 1, trackerRounds: 1, bloodhoundModel: 'glm' },
  bloodhound: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'glm', status: 'glm' },
  debrief: {},
  'shepherd-seat': { shepherdPin: '', complianceCritical: false, shepherdFamilies: [] },
  'shepherd-glm': { outcome: 'done', exitCode: 0, changedFiles: ['app/x.py'], committed: true },
  shepherd: { verdict: 'DONE' },
  pointer: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'mistral', status: 'mistral' },
  tracker: { verdict: 'TESTS_PASS' },
  // seat-profiles-into-pack: a certifier whose shell ran reports tool_access (mandatory on
  // Orange/Red — a PASS without it parks audit_only_certification there).
  watchdog: { verdict: 'PASS', provider: 'mistral', status: 'mistral', deniedTools: [], toolAccess: { shell: 'ok', denied_tools: [] } },
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

test('shell commands single-quote interpolated paths (worktree AND pack home with a space and a quote)', async () => {
  const wt = "/re po/it's/.agents/worktrees/h"
  const { find } = await runHunt({ env: { WOLFPACK_HOME: "/pa ck/it's" }, answers: { scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  const bh = find('bloodhound:')[0].prompt
  assert.ok(bh.includes(`'/re po/it'\\''s/.agents/worktrees/h'`), 'worktree path is POSIX single-quoted')
  assert.ok(bh.includes(`'/pa ck/it'\\''s/scripts/podman-vibe.sh'`), 'shim path (from the pack home) is quoted too')
  assert.match(find('toolcheck-preflight:')[0].prompt, /--shim '\/pa ck\/it'\\''s\/scripts\/podman-vibe\.sh'/)
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
    if (opts.label === 'project-config') return configAnswer()
    if (opts.label === 'parse-campaign') return { waves: [] }
    if (opts.label === 'pipeline-capability') return { path: '.claude/workflows/hunt-pipeline.js', protocol, gatePresent: true, gateProtocol: 1 }
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
    if (opts.label === 'project-config') return configAnswer()
    if (opts.label === 'parse-campaign') return { waves: [] }
    if (opts.label === 'pipeline-capability') return { path: '.claude/workflows/hunt-pipeline.js', protocol, gatePresent: true, gateProtocol: 1 }
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

// ════════════════════════════════════════════════════════════════════════════
// usage-limit-gate Pointer r1 F1 / F3 and r2 F2.
// ════════════════════════════════════════════════════════════════════════════
const glmReworkAll = (p) => (/rework/i.test(p)
  ? { outcome: 'done', exitCode: 0, committed: true, findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'fixed' }], allAddressed: true }
  : BASE['shepherd-glm'])
// Distinct fingerprint per round ⇒ classifyConvergence sees "converging" (all-new, flat
// count), so ONLY the circuit breaker can park — isolates the r1 F3 round accounting.
const findingFor = (round) => ({ ...FINDING, fingerprint: `app/x.py:defect-r${round}` })
const issues = (round, provider) => ({ verdict: 'ISSUES_FOUND', findings: 1, findingsList: [findingFor(round)], provider })

test('r1 F1: the Claude FINAL round renders its OWN review step — no fallback marker / fallback-record instruction', async () => {
  const { find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 },
    'shepherd-seat': OFFLOAD_SEAT,
    pointer: pointerBy(),
  } })
  const [cross, final] = find('pointer:')
  assert.ok(isFinalPrompt(final.prompt))
  assert.match(final.prompt, /\[1\] CLAUDE FINAL REVIEW \(provider "claude"\)/)
  assert.match(final.prompt, /MANDATED\s+final review/)
  assert.match(final.prompt, /This round the ONLY link is the mandated Claude FINAL review — not a fallback/)
  assert.doesNotMatch(final.prompt, /Claude only as the final last-resort link/)
  // The fallback-only step's instructions must be ABSENT (they contradicted the final step).
  assert.doesNotMatch(final.prompt, /Before you do, print\s+WOLFPACK_CLAUDE_FALLBACK/)
  assert.doesNotMatch(final.prompt, /append \{role, round, reason, evidence\}/)
  assert.doesNotMatch(final.prompt, /This link exists ONLY because every cross-family examiner was unavailable/)
  assert.match(final.prompt, /do NOT print\s+WOLFPACK_CLAUDE_FALLBACK and do NOT write a claude_fallback_reviews row/)
  assert.match(final.prompt, /claude_final_reviews/)
  // the cross-family round keeps the normal chain intro
  assert.match(cross.prompt, /Claude only as the final last-resort link/)
  assert.doesNotMatch(cross.prompt, /\[1\] CLAUDE FINAL REVIEW/)
})

test('r1 F1: an APPROVED Claude-final round is NOT recorded as a claude fallback review', async () => {
  const { find, logs } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 },
    'shepherd-seat': OFFLOAD_SEAT,
    pointer: pointerBy(),
  } })
  assert.ok(logs.some(l => /CLAUDE FINAL REVIEW passed/.test(l)))
  assert.equal(logs.some(l => /CLAUDE LAST-RESORT examiner/.test(l)), false, logs.join("\n"))
  assert.equal(find('claude-fallback-record').length + find('fallback-review-record').length, 0)
})

test('r1 F3: a cross-family approval AT the breaker still earns a rework after Claude-final ISSUES (Red, maxRounds 8)', async () => {
  // r1..r7 cross ISSUES (rework each) → r8 cross APPROVED → r9 Claude final ISSUES →
  // rework → r10 cross APPROVED → r11 Claude final APPROVED → Test. Pre-fix, r9 hit
  // round 9 ≥ maxRounds 8 and parked non-convergence without a rework.
  const { result, find, logs } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 },
    'shepherd-seat': OFFLOAD_SEAT,
    'shepherd-glm': glmReworkAll,
    pointer: (p, opts) => {
      const r = pointerRoundOf(opts)
      if (isFinalPrompt(p)) return r === 9 ? issues(r, 'claude') : { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'claude' }
      return r <= 7 ? issues(r, 'mistral') : { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'mistral' }
    },
  } })
  assert.notEqual(String(result && result.status).startsWith('parked'), true, JSON.stringify(result) + '\n' + logs.join('\n'))
  const ptr = find('pointer:')
  assert.deepEqual(ptr.map(pointerRoundOf), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.deepEqual(ptr.map(c => isFinalPrompt(c.prompt)), [false, false, false, false, false, false, false, false, true, false, true])
  assert.equal(find('shepherd-glm').length, 1 + 7 + 1, 'implement + 7 cross reworks + 1 Claude-final rework')
  assert.equal(find('tracker:').length, 1)
})

test('r1 F3: still BOUNDED — a Claude final that never approves parks non-convergence (no infinite ping-pong)', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 },
    'shepherd-seat': OFFLOAD_SEAT,
    'shepherd-glm': glmReworkAll,
    pointer: (p, opts) => (isFinalPrompt(p)
      ? issues(pointerRoundOf(opts), 'claude')
      : { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'mistral' }),
  } })
  assert.equal(result.verdict, 'PARKED', JSON.stringify(result))
  assert.match(String(result.status), /non_convergence/)
  const n = find('pointer:').length
  assert.ok(n <= 2 * (8 + 1), `bounded by the breaker (+1 grace) per cross/final pair — got ${n}`)
  assert.equal(find('tracker:').length, 0, 'never proceeds to Test past an open final finding')
})

test('r1 F3: a plain (non-offload) Red hunt keeps the ORIGINAL breaker — parks at maxRounds 8', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 },
    'shepherd-seat': { ...OFFLOAD_SEAT, usageOffload: false },
    pointer: (p, opts) => issues(pointerRoundOf(opts), 'glm'),
  } })
  assert.equal(result.verdict, 'PARKED')
  assert.match(String(result.status), /non_convergence/)
  assert.equal(find('pointer:').length, 8)
})

test('r2 F2: SHEPHERD_SEAT_SCHEMA REQUIRES usageOffload (an omitted field cannot silently read as false)', async () => {
  const { find } = await runHunt()
  const seat = find('shepherd-seat')[0]
  assert.deepEqual(seat.opts.schema.required, ['shepherdPin', 'complianceCritical', 'shepherdFamilies', 'usageOffload'])
})

test('shim wait: every non-Claude review/certify link runs via rc-file + foreground polls, never a turn-ending wait', async () => {
  const { find } = await runHunt()
  const prompts = [...find('bloodhound:'), ...find('pointer:'), ...find('watchdog')].map(c => c.prompt)
  assert.ok(prompts.length >= 3, 'expected bloodhound, pointer and watchdog shim prompts')
  for (const p of prompts) {
    assert.match(p, /podman-vibe\.sh[^\n]*> \S+-l1\.out 2> \S+-l1\.err; echo \$\? > \S+-l1\.rc \) <\/dev\/null >\/dev\/null 2>&1 &/)
    assert.match(p, /timeout 540 bash -c 'until \[ -f "\$1" \]/)
    assert.match(p, /WAITING ON A SHIM \(hard rule\)/)
    assert.match(p, /NEVER end your turn/)
  }
})

test('resume into Review continues the round numbering from the newest plan-revised-K.md', async () => {
  const probe = { fresh: false, status: 'reviewing', resumePhase: 'Debrief', tier: 'Orange', bloodhoundRounds: 2,
    pointerRounds: 2, trackerRounds: 2, bloodhoundModel: 'glm', worktreePath: WT, planDir: PD,
    worktreeExists: true, branchExists: true, humanNotesPresent: true, latestRevisedPlan: 3 }
  const { find } = await runHunt({ rawArgs: 'h', answers: { 'resume-probe': probe } })
  const bh = find('bloodhound:')
  assert.ok(bh.length >= 1)
  assert.match(bh[0].opts.label, /:r4(:|$)/)
  assert.match(bh[0].prompt, /plan-revised-3\.md/)
  assert.doesNotMatch(bh[0].prompt, /Plan file to review: plan\.md/)
})

test('a fresh hunt still starts the plan review at round 1 of plan.md', async () => {
  const { find } = await runHunt()
  assert.match(find('bloodhound:')[0].opts.label, /:r1(:|$)/)
  assert.match(find('bloodhound:')[0].prompt, /Plan file to review: plan\.md/)
})

test('the resume probe schema REQUIRES latestRevisedPlan (an optional field was silently dropped)', async () => {
  const { find } = await runHunt()
  assert.ok(find('resume-probe')[0].opts.schema.required.includes('latestRevisedPlan'))
})

// ════════════════════════════════════════════════════════════════════════════
// CHAIN MODE (campaign-chain-mode): args.baseBranch "campaign/<slug>" — fork from, rebase onto
// and diff against the LOCAL campaign branch; merge-and-await compliance; no per-hunt Verify.
// ════════════════════════════════════════════════════════════════════════════
const CHAIN_ARGS = { baseBranch: 'campaign/c1' }
const OLD_BASE_RE = /main\.\.HEAD|origin\/main|pre-hunt-h main/
const allPrompts = (calls) => calls.map(c => c.prompt).join('\n')

test('AC3 chain: no prompt diffs against main or rebases onto origin/main; the scaffold forks from + tags the campaign branch and records base_branch', async () => {
  const { calls, find, logs, result } = await runHunt({ args: CHAIN_ARGS })
  for (const c of calls) assert.doesNotMatch(c.prompt, OLD_BASE_RE, `${c.label} still names main`)
  const sc = find('scaffold')[0].prompt
  assert.match(sc, /git worktree add \.agents\/worktrees\/h -b feat\/h campaign\/c1/)
  assert.match(sc, /git tag -f pre-hunt-h campaign\/c1/)
  assert.match(sc, /base_branch: "campaign\/c1"/)
  assert.match(sc, /rollback point on campaign\/c1/)
  assert.ok(logs.some(l => /⛓ h: chain mode — forks from, rebases onto and diffs against campaign\/c1/.test(l)))
  // the code-review and certify seats diff against the campaign branch
  assert.match(find('pointer:')[0].prompt, /git diff campaign\/c1\.\.HEAD/)
  assert.match(find('watchdog:')[0].prompt, /git diff campaign\/c1\.\.HEAD/)
  assert.match(find('compliance-gate')[0].prompt, /git diff --name-only campaign\/c1\.\.HEAD/)
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
})
test('AC3 barrier: a run without baseBranch still carries all three main-based strings and no base_branch', async () => {
  const { calls, find } = await runHunt()
  const all = allPrompts(calls)
  assert.match(all, /main\.\.HEAD/)
  assert.match(all, /origin\/main/)
  assert.match(all, /pre-hunt-h main/)
  const sc = find('scaffold')[0].prompt
  assert.match(sc, /git worktree add \.agents\/worktrees\/h -b feat\/h\n/)
  assert.doesNotMatch(sc, /base_branch/)
  assert.doesNotMatch(all, /campaign\//)
})
test('AC4 chain: both Shepherd paths rebase onto the LOCAL campaign branch (no fetch, no origin/), conflict handling unchanged', async () => {
  const claude = await runHunt({ args: CHAIN_ARGS })
  const sp = claude.find('shepherd:')[0].prompt
  assert.match(sp, /CRITICAL FIRST STEP: Rebase onto campaign\/c1/)
  assert.match(sp, /git rebase campaign\/c1/)
  assert.doesNotMatch(sp, /git fetch|origin\//)
  assert.match(sp, /git rebase --abort/)
  assert.match(sp, /REBASE_CONFLICT/)
  assert.match(sp, /"base_branch": "campaign\/c1"/)
  assert.match(sp, /Self-check: git diff campaign\/c1\.\.HEAD/)
  const glm = await runHunt({ args: CHAIN_ARGS, answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  const gp = glm.find('shepherd-glm')[0].prompt
  assert.match(gp, /REBASE FIRST \(worktree drift\): git rebase campaign\/c1\n/)
  assert.doesNotMatch(gp, /git fetch|origin\//)
  assert.match(gp, /git rebase --abort and return outcome "rebase_conflict"/)
  assert.match(gp, /"base_branch": "campaign\/c1"/)
  // barrier: the GLM wrapper still fetches + rebases onto origin/main, no base_branch line
  const bglm = await runHunt({ answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  const bgp = bglm.find('shepherd-glm')[0].prompt
  assert.match(bgp, /git fetch origin && git rebase origin\/main/)
  assert.doesNotMatch(bgp, /base_branch/)
})
test('AC4 chain: rewrite entries (Pointer / Tracker bounce) self-check against the campaign branch', async () => {
  const probe = { ...RESUME_AT_CODE_REVIEW, status: 'code_rewrite_needed', resumePhase: 'Implement', baseBranch: 'campaign/c1', latestRevisedPlan: 0 }
  const { find } = await runHunt({ rawArgs: 'h', answers: { 'resume-probe': probe } })
  const sp = find('shepherd:')[0].prompt
  assert.match(sp, /REWRITE ENTRY — Pointer round 1/)
  assert.match(sp, /re-run your self-check \(git diff campaign\/c1\.\.HEAD\)/)
})
test('baseBranch validation: main, traversal and non-campaign values throw at hunt start', async () => {
  for (const bad of ['main', 'campaign/../x', 'campaign/', 'feature/x', 'campaign/C1', 'campaign/a b']) {
    await assert.rejects(runHunt({ args: { baseBranch: bad } }), /invalid baseBranch/, bad)
  }
})
test('baseBranch sticks per hunt: probe-only → chain prompts; a conflicting arg throws; "" → barrier; a non-campaign stored value throws', async () => {
  await assert.rejects(runHunt({ args: CHAIN_ARGS, answers: { 'resume-probe': { fresh: true, baseBranch: 'campaign/c2' } } }),
    /base_branch campaign\/c2 ≠ args\.baseBranch campaign\/c1/)
  const sticky = await runHunt({ answers: { 'resume-probe': { fresh: true, baseBranch: 'campaign/c1' } } })
  for (const c of sticky.calls) assert.doesNotMatch(c.prompt, OLD_BASE_RE, c.label)
  assert.match(sticky.find('scaffold')[0].prompt, /-b feat\/h campaign\/c1/)
  const same = await runHunt({ args: CHAIN_ARGS, answers: { 'resume-probe': { fresh: true, baseBranch: 'campaign/c1' } } })
  assert.match(same.find('shepherd:')[0].prompt, /git rebase campaign\/c1/)
  const barrier = await runHunt({ answers: { 'resume-probe': { fresh: true, baseBranch: '' } } })
  assert.match(allPrompts(barrier.calls), /pre-hunt-h main/)
  assert.match(barrier.find('shepherd:')[0].prompt, /git fetch origin && git rebase origin\/main/)
  await assert.rejects(runHunt({ answers: { 'resume-probe': { fresh: true, baseBranch: 'main' } } }), /is not a campaign branch/)
})
test('the resume probe REQUIRES baseBranch, checks commits against the base, and treats the chain statuses as DONE', async () => {
  const { find } = await runHunt({ args: CHAIN_ARGS })
  const p = find('resume-probe')[0]
  assert.ok(p.opts.schema.required.includes('baseBranch'))
  assert.equal(p.opts.schema.properties.baseBranch.type, 'string')
  assert.match(p.prompt, /git log campaign\/c1\.\.feat\/h/)
  assert.match(p.prompt, /"merged_to_campaign" \/ "merged_to_campaign_pending_compliance" \/ "certified_held_overlap" → "DONE"/)
  assert.match(p.prompt, /baseBranch: ALWAYS return it/)
  const b = await runHunt()
  assert.match(b.find('resume-probe')[0].prompt, /git log main\.\.feat\/h/)
})
test('the pipeline carries the WOLFPACK_CHAIN_PROTOCOL marker the chain runner greps for', () => {
  assert.match(SRC, /^\/\/ WOLFPACK_CHAIN_PROTOCOL=1$/m)
})
test('AC11 chain: the compliance gate firing → compliance-hold write (no park), CERTIFIED_PENDING_COMPLIANCE, no Verify', async () => {
  const gate = { determined: true, complianceTouched: true, alreadySignedOff: false, touchedPaths: ['billing/services/payments.py'] }
  const { result, find, logs } = await runHunt({ args: CHAIN_ARGS, answers: { 'compliance-gate': gate } })
  assert.equal(find('park:').length, 0, 'no park payload in chain mode')
  const hold = find('compliance-hold:h')
  assert.equal(hold.length, 1)
  assert.equal(hold[0].opts.model, 'sonnet')
  assert.match(hold[0].prompt, /"status" = "certified_pending_compliance"/)
  assert.match(hold[0].prompt, /"compliance_hold" block/)
  assert.match(hold[0].prompt, /billing\/services\/payments\.py/)
  assert.match(hold[0].prompt, /spec\.compliance_review_required = true/)
  assert.match(hold[0].prompt, /Do NOT write parked\.md\. Do NOT touch the "park" block/)
  assert.match(find('compliance-gate')[0].prompt, /git diff --name-only campaign\/c1\.\.HEAD/)
  assert.match(find('compliance-gate')[0].prompt, /git diff --stat campaign\/c1\.\.HEAD/)
  assert.equal(find('verify').length, 0)
  assert.equal(result.verdict, 'CERTIFIED_PENDING_COMPLIANCE')
  assert.equal(result.status, 'certified_pending_compliance')
  assert.equal(result.reason, 'compliance_review')
  assert.ok(logs.some(l => /chain mode: certified, will merge into campaign\/c1 as merged_to_campaign_pending_compliance/.test(l)))
  // fail-closed: an INCONCLUSIVE gate in chain mode also holds (never a clean certify)
  const inc = await runHunt({ args: CHAIN_ARGS, answers: { 'compliance-gate': { determined: false, complianceTouched: null, alreadySignedOff: false } } })
  assert.equal(inc.result.verdict, 'CERTIFIED_PENDING_COMPLIANCE')
  assert.match(inc.find('compliance-hold:h')[0].prompt, /path detection was inconclusive — failing closed/)
})
test('AC11 barrier: the same gate answer still parks compliance_review exactly as before', async () => {
  const gate = { determined: true, complianceTouched: true, alreadySignedOff: false, touchedPaths: ['billing/x.py'] }
  const { result, find } = await runHunt({ answers: { 'compliance-gate': gate } })
  assert.equal(find('compliance-hold').length, 0)
  assert.equal(find('park:h:compliance_review').length, 1)
  assert.match(find('park:h:compliance_review')[0].prompt, /git -C .* diff main\.\.HEAD/)
  assert.equal(result.verdict, 'PARKED')
  assert.equal(result.status, 'parked:compliance_review')
})
test('A-13 chain: no per-hunt dev deploy (no verify call); the result is certified for the runner to merge', async () => {
  const { result, find, logs } = await runHunt({ args: CHAIN_ARGS })
  assert.equal(find('verify').length, 0)
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  assert.equal(result.status, 'certified')
  assert.ok(logs.some(l => /per-hunt dev deploy skipped — \/release-campaign deploys campaign\/c1 once/.test(l)))
  // a signed-off chain hunt also skips Verify
  const signed = await runHunt({ args: CHAIN_ARGS, answers: { 'compliance-gate': { determined: true, complianceTouched: true, alreadySignedOff: true } } })
  assert.equal(signed.find('verify').length, 0)
  assert.equal(signed.result.status, 'certified')
  // barrier still verifies
  const b = await runHunt()
  assert.equal(b.find('verify').length, 1)
})

test('protected paths: the Debrief flags hook/settings edits and every Shepherd prompt stages them as patches', async () => {
  const { find } = await runHunt()
  const debrief = find('debrief:')[0].prompt
  assert.match(debrief, /PROTECTED-PATH CHECK \(mandatory\)/)
  assert.match(debrief, /\.claude\/hooks\//)
  assert.match(debrief, /## Human-Applied Edits/)
  const shep = find('shepherd:')[0].prompt
  assert.match(shep, /PROTECTED AGENT-CONFIG PATHS/)
  assert.match(shep, /human-patches\/<NN>-<short-name>\.patch/)
  assert.match(shep, /git apply --check <patch>/)
})

test('protected paths: the GLM Shepherd task also routes protected edits to human-patches/', async () => {
  const { find } = await runHunt({ answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  const g = find('shepherd-glm')[0].prompt
  assert.match(g, /NEVER edit a file under \.claude\/hooks\//)
  assert.match(g, /human-patches\/<NN>-<short-name>\.patch/)
})

test('human-patch gate: no staged patches → no park, Code Review runs', async () => {
  const { result, find } = await runHunt()
  assert.equal(find('human-patch-check').length >= 1, true)
  assert.notEqual(result.status, 'parked:human_patch')
  assert.ok(find('pointer:').length >= 1)
})

test('human-patch gate: an unapplied patch parks human_patch at Implement, before any code review', async () => {
  const patch = `${PD}/human-patches/01-guard.patch`
  const { result, find } = await runHunt({ answers: {
    'human-patch-check': { pending: [{ patch, paths: ['.claude/hooks/bash-guards.sh'], applies: true }] },
  } })
  assert.equal(result.verdict, 'PARKED')
  assert.equal(result.status, 'parked:human_patch')
  assert.equal(find('pointer:').length, 0, 'never reviews code that is missing the staged change')
  const park = find('park:h:human_patch')
  assert.equal(park.length, 1)
  assert.match(park[0].prompt, /resume_phase: Code Review/)
  assert.ok(park[0].prompt.includes(`apply ${patch}`))
  assert.match(park[0].prompt, /add \.claude\/hooks\/bash-guards\.sh/)
})

test('human-patch gate: a patch staged during a Pointer rework parks before the next review round', async () => {
  const { result, find } = await runHunt({ answers: {
    pointer: (p, opts) => issues(pointerRoundOf(opts), 'glm'),
    'human-patch-check': (p, opts, n) => n === 1 ? { pending: [] }
      : { pending: [{ patch: `${PD}/human-patches/01-guard.patch`, paths: ['.claude/hooks/bash-guards.sh'], applies: false }] },
  } })
  assert.equal(result.status, 'parked:human_patch')
  assert.equal(find('pointer:').length, 1, 'parks after the round-1 rework, before round 2')
  assert.match(find('park:h:human_patch')[0].prompt, /does NOT apply cleanly/)
})

// ─── seat-profiles-into-pack: toolcheck preflight (AC5) + audit_only (AC6) ───

// A capable fixture shim carrying both halves the toolcheck reads (Mistral loop + GLM lists).
const FIXTURE_SHIM = `VIBE_TOOLS_DEFAULT="read grep edit write_file bash"
VIBE_TOOL_FLAGS=()
for _t in \${WOLFPACK_VIBE_TOOLS:-$VIBE_TOOLS_DEFAULT}; do
    VIBE_TOOL_FLAGS+=(--enabled-tools "$_t")
done
GLM_REVIEW_TOOLS_DEFAULT="read_file grep bash dev_cortex_repo_map dev_cortex_file_outline"
GLM_IMPLEMENT_TOOLS_DEFAULT="read_file grep write_file edit dev_cortex_repo_map dev_cortex_file_outline"
GLM_REVIEW_DROP="task"
GLM_IMPLEMENT_DROP="bash task"
`
const TOOLCHECK = join(here, 'wolfpack-toolcheck.mjs')
const TEMPLATES = join(here, '..', 'vibe-agents')

// A temp fixture: the shim above + the tracked templates as the "installed" profiles, with an
// optional mutation of one profile. Returns { shim, profiles, cleanup }.
function toolcheckFixture(mutate = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hp-toolcheck-'))
  const shim = join(root, 'podman-vibe.sh')
  writeFileSync(shim, FIXTURE_SHIM)
  const profiles = join(root, 'agents')
  execFileSync('mkdir', ['-p', profiles])
  for (const n of readdirSync(TEMPLATES)) copyFileSync(join(TEMPLATES, n), join(profiles, n))
  for (const [name, fn] of Object.entries(mutate)) {
    const f = join(profiles, `${name}.toml`)
    writeFileSync(f, fn(readFileSync(f, 'utf8')))
  }
  return { shim, profiles, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
// The preflight answer: REALLY runs the toolcheck CLI against the fixture and returns what
// the preflight agent would (exit code + stdout/stderr verbatim).
const realToolcheck = (fx) => () => {
  try {
    const out = execFileSync(process.execPath, [TOOLCHECK, '--shim', fx.shim, '--profiles', fx.profiles], { encoding: 'utf8', stdio: 'pipe' })
    return { ok: true, exitCode: 0, output: out }
  } catch (e) {
    return { ok: false, exitCode: e.status, output: `${e.stdout || ''}${e.stderr || ''}` }
  }
}
const bashNever = (t) => t.replace(/\[tools\.bash\]\npermission = "always"/, '[tools.bash]\npermission = "never"')
  .replace(/\[tools\.git_bash\]\npermission = "always"/, '[tools.git_bash]\npermission = "never"')
const SEAT_CALLS = ['bloodhound:', 'pointer:', 'watchdog:', 'alpha:', 'shepherd:', 'tracker:']

test('AC5: a pointer-glm profile with bash = "never" → the REAL toolcheck exits 1 → the run parks toolcheck_failed before any seat', async () => {
  const fx = toolcheckFixture({ 'wolfpack-pointer-glm': bashNever })
  try {
    const { result, calls, find, logs } = await runHunt({ answers: { 'toolcheck-preflight': realToolcheck(fx) } })
    assert.equal(result.status, 'parked:toolcheck_failed', JSON.stringify(result))
    assert.equal(result.reason, 'toolcheck_failed')
    for (const p of SEAT_CALLS) assert.equal(find(p).length, 0, `${p} never ran`)
    const pf = find('toolcheck-preflight:')
    assert.equal(pf.length, 1)
    assert.match(pf[0].prompt, /'\/repo\/scripts\/wolfpack-toolcheck\.mjs' --shim '\/pack\/scripts\/podman-vibe\.sh' --profiles '\/agents'/, 'targets the pack shim (WOLFPACK_HOME) + the configured Vibe agent dir')
    const park = find('park:h:toolcheck_failed')
    assert.equal(park.length, 1)
    assert.match(park[0].prompt, /wolfpack-pointer-glm/)
    assert.match(park[0].prompt, /profile denies "bash"/)
    assert.match(park[0].prompt, /resume_phase: Spec/, 'a fresh hunt resumes at Spec once fixed')
    assert.match(park[0].prompt, /resolution_type_expected: redirect/)
    assert.match(park[0].prompt, /wolfpack-install-vibe-agents\.mjs/)
    const stop = logs.find(l => /seat toolcheck FAILED \(exit 1\)/.test(l))
    assert.ok(stop, logs.join('\n'))
    assert.match(stop, /wolfpack-pointer-glm/)
    assert.match(stop, /bash/)
    // the preflight runs right after scaffold — Spec never started
    assert.equal(find('spec').length, 0)
    assert.ok(calls.findIndex(c => c.label.startsWith('toolcheck-preflight')) > calls.findIndex(c => c.label === 'scaffold' || c.label.startsWith('scaffold')))
  } finally { fx.cleanup() }
})

test('AC5: matching profiles → the REAL toolcheck exits 0 → the run proceeds through every seat to Verify', async () => {
  const fx = toolcheckFixture()
  try {
    const { result, find, logs } = await runHunt({ answers: { 'toolcheck-preflight': realToolcheck(fx) } })
    assert.notEqual(String(result.status).startsWith('parked'), true, JSON.stringify(result))
    assert.ok(logs.some(l => /✓ seat toolcheck: profiles match the shim/.test(l)))
    for (const p of ['bloodhound:', 'pointer:', 'watchdog:']) assert.equal(find(p).length >= 1, true, p)
    assert.equal(find('verify').length, 1)
  } finally { fx.cleanup() }
})

test('AC5: fail closed — an empty / garbled / non-zero preflight result parks (never a silent continue)', async () => {
  for (const ans of [{}, { exitCode: '0', output: 'x' }, { ok: true, exitCode: 2, output: 'shim not found' }, null]) {
    const { result, find } = await runHunt({ answers: { 'toolcheck-preflight': () => ans } })
    assert.equal(result.status, 'parked:toolcheck_failed', JSON.stringify(ans))
    assert.equal(find('bloodhound:').length, 0, JSON.stringify(ans))
  }
})

test('AC5: no Vibe family enabled → no preflight call (nothing to guard), the run still completes', async () => {
  const { result, find, logs } = await runHunt({ env: { WOLFPACK_ENABLE_GLM: '0', WOLFPACK_ENABLE_MISTRAL_AUTO: '0' },
    answers: {
      'toolcheck-preflight': () => { throw new Error('preflight must not run') },
      bloodhound: { ...BASE.bloodhound, provider: 'claude' },
    } })
  assert.equal(find('toolcheck-preflight').length, 0)
  assert.ok(logs.some(l => /Seat toolcheck preflight skipped — no Vibe examiner family enabled/.test(l)))
  void result
})

test('AC5: one Vibe family enabled is enough to require the preflight', async () => {
  const { result, find } = await runHunt({ env: { WOLFPACK_ENABLE_GLM: '0' }, answers: { 'toolcheck-preflight': {} } })
  assert.equal(find('toolcheck-preflight').length, 1)
  assert.equal(result.status, 'parked:toolcheck_failed')
})

test('AC5: a resume at Code Review re-runs the preflight and parks with resume_phase Code Review', async () => {
  const fx = toolcheckFixture({ 'wolfpack-watchdog': bashNever })
  try {
    const { result, find } = await runHunt({ answers: { 'resume-probe': RESUME_AT_CODE_REVIEW, 'toolcheck-preflight': realToolcheck(fx) } })
    assert.equal(result.status, 'parked:toolcheck_failed')
    assert.equal(find('pointer:').length, 0)
    assert.match(find('park:h:toolcheck_failed')[0].prompt, /resume_phase: Code Review/)
    assert.match(find('park:h:toolcheck_failed')[0].prompt, /wolfpack-watchdog: profile denies "bash"/)
  } finally { fx.cleanup() }
})

test('AC5: a resume past Certify (Verify) skips the preflight — no shim seat lies ahead', async () => {
  const probe = { ...RESUME_AT_CODE_REVIEW, status: 'certified', resumePhase: 'Verify' }
  const { find, logs } = await runHunt({ answers: { 'resume-probe': probe, 'toolcheck-preflight': {} } })
  assert.equal(find('toolcheck-preflight').length, 0)
  assert.ok(logs.some(l => /Seat toolcheck preflight skipped — no shim seat lies ahead/.test(l)), logs.join('\n'))
})

test('TOOL_DENIAL_PATTERN in hunt-pipeline.js is byte-equal to the toolcheck export', () => {
  const m = SRC.match(/const TOOL_DENIAL_PATTERN =\s*\n?\s*"([^"]*)"/)
  assert.ok(m, 'literal found in the workflow source')
  assert.equal(m[1], TOOLCHECK_DENIAL_PATTERN)
  // and the TOOL-DENIAL CHECK prompt carries it shell-quoted, verbatim
  assert.ok(SRC.includes('grep -E -i -h -o ${shq(TOOL_DENIAL_PATTERN)} <base>.out <base>.err'))
})

// A Vibe transcript of a boxed seat, grepped IN-TEST with the shared pattern — exactly what the
// shim agent's TOOL-DENIAL CHECK returns as deniedTools.
const BOXED_TRANSCRIPT = `I'll start by running the diff.
<tool_result>Tool 'bash' is permanently disabled</tool_result>
I cannot run git diff; reading files instead.
<tool_result>Unknown tool 'git_bash'</tool_result>
<verdict>{"verdict":"APPROVED","findings":[]}</verdict>`
const deniedFrom = (text) => [...new Set((text.match(new RegExp(TOOLCHECK_DENIAL_PATTERN, 'ig')) || []))].sort()
const auditRecords = (find, role) => find(`audit-only-record:h:${role}:`)

test('AC6a: a Pointer transcript with denied tool calls → audit_only recorded (metadata + pointer-review header), loud log', async () => {
  const denied = deniedFrom(BOXED_TRANSCRIPT)
  assert.deepEqual(denied, ["Tool 'bash' is permanently disabled", "Unknown tool 'git_bash'"])
  const { result, find, logs } = await runHunt({ answers: {
    pointer: { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'mistral', deniedTools: denied },
  } })
  assert.notEqual(String(result.status).startsWith('parked'), true, 'a review seat never parks on audit_only')
  const rec = auditRecords(find, 'pointer')
  assert.equal(rec.length, 1)
  assert.match(rec[0].prompt, /"audit_only": true/)
  assert.match(rec[0].prompt, /audit_only_seats/)
  assert.match(rec[0].prompt, /pointer-review-1\.md/)
  assert.ok(rec[0].prompt.includes(`"evidence": ["Tool 'bash' is permanently disabled","Unknown tool 'git_bash'"]`), rec[0].prompt)
  assert.ok(rec[0].prompt.includes("> audit_only: true — pointer r1 (mistral) ran without a working shell: Tool 'bash' is permanently disabled; Unknown tool 'git_bash'"), rec[0].prompt)
  assert.equal(rec[0].opts.model, 'sonnet')
  assert.ok(logs.some(l => /⚠ h: pointer r1 \(mistral\) was audit_only/.test(l)), logs.join('\n'))
})

test('AC6a: a Bloodhound self-report tool_access.shell = "denied" → audit_only recorded against review-1.md', async () => {
  const { find, logs } = await runHunt({ answers: {
    bloodhound: { ...BASE.bloodhound, deniedTools: [], toolAccess: { shell: 'denied', denied_tools: ['bash'] } },
  } })
  const rec = auditRecords(find, 'bloodhound')
  assert.equal(rec.length, 1)
  assert.match(rec[0].prompt, /"audit_only": true/)
  assert.match(rec[0].prompt, /review-1\.md/)
  assert.match(rec[0].prompt, /seat reported tool_access\.shell = denied/)
  assert.match(rec[0].prompt, /seat reported denied tool: bash/)
  assert.ok(logs.some(l => /⚠ h: bloodhound r1 \(glm\) was audit_only/.test(l)))
})

test('AC6a: a review with a working shell (tool_access ok, no denial lines) records nothing', async () => {
  const { find } = await runHunt({ answers: {
    bloodhound: { ...BASE.bloodhound, deniedTools: [], toolAccess: { shell: 'ok', denied_tools: [] } },
    pointer: { ...BASE.pointer, deniedTools: [], toolAccess: { shell: 'ok', denied_tools: [] } },
  } })
  assert.equal(find('audit-only-record:').length, 0)
})

test('AC6: a review whose tool_access has no recognised shell state → "unreported" row, not audit_only', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange' },
    bloodhound: { ...BASE.bloodhound, deniedTools: [], toolAccess: {} },
    pointer: { ...BASE.pointer, deniedTools: [], toolAccess: { shell: 'maybe', denied_tools: [] } },
  } })
  assert.notEqual(String(result.status).startsWith('parked'), true, JSON.stringify(result))
  for (const role of ['bloodhound', 'pointer']) {
    const rec = auditRecords(find, role)
    assert.ok(rec.length >= 1, role)
    assert.match(rec[0].prompt, /"tool_access": "unreported"/, role)
    assert.doesNotMatch(rec[0].prompt, /"audit_only": true/, role)
  }
})

test('AC6: a Vibe review that omits tool_access → "unreported" row (measured), not audit_only, never parks', async () => {
  const { result, find, logs } = await runHunt({ answers: { alpha: { ...BASE.alpha, tier: 'Orange' } } })
  assert.notEqual(String(result.status).startsWith('parked'), true, JSON.stringify(result))
  for (const role of ['bloodhound', 'pointer']) {
    const rec = auditRecords(find, role)
    assert.ok(rec.length >= 1, role)
    assert.match(rec[0].prompt, /"tool_access": "unreported"/, role)
    assert.doesNotMatch(rec[0].prompt, /"audit_only": true/, role)
  }
  assert.ok(logs.some(l => /pointer r1 \(mistral\) did not report a tool_access shell state/.test(l)))
})

test('AC6: the review verdict contract and the Watchdog verdict instruction both demand tool_access', async () => {
  const { find } = await runHunt({})
  for (const p of ['bloodhound:', 'pointer:']) {
    const prompt = find(p)[0].prompt
    assert.match(prompt, /"tool_access": \{ "shell": "ok" \| "denied" \| "unused", "denied_tools": \[\] \}/, p)
    assert.match(prompt, /"tool_access" is MANDATORY/, p)
    assert.match(prompt, /TOOL-DENIAL CHECK/, p)
  }
  const wd = find('watchdog:')[0].prompt
  assert.match(wd, /tool_access: \{shell: ok\|denied\|unused, denied_tools: \[\]\}/)
  assert.match(wd, /4a\. TOOL-DENIAL CHECK/)
  assert.match(wd, /4\.5 AUDIT-ONLY GATE \(tier Yellow\): an audit-only certification is allowed on this tier but recorded/)
})

test('AC6: on Orange the Watchdog prompt forbids the PASS-only side effects of an audit-only certification', async () => {
  const { find } = await runHunt({ answers: { alpha: { ...BASE.alpha, tier: 'Orange' } } })
  const wd = find('watchdog:')[0].prompt
  assert.match(wd, /4\.5 AUDIT-ONLY GATE \(tier Orange\): this tier cannot certify on audit alone/)
  assert.match(wd, /do not append to \.wolfpack\/pedigree\/index\.md, do not commit/)
})

const AUDIT_PASS = { verdict: 'PASS', provider: 'mistral', status: 'mistral', deniedTools: ["Tool 'bash' is permanently disabled"] }

test('AC6b: Orange + an audit-only PASS → parks audit_only_certification, not PASS; no Verify', async () => {
  for (const tier of ['Orange', 'Red', 'Purple' /* unknown tier fails closed */]) {
    const { result, find, logs } = await runHunt({ answers: { alpha: { ...BASE.alpha, tier }, watchdog: AUDIT_PASS } })
    assert.equal(result.status, 'parked:audit_only_certification', `${tier}: ${JSON.stringify(result)}`)
    assert.equal(result.verdict, 'PARKED', tier)
    assert.equal(find('verify').length, 0, `${tier}: no Verify`)
    const park = find('park:h:audit_only_certification')
    assert.equal(park.length, 1, tier)
    assert.match(park[0].prompt, /resume_phase: Certify/, tier)
    assert.match(park[0].prompt, /permanently disabled/, tier)
    assert.match(park[0].prompt, /cannot certify on audit alone/, tier)
    // recorded too (metadata + certification.md header)
    const rec = auditRecords(find, 'watchdog')
    assert.equal(rec.length, 1, tier)
    assert.match(rec[0].prompt, /certification\.md/, tier)
    assert.match(rec[0].prompt, /"audit_only": true/, tier)
    assert.ok(logs.some(l => /certification was AUDIT-ONLY .* PASS not accepted/.test(l)), tier)
  }
})

test('AC6b: Orange + a PASS whose certifier reports shell "unused" parks (Pointer r1 #1)', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange' },
    watchdog: { verdict: 'PASS', provider: 'mistral', deniedTools: [], toolAccess: { shell: 'unused', denied_tools: [] } },
  } })
  assert.equal(result.status, 'parked:audit_only_certification', JSON.stringify(result))
  assert.match(find('park:h:audit_only_certification')[0].prompt, /tool_access\.shell = \\?"unused\\?" \(not \\?"ok\\?"\)/)
  assert.equal(find('verify').length, 0)
})

test('AC6b: Orange + a self-reported denied shell (no denial lines) also parks', async () => {
  const { result } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange' },
    watchdog: { verdict: 'PASS', provider: 'glm', deniedTools: [], toolAccess: { shell: 'denied', denied_tools: ['bash'] } },
  } })
  assert.equal(result.status, 'parked:audit_only_certification')
})

test('Orange + a shell-ok PASS that lists only read-only-by-role tools as denied certifies (not audit-only)', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange' },
    watchdog: { verdict: 'PASS', provider: 'glm', deniedTools: [], toolAccess: { shell: 'ok', denied_tools: ['write_file', 'edit', 'skill', 'task'] } },
  } })
  assert.notEqual(result.status, 'parked:audit_only_certification', JSON.stringify(result))
  assert.equal(find('park:h:audit_only_certification').length, 0)
  assert.equal(auditRecords(find, 'watchdog').length, 0)
})

test('Orange + a shell-ok PASS that also lists a non-role tool (bash) as denied still parks', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange' },
    watchdog: { verdict: 'PASS', provider: 'glm', deniedTools: [], toolAccess: { shell: 'ok', denied_tools: ['write_file', 'bash'] } },
  } })
  assert.equal(result.status, 'parked:audit_only_certification', JSON.stringify(result))
  const ev = find('park:h:audit_only_certification')[0].prompt
  assert.match(ev, /seat reported denied tool: bash/)
  assert.doesNotMatch(ev, /seat reported denied tool: write_file/)
})

test('a review seat that lists only write_file as denied is not recorded audit_only', async () => {
  const { find } = await runHunt({ answers: {
    bloodhound: { ...BASE.bloodhound, deniedTools: [], toolAccess: { shell: 'ok', denied_tools: ['write_file'] } },
  } })
  assert.equal(auditRecords(find, 'bloodhound').length, 0)
})

test('AC6c: Yellow + an audit-only PASS → allowed (Verify runs) but recorded against certification.md', async () => {
  const { result, find } = await runHunt({ answers: { watchdog: AUDIT_PASS } })
  assert.notEqual(String(result.status).startsWith('parked'), true, JSON.stringify(result))
  assert.equal(find('verify').length, 1)
  const rec = auditRecords(find, 'watchdog')
  assert.equal(rec.length, 1)
  assert.match(rec[0].prompt, /"audit_only": true/)
  assert.match(rec[0].prompt, /certification\.md/)
  assert.match(rec[0].prompt, /> audit_only: true — watchdog r0 \(mistral\) ran without a working shell/)
})

test('AC6: a clean Orange PASS (tool_access ok, no denial lines) → no record, no park', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange' },
    bloodhound: { ...BASE.bloodhound, deniedTools: [], toolAccess: { shell: 'ok', denied_tools: [] } },
    pointer: { ...BASE.pointer, deniedTools: [], toolAccess: { shell: 'ok', denied_tools: [] } },
    watchdog: { verdict: 'PASS', provider: 'mistral', deniedTools: [], toolAccess: { shell: 'ok', denied_tools: [] } },
  } })
  assert.notEqual(String(result.status).startsWith('parked'), true, JSON.stringify(result))
  assert.equal(find('audit-only-record:').length, 0)
  assert.equal(find('verify').length, 1)
})

test('AC6 (Bloodhound r1 MEDIUM): an Orange/Red/unknown PASS that OMITS tool_access parks (glm and mistral certifiers)', async () => {
  for (const [tier, provider] of [['Orange', 'glm'], ['Red', 'glm'], ['Purple', 'glm'], ['Orange', 'mistral']]) {
    const { result, find } = await runHunt({ answers: { alpha: { ...BASE.alpha, tier }, watchdog: { verdict: 'PASS', provider, deniedTools: [] } } })
    assert.equal(result.status, 'parked:audit_only_certification', `${tier}/${provider}: ${JSON.stringify(result)}`)
    assert.equal(find('verify').length, 0, `${tier}/${provider}`)
    assert.match(find('park:h:audit_only_certification')[0].prompt, /certifier omitted the mandatory tool_access field/)
    assert.match(find('audit-only-record:h:watchdog:')[0].prompt, /"audit_only": true/)
  }
})

test('AC6: the missing-tool_access rule is provider-agnostic (a claude-attributed certification is held to it too)', () => {
  // Exercise the deployed helpers directly: certAuditEvidence never looks at the provider.
  const body = SRC.match(/const SINGLE_LENS = .*\n/)[0] + SRC.match(/const TIER_CONFIG = \{[\s\S]*?\n\}\n/)[0]
  const helpers = SRC.match(/const ROLE_DENIED_TOOLS = [\s\S]*?\nconst certAuditEvidence = [\s\S]*?\n\}\n/)[0]
  const mk = new Function(`${body}\n${helpers}\nreturn { auditEvidence, isAuditOnly, HEAVY, certAuditEvidence, mergeToolAccess }`)
  const { auditEvidence, isAuditOnly, HEAVY, certAuditEvidence, mergeToolAccess } = mk()
  // Pointer r1 #1: on Orange/Red/unknown, any shell state other than "ok" is evidence ("unused" =
  // never ran git diff or the tests); lighter tiers keep "unused" as not audit-only.
  for (const t of ['Orange', 'Red', undefined]) {
    assert.deepEqual(certAuditEvidence({ verdict: 'PASS', toolAccess: { shell: 'unused', denied_tools: [] } }, t),
      ['certifier reported tool_access.shell = "unused" (not "ok")'], String(t))
    assert.equal(certAuditEvidence({ verdict: 'PASS', toolAccess: {} }, t).length, 1, `${t}: missing shell`)
    assert.deepEqual(certAuditEvidence({ verdict: 'PASS', toolAccess: { shell: 'OK', denied_tools: [] } }, t), [], `${t}: ok`)
    assert.deepEqual(certAuditEvidence({ verdict: 'PASS', toolAccess: { shell: 'denied' } }, t),
      ['seat reported tool_access.shell = denied'], `${t}: denied counted once`)
  }
  assert.deepEqual(certAuditEvidence({ verdict: 'PASS', toolAccess: { shell: 'unused', denied_tools: [] } }, 'Yellow'), [])
  // Pointer r1 #2: the multi-lens merge keeps the worst shell state and unions denied_tools.
  assert.equal(mergeToolAccess([null, undefined]), null)
  assert.deepEqual(mergeToolAccess([{ shell: 'ok', denied_tools: [] }, { shell: 'denied', denied_tools: ['bash'] }]),
    { shell: 'denied', denied_tools: ['bash'] })
  assert.deepEqual(mergeToolAccess([{ shell: 'ok', denied_tools: ['grep'] }, null, { shell: 'ok', denied_tools: ['bash', 'grep'] }]),
    { shell: 'ok', denied_tools: ['grep', 'bash'] })
  assert.equal(mergeToolAccess([{ shell: 'ok' }, { shell: 'unused' }]).shell, 'unused')
  assert.equal(mergeToolAccess([{ shell: 'ok' }, {}]).shell, null, 'a missing shell outranks ok')
  assert.deepEqual(auditEvidence({ toolAccess: mergeToolAccess([{ shell: 'ok', denied_tools: [] }, { shell: 'denied', denied_tools: ['bash'] }]) }),
    ['seat reported tool_access.shell = denied', 'seat reported denied tool: bash'])
  assert.deepEqual(certAuditEvidence({ verdict: 'PASS', provider: 'claude', deniedTools: [] }, 'Orange'),
    ['certifier omitted the mandatory tool_access field'])
  assert.deepEqual(certAuditEvidence({ verdict: 'PASS', provider: 'claude', deniedTools: [] }, 'Yellow'), [])
  assert.equal(HEAVY('Orange'), true); assert.equal(HEAVY('Red'), true); assert.equal(HEAVY(undefined), true)
  assert.equal(HEAVY('Yellow'), false); assert.equal(HEAVY('Blue'), false); assert.equal(HEAVY('Green'), false)
  assert.equal(isAuditOnly({ deniedTools: ['  ', ''] }), false, 'blank grep lines are not evidence')
  assert.equal(isAuditOnly({ toolAccess: { shell: 'unused', denied_tools: [] } }), false)
  assert.equal(isAuditOnly({ toolAccess: { shell: 'DENIED' } }), true, 'case-insensitive')
  assert.deepEqual(auditEvidence({ auditOnly: true }), ['shim agent reported auditOnly'])
  assert.deepEqual(auditEvidence(null), [])
})

test('AC6: Yellow PASS that omits tool_access → not parked, "unreported" row for the Watchdog', async () => {
  const { result, find } = await runHunt({ answers: { watchdog: { verdict: 'PASS', provider: 'mistral', deniedTools: [] } } })
  assert.notEqual(String(result.status).startsWith('parked'), true)
  assert.equal(find('verify').length, 1)
  const rec = auditRecords(find, 'watchdog')
  assert.equal(rec.length, 1)
  assert.match(rec[0].prompt, /"tool_access": "unreported"/)
})

test('AC6: a non-PASS audit-only Orange certification is recorded but not parked as audit_only (REWORK flows as before)', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange' },
    watchdog: (_p, _o, n) => (n === 1 ? { ...AUDIT_PASS, verdict: 'REWORK' } : BASE.watchdog),
  } })
  assert.notEqual(result.status, 'parked:audit_only_certification')
  assert.ok(auditRecords(find, 'watchdog').some(c => /"audit_only": true/.test(c.prompt)))
})

test('AC6: a failed audit-only record never discards the accepted review (noteAuditOnly never throws)', async () => {
  const { result, logs, find } = await runHunt({ answers: {
    pointer: { ...BASE.pointer, deniedTools: ['permanently disabled'] },
    'audit-only-record': () => { throw new Error('disk full') },
  } })
  assert.notEqual(String(result.status).startsWith('parked'), true, JSON.stringify(result))
  assert.ok(logs.some(l => /⚠ h: pointer r1 \(mistral\) was audit_only/.test(l)), 'the loud log happens either way')
  assert.ok(logs.some(l => /could not record the pointer r1 tool-access row \(disk full\)/.test(l)))
  assert.equal(find('tracker:').length, 1)
})

test('AC6: runReviewFanout passes deniedTools / toolAccess from the accepted review through to the record', async () => {
  const { find } = await runHunt({ answers: {
    pointer: { ...BASE.pointer, deniedTools: ['denied by approval policy', 'denied by approval policy'], toolAccess: { shell: 'ok', denied_tools: [] } },
  } })
  const rec = auditRecords(find, 'pointer')
  assert.equal(rec.length, 1)
  assert.match(rec[0].prompt, /"evidence": \["denied by approval policy"\]/, 'deduplicated')
})

test('AC6 (Bloodhound r1 MEDIUM): a claude last-resort certifier that omits tool_access on Orange parks too', async () => {
  // GLM Shepherd (usage offload) + a mistral-family Tracker → writers {glm, mistral} → the only
  // legal certifier is the claude last-resort link.
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, tier: 'Orange' },
    'shepherd-seat': OFFLOAD_SEAT,
    tracker: { verdict: 'TESTS_PASS', provider: 'mistral' },
    pointer: { ...BASE.pointer, provider: 'mistral' },
    watchdog: { verdict: 'PASS', provider: 'claude', deniedTools: [] },
  } })
  assert.match(find('watchdog:')[0].prompt, /Claude \(last resort\)/, 'claude is in the certifier chain')
  assert.equal(result.status, 'parked:audit_only_certification', JSON.stringify(result))
  assert.match(find('park:h:audit_only_certification')[0].prompt, /certifier omitted the mandatory tool_access field/)
  assert.match(find('park:h:audit_only_certification')[0].prompt, /certifier: claude/)
})

// ════════════════════════════════════════════════════════════════════════════
// wolfpack-self-hosting (AC10): wolfpack as the CONSUMING repo. The project-config probe is
// answered by REALLY running scripts/wolfpack-config.mjs on the real wolfpack-config.md, and
// the worktree sits under wolfpack's own .agents/worktrees namespace.
// ════════════════════════════════════════════════════════════════════════════
const PACK_ROOT = join(here, '..')
const WT_PACK = '/x/wolfpack/.agents/worktrees/h'
const PD_PACK = `${WT_PACK}/.wolfpack/plans/h`
// The probe answer: exit code + stdout/stderr verbatim, exactly as the probe agent relays it.
const realConfig = (cfgPath = join(PACK_ROOT, 'wolfpack-config.md')) => () => {
  try {
    const out = execFileSync(process.execPath, [join(here, 'wolfpack-config.mjs'), '--json', cfgPath], { encoding: 'utf8', stdio: 'pipe' })
    return { exitCode: 0, output: out }
  } catch (e) {
    return { exitCode: e.status, output: `${e.stdout || ''}${e.stderr || ''}` }
  }
}
const PACK_ANSWERS = { 'project-config': realConfig(), scaffold: { worktreePath: WT_PACK, planDir: PD_PACK } }
const FORBIDDEN_IN_PROMPTS = [/run_tests\.sh/, /manage\.py/, /gcloud/, /controlled_substances/, /billing\//]

test('AC10 (a): wolfpack-hosted — Tracker/Shepherd/heartbeat carry `bash scripts/test-all.sh`; NO prompt carries a consumer-specific command or path', async () => {
  // Red: exercises the single-pass review text and the full ceremony prompts.
  for (const tier of ['Yellow', 'Red']) {
    const { result, calls, find } = await runHunt({ answers: { ...PACK_ANSWERS, alpha: { ...BASE.alpha, tier } } })
    assert.equal(result.status, 'certified', `${tier}: ${JSON.stringify(result)}`)
    const tracker = find('tracker:')[0].prompt
    assert.match(tracker, /- Run tests using: bash scripts\/test-all\.sh\n/)
    assert.match(find('shepherd:')[0].prompt, /NEVER invoke the project's test command \(`bash scripts\/test-all\.sh`\)/)
    assert.match(tracker, /Tests run ONLY via `bash scripts\/test-all\.sh` \(the project's test command/, 'heartbeat TOOLING POLICY')
    // review seats (VERDICT_CONTRACT + DIFF_CATCH_NOTE) are included
    assert.ok(find('bloodhound:').length && find('pointer:').length && find('watchdog:').length)
    for (const c of calls) {
      for (const re of FORBIDDEN_IN_PROMPTS) assert.doesNotMatch(c.prompt, re, `${tier} ${c.label} carries ${re}`)
    }
  }
})

test('AC10 (b): the scaffold uses .agents/worktrees/h; shim + toolcheck resolve under the pack root /x/wolfpack/scripts/', async () => {
  const { find, logs } = await runHunt({ answers: PACK_ANSWERS })
  const scaffold = find('scaffold:')[0].prompt
  assert.match(scaffold, /git worktree add \.agents\/worktrees\/h|\.agents\/worktrees\/h/)
  assert.doesNotMatch(scaffold, /\.claude\/worktrees/)
  assert.match(scaffold, /7\. Convenience links \(wolfpack-config\.md → Worktree links\): for each of \(none configured — skip this step\)/)
  assert.doesNotMatch(scaffold, /adcValid|application-default/)
  // exec-layer-into-pack: the repo-local scripts stay under the repo root; the SHIM comes from the
  // pack home the real config names (Project Identity → Wolfpack home, ~ expanded).
  const packHome = JSON.parse(realConfig()().output).wolfpackHome
  assert.ok(typeof packHome === 'string' && packHome.startsWith('/'), `the real config names a Wolfpack home (${packHome})`)
  assert.ok(logs.some(l => l === 'Repo root: /x/wolfpack'), logs.join('\n'))
  assert.ok(logs.some(l => l === `Pack home (WOLFPACK_HOME): ${packHome} — from wolfpack-config.md → Project Identity → Wolfpack home; seat shim ${packHome}/scripts/podman-vibe.sh`), logs.join('\n'))
  assert.ok(find('toolcheck-preflight:')[0].prompt.includes(`'/x/wolfpack/scripts/wolfpack-toolcheck.mjs' --shim '${packHome}/scripts/podman-vibe.sh'`))
  assert.ok(find('pointer:')[0].prompt.includes(`'${packHome}/scripts/podman-vibe.sh' 'wolfpack-pointer-glm'`))
  assert.ok(logs.some(l => /^Project config: wolfpack .* — tests: bash scripts\/test-all\.sh; deploy: none; risk surfaces: 0$/.test(l)), logs.join('\n'))
})

test('AC10 (b): the project-config probe runs FIRST — read-only sonnet, the exact reader command, before the resume probe', async () => {
  const { calls } = await runHunt({ answers: PACK_ANSWERS })
  assert.equal(calls[0].label, 'project-config:h')
  assert.equal(calls[1].label, 'resume-probe:h')
  assert.equal(calls[0].opts.model, 'sonnet')
  assert.equal(calls[0].opts.phase, 'Scaffold')
  assert.deepEqual(calls[0].opts.schema.required, ['exitCode', 'output'])
  assert.match(calls[0].prompt, /node scripts\/wolfpack-config\.mjs --json wolfpack-config\.md 2>&1; echo "CONFIG_RC=\$\?"/)
  assert.match(calls[0].prompt, /modify nothing/)
})

test('AC10 (c): no deploy step → Verify is never called; CERTIFIED_AWAITING_DEPLOY / certified; the log names /merge', async () => {
  const { result, find, logs } = await runHunt({ answers: PACK_ANSWERS })
  assert.equal(find('verify').length, 0)
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  assert.equal(result.status, 'certified')
  assert.ok(logs.some(l => /No deploy step: .*Dev deploy command is none — h is certified; next: \/merge h\./.test(l)), logs.join('\n'))
  assert.equal(logs.some(l => /Deploying feat\/h to dev/.test(l)), false)
})

test('AC10 (c): a project WITH a deploy step still reaches Verify, which surfaces the configured command (never runs it)', async () => {
  const { find } = await runHunt()
  const v = find('verify')
  assert.equal(v.length, 1)
  assert.match(v[0].prompt, /surface the Dev deploy\s+command \(`deploy-x`\)/i)
  assert.match(v[0].prompt, /Feature-branch deploy \(Verify\)/)
  assert.match(v[0].prompt, /Do NOT run any deploy command \(user-only\)/)
  assert.doesNotMatch(v[0].prompt, /gcloud/)
})

test('AC10 (d): the compliance gate prompt says the project "declares no risk-surface paths"', async () => {
  const { find } = await runHunt({ answers: PACK_ANSWERS })
  const gate = find('compliance-gate')[0].prompt
  assert.match(gate, /this project declares no risk-surface paths — nothing matches here; step 1b still applies/)
  const spec = find('spec')[0].prompt
  assert.match(spec, /Compliance areas: none — this project declares no compliance areas/)
})

test('consumer config: declared risk-surface paths, compliance areas and worktree links reach their prompts verbatim', async () => {
  const consumer = { ...FIXTURE_CONFIG, complianceAreas: 'payments (card data)', compliancePaths: ['app/payments/', 'app/ledger.py'], worktreeLinks: ['.env', 'venv'] }
  const { find } = await runHunt({ answers: { 'project-config': configAnswer(consumer), 'compliance-gate': { determined: true, complianceTouched: true, alreadySignedOff: false, touchedPaths: ['app/ledger.py'] } } })
  const gate = find('compliance-gate')[0].prompt
  assert.match(gate, /\n   - app\/payments\/\n   - app\/ledger\.py\n/)
  assert.doesNotMatch(gate, /declares no risk-surface paths/)
  assert.match(find('spec')[0].prompt, /Compliance areas: payments \(card data\)\)/)
  assert.match(find('scaffold:')[0].prompt, /for each of `\.env`, `venv` that exists in the main repo/)
  const park = find('park:h:compliance_review')
  assert.equal(park.length, 1)
  assert.match(park[0].prompt, /checking it against the project's Compliance Requirements \(wolfpack-config\.md\) — declared areas: payments \(card data\)/)
  assert.doesNotMatch(park[0].prompt, /DEA|SAQ/)
})

test('AC10 (e): a failing / garbled / empty project-config probe THROWS naming wolfpack-config.md — nothing scaffolded', async () => {
  const missingKeys = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'hp-cfg-'))
    const p = join(dir, 'wolfpack-config.md')
    writeFileSync(p, readFileSync(join(PACK_ROOT, 'wolfpack-config.md'), 'utf8').replace(/^- \*\*Test command:\*\*.*\n/m, ''))
    const ans = realConfig(p)()
    rmSync(dir, { recursive: true, force: true })
    return ans
  })()
  assert.equal(missingKeys.exitCode, 2, 'the real reader exits 2 on a missing key')
  const cases = [
    [missingKeys, /the reader exited 2: ✗ wolfpack-config: missing testCommand/],
    [{ exitCode: 2, output: '✗ wolfpack-config.md not found at /r/wolfpack-config.md' }, /not found at/],
    [{ exitCode: 0, output: 'garbled, no json here' }, /no parseable JSON object/],
    [{ exitCode: 0, output: '{ "testCommand": "x", ' }, /no parseable JSON object/],
    [{ exitCode: 0, output: JSON.stringify({ ...FIXTURE_CONFIG, testCommand: null }) }, /testCommand is not a string/],
    [{ exitCode: 0, output: JSON.stringify({ ...FIXTURE_CONFIG, testCommand: '' }) }, /testCommand is not a string/],
    [{ exitCode: 0, output: JSON.stringify({ ...FIXTURE_CONFIG, compliancePaths: 'a/' }) }, /compliancePaths is not an array/],
    [{ exitCode: '0', output: JSON.stringify(FIXTURE_CONFIG) }, /the reader exited 0/],
    [null, /the project-config probe returned no result/],
    [{}, /the reader exited undefined/],
  ]
  for (const [ans, why] of cases) {
    const ran = []
    const record = (label) => () => { ran.push(label); return {} }
    await assert.rejects(runHunt({ answers: { 'project-config': () => ans, 'resume-probe': record('resume-probe'), scaffold: record('scaffold'), spec: record('spec') } }), (e) => {
      assert.match(e.message, /^hunt-pipeline: h: wolfpack-config\.md is missing or incomplete — the pipeline will not guess project values\./, JSON.stringify(ans))
      assert.match(e.message, why, JSON.stringify(ans))
      assert.match(e.message, /node scripts\/wolfpack-config\.mjs --json$/)
      return true
    })
    assert.deepEqual(ran, [], `${JSON.stringify(ans)}: nothing after the probe ran`)
  }
})

test('AC10 (e): a relayed output with a leading banner and nested braces in strings still parses (brace-balanced, string-aware)', async () => {
  const tricky = { ...FIXTURE_CONFIG, name: 'odd } name { "quoted"', testCommand: 'make test ARGS="{a}"' }
  const { logs, find } = await runHunt({ answers: { 'project-config': { exitCode: 0, output: `note: relayed\n${JSON.stringify(tricky, null, 2)}\ntrailing {junk}` } } })
  assert.ok(logs.some(l => l.startsWith('Project config: odd } name { "quoted" — tests: make test ARGS="{a}"')), logs.join('\n'))
  assert.match(find('tracker:')[0].prompt, /Run tests using: make test ARGS="\{a\}"/)
})

// (f) / (g): the REAL toolcheck against a fixture root.
function shimlessFixture() {
  const fx = toolcheckFixture()
  rmSync(fx.shim)
  return fx
}
test('AC10 (f): a MISSING seat shim → parked:shim_missing naming the path; NO seat (and no Claude substitute) runs', async () => {
  const fx = shimlessFixture()
  try {
    const { result, find, logs } = await runHunt({ answers: { ...PACK_ANSWERS, 'toolcheck-preflight': realToolcheck(fx) } })
    assert.equal(result.status, 'parked:shim_missing', JSON.stringify(result))
    assert.equal(result.verdict, 'PARKED')
    assert.equal(result.reason, 'shim_missing')
    for (const p of SEAT_CALLS) assert.equal(find(p).length, 0, `${p} never ran`)
    assert.equal(find('spec').length, 0)
    assert.equal(find('park:h:toolcheck_failed').length, 0, 'not the generic toolcheck park')
    const park = find('park:h:shim_missing')
    assert.equal(park.length, 1)
    assert.ok(park[0].prompt.includes(`The seat shim ${fx.shim} does not exist in the pack at WOLFPACK_HOME=`), park[0].prompt)
    assert.match(park[0].prompt, /resume_phase: Spec/)
    assert.match(park[0].prompt, /resolution_type_expected: redirect/)
    assert.match(park[0].prompt, /WOLFPACK_ENABLE_GLM=0 WOLFPACK_ENABLE_MISTRAL_AUTO=0/)
    assert.ok(park[0].prompt.includes(`shim not found: ${fx.shim}`), 'the toolcheck output is the park context')
    const stop = logs.find(l => /cross-family seat shim MISSING at/.test(l))
    assert.ok(stop && stop.includes(fx.shim), logs.join('\n'))
    assert.match(stop, /will NOT substitute Claude/)
  } finally { fx.cleanup() }
})

test('AC10 (f): a missing shim on a resume at Code Review parks shim_missing with resume_phase Code Review', async () => {
  const fx = shimlessFixture()
  try {
    const { result, find } = await runHunt({ answers: { ...PACK_ANSWERS, 'resume-probe': { ...RESUME_AT_CODE_REVIEW, worktreePath: WT_PACK, planDir: PD_PACK }, 'toolcheck-preflight': realToolcheck(fx) } })
    assert.equal(result.status, 'parked:shim_missing')
    assert.equal(find('pointer:').length, 0)
    assert.match(find('park:h:shim_missing')[0].prompt, /resume_phase: Code Review/)
  } finally { fx.cleanup() }
})

test('AC10 (g): a toolcheck profile MISMATCH (shim present) still parks toolcheck_failed, not shim_missing', async () => {
  const fx = toolcheckFixture({ 'wolfpack-pointer-glm': bashNever })
  try {
    const { result, find } = await runHunt({ answers: { ...PACK_ANSWERS, 'toolcheck-preflight': realToolcheck(fx) } })
    assert.equal(result.status, 'parked:toolcheck_failed')
    assert.equal(find('park:h:shim_missing').length, 0)
  } finally { fx.cleanup() }
})

test('the shim_missing park reason is registered in the parked skill reason table', () => {
  const skill = readFileSync(join(PACK_ROOT, '.agents', 'skills', 'parked', 'SKILL.md'), 'utf8')
  const row = skill.split('\n').find(l => /^\|.*`shim_missing`/.test(l))
  assert.ok(row, 'a shim_missing row')
  assert.match(row, /WOLFPACK_ENABLE_GLM=0 WOLFPACK_ENABLE_MISTRAL_AUTO=0/)
  assert.match(row, /redirect/)
})

// ─── exec-layer-into-pack: WOLFPACK_HOME resolution (AC3 / AC4 / AC5) ───────────────────────
// Every podman-vibe.sh occurrence in a recorded prompt, with the text that precedes it.
const shimRefs = (calls) => calls.flatMap(c => [...c.prompt.matchAll(/(\S*)podman-vibe\.sh/g)].map(m => ({ label: c.label, ref: m[0] })))
const SHIM_SEATS = ['bloodhound:', 'pointer:', 'watchdog:', 'toolcheck-preflight:']

test('AC3 (a) / AC4: env WOLFPACK_HOME wins over the key — EVERY shim command (review, implement, certify, toolcheck) uses it', async () => {
  // default run: Bloodhound + Pointer (glm + mistral links), Watchdog (glm + mistral certify), toolcheck
  const a = await runHunt({ env: { WOLFPACK_HOME: '/envpack' } })
  for (const p of SHIM_SEATS) assert.ok(a.find(p).length >= 1, `${p} ran`)
  const wd = a.find('watchdog:')[0].prompt
  assert.ok(wd.includes(`'/envpack/scripts/podman-vibe.sh' wolfpack-watchdog-glm `), 'GLM certify step')
  assert.ok(wd.includes(`'/envpack/scripts/podman-vibe.sh' wolfpack-watchdog `), 'Mistral certify step')
  const bh = a.find('bloodhound:')[0].prompt
  assert.ok(bh.includes(`'/envpack/scripts/podman-vibe.sh' 'wolfpack-bloodhound-glm'`), 'GLM review')
  assert.ok(bh.includes(`'/envpack/scripts/podman-vibe.sh' 'wolfpack-bloodhound'`), 'Mistral review')
  assert.ok(a.find('toolcheck-preflight:')[0].prompt.includes(`--shim '/envpack/scripts/podman-vibe.sh'`), 'toolcheck --shim')
  // GLM Shepherd (--implement) run
  const g = await runHunt({ env: { WOLFPACK_HOME: '/envpack' }, answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  assert.ok(g.find('shepherd-glm')[0].prompt.includes(`'/envpack/scripts/podman-vibe.sh' --implement wolfpack-shepherd-glm `), 'GLM implement')
  const refs = [...shimRefs(a.calls), ...shimRefs(g.calls)]
  assert.ok(refs.length >= 8, `found ${refs.length} shim references`)
  for (const r of refs) assert.equal(r.ref, `'/envpack/scripts/podman-vibe.sh`, `${r.label}: ${r.ref}`)
  assert.ok(a.logs.some(l => l === 'Pack home (WOLFPACK_HOME): /envpack — from env WOLFPACK_HOME; seat shim /envpack/scripts/podman-vibe.sh'), a.logs.join('\n'))
  // a trailing slash is normalised
  const t = await runHunt({ env: { WOLFPACK_HOME: '/envpack//' } })
  for (const r of shimRefs(t.calls)) assert.equal(r.ref, `'/envpack/scripts/podman-vibe.sh`, r.label)
})

test('AC3 (b): env unset (or blank) → the config key is used, and the log names the key as the source', async () => {
  for (const env of [{}, { WOLFPACK_HOME: '' }, { WOLFPACK_HOME: '   ' }]) {
    const { calls, logs } = await runHunt({ env })
    const refs = shimRefs(calls)
    assert.ok(refs.length >= 5, JSON.stringify(env))
    for (const r of refs) assert.equal(r.ref, `'/pack/scripts/podman-vibe.sh`, `${JSON.stringify(env)} ${r.label}`)
    assert.ok(logs.some(l => l === 'Pack home (WOLFPACK_HOME): /pack — from wolfpack-config.md → Project Identity → Wolfpack home; seat shim /pack/scripts/podman-vibe.sh'), logs.join('\n'))
  }
})

test('AC3 (c): neither env nor key → THROWS naming WOLFPACK_HOME and the Wolfpack home key, before any scaffold — even when the consuming repo HAS a scripts/podman-vibe.sh', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hp-consumer-'))
  try {
    execFileSync('git', ['init', '-q', repo])
    execFileSync('mkdir', ['-p', join(repo, 'scripts')])
    writeFileSync(join(repo, 'scripts', 'podman-vibe.sh'), FIXTURE_SHIM)
    const wt = join(repo, '.agents', 'worktrees', 'h')
    for (const cfg of [{ ...FIXTURE_CONFIG, wolfpackHome: null }, (({ wolfpackHome, ...rest }) => rest)(FIXTURE_CONFIG)]) {
      const calls = []
      const record = (label) => (prompt) => { calls.push({ label, prompt }); return label === 'scaffold' ? { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } : {} }
      let seen = null
      await assert.rejects(runHunt({ env: {}, answers: {
        'project-config': configAnswer(cfg), 'resume-probe': record('resume-probe'), scaffold: record('scaffold'),
        spec: record('spec'), 'toolcheck-preflight': record('toolcheck-preflight'), bloodhound: record('bloodhound') } }), (e) => {
        seen = e.message
        assert.match(e.message, /^hunt-pipeline: h: WOLFPACK_HOME is not set and wolfpack-config\.md has no Wolfpack home/)
        assert.match(e.message, /WOLFPACK_HOME/)
        assert.match(e.message, /"- \*\*Wolfpack home:\*\* `<path>`" under ## Project Identity in wolfpack-config\.md/)
        assert.match(e.message, /never looked up in the consuming repo/)
        return true
      })
      assert.deepEqual(calls, [], `nothing after the config probe ran (${calls.map(c => c.label)})`)
      assert.ok(!seen.includes(repo), 'the consuming repo is never named as a shim source')
    }
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('AC3 (d): a relative env value or a relative key → throws "not an absolute path" before any scaffold', async () => {
  const ran = []
  const rec = (l) => () => { ran.push(l); return {} }
  await assert.rejects(runHunt({ env: { WOLFPACK_HOME: 'Projects/pack' }, answers: { 'resume-probe': rec('resume-probe'), scaffold: rec('scaffold') } }),
    /hunt-pipeline: h: env WOLFPACK_HOME is not an absolute path \('Projects\/pack'\)\. Fix: export WOLFPACK_HOME=/)
  await assert.rejects(runHunt({ env: {}, answers: { 'project-config': configAnswer({ ...FIXTURE_CONFIG, wolfpackHome: '~/pack' }), 'resume-probe': rec('resume-probe'), scaffold: rec('scaffold') } }),
    /wolfpack-config\.md → Project Identity → Wolfpack home is not an absolute path \('~\/pack'\)/)
  assert.deepEqual(ran, [])
})

// The toolcheck preflight answered by REALLY running the toolcheck CLI with exactly the --shim
// (and --profiles) the workflow put in the prompt, against fixture profiles.
const realToolcheckFromPrompt = (profiles) => (prompt) => {
  const shim = /--shim '([^']*)'/.exec(prompt)
  assert.ok(shim, 'the preflight prompt names a --shim')
  try {
    const out = execFileSync(process.execPath, [TOOLCHECK, '--shim', shim[1], '--profiles', profiles], { encoding: 'utf8', stdio: 'pipe' })
    return { ok: true, exitCode: 0, output: out }
  } catch (e) {
    return { ok: false, exitCode: e.status, output: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

test('AC5: WOLFPACK_HOME = an EMPTY pack dir → parked:shim_missing naming <home>/scripts/podman-vibe.sh; no seat, no Claude substitute', async () => {
  const fx = toolcheckFixture()
  const home = mkdtempSync(join(tmpdir(), 'hp-emptypack-'))
  try {
    const { result, find, calls } = await runHunt({ env: { WOLFPACK_HOME: home }, answers: { 'toolcheck-preflight': realToolcheckFromPrompt(fx.profiles) } })
    assert.equal(result.status, 'parked:shim_missing', JSON.stringify(result))
    const missing = join(home, 'scripts', 'podman-vibe.sh')
    const park = find('park:h:shim_missing')
    assert.equal(park.length, 1)
    assert.ok(park[0].prompt.includes(`The seat shim ${missing} does not exist in the pack at WOLFPACK_HOME=${home} (env WOLFPACK_HOME).`), park[0].prompt)
    assert.ok(park[0].prompt.includes(`shim not found: ${missing}`), 'the real toolcheck output is the context')
    for (const p of [...SEAT_CALLS, 'spec', 'shepherd-glm', 'shepherd-fallback']) assert.equal(find(p).length, 0, `${p} never ran`)
    assert.equal(calls.some(c => c.opts && c.opts.model && /review|certif/i.test(c.label)), false, 'no Claude review/certify substitute')
  } finally { fx.cleanup(); rmSync(home, { recursive: true, force: true }) }
})

test('AC5: WOLFPACK_HOME = a pack WITH the shim → the real toolcheck passes and the run proceeds', async () => {
  const fx = toolcheckFixture()
  const home = mkdtempSync(join(tmpdir(), 'hp-pack-'))
  try {
    execFileSync('mkdir', ['-p', join(home, 'scripts')])
    copyFileSync(fx.shim, join(home, 'scripts', 'podman-vibe.sh'))
    const { result, logs } = await runHunt({ env: { WOLFPACK_HOME: home }, answers: { 'toolcheck-preflight': realToolcheckFromPrompt(fx.profiles) } })
    assert.notEqual(String(result.status).startsWith('parked'), true, JSON.stringify(result))
    assert.ok(logs.some(l => /✓ seat toolcheck: profiles match the shim/.test(l)))
  } finally { fx.cleanup(); rmSync(home, { recursive: true, force: true }) }
})

test('toolcheck --profiles: passes the configured Vibe agent dir (shell-quoted); omitted when the config has none', async () => {
  const a = await runHunt({ answers: { 'project-config': configAnswer({ ...FIXTURE_CONFIG, exec: { ...FIXTURE_CONFIG.exec, vibeAgentDir: "/a b/it's agents" } }) } })
  assert.ok(a.find('toolcheck-preflight:')[0].prompt.includes(`--shim '/pack/scripts/podman-vibe.sh' --profiles '/a b/it'\\''s agents' 2>&1;`))
  for (const exec of [undefined, { ...FIXTURE_CONFIG.exec, vibeAgentDir: null, missing: ['Vibe agent dir'] }]) {
    const cfg = { ...FIXTURE_CONFIG, exec }
    if (exec === undefined) delete cfg.exec
    const b = await runHunt({ answers: { 'project-config': configAnswer(cfg) } })
    const pf = b.find('toolcheck-preflight:')[0].prompt
    assert.ok(pf.includes(`--shim '/pack/scripts/podman-vibe.sh' 2>&1;`), pf)
    assert.doesNotMatch(pf, /--profiles/)
  }
})

test('AC4 (g): source guard — no shim path is built from repoRoot in either workflow; every shim site uses shimPath', () => {
  const runner = readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
  const AC4 = /repoRoot\}?\/scripts\/(podman-vibe|run-pipeline-sandbox)\.sh/
  assert.doesNotMatch(SRC, AC4)
  assert.doesNotMatch(runner, AC4)
  // the only place the shim FILE NAME is joined to a directory is the shimPath definition
  const joins = [...SRC.matchAll(/\$\{[^}]*\}\/scripts\/podman-vibe\.sh/g)].map(m => m[0])
  assert.deepEqual(joins, ['${wolfpackHome.home}/scripts/podman-vibe.sh'])
  assert.equal((SRC.match(/shq\(shimPath\)/g) || []).length, 5, 'review ×2, implement, certify ×2')
  assert.match(SRC, /const tcShim = shimPath\n/, 'toolcheck --shim')
  // the resolver runs right after the pre-scaffold config probe and BEFORE the resume probe (H7 trust boundary)
  const iProbe = SRC.indexOf('projectConfig = await loadProjectConfig(')
  const iResolve = SRC.indexOf('const wolfpackHome = resolveWolfpackHome(')
  const iResume = SRC.indexOf('const resumeProbe = await agent(')
  assert.ok(iProbe > 0 && iProbe < iResolve && iResolve < iResume, `${iProbe} < ${iResolve} < ${iResume}`)
})
