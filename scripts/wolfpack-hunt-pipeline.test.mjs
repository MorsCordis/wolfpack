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
import { stripMeta, splitMeta, runtimeMetaRefs } from './lib/workflow-source.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// workflow-meta-runtime: load the way the Workflow runtime does — the `export const meta` block is
// REMOVED, not rewritten to `const meta` (which kept `meta` defined and hid a ReferenceError).
const SRC = stripMeta(readFileSync(join(here, '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8'))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const RETIRED_SYNC = ['wolfpack', 'sync', 'runtime'].join('-')   // built, so AC7's literal git grep stays empty
const WT = '/repo/.agents/worktrees/h'
const PD = `${WT}/.wolfpack/plans/h`
// seat-handoff-writes: a review/certify Vibe command carries the handoff args BETWEEN the shim
// and the agent, so "shim then agent" is asserted on one line: the shim prefix followed by
// " --deliver-to ", then the agent token later on that same line.
const hasHandoffCall = (text, shimPrefix, agentTok) => text.split('\n').some(l => {
  const i = l.indexOf(`${shimPrefix} --deliver-to `)
  return i >= 0 && l.indexOf(agentTok, i) > i
})

// Default happy-path answers; a scenario overrides by label prefix (value or fn(prompt, opts, n)).
// wolfpack-self-hosting (AC10): the project-config probe relays the reader's JSON. The default
// answer is a GENERIC consumer fixture WITH a deploy step, so the existing scenarios keep their
// Verify path; the wolfpack-shaped scenarios below answer it by REALLY running the reader.
const FIXTURE_CONFIG = { name: 'fixture-project', testCommand: 'bash scripts/test-all.sh', worktreeLinks: [],
  complianceAreas: null, compliancePaths: [], devDeployCommand: 'deploy-x', changelogFile: 'CHANGELOG.md',
  tagPattern: 'v[0-9]*', backlogFile: 'TODO.md', missing: [], problems: [],
  testVerdictCommand: null,   // run-observability: Project Identity → Test verdict command (none)
  // exec-layer-into-pack: the pack home (Project Identity → Wolfpack home) + the Execution Layer.
  wolfpackHome: '/pack',
  // pack-install-model: Project Identity → Worktree root (required by both workflows).
  worktreeRoot: '.agents/worktrees',
  exec: { sandboxImage: 'fx-sandbox:latest', glmImage: 'fx-sandbox-glm:latest', projectLayer: null, seatExtraMounts: [],
    sandboxExtraMounts: [], secretsPaths: [], vibeAgentDir: '/agents', seatTestEnv: [], missing: [], problems: [] } }
// scripts-unfork: the probe also reports the PACK it ran the reader from (PACK_HOME=). The answer
// simulates the seat: the env leg's injected literal `PACK='<home>'` (shq-quoted) wins; otherwise
// the seat copied the config key (the reader JSON's wolfpackHome — the shell's `~` case already
// expanded, as the reader's expandHome does). A function of the prompt, like the real seat.
const probePack = (prompt, keyHome) => {
  const m = /PACK='((?:[^']|'\\'')*)'; echo /.exec(prompt || '')   // env leg only (the key leg is now `PACK='<home>'; case`)
  return m ? m[1].replace(/'\\''/g, "'") : (typeof keyHome === 'string' ? keyHome : '')
}
const configAnswer = (cfg = FIXTURE_CONFIG, cwd = '/repo') => (prompt) =>
  ({ exitCode: 0, output: JSON.stringify(cfg, null, 2), cwd, pack: probePack(prompt, cfg.wolfpackHome) })
// pack-install-model (AC5): the run-start stamp probe relays `wolfpack-workflows.mjs check --json`.
// Default: both workflows are the pack's own canonical files (wolfpack's layout), which is what
// the UNSTAMPED canonical SRC expects. A scenario passes per-file states / extra fields.
const PACK_COMMIT = 'a'.repeat(40)
const stampResult = ({ hunt = 'canonical', runner = 'canonical', huntExtra = {}, runnerExtra = {}, canonicalSource = `sha256:${'c'.repeat(64)}`, consumer = '/repo' } = {}) => {
  const w = (name, state, extra) => ({ name, file: `/repo/.claude/workflows/${name}`, state, stamp: null, canonicalSource,
    fix: ['current', 'canonical'].includes(state) ? null : "bash '/pack/install.sh' --consumer '/repo'", ...extra })
  const workflows = [w('campaign-runner.js', runner, runnerExtra), w('hunt-pipeline.js', hunt, huntExtra)]
  return { ok: workflows.every(x => ['current', 'canonical'].includes(x.state)), pack: '/pack', packVersion: 'v0.2.0-1-gaaaaaaa', packCommit: PACK_COMMIT, consumer, workflows }
}
const stampAnswer = (opts = {}, exitCode, cwd = '/repo') => {
  const r = stampResult(opts)
  return { exitCode: exitCode ?? (r.ok ? 0 : 1), output: JSON.stringify(r), cwd }
}

// run-observability: a relayed `wolfpack-test-record.mjs ensure --json` answer for a stage.
const REC_SHA = 'b'.repeat(40)
const stageOf = (prompt) => (/ensure --json --stage (\w+)/.exec(prompt || '') || [])[1] || 'tracker'
const recordAnswer = (stage, over = {}) => ({
  exitCode: over.exitCode ?? (over.pass === false ? 2 : 0),
  output: JSON.stringify({ schema: 1, stage, commit: REC_SHA, head: REC_SHA, exit: over.pass === false ? 1 : 0, pass: true,
    summary: 'test-all: 1 passed, 0 failed', log: `${PD}/test-record-${stage}.log`, command: FIXTURE_CONFIG.testCommand,
    verdict_command: null, reused: false, ran_in: 'repo', ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'exitCode')) }),
})

const BASE = {
  'project-config': configAnswer(),
  'workflow-stamp': stampAnswer(),
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
  // run-observability: the boundary usage gate (one relay per agent phase) proceeds by default,
  // and the pipeline's SHA-stamped test record passes at every stage (a fn of the prompt's stage).
  'usage-gate': { exitCode: 0, output: JSON.stringify({ decision: 'proceed', exit: 0, reason: '5h 10% < 95% boundary', source: 'live', degraded: false, mode: 'boundary' }) },
  'test-record': (prompt) => recordAnswer(stageOf(prompt)),
  // merge-and-state-hygiene (AC16): the Certify shim probe — by default the hunt does not touch
  // the seat shim, so Certify keeps the pack shim (an invalid answer correctly parks fail-closed).
  'cert-shim-probe': { changed: [], worktreeShimExists: false },
}

async function runHunt({ env = {}, answers = {}, args = {}, rawArgs, src = SRC } = {}) {
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
  // workflow-meta-runtime: the real runtime's parallel() turns a throwing unit into `null`; a
  // harness that propagated the throw hid a pipeline error behind a different symptom.
  const parallel = async (fns) => Promise.all(fns.map(async f => { try { return await f() } catch { return null } }))
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'process', src)
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
  assert.match(bh, /podman-vibe\.sh' --deliver-to [^\n]*'wolfpack-bloodhound-glm'/)
  assert.match(bh, /podman-vibe\.sh' --deliver-to [^\n]*'wolfpack-bloodhound'/)   // mistral is default-ON now
  // Alpha (Claude) wrote the plan, so the claude last-resort link is filtered out
  assert.doesNotMatch(bh, /Claude \(last resort\)/)
  const ptr = find('pointer:')[0].prompt
  assert.doesNotMatch(ptr, /Claude \(last resort\)/)   // a Claude Shepherd wrote the code
  assert.match(ptr, /podman-vibe\.sh' --deliver-to [^\n]*'wolfpack-pointer-glm'/)
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
  assert.match(ptr, /podman-vibe\.sh' --deliver-to [^\n]*'wolfpack-pointer'/)
  // no Claude has written yet, so the last-resort link IS live for Pointer round 1
  assert.match(ptr, /Claude \(last resort\)/)
  const wd = find('watchdog:')[0].prompt
  assert.doesNotMatch(wd, /wolfpack-watchdog-glm/)
  assert.match(wd, /podman-vibe\.sh' --deliver-to [^\n]* wolfpack-watchdog /)
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
  assert.match(ptr, /podman-vibe\.sh' --deliver-to [^\n]*'wolfpack-pointer'/)
  assert.doesNotMatch(ptr, /-glm'/)
})

test('resume: metadata.shepherd_families=["glm"] keeps glm out of the chain even without a pin', async () => {
  const { find } = await runHunt({ answers: { 'shepherd-seat': { shepherdPin: '', complianceCritical: false, shepherdFamilies: ['glm', 'claude'] } } })
  assert.doesNotMatch(find('pointer:')[0].prompt, /-glm'/)
  assert.doesNotMatch(find('watchdog:')[0].prompt, /wolfpack-watchdog-glm/)
})

test('Pointer rework goes back to the GLM Shepherd (same family that wrote the code)', async () => {
  const finding = { id: 1, severity: 'MEDIUM', title: 't', file: 'app/x.py', line: 1, claim: 'c', evidence: 'e', fingerprint: 'app/x.py:null-deref', symbol: 'x', claim_class: 'missing-handling' }
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
const FINDING = { id: 1, severity: 'MEDIUM', title: 't', file: 'app/x.py', line: 1, claim: 'c', evidence: 'e', fingerprint: 'app/x.py:null-deref', symbol: 'x', claim_class: 'missing-handling' }
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

test('shell commands single-quote interpolated paths (worktree with a space and a quote; pack home with a space)', async () => {
  // pack-install-model: a pack home containing a single quote is now REFUSED at the stamp probe
  // (plan-final § checkWorkflowStamp), so the quote case for the pack home lives in its own test below.
  const wt = "/re po/it's/.agents/worktrees/h"
  const { find } = await runHunt({ env: { WOLFPACK_HOME: '/pa ck/dir' }, answers: { scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  const bh = find('bloodhound:')[0].prompt
  assert.ok(bh.includes(`'/re po/it'\\''s/.agents/worktrees/h'`), 'worktree path is POSIX single-quoted')
  assert.ok(bh.includes(`'/pa ck/dir/scripts/podman-vibe.sh'`), 'shim path (from the pack home) is quoted too')
  assert.match(find('toolcheck-preflight:')[0].prompt, /--shim '\/pa ck\/dir\/scripts\/podman-vibe\.sh'/)
  assert.ok(find('workflow-stamp:')[0].prompt.includes(`node '/pa ck/dir/scripts/wolfpack-workflows.mjs' check --pack '/pa ck/dir' --consumer "$(pwd)" --json`))
})

test('pack-install-model: a pack home containing a single quote is refused BEFORE the stamp probe or any state probe', async () => {
  const ran = []
  const rec = (l) => () => { ran.push(l); return {} }
  await assert.rejects(runHunt({ env: { WOLFPACK_HOME: "/pa ck/it's" }, answers: { 'workflow-stamp': rec('workflow-stamp'), 'resume-probe': rec('resume-probe'), scaffold: rec('scaffold') } }),
    /hunt-pipeline: h: WOLFPACK_HOME contains a single quote — refusing to build the stamp probe/)
  assert.deepEqual(ran, [])
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
const RUNNER = stripMeta(readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8'))
async function runRunner({ env = {}, protocol }) {
  const calls = []
  const agent = async (_p, opts = {}) => {
    calls.push(opts.label)
    if (opts.label === 'project-config') return configAnswer()(_p)
    if (opts.label === 'workflow-stamp') return stampAnswer()
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
  await assert.rejects(runRunner({ protocol: 0 }), /STALE .*Regenerate it: bash '\/pack\/install\.sh' --consumer <this repo> \(then restart Claude Code\)/)
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
  // scripts-unfork: the helpers run from the PACK home (here one with a space — a single quote in
  // a pack home is refused up front, see the pack-install-model test), while the plan dir keeps
  // the space + quote of the worktree path, so shq is exercised on both arguments.
  const wt = "/re po/it's/.agents/worktrees/h"
  const pack = '/pa ck/home'
  const { find } = await runHunt({ env: { WOLFPACK_HOME: pack }, answers: { scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  const q = (x) => `'${x.replace(/'/g, `'\\''`)}'`
  assert.ok(find('alpha:')[0].prompt.includes(`node ${q(`${pack}/scripts/wolfpack-routing.mjs`)} ${q(`${wt}/.wolfpack/plans/h`)}`))
  const wd = find('watchdog:')[0].prompt
  assert.ok(wd.includes(`node ${q(`${pack}/scripts/wolfpack-timing.mjs`)} ${q(`${wt}/.wolfpack/plans/h`)}`))
  assert.ok(wd.includes(`node ${q(`${pack}/scripts/wolfpack-model-stats.mjs`)} --stamp`))
  assert.ok(wd.includes(`bash ${q(`${pack}/scripts/wolfpack-lessons.sh`)}`), 'Watchdog step 4.6 runs the pack lessons aggregator')
  // never the consuming repo's (or the worktree's) scripts dir
  for (const p of [find('alpha:')[0].prompt, wd]) {
    assert.doesNotMatch(p, /\/re po\/it'\\''s\/scripts\/wolfpack-|\.\/scripts\/wolfpack-/)
  }
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
    if (opts.label === 'project-config') return configAnswer()(_p)
    if (opts.label === 'workflow-stamp') return stampAnswer()
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
  assert.ok(logs.some(l => /STALE PIPELINE.*regenerate it: bash '\/pack\/install\.sh' --consumer <this repo> \(then restart Claude Code\)/.test(l)), 'the warning names the fix command')
  assert.equal(logs.some(l => l.includes(RETIRED_SYNC)), false, 'the retired sync script is never named')
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
  assert.match(ptr[0].prompt, /podman-vibe\.sh' --deliver-to [^\n]*'wolfpack-pointer'/)
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
  assert.match(rec[0].prompt, /node '\/pack\/scripts\/wolfpack-usage\.mjs' record-offload --plan-dir '\/repo\/\.agents\/worktrees\/h\/\.wolfpack\/plans\/h' --reason 'weekly pace \+16\.4 — it'\\''s ahead'/)
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
  // scripts-unfork: the meter CLI is the PACK's (FIXTURE_CONFIG Wolfpack home /pack), never /repo/scripts/.
  const timedStamp = `if [ -f "/pack/scripts/wolfpack-usage.mjs" ] && [ -w "${WT}/.wolfpack/plans/h" ]; then node "/pack/scripts/wolfpack-usage.mjs" stamp --heartbeat .wolfpack/heartbeats/h.json --plan-dir "${WT}/.wolfpack/plans/h"; fi`
  for (const p of ['alpha:', 'bloodhound:', 'shepherd:', 'pointer:', 'tracker:', 'watchdog:']) {
    const c = find(p)[0]
    assert.ok(c, p)
    const n = c.prompt.split(timedStamp).length - 1
    assert.equal(n, 2, `${p} prompt: stamp after the JSON write AND after "done" (found ${n})`)
    assert.match(c.prompt, /preserve every other heartbeat field/)
    assert.match(c.prompt, /expected in a sandboxed seat/)
  }
  const sc = find('scaffold:')[0].prompt
  assert.match(sc, /if \[ -f "\/pack\/scripts\/wolfpack-usage\.mjs" \]; then node "\/pack\/scripts\/wolfpack-usage\.mjs" stamp --heartbeat \.wolfpack\/heartbeats\/h\.json; fi/)
  assert.doesNotMatch(sc, /stamp --heartbeat[^\n]*--plan-dir/, 'Scaffold never stamps metadata (no plan dir yet)')
  const { calls } = await runHunt()
  for (const c of calls) {
    assert.doesNotMatch(c.prompt, /\/repo\/scripts\/wolfpack-usage|"scripts\/wolfpack-usage/, `${c.label}: no repo-relative / consuming-repo meter CLI`)
  }
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
  const { result, find } = await runHunt({ answers: { pointer: { verdict: 'ERROR', status: 'infra_error', findingsList: [] } } })
  assert.equal(result.verdict, 'PARKED')
  // workflow-meta-runtime (4): when seats DID run and fail, the outage guess stays and no error line is added
  const parks = find('park:')
  assert.equal(parks.length, 1)
  assert.match(parks[0].prompt, /likely a model outage or quota exhaustion/)
  assert.doesNotMatch(parks[0].prompt, /- error:/)
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
// run-observability: the pipeline composes fingerprint = file::symbol::claim_class (a seat value is
// overwritten), so per-round distinctness comes from the SYMBOL.
const findingFor = (round) => ({ ...FINDING, fingerprint: `app/x.py:defect-r${round}`, symbol: `defect-r${round}` })
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
    // consolidation-acceptance: the probe relays wolfpack-human-patches.mjs check, so every pending item
    // carries its target + repo (no back-compat default for a missing one).
    'human-patch-check': { pending: [{ patch, rel: '01-guard.patch', paths: ['.claude/hooks/bash-guards.sh'], applies: true, target: 'hunt', repo: WT }], consumer: null },
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
      : { pending: [{ patch: `${PD}/human-patches/01-guard.patch`, paths: ['.claude/hooks/bash-guards.sh'], applies: false, target: 'hunt', repo: WT }], consumer: null },
  } })
  assert.equal(result.status, 'parked:human_patch')
  assert.equal(find('pointer:').length, 1, 'parks after the round-1 rework, before round 2')
  assert.match(find('park:h:human_patch')[0].prompt, /does NOT apply cleanly/)
})

// ─── consolidation-acceptance AC1–AC3: the human-patch gate knows each patch's target repo ───
const CWT = '/consumer/.claude/worktrees/h'
const consumerPending = (over = {}) => ({ patch: `${PD}/human-patches/consumer/01-smoke.patch`, rel: 'consumer/01-smoke.patch',
  paths: ['.claude/hooks/smoke.sh'], applies: true, target: 'consumer', repo: CWT, ...over })

test('consolidation-acceptance AC2: the gate probe runs the deterministic CLI (not an LLM git walk) with plan dir + worktree', async () => {
  const { find } = await runHunt()
  const probe = find('human-patch-check')[0]
  assert.ok(probe.prompt.includes(`node '/pack/scripts/wolfpack-human-patches.mjs' check --plan-dir '${PD}' --worktree '${WT}'; echo "RC=$?"`), probe.prompt)
  assert.match(probe.prompt, /return the command's JSON stdout VERBATIM/)
  assert.doesNotMatch(probe.prompt, /git apply --check -R/, 'the old in-prompt probe is gone')
  assert.equal(probe.opts.schema.properties.pending.items.properties.target.enum.join(','), 'hunt,consumer')
  assert.deepEqual(probe.opts.schema.properties.pending.items.required, ['patch', 'paths', 'applies', 'target', 'repo'])
})

test('consolidation-acceptance AC3: a pending CONSUMER patch parks with git -C <consumer> apply/add/commit and names the consumer branch', async () => {
  const { result, find } = await runHunt({ answers: {
    'human-patch-check': { pending: [consumerPending()], consumer: { path: CWT, branch: 'feat/h' } },
  } })
  assert.equal(result.status, 'parked:human_patch')
  assert.equal(find('pointer:').length, 0)
  const park = find('park:h:human_patch')[0].prompt
  assert.ok(park.includes(`git -C ${CWT} apply ${PD}/human-patches/consumer/01-smoke.patch`), park)
  assert.ok(park.includes(`git -C ${CWT} add .claude/hooks/smoke.sh`))
  assert.ok(park.includes(`git -C ${CWT} commit -m`))
  assert.ok(!park.includes(`git -C ${WT} apply ${PD}/human-patches/consumer/01-smoke.patch`), 'never the hunt worktree for a consumer patch')
  assert.ok(!park.includes(`git -C ${WT} add`), 'no hunt-worktree add line when only a consumer patch is pending')
  assert.ok(park.includes(`commit them on feat/h (consumer worktree ${CWT})`), 'the needFromUser names the consumer branch')
  assert.match(park, /resume_phase: Code Review/)
})

test('consolidation-acceptance AC3: hunt + consumer patches → one add/commit block per repo; both branches named', async () => {
  const hunt = { patch: `${PD}/human-patches/01-guard.patch`, rel: '01-guard.patch', paths: ['.claude/hooks/bash-guards.sh'], applies: true, target: 'hunt', repo: WT }
  const { result, find } = await runHunt({ answers: {
    'human-patch-check': { pending: [hunt, consumerPending({ applies: false })], consumer: { path: CWT, branch: 'feat/consumer-h' } },
  } })
  assert.equal(result.status, 'parked:human_patch')
  const park = find('park:h:human_patch')[0].prompt
  assert.ok(park.includes(`git -C ${WT} apply ${PD}/human-patches/01-guard.patch\n  git -C ${WT} add .claude/hooks/bash-guards.sh\n  git -C ${WT} commit -m`), park)
  assert.ok(park.includes(`git -C ${CWT} apply ${PD}/human-patches/consumer/01-smoke.patch   # does NOT apply cleanly: inspect it first`))
  assert.ok(park.includes(`git -C ${CWT} add .claude/hooks/smoke.sh`))
  assert.ok(park.includes(`commit them on feat/h (hunt worktree) and feat/consumer-h (consumer worktree ${CWT})`))
  assert.ok(park.indexOf(`git -C ${WT} apply`) < park.indexOf(`git -C ${CWT} apply`), 'hunt group first')
})

test('consolidation-acceptance F4: a pending patch with no b/ paths (deletion-only) parks with a stage hint, never a pathspec-less `git -C <repo> add`', async () => {
  const del = { patch: `${PD}/human-patches/01-del.patch`, rel: '01-del.patch', paths: [], applies: true, target: 'hunt', repo: WT }
  const { result, find } = await runHunt({ answers: {
    'human-patch-check': { pending: [del, consumerPending()], consumer: { path: CWT, branch: 'feat/h' } },
  } })
  assert.equal(result.status, 'parked:human_patch')
  assert.equal(find('pointer:').length, 0)
  const park = find('park:h:human_patch')[0].prompt
  assert.ok(park.includes(`git -C ${WT} apply ${PD}/human-patches/01-del.patch\n  # these patches name no b/ paths: stage the changed files in ${WT} by name before committing\n  git -C ${WT} commit -m`), park)
  assert.doesNotMatch(park, new RegExp(`git -C ${WT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} add`), 'no pathspec-less hunt add')
  assert.ok(park.includes(`git -C ${CWT} add .claude/hooks/smoke.sh`), 'the consumer group with paths still stages them')
})

test('consolidation-acceptance AC2: an already-applied consumer patch (CLI pending: []) → no park, Code Review runs', async () => {
  const { result, find } = await runHunt({ answers: { 'human-patch-check': { pending: [], consumer: { path: CWT, branch: 'feat/h' } } } })
  assert.notEqual(result.status, 'parked:human_patch')
  assert.equal(find('park:h:human_patch').length, 0)
  assert.ok(find('pointer:').length >= 1)
})

test('consolidation-acceptance fail closed: an unreadable / inconsistent check parks human_patch "could not run" — never "nothing pending"', async () => {
  const cases = {
    'CLI error': [{ pending: [], error: 'a consumer-targeted human patch needs metadata.consumer_worktree.path (absolute)' }, /consumer_worktree\.path/],
    'no target (old shape)': [{ pending: [{ patch: `${PD}/human-patches/01-guard.patch`, paths: ['x'], applies: true }] }, /has no valid target/],
    'unknown target': [{ pending: [consumerPending({ target: 'elsewhere' })], consumer: { path: CWT, branch: 'b' } }, /has no valid target/],
    'missing repo': [{ pending: [{ ...consumerPending(), repo: undefined }], consumer: { path: CWT, branch: 'b' } }, /names repo undefined, expected/],
    'hunt patch, wrong repo': [{ pending: [{ patch: `${PD}/human-patches/01-g.patch`, paths: ['x'], applies: true, target: 'hunt', repo: '/elsewhere' }], consumer: null }, /names repo "\/elsewhere", expected "\/repo\/\.agents\/worktrees\/h"/],
    'consumer patch, no consumer recorded': [{ pending: [consumerPending()], consumer: null }, /needs metadata\.consumer_worktree\.path/],
    'consumer repo mismatch': [{ pending: [consumerPending({ repo: WT })], consumer: { path: CWT, branch: 'b' } }, /expected "\/consumer\/\.claude\/worktrees\/h"/],
    'null answer': [null, /the check returned nothing/],
  }
  for (const [name, [answer, re]] of Object.entries(cases)) {
    const { result, find } = await runHunt({ answers: { 'human-patch-check': () => answer } })
    assert.equal(result.status, 'parked:human_patch', name)
    assert.equal(result.verdict, 'PARKED', name)
    assert.equal(find('pointer:').length, 0, `${name}: no review on an unreadable check`)
    const park = find('park:h:human_patch')
    assert.equal(park.length, 1, name)
    assert.match(park[0].prompt, /The human-patch check could not run: /, name)
    assert.match(park[0].prompt, re, name)
    assert.match(park[0].prompt, /record metadata\.consumer_worktree/, name)
    assert.ok(park[0].prompt.includes(`wolfpack-human-patches.mjs check --plan-dir ${PD} --worktree ${WT}`), name)
    assert.doesNotMatch(park[0].prompt, /Apply \(from any shell\)/, `${name}: no apply commands for an unreadable check`)
  }
})

test('consolidation-acceptance AC1: Shepherd prompts teach the consumer/ subdir + consumer_worktree; the Debrief asks for each file\'s repo', async () => {
  const { find } = await runHunt()
  const shep = find('shepherd:')[0].prompt
  assert.ok(shep.includes(`${PD}/human-patches/consumer/<NN>-<short-name>.patch`))
  assert.match(shep, /git -C <consumer worktree> apply --check <patch>/)
  assert.match(shep, /"consumer_worktree": \{"path": "<abs>", "branch": "<branch>"\}/)
  // the existing hunt-worktree strings stay
  assert.match(shep, /human-patches\/<NN>-<short-name>\.patch/)
  assert.match(shep, /git apply --check <patch>/)
  assert.match(find('debrief:')[0].prompt, /listing each such file, its repo \(hunt worktree or consumer\), and the exact change/)
  const glm = (await runHunt({ answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })).find('shepherd-glm')[0].prompt
  assert.ok(glm.includes(`${PD}/human-patches/consumer/<NN>-<short-name>.patch`))
  assert.match(glm, /"consumer_worktree": \{"path": "<abs>", "branch": "<branch>"\}/)
})

test('consolidation-acceptance AC1: core drift — the human-patch block is byte-identical (minus export) in the module and hunt-pipeline.js', () => {
  const RE = /\/\/ ── BEGIN wolfpack-human-patch core[^\n]*\n[\s\S]*?\/\/ ── END wolfpack-human-patch core ──/
  const modSrc = readFileSync(join(here, 'lib', 'human-patch.mjs'), 'utf8')
  const wfSrc = readFileSync(join(here, '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
  const mod = modSrc.match(RE)
  const wf = wfSrc.match(RE)
  assert.ok(mod, 'core markers missing in scripts/lib/human-patch.mjs')
  assert.ok(wf, 'core markers missing in hunt-pipeline.js')
  for (const name of ['humanPatchTarget', 'humanPatchRepo', 'humanPatchApplySteps']) assert.match(mod[0], new RegExp(`^export function ${name}\\(`, 'm'))
  assert.match(mod[0], /^export const HUMAN_PATCH_TARGETS = /m)
  assert.equal(wf[0], mod[0].replace(/^export /gm, ''))
  assert.doesNotMatch(modSrc, /^import /m, 'the module is pure (the workflow runner cannot import)')
  assert.equal((wfSrc.match(/^function humanPatchApplySteps\(/gm) || []).length, 1)
  assert.equal((wfSrc.match(/^const HUMAN_PATCH_TARGETS = /gm) || []).length, 1)
})

// ─── consolidation-acceptance AC10: Certify parks pedigree_incomplete instead of writing a dashed row ───
test('consolidation-acceptance AC10: a PASS whose pedigree row was refused → parked:pedigree_incomplete, no Verify', async () => {
  const err = 'index-row: missing or invalid pedigree scores: Adherence (execution_scores.plan_adherence), Verdict (certifier_verdict)'
  const { result, find, logs } = await runHunt({ answers: { watchdog: { ...BASE.watchdog, pedigreeRowError: err } } })
  assert.equal(result.status, 'parked:pedigree_incomplete', JSON.stringify(result))
  assert.equal(result.verdict, 'PARKED')
  assert.equal(result.reason, 'pedigree_incomplete')
  assert.equal(find('verify').length, 0, 'no Verify after a refused row')
  const park = find('park:h:pedigree_incomplete')
  assert.equal(park.length, 1)
  assert.match(park[0].prompt, /resume_phase: Certify/)
  assert.ok(park[0].prompt.includes(err), 'the park names the missing fields')
  assert.match(park[0].prompt, /lacks scores, so no index row was written/)
  assert.ok(logs.some(l => /certification PASSED but the pedigree row was refused/.test(l)))
})

test('consolidation-acceptance AC10: a PASS without pedigreeRowError is unchanged (Verify runs); a non-PASS with one does not park pedigree_incomplete', async () => {
  const ok = await runHunt()
  assert.notEqual(ok.result.status, 'parked:pedigree_incomplete')
  assert.ok(ok.find('verify').length >= 1)
  assert.equal(ok.find('park:h:pedigree_incomplete').length, 0)
  const empty = await runHunt({ answers: { watchdog: { ...BASE.watchdog, pedigreeRowError: '' } } })
  assert.notEqual(empty.result.status, 'parked:pedigree_incomplete', 'an empty error string is not a refusal')
})

test('consolidation-acceptance AC10: the cert seat prompt names the required pedigree score fields; VERDICT_SCHEMA carries pedigreeRowError', async () => {
  const { find } = await runHunt()
  const wd = find('watchdog:')[0]
  const seat = wd.prompt.slice(wd.prompt.indexOf('2. Write the Watchdog prompt'), wd.prompt.indexOf('3. Walk the CERTIFIER CHAIN'))
  assert.match(seat, /pedigree\.json MUST carry certifier_verdict \(pass\|rework\|flawed_plan, matching your verdict\)/)
  for (const f of ['plan_adherence', 'code_quality', 'implementation_judgment', 'test_result', 'code_review_quality',
    'test_authoring_quality', 'rework_rounds', 'pointer_rounds', 'tracker_rounds', 'human_interventions',
    'pointer_value_add', 'tracker_value_add', 'cycle_efficiency']) assert.ok(seat.includes(f), f)
  assert.equal(wd.opts.schema.properties.pedigreeRowError.type, 'string')
  assert.match(wd.prompt, /return `pedigreeRowError` = its stderr/)
  assert.match(wd.prompt, /pass it to the index-row writer \(--duration\) in step 4\.6/)
})

// ─── seat-profiles-into-pack: toolcheck preflight (AC5) + audit_only (AC6) ───

// A capable fixture shim carrying both halves the toolcheck reads (Mistral loop + GLM lists).
const FIXTURE_SHIM = `VIBE_TOOLS_DEFAULT="read grep edit write_file bash"
VIBE_TOOL_FLAGS=()
for _t in \${WOLFPACK_VIBE_TOOLS:-$VIBE_TOOLS_DEFAULT}; do
    VIBE_TOOL_FLAGS+=(--enabled-tools "$_t")
done
GLM_REVIEW_TOOLS_DEFAULT="read_file grep bash write_file dev_cortex_repo_map dev_cortex_file_outline"
GLM_IMPLEMENT_TOOLS_DEFAULT="read_file grep write_file edit dev_cortex_repo_map dev_cortex_file_outline"
GLM_REVIEW_DROP="task edit"
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
    assert.match(pf[0].prompt, /node '\/pack\/scripts\/wolfpack-toolcheck\.mjs' --shim '\/pack\/scripts\/podman-vibe\.sh' --profiles '\/agents'/, 'the PACK toolcheck (scripts-unfork) targets the pack shim (WOLFPACK_HOME) + the configured Vibe agent dir')
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
    // seat-handoff-writes: write_file is no longer read-only-by-role (the seat writes its handoff
    // file), so the role-denied set is edit/skill/task only.
    watchdog: { verdict: 'PASS', provider: 'glm', deniedTools: [], toolAccess: { shell: 'ok', denied_tools: ['edit', 'skill', 'task'] } },
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
  // seat-handoff-writes: write_file is now audit-only evidence too (A7: profile drift)
  assert.match(ev, /seat reported denied tool: write_file/)
})

test('seat-handoff-writes AC12: a review seat that lists only write_file as denied IS recorded audit_only', async () => {
  const { find } = await runHunt({ answers: {
    bloodhound: { ...BASE.bloodhound, deniedTools: [], toolAccess: { shell: 'ok', denied_tools: ['write_file'] } },
  } })
  const rec = auditRecords(find, 'bloodhound')
  assert.equal(rec.length, 1)
  assert.match(rec[0].prompt, /"audit_only": true/)
  assert.match(rec[0].prompt, /write_file/)
})

test('seat-handoff-writes AC12: a review seat that lists only edit/task/skill as denied is NOT recorded audit_only', async () => {
  const { find } = await runHunt({ answers: {
    bloodhound: { ...BASE.bloodhound, deniedTools: [], toolAccess: { shell: 'ok', denied_tools: ['edit', 'task', 'skill'] } },
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
const realConfig = (cfgPath = join(PACK_ROOT, 'wolfpack-config.md')) => (prompt) => {
  try {
    const out = execFileSync(process.execPath, [join(here, 'wolfpack-config.mjs'), '--json', cfgPath], { encoding: 'utf8', stdio: 'pipe' })
    return { exitCode: 0, output: out, cwd: '/repo', pack: probePack(prompt, JSON.parse(out).wolfpackHome) }
  } catch (e) {
    return { exitCode: e.status, output: `${e.stdout || ''}${e.stderr || ''}`, cwd: '/repo', pack: probePack(prompt, '') }
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
  // exec-layer-into-pack + scripts-unfork: the SHIM and every pack script (toolcheck here) come from
  // the pack home the real config names (Project Identity → Wolfpack home, ~ expanded) — never the
  // hosting repo's root (/x/wolfpack is only the worktree math).
  const packHome = JSON.parse(realConfig()().output).wolfpackHome
  assert.ok(typeof packHome === 'string' && packHome.startsWith('/'), `the real config names a Wolfpack home (${packHome})`)
  assert.ok(logs.some(l => l === 'Repo root: /x/wolfpack'), logs.join('\n'))
  assert.ok(logs.some(l => l === `Pack home (WOLFPACK_HOME): ${packHome} — from wolfpack-config.md → Project Identity → Wolfpack home; seat shim ${packHome}/scripts/podman-vibe.sh`), logs.join('\n'))
  assert.ok(find('toolcheck-preflight:')[0].prompt.includes(`node '${packHome}/scripts/wolfpack-toolcheck.mjs' --shim '${packHome}/scripts/podman-vibe.sh'`))
  assert.ok(!find('toolcheck-preflight:')[0].prompt.includes('/x/wolfpack/scripts/'))
  assert.ok(hasHandoffCall(find('pointer:')[0].prompt, `'${packHome}/scripts/podman-vibe.sh'`, ` 'wolfpack-pointer-glm' `))
  assert.ok(logs.some(l => /^Project config: wolfpack .* — tests: bash scripts\/test-all\.sh; deploy: none; risk surfaces: 0$/.test(l)), logs.join('\n'))
})

test('AC10 (b): the project-config probe runs FIRST — read-only sonnet, the exact reader command, before the resume probe', async () => {
  const { calls } = await runHunt({ answers: PACK_ANSWERS })
  assert.equal(calls[0].label, 'project-config:h')
  // pack-install-model (AC5): the read-only stamp probe sits between the config probe and the resume probe.
  assert.equal(calls[1].label, 'workflow-stamp:h')
  assert.equal(calls[2].label, 'resume-probe:h')
  assert.equal(calls[0].opts.model, 'sonnet')
  assert.equal(calls[0].opts.phase, 'Scaffold')
  // scripts-unfork: the probe runs the PACK's reader and reports which PACK it used.
  assert.deepEqual(calls[0].opts.schema.required, ['exitCode', 'output', 'cwd', 'pack'])
  assert.match(calls[0].prompt, /echo "PACK_HOME=\$PACK"; node "\$PACK\/scripts\/wolfpack-config\.mjs" --json wolfpack-config\.md 2>&1; echo "CONFIG_RC=\$\?"/)
  assert.doesNotMatch(calls[0].prompt, /node scripts\/wolfpack-config\.mjs/)
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
      // scripts-unfork: the fix names the PACK's reader, never a repo-relative copy
      assert.match(e.message, /check with node <pack>\/scripts\/wolfpack-config\.mjs --json, and make sure WOLFPACK_HOME \/ Wolfpack home points at a wolfpack checkout \(the reader is <pack>\/scripts\/wolfpack-config\.mjs\)$/)
      assert.doesNotMatch(e.message, /node scripts\/wolfpack-config/)
      return true
    })
    assert.deepEqual(ran, [], `${JSON.stringify(ans)}: nothing after the probe ran`)
  }
})

test('AC10 (e): a relayed output with a leading banner and nested braces in strings still parses (brace-balanced, string-aware)', async () => {
  const tricky = { ...FIXTURE_CONFIG, name: 'odd } name { "quoted"', testCommand: 'make test ARGS="{a}"' }
  const { logs, find } = await runHunt({ answers: { 'project-config': { exitCode: 0, output: `note: relayed\n${JSON.stringify(tricky, null, 2)}\ntrailing {junk}`, cwd: '/repo', pack: '/pack' } } })
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
// merge-and-state-hygiene (AC16): the read-only cert-shim PROBE names the shim sources and the
// worktree's shim to ask whether the hunt changes them — it runs no shim, so it is not a shim command.
const shimRefs = (calls) => calls.filter(c => !c.label.startsWith('cert-shim-probe'))
  .flatMap(c => [...c.prompt.matchAll(/(\S*)podman-vibe\.sh/g)].map(m => ({ label: c.label, ref: m[0] })))
const SHIM_SEATS = ['bloodhound:', 'pointer:', 'watchdog:', 'toolcheck-preflight:']

test('AC3 (a) / AC4: env WOLFPACK_HOME wins over the key — EVERY shim command (review, implement, certify, toolcheck) uses it', async () => {
  // default run: Bloodhound + Pointer (glm + mistral links), Watchdog (glm + mistral certify), toolcheck
  const a = await runHunt({ env: { WOLFPACK_HOME: '/envpack' } })
  for (const p of SHIM_SEATS) assert.ok(a.find(p).length >= 1, `${p} ran`)
  const wd = a.find('watchdog:')[0].prompt
  assert.ok(hasHandoffCall(wd, `'/envpack/scripts/podman-vibe.sh'`, ` wolfpack-watchdog-glm `), 'GLM certify step')
  assert.ok(hasHandoffCall(wd, `'/envpack/scripts/podman-vibe.sh'`, ` wolfpack-watchdog `), 'Mistral certify step')
  const bh = a.find('bloodhound:')[0].prompt
  assert.ok(hasHandoffCall(bh, `'/envpack/scripts/podman-vibe.sh'`, ` 'wolfpack-bloodhound-glm' `), 'GLM review')
  assert.ok(hasHandoffCall(bh, `'/envpack/scripts/podman-vibe.sh'`, ` 'wolfpack-bloodhound' `), 'Mistral review')
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
  // merge-and-state-hygiene (AC16): besides shimPath, the only joins are the worktree shim that
  // certShimPath may pick (a hunt changing the shim) and the probe's `test -f` of that same file.
  assert.deepEqual(joins, ['${wolfpackHome.home}/scripts/podman-vibe.sh', '${worktreePath}/scripts/podman-vibe.sh', '${shq(`${worktreePath}/scripts/podman-vibe.sh'])
  assert.equal((SRC.match(/shq\(shimPath\)/g) || []).length, 3, 'review ×2, implement')
  assert.equal((SRC.match(/shq\(certShim\)/g) || []).length, 2, 'certify ×2 (certShimPath → the pack shim unless the hunt changes the shim)')
  assert.match(SRC, /const certShim = certShimPath\(\{ packShim: shimPath,/, 'the certify shim defaults to shimPath')
  assert.match(SRC, /const tcShim = shimPath\n/, 'toolcheck --shim')
  // the resolver runs right after the pre-scaffold config probe and BEFORE the resume probe (H7 trust boundary)
  const iProbe = SRC.indexOf('projectConfig = await loadProjectConfig(')
  const iResolve = SRC.indexOf('const wolfpackHome = resolveWolfpackHome(')
  const iResume = SRC.indexOf('const resumeProbe = await agent(')
  assert.ok(iProbe > 0 && iProbe < iResolve && iResolve < iResume, `${iProbe} < ${iResolve} < ${iResume}`)
})

// ════════════════════════════════════════════════════════════════════════════
// seat-handoff-writes: review/certify seats write their OWN handoff file into a shim-mounted
// per-seat out dir; the shim delivers it byte-for-byte; the shim agent never re-transcribes it.
// ════════════════════════════════════════════════════════════════════════════

// Evaluate a claude-link constant from the deployed SRC with this harness's planDir and pack
// skills dir (FIXTURE_CONFIG's Wolfpack home), so the prompt can be checked to carry it
// BYTE-EQUAL (the Out list: those texts are unchanged).
const claudeConst = (name, ...callArgs) => {
  const m = SRC.match(new RegExp(`\\nconst ${name} = ([\\s\\S]*?\`)\\n`))
  assert.ok(m, `${name} found in hunt-pipeline.js`)
  return new Function('planDir', 'PACK_SKILLS', `const v = ${m[1]}; return typeof v === 'function' ? v(...arguments[2]) : v`)(PD, '/pack/.agents/skills', callArgs)
}
const ORANGE = { ...BASE.alpha, tier: 'Orange' }
const SHELL_OK = { shell: 'ok', denied_tools: [] }
const GLM_PASS = { verdict: 'PASS', provider: 'glm', status: 'glm', deniedTools: [], toolAccess: SHELL_OK }

test('seat-handoff-writes AC12: ROLE_DENIED_TOOLS = edit/task/skill (no write_file); auditEvidence follows', () => {
  const m = SRC.match(/const ROLE_DENIED_TOOLS = (\[[^\]]*\])/)
  assert.ok(m)
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), ['edit', 'task', 'skill'])
  const body = SRC.match(/const SINGLE_LENS = .*\n/)[0] + SRC.match(/const TIER_CONFIG = \{[\s\S]*?\n\}\n/)[0]
  const helpers = SRC.match(/const ROLE_DENIED_TOOLS = [\s\S]*?\nconst certAuditEvidence = [\s\S]*?\n\}\n/)[0]
  const { auditEvidence, isAuditOnly } = new Function(`${body}\n${helpers}\nreturn { auditEvidence, isAuditOnly }`)()
  assert.deepEqual(auditEvidence({ toolAccess: { shell: 'ok', denied_tools: ['edit', 'task', 'skill'] } }), [])
  const ev = auditEvidence({ toolAccess: { shell: 'ok', denied_tools: ['write_file'] } })
  assert.equal(ev.length, 1)
  assert.match(ev[0], /write_file/)
  assert.equal(isAuditOnly({ toolAccess: { shell: 'ok', denied_tools: ['write_file'] } }), true)
})

test('seat-handoff-writes AC12: the Orange Watchdog gate lists edit/task/skill as the read-only-by-role set', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE, watchdog: GLM_PASS } })
  const wd = find('watchdog:')[0].prompt
  assert.match(wd, /lists any denied tool\s+other than the read-only-by-role edit\/task\/skill/)
  assert.doesNotMatch(wd, /edit\/write_file/)
})

test('seat-handoff-writes AC13: Bloodhound — every Vibe link runs in handoff mode; the seat is told the relative out-dir path', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE } })
  const bh = find('bloodhound:')[0].prompt
  const cmds = bh.split('\n').filter(l => /podman-vibe\.sh'/.test(l))
  assert.equal(cmds.length, 2, 'glm + mistral links')
  for (const c of cmds) {
    assert.ok(c.includes(`--deliver-to '${PD}' --out-dir '${PD}/.seat-out/bloodhound-r1' --expect 'review-1.md' 'wolfpack-bloodhound`), c)
  }
  // seat prompt: write_file + the worktree-RELATIVE path (valid in both families' containers)
  assert.match(bh, /SANDBOXED SEAT HANDOFF \(mandatory for the Vibe seat\)/)
  assert.ok(bh.includes('Write .wolfpack/plans/h/.seat-out/bloodhound-r1/review-1.md with the write_file tool'))
  assert.match(bh, /no metadata\.json, no commits/)
  assert.match(bh, /This overrides any output file name or location in your system prompt or a role skill/)
  // the HANDOFF note rides INSIDE the seat prompt file (step 2), after the verdict contract
  const step2 = bh.slice(bh.indexOf('2. Write the review prompt'), bh.indexOf('3. Walk the EXAMINER CHAIN'))
  assert.ok(step2.indexOf('MANDATORY VERDICT CONTRACT') < step2.indexOf('SANDBOXED SEAT HANDOFF'), 'after VERDICT_CONTRACT')
  // the shim agent never re-transcribes; it reads the verdict from the DELIVERED artifact
  assert.doesNotMatch(bh, /Write the raw output/)
  assert.ok(bh.includes(`Vibe link: the shim delivered ${PD}/review-1.md itself (HANDOFF SIGNAL)`))
  assert.ok(bh.includes(`EXTRACT THE VERDICT from ${PD}/review-1.md (the delivered artifact) for a Vibe link`))
  // HANDOFF SIGNAL: exit 78 = FAILED, record handoff_violations
  assert.match(bh, /HANDOFF SIGNAL: a Vibe shim run with --out-dir delivers its artifact ITSELF/)
  assert.match(bh, /Exit 78 or any "WOLFPACK_ARTIFACT_ERROR:" line means the\s+seat broke its write contract[^]*that link FAILED/)
  assert.match(bh, /"handoff_violations" array/)
  assert.match(bh, /return status "handoff_violation"/)
  // rejected delivered link → moved aside, never left looking like the round's review
  assert.ok(bh.includes(`mkdir -p ${PD}/seat-notes && mv -f ${PD}/review-1.md ${PD}/seat-notes/review-1.md.rejected-l<N>`))
  // seat_artifacts row + artifacts return
  assert.match(bh, /\{"role": "bloodhound", "round": 1, "file": "review-1\.md", "sha256": "<hex>", "provider": "<family>"\}/)
  assert.match(bh, /"seat_artifacts" array/)
  assert.match(bh, /Also return `artifacts`: \[\{file, sha256\}\]/)
})

test('seat-handoff-writes AC14: the Bloodhound grounding line goes to the seat-notes sidecar, never into review-N.md', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE } })
  const bh = find('bloodhound:')[0].prompt
  const e = bh.slice(bh.indexOf('e. Write the grounding line'), bh.indexOf('6.5 FINGERPRINT'))
  assert.ok(e.length > 0)
  assert.ok(e.includes(`to\n      ${PD}/seat-notes/review-1.md (mkdir -p ${PD}/seat-notes; overwrite)`), e)
  assert.ok(e.includes(`NEVER add it\n      to ${PD}/review-1.md`), e)
  assert.doesNotMatch(bh, /(prepend|FIRST line)[^\n]*review-1\.md/i)
})

test('seat-handoff-writes AC13: Pointer — handoff args on every Vibe link, out dir pointer-r<N>, relative seat path', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE, pointer: issuesThenApprove,
    'shepherd-rewrite': { findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true } } })
  const ptrs = find('pointer:')
  assert.equal(ptrs.length, 2)
  for (const [i, c] of ptrs.entries()) {
    const n = i + 1
    const cmds = c.prompt.split('\n').filter(l => /podman-vibe\.sh'/.test(l))
    assert.equal(cmds.length, 2, `r${n}: glm + mistral`)
    for (const l of cmds) assert.ok(l.includes(`--deliver-to '${PD}' --out-dir '${PD}/.seat-out/pointer-r${n}' --expect 'pointer-review-${n}.md' 'wolfpack-pointer`), l)
    assert.ok(c.prompt.includes(`Write .wolfpack/plans/h/.seat-out/pointer-r${n}/pointer-review-${n}.md with the write_file tool`))
    assert.doesNotMatch(c.prompt, /Write the raw output/)
    assert.match(c.prompt, /HANDOFF SIGNAL:/)
    assert.ok(c.prompt.includes(`${PD}/seat-notes/pointer-review-${n}.md`), 'grounding sidecar')
  }
  // AC14 / 4i: the Shepherd rework prompt points at the sidecar
  const rw = find('shepherd-rewrite')[0].prompt
  assert.ok(rw.includes(`Read ${PD}/pointer-review-1.md for full context on each finding\n(pipeline notes, if any: ${PD}/seat-notes/pointer-review-1.md).`), rw)
})

test('seat-handoff-writes 4i: the Alpha revise prompt lists the Bloodhound sidecar next to review-N.md', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE,
    bloodhound: (_p, _o, n) => (n === 1
      ? { verdict: 'ISSUES_FOUND', findings: 1, findingsList: [FINDING], provider: 'glm', status: 'glm' }
      : { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'glm', status: 'glm' }),
    'alpha-revise': { findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true } } })
  const rv = find('alpha-revise')
  assert.ok(rv.length >= 1, 'a revise ran')
  assert.ok(rv[0].prompt.includes(`- ${PD}/review-1.md (Bloodhound findings for this round)\n- ${PD}/seat-notes/review-1.md (pipeline notes on that review: grounding, dropped findings, audit-only — if present)`), rv[0].prompt)
})

test('seat-handoff-writes 4i: the GLM Shepherd rework prompt also points at the Pointer sidecar', async () => {
  const { find } = await runHunt({ answers: { 'shepherd-seat': GLM_SEAT, pointer: issuesThenApprove,
    'shepherd-glm': (p) => (/addressing Pointer code-review round/.test(p)
      ? { outcome: 'done', exitCode: 0, changedFiles: ['app/x.py'], committed: true, findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true }
      : { outcome: 'done', exitCode: 0, changedFiles: ['app/x.py'], committed: true }) } })
  const rw = find('shepherd-glm').map(c => c.prompt).find(p => /addressing Pointer code-review round 1/.test(p))
  assert.ok(rw, 'the GLM rework ran')
  assert.ok(rw.includes(`${PD}/pointer-review-1.md (pipeline notes, if any: ${PD}/seat-notes/pointer-review-1.md).`))
})

test('seat-handoff-writes AC13: the claude last-resort review texts are byte-equal to their constants', async () => {
  // GLM Shepherd → Pointer chain = mistral → claude (last resort)
  const { find } = await runHunt({ answers: { 'shepherd-seat': GLM_SEAT } })
  const ptr = find('pointer:')[0].prompt
  assert.ok(ptr.includes(claudeConst('CLAUDE_SELF_REVIEW_STEP', '/tmp/pointer-h-r1.txt', 'pointer')), 'CLAUDE_SELF_REVIEW_STEP verbatim')
  // the claude link line carries no handoff args (it is not a shim)
  const claudeLine = ptr.split('\n').find(l => /CLAUDE|Claude \(last resort\)/.test(l) && /\[\d\]/.test(l))
  assert.ok(claudeLine && !/--deliver-to/.test(claudeLine), claudeLine)
  // only the mistral link is a shim call, and it carries the handoff args
  const cmds = ptr.split('\n').filter(l => /podman-vibe\.sh'/.test(l))
  assert.equal(cmds.length, 1)
  assert.match(cmds[0], /--deliver-to [^\n]*'wolfpack-pointer' /)
  // claude-link step 5 governs its own save, and the HANDOFF note is scoped to Vibe links
  assert.ok(ptr.includes(`claude link: save your review to ${PD}/pointer-review-1.md.`))
  assert.match(ptr, /SANDBOXED SEAT HANDOFF note in the review prompt applies only to Vibe links/)
})

test('seat-handoff-writes AC13: the claude FINAL review round keeps CLAUDE_FINAL_SELF_REVIEW_STEP byte-equal and runs no shim', async () => {
  const { find } = await runHunt({ answers: { alpha: { ...BASE.alpha, tier: 'Red', pointerRounds: 3 }, 'shepherd-seat': OFFLOAD_SEAT, pointer: pointerBy() } })
  const fin = find('pointer:')[1].prompt
  assert.ok(fin.includes(claudeConst('CLAUDE_FINAL_SELF_REVIEW_STEP', '/tmp/pointer-h-r2.txt')), 'CLAUDE_FINAL_SELF_REVIEW_STEP verbatim')
  assert.doesNotMatch(fin, /podman-vibe\.sh/)
  assert.doesNotMatch(fin, /--deliver-to/)
})

test('seat-handoff-writes AC13: Watchdog — both Vibe certify commands deliver certification.md + pedigree.json from watchdog-r0', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE, watchdog: GLM_PASS } })
  const wd = find('watchdog:')[0].prompt
  const cmds = wd.split('\n').filter(l => /podman-vibe\.sh'/.test(l))
  assert.equal(cmds.length, 2)
  for (const l of cmds) {
    assert.ok(l.includes(`--deliver-to '${PD}' --out-dir '${PD}/.seat-out/watchdog-r0' --expect 'certification.md' --expect 'pedigree.json' wolfpack-watchdog`), l)
  }
  assert.ok(wd.includes('Write .wolfpack/plans/h/.seat-out/watchdog-r0/certification.md and .wolfpack/plans/h/.seat-out/watchdog-r0/pedigree.json with the write_file tool'))
  assert.match(wd, /Do NOT append to \.wolfpack\/pedigree\/index\.md, run scripts, commit or update metadata\.json — the pipeline does that after you\./)
  // the shim agent no longer authors the files from stdout
  assert.doesNotMatch(wd, /YOU write certification\.md \/ pedigree\.json from it/)
  assert.doesNotMatch(wd, /is read-only \(--enabled-tools\), so YOU/)
  assert.match(wd, /writes certification\.md \+ pedigree\.json itself; the shim delivers them byte-for-byte \(HANDOFF SIGNAL\)\. Do NOT write, edit or re-create either file for this link\./)
  assert.match(wd, /HANDOFF SIGNAL:/)
  // step 4 reads the verdict from the delivered file; a rejected / partially-delivered link is moved aside (both files)
  assert.ok(wd.includes(`If ${PD}/certification.md exists (the shim delivered it, or the claude link wrote it), read the verdict from the file`))
  assert.ok(wd.includes(`for f in certification.md pedigree.json; do [ ! -e ${PD}/$f ] || mv -f ${PD}/$f ${PD}/seat-notes/$f.rejected-l<N>; done`))
  // seat_artifacts rows for both files + artifacts return
  assert.match(wd, /\{"role": "watchdog", "round": 0, "file": "certification\.md" \| "pedigree\.json", "sha256": "<hex>", "provider": "<family>"\}/)
  assert.match(wd, /Also return `artifacts`:/)
})

test('seat-handoff-writes P10: the Watchdog SEAT prompt no longer commits or appends the pedigree index; step 4.6 (the shim agent) does', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE, watchdog: GLM_PASS } })
  const wd = find('watchdog:')[0].prompt
  const seat = wd.slice(wd.indexOf('2. Write the Watchdog prompt'), wd.indexOf('3. Walk the CERTIFIER CHAIN'))
  assert.ok(seat.length > 0)
  assert.doesNotMatch(seat, /git commit/)
  assert.doesNotMatch(seat, /If PASS: append/)
  assert.doesNotMatch(seat, /Write certification\.md to /)
  assert.doesNotMatch(seat, /Update [^\n]*metadata\.json with verdict/)
  assert.match(seat, /SAFETY: No git push\. No deploy commands\./, 'the SAFETY line stays')
  const s46 = wd.slice(wd.indexOf('4.6 PASS-ONLY ACTIONS'), wd.indexOf('5. If a link failed'))
  assert.match(s46, /YOU, the shim agent — never the certifier seat/)
  // scripts-unfork: the lessons aggregator is the PACK's, run with cwd = the worktree
  // consolidation-acceptance: the index row goes through the validating writer (never by hand), then the lessons aggregator
  assert.match(s46, /write the\s+\.wolfpack\/pedigree\/index\.md row with the validating writer \(cwd = the worktree\) — NEVER by hand/)
  assert.ok(s46.includes(`node '/pack/scripts/wolfpack-pedigree.mjs' index-row --plan-dir '${PD}' --index .wolfpack/pedigree/index.md --date "$(date -u +%F)" --duration "<DURATION from step 8>"`))
  assert.match(s46, /If it exits 0, run\s+`bash '\/pack\/scripts\/wolfpack-lessons\.sh'` \(cwd = the worktree\), then commit/)
  assert.doesNotMatch(s46, /append to\s+\.wolfpack\/pedigree\/index\.md/)
  assert.doesNotMatch(s46, /\.\/scripts\/wolfpack-lessons/)
  assert.ok(s46.includes('FIRST `cd /repo/.agents/worktrees/h`'))
  assert.match(s46, /NEVER `git add \.` \/ `git add -A` \/ `git add -f`\. NEVER stage certification\.md or\s+metadata\.json/)
  assert.match(s46, /only if\s+4\.5 allows it/)
  // 4.6 sits after the 4.5 gate
  assert.ok(wd.indexOf('4.5 AUDIT-ONLY GATE') < wd.indexOf('4.6 PASS-ONLY ACTIONS'))
})

test('seat-handoff-writes 4f: the HEAVY 4.5 gate keeps delivered Vibe files byte-identical (no unconditional "Still write certification.md")', async () => {
  for (const tier of ['Orange', 'Red']) {
    const { find } = await runHunt({ answers: { alpha: { ...BASE.alpha, tier }, watchdog: GLM_PASS } })
    const wd = find('watchdog:')[0].prompt
    assert.doesNotMatch(wd, /Still write\s+certification\.md, and return/, tier)
    assert.match(wd, /a delivered Vibe link's\s+certification\.md \/ pedigree\.json stay byte-identical/, tier)
    assert.match(wd, /Still write\s+certification\.md if the claude link produced the verdict/, tier)
  }
})

test('seat-handoff-writes [debrief]: a Watchdog chain WITH a claude link tells it to write straight to the plan dir; CLAUDE_SELF_CERTIFY_STEP stays byte-equal', async () => {
  const { find } = await runHunt({ answers: {
    alpha: ORANGE, 'shepherd-seat': OFFLOAD_SEAT,
    tracker: { verdict: 'TESTS_PASS', provider: 'mistral' },
    pointer: { ...BASE.pointer, provider: 'mistral' },
    watchdog: { verdict: 'PASS', provider: 'claude', deniedTools: [], toolAccess: SHELL_OK },
  } })
  const wd = find('watchdog:')[0].prompt
  assert.match(wd, /Claude \(last resort\)/)
  const at = wd.indexOf('claude link: the SANDBOXED SEAT HANDOFF note')
  assert.ok(at >= 0, 'the claude-link branch sentence is present')
  const slice = wd.slice(at, wd.indexOf('\n\n', at))
  assert.match(slice, /does NOT apply to you/)
  assert.ok(slice.includes(`${PD}/certification.md`) && slice.includes(`${PD}/pedigree.json`), slice)
  assert.doesNotMatch(slice, /\.seat-out\/watchdog-r0/)
  assert.ok(wd.includes(claudeConst('CLAUDE_SELF_CERTIFY_STEP')), 'CLAUDE_SELF_CERTIFY_STEP verbatim')
  assert.ok(wd.includes('This link IS you — follow the step above and write certification.md / pedigree.json yourself.'))
  // claude-only chain → no shim command at all
  assert.doesNotMatch(wd, /podman-vibe\.sh'/)
})

test('seat-handoff-writes [debrief]: a Vibe-only Watchdog chain carries NO claude-link branch sentence', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE, watchdog: GLM_PASS } })
  assert.doesNotMatch(find('watchdog:')[0].prompt, /claude link: the SANDBOXED SEAT HANDOFF note/)
})

test('seat-handoff-writes AC14: noteAuditOnly writes the seat-notes sidecar and never touches the artifact', async () => {
  const { find, logs } = await runHunt({ answers: {
    pointer: { ...BASE.pointer, deniedTools: [], toolAccess: { shell: 'denied', denied_tools: ['bash'] } } } })
  const rec = auditRecords(find, 'pointer')
  assert.equal(rec.length, 1)
  const p = rec[0].prompt
  assert.ok(p.includes(`Append this line to ${PD}/seat-notes/pointer-review-1.md (mkdir -p ${PD}/seat-notes; create the file if absent)`), p)
  assert.ok(p.includes(`Do NOT modify ${PD}/pointer-review-1.md — it is the seat's byte-identical handoff`))
  assert.doesNotMatch(p, /FIRST line of/)
  assert.match(p, /> audit_only: true — pointer r1 \(mistral\) ran without a working shell/)
  assert.ok(logs.some(l => l.includes(`noting it in ${PD}/seat-notes/pointer-review-1.md`)), logs.join('\n'))
  // Watchdog: the sidecar is seat-notes/certification.md
  const w = await runHunt({ answers: { watchdog: AUDIT_PASS } })
  const wr = auditRecords(w.find, 'watchdog')[0].prompt
  assert.ok(wr.includes(`${PD}/seat-notes/certification.md`))
  assert.doesNotMatch(wr, /FIRST line of/)
})

test('seat-handoff-writes 4h: the accepted results log the artifacts the shim delivered (or why none were reported)', async () => {
  const arts = (f) => [{ file: f, sha256: 'abcdef0123456789abcdef' }]
  const { logs } = await runHunt({ answers: {
    bloodhound: { ...BASE.bloodhound, artifacts: arts('review-1.md') },
    pointer: { ...BASE.pointer, artifacts: [] },
    watchdog: { ...BASE.watchdog, artifacts: [...arts('certification.md'), { file: 'pedigree.json', sha256: '0011223344556677' }] },
  } })
  assert.ok(logs.includes('✓ h: bloodhound r1 artifacts delivered by the shim: review-1.md abcdef012345'), logs.join('\n'))
  assert.ok(logs.includes('✓ h: pointer r1 artifacts delivered by the shim: (artifacts not reported by the shim agent)'), logs.join('\n'))
  assert.ok(logs.includes('✓ h: watchdog r0 artifacts delivered by the shim: certification.md abcdef012345, pedigree.json 001122334455'), logs.join('\n'))
  // a claude-provider result with no artifacts says the claude link wrote them
  const c = await runHunt({ answers: { 'shepherd-seat': GLM_SEAT, pointer: { ...BASE.pointer, provider: 'claude', artifacts: [] } } })
  assert.ok(c.logs.includes('✓ h: pointer r1 artifacts delivered by the shim: (claude link wrote them)'), c.logs.join('\n'))
})

test('seat-handoff-writes 4h: REVIEW_SCHEMA and VERDICT_SCHEMA carry the artifacts array', () => {
  for (const name of ['REVIEW_SCHEMA', 'VERDICT_SCHEMA']) {
    const m = SRC.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\}\\n`))
    assert.ok(m, name)
    assert.match(m[0], /artifacts: \{ type: 'array', items: \{ type: 'object', properties: \{ file: \{ type: 'string' \}, sha256: \{ type: 'string' \} \} \} \}/, name)
  }
})

test('workflow-meta-runtime (3): an agent-reported plan dir that differs is WARNED and IGNORED (the computed one is used)', async () => {
  const { find, logs, calls } = await runHunt({ answers: { scaffold: { worktreePath: WT, planDir: '/elsewhere/.wolfpack/plans/h' } } })
  assert.ok(logs.some(l => /WARNING[\s\S]*\/elsewhere\/\.wolfpack\/plans\/h[\s\S]*\/repo\/\.agents\/worktrees\/h\/\.wolfpack\/plans\/h/.test(l)), logs.join('\n'))
  const bh = find('bloodhound:')
  assert.ok(bh.length > 0)
  for (const c of bh) assert.ok(c.prompt.includes(`--deliver-to '${PD}'`), c.label)
  // nothing the pipeline sent to any seat or writer names the reported (wrong) dir
  for (const c of calls) assert.ok(!c.prompt.includes('/elsewhere'), `${c.label} leaked the reported plan dir`)
})

test('workflow-meta-runtime (3): the resume path computes the plan dir too (a differing reported value is WARNED and IGNORED)', async () => {
  const probe = { fresh: false, status: 'test_rewrite_needed', resumePhase: 'Implement', tier: 'Yellow',
    worktreePath: WT, planDir: '/elsewhere/.wolfpack/plans/h', worktreeExists: true, branchExists: true, trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }
  const { logs, calls, find } = await runHunt({ answers: { 'resume-probe': probe } })
  assert.ok(logs.some(l => /WARNING[\s\S]*resume probe[\s\S]*\/elsewhere\/\.wolfpack\/plans\/h[\s\S]*\/repo\/\.agents\/worktrees\/h\/\.wolfpack\/plans\/h/.test(l)), logs.join('\n'))
  for (const c of calls) assert.ok(!c.prompt.includes('/elsewhere'), `${c.label} leaked the reported plan dir`)
  assert.ok(find('pointer:')[0].prompt.includes(PD), 'the computed plan dir reaches the seat prompt')
})

test('workflow-meta-runtime (3): a matching (or omitted) reported plan dir logs no WARNING and the computed dir is used', async () => {
  for (const planDir of [PD, `${PD}/`, undefined]) {
    const { logs, find } = await runHunt({ answers: { scaffold: { worktreePath: WT, ...(planDir === undefined ? {} : { planDir }) } } })
    assert.equal(logs.some(l => /reported plan dir/.test(l)), false, `${planDir}: ${logs.join('\n')}`)
    assert.ok(find('bloodhound:')[0].prompt.includes(`--deliver-to '${PD}'`), String(planDir))
  }
})

test('workflow-meta-runtime (3): a trailing-slash reported worktreePath is normalized — no seat-handoff park, computed plan dir reaches the seat', async () => {
  const { find, logs, result } = await runHunt({ answers: { scaffold: { worktreePath: WT + '/', planDir: PD } } })
  assert.ok(find('bloodhound:').length > 0, 'reaches the Bloodhound seat')
  for (const c of find('bloodhound:')) assert.ok(c.prompt.includes(`--deliver-to '${PD}'`), c.label)
  assert.equal(logs.some(l => /not inside the worktree/.test(l)), false, logs.join('\n'))
  assert.notEqual(result?.verdict, 'PARKED_REVIEW_ERROR')
})

test('workflow-meta-runtime AC5: runtimeMetaRefs keeps a meta ref after a // inside a string/template literal', () => {
  assert.ok(runtimeMetaRefs('const a = `x // y ${meta.name}`').length > 0)
  assert.ok(runtimeMetaRefs("const a = 'x // y'; const b = meta.name").length > 0)
  assert.equal(runtimeMetaRefs('// meta\nconst a = 1 /* meta */').length, 0)
})

test('workflow-meta-runtime (3): the source never adopts an agent-reported plan dir', () => {
  assert.doesNotMatch(SRC, /scaffold\.planDir \|\|/)
  assert.doesNotMatch(SRC, /resumeProbe\.planDir \|\|/)
})

test('seat-handoff-writes AC13 (lens): a two-lens review gives each lens its own out dir and artifact name', async () => {
  const lensSrc = SRC.replace("const SINGLE_LENS = [{ key: 'full', focus: '' }]",
    "const SINGLE_LENS = [{ key: 'sec', focus: 'security' }, { key: 'perf', focus: 'performance' }]")
  assert.notEqual(lensSrc, SRC, 'the lens substitution applied')
  const { find } = await runHunt({ src: lensSrc, answers: { alpha: ORANGE } })
  const bh = find('bloodhound:')
  assert.equal(bh.length, 2, 'one shim agent per lens')
  for (const key of ['sec', 'perf']) {
    const p = bh.find(c => c.label.includes(`:${key}`)).prompt
    for (const l of p.split('\n').filter(x => /podman-vibe\.sh'/.test(x))) {
      assert.ok(l.includes(`--out-dir '${PD}/.seat-out/bloodhound-r1-${key}' --expect 'review-1-${key}.md'`), l)
    }
    assert.ok(p.includes(`Write .wolfpack/plans/h/.seat-out/bloodhound-r1-${key}/review-1-${key}.md with the write_file tool`))
    assert.ok(p.includes(`${PD}/seat-notes/review-1-${key}.md`))
  }
})

// ════════════════════════════════════════════════════════════════════════════
// pack-install-model (AC5, AC8): the run-start stamp check, the Worktree root key, and
// host-side role skills read from the PACK. A STAMPED source is produced by the REAL generator
// (render), so the script under test is byte-for-byte what a consumer's copy would run.
// ════════════════════════════════════════════════════════════════════════════
import { render as renderWorkflow } from './wolfpack-workflows.mjs'
const CANON_HP = readFileSync(join(here, '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
const SRC_STAMP = { workflow: 'hunt-pipeline.js', commit: 'b'.repeat(40), version: 'v0.2.0-1-gbbbbbbb', source: `sha256:${'5'.repeat(64)}` }
const stampedSrc = (stamp = SRC_STAMP) => stripMeta(renderWorkflow(CANON_HP, stamp))
// The default FIXTURE_CONFIG has a deploy step, so a run that gets all the way through ends
// awaiting_user_deploy (Verify surfaces the deploy).
const NO_STATE = () => {
  const ran = []
  const rec = (l) => () => { ran.push(l); return {} }
  return { ran, answers: { 'resume-probe': rec('resume-probe'), scaffold: rec('scaffold'), spec: rec('spec'), 'toolcheck-preflight': rec('toolcheck-preflight') } }
}

test('AC5 stamped-current: a stamped run whose source equals the pack\'s logs the version line and proceeds', async () => {
  const { result, logs, find } = await runHunt({ src: stampedSrc(), answers: {
    'workflow-stamp': stampAnswer({ hunt: 'current', canonicalSource: SRC_STAMP.source, huntExtra: { stamp: SRC_STAMP } }) } })
  assert.equal(result.status, 'awaiting_user_deploy', JSON.stringify(result))
  assert.ok(logs.some(l => l === `Workflow version: hunt-pipeline.js v0.2.0-1-gbbbbbbb @ bbbbbbbbbbbb (source sha256:555555555555…) — current against the pack at /pack`), logs.join('\n'))
  assert.equal(find('resume-probe:').length, 1)
  const probe = find('workflow-stamp:')[0]
  assert.equal(probe.opts.model, 'sonnet')
  assert.equal(probe.opts.phase, 'Scaffold')
  assert.deepEqual(probe.opts.schema.required, ['exitCode', 'output', 'cwd'])
  assert.match(probe.prompt, /READ-ONLY workflow stamp probe — modify nothing/)
  assert.ok(probe.prompt.includes(`node '/pack/scripts/wolfpack-workflows.mjs' check --pack '/pack' --consumer "$(pwd)" --json 2>&1; echo "STAMP_RC=$?"`))
})

test('AC5 canonical-self: the UNSTAMPED canonical with its entry canonical logs the canonical version line and proceeds', async () => {
  const { result, logs } = await runHunt()
  assert.equal(result.status, 'awaiting_user_deploy')
  assert.ok(logs.some(l => l === 'Workflow version: hunt-pipeline.js canonical — pack v0.2.0-1-gaaaaaaa @ aaaaaaaaaaaa (/repo/.claude/workflows/hunt-pipeline.js)'), logs.join('\n'))
})

test('AC5 stale: a stamped run whose source differs and the copy is stale → rejects with the file + install.sh fix; NO resume-probe / scaffold', async () => {
  const { ran, answers } = NO_STATE()
  await assert.rejects(runHunt({ src: stampedSrc(), answers: { ...answers, 'workflow-stamp': stampAnswer({ hunt: 'stale' }) } }), (e) => {
    assert.match(e.message, /^hunt-pipeline: h: STALE WORKFLOW — this run is hunt-pipeline\.js v0\.2\.0-1-gbbbbbbb @ bbbbbbbbbbbb, but the pack's canonical hunt-pipeline\.js has changed\./)
    assert.ok(e.message.includes("/repo/.claude/workflows/hunt-pipeline.js is stale. Fix: bash '/pack/install.sh' --consumer '/repo', then restart Claude Code and relaunch."), e.message)
    return true
  })
  assert.deepEqual(ran, [])
})

test('AC5 session cache: source differs but the copy on disk is already current → the message says restart Claude Code (cached copy)', async () => {
  const { ran, answers } = NO_STATE()
  await assert.rejects(runHunt({ src: stampedSrc(), answers: { ...answers, 'workflow-stamp': stampAnswer({ hunt: 'current' }) } }),
    /STALE WORKFLOW .*\/repo\/\.claude\/workflows\/hunt-pipeline\.js is already regenerated: this session is running a CACHED older copy — restart Claude Code \(named workflows are cached per session\) and relaunch\./)
  assert.deepEqual(ran, [])
})

test('AC5 stamp-intact but the copy is modified / unstamped / missing → rejects naming the state + the install fix + restart; nothing runs', async () => {
  for (const state of ['modified', 'unstamped', 'missing', 'foreign-link']) {
    const { ran, answers } = NO_STATE()
    await assert.rejects(runHunt({ src: stampedSrc(), answers: { ...answers, 'workflow-stamp': stampAnswer({ hunt: state, canonicalSource: SRC_STAMP.source }) } }), (e) => {
      assert.ok(e.message.startsWith(`hunt-pipeline: h: /repo/.claude/workflows/hunt-pipeline.js is ${state} — its stamp matches the pack but the copy on disk is not the generated bytes.`), `${state}: ${e.message}`)
      assert.ok(e.message.includes("Fix: bash '/pack/install.sh' --consumer '/repo', then restart Claude Code (named workflows are cached per session) and relaunch."), e.message)
      return true
    })
    assert.deepEqual(ran, [], state)
  }
})

test('AC5 the unstamped canonical running where the consumer copy is NOT the canonical (missing / current / stale) → throws with the fix', async () => {
  for (const state of ['missing', 'current', 'stale', 'unstamped']) {
    const { ran, answers } = NO_STATE()
    await assert.rejects(runHunt({ answers: { ...answers, 'workflow-stamp': stampAnswer({ hunt: state }) } }),
      new RegExp(`hunt-pipeline: h: this run is the UNSTAMPED canonical hunt-pipeline\\.js but /repo/\\.claude/workflows/hunt-pipeline\\.js is ${state} — fix: .*restart Claude Code`))
    assert.deepEqual(ran, [], state)
  }
})

test('AC5 fail closed: a null / exit-2 / garbled / workflows-less / self-less probe answer THROWS with freshness UNKNOWN; nothing runs', async () => {
  const self = stampResult()
  self.workflows = self.workflows.filter(w => w.name !== 'hunt-pipeline.js')
  const cases = [
    [null, /the workflow stamp probe returned no result — workflow freshness UNKNOWN; relaunch/],
    [{ exitCode: 2, output: '✗ wolfpack-workflows check: cannot read the pack version' }, /the workflow stamp check failed \(exit 2\) — workflow freshness UNKNOWN: ✗ wolfpack-workflows check: cannot read the pack version\. Fix: run node '\/pack\/scripts\/wolfpack-workflows\.mjs' check/],
    [{ exitCode: '0', output: JSON.stringify(stampResult()) }, /the workflow stamp check failed \(exit 0\)/],
    [{ exitCode: 0, output: 'garbled' }, /held no checker result \(no workflows\[\] array\) — workflow freshness UNKNOWN: garbled/],
    [{ exitCode: 0, output: '{"ok":true' }, /held no checker result/],
    [{ exitCode: 0, output: JSON.stringify({ ok: true, workflows: 'x' }) }, /held no checker result/],
    [{ exitCode: 0, output: JSON.stringify(self) }, /the workflow stamp check did not report hunt-pipeline\.js — workflow freshness UNKNOWN/],
    [{}, /the workflow stamp check failed \(exit undefined\)/],
  ]
  for (const [ans, re] of cases) {
    const { ran, answers } = NO_STATE()
    await assert.rejects(runHunt({ answers: { ...answers, 'workflow-stamp': () => ans } }), re, JSON.stringify(ans))
    assert.deepEqual(ran, [], JSON.stringify(ans))
  }
  // a banner before the JSON and exit 1 (some OTHER workflow drifted) still parses and proceeds
  const { result } = await runHunt({ answers: { 'workflow-stamp': { exitCode: 1, output: `relayed:\n${JSON.stringify(stampResult({ runner: 'stale' }))}\n`, cwd: '/repo' } } })
  assert.equal(result.status, 'awaiting_user_deploy', 'only THIS script\'s own entry decides the hunt')
})

test('AC8: no Worktree root in the config → throws with the key fix BEFORE the stamp probe or any resume-probe', async () => {
  for (const cfg of [{ ...FIXTURE_CONFIG, worktreeRoot: null }, (({ worktreeRoot, ...rest }) => rest)(FIXTURE_CONFIG), { ...FIXTURE_CONFIG, worktreeRoot: '' }]) {
    const { ran, answers } = NO_STATE()
    const stampRan = []
    await assert.rejects(runHunt({ answers: { ...answers, 'project-config': configAnswer(cfg), 'workflow-stamp': () => { stampRan.push(1); return stampAnswer() } } }), (e) => {
      assert.match(e.message, /^hunt-pipeline: h: wolfpack-config\.md has no Worktree root — the pipeline will not guess where hunt worktrees live\. Fix: add "- \*\*Worktree root:\*\* `<dir>`" under ## Project Identity/)
      assert.match(e.message, /check: node <pack>\/scripts\/wolfpack-config\.mjs --json$/)
      return true
    })
    assert.deepEqual([...ran, ...stampRan], [])
  }
})

test('AC8: a malformed relayed Worktree root (`../x`, `/abs`, `a b`, `.git/x`) throws (fail closed on a garbled relay)', async () => {
  for (const v of ['../x', '/abs', 'a b', '.git/x', './x', '~/w']) {
    const { ran, answers } = NO_STATE()
    await assert.rejects(runHunt({ answers: { ...answers, 'project-config': configAnswer({ ...FIXTURE_CONFIG, worktreeRoot: v }) } }),
      new RegExp(`Worktree root '${v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}' is not a repo-relative path`))
    assert.deepEqual(ran, [], v)
  }
})

test('AC8: a non-default root `.wt/hunts` reaches the resume probe, the scaffold, the repo-root split and the Watchdog staging rules', async () => {
  const wt = '/repo/.wt/hunts/h'
  const { result, find, logs } = await runHunt({ answers: {
    'project-config': configAnswer({ ...FIXTURE_CONFIG, worktreeRoot: '.wt/hunts' }),
    scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  assert.equal(result.status, 'awaiting_user_deploy', JSON.stringify(result))
  assert.ok(logs.includes('Worktree root: .wt/hunts (wolfpack-config.md → Project Identity)'), logs.join('\n'))
  const resume = find('resume-probe:')[0].prompt
  assert.ok(resume.includes('REPO/.wt/hunts/h; its plan dir is'), resume)
  assert.ok(resume.includes('worktreePath: absolute REPO/.wt/hunts/h'))
  const scaffold = find('scaffold:')[0].prompt
  assert.ok(scaffold.includes('git worktree add .wt/hunts/h -b feat/h'))
  assert.ok(scaffold.includes('git worktree add .wt/hunts/h feat/h'))
  assert.ok(scaffold.includes('mkdir -p .wt/hunts/h/.wolfpack/plans/h/'))
  assert.ok(scaffold.includes('git worktree remove --force .wt/hunts/h'))
  assert.doesNotMatch(scaffold, /\.agents\/worktrees/)
  assert.ok(logs.includes('Repo root: /repo'), logs.join('\n'))
  const wd = find('watchdog:')[0].prompt
  assert.ok(wd.includes('NEVER\n       stage a path that begins with `.wt/hunts/`'), 'Watchdog staging rule uses the configured root')
  for (const c of [...find('resume-probe:'), ...find('scaffold:'), ...find('watchdog:')]) assert.doesNotMatch(c.prompt, /\.agents\/worktrees/, c.label)
})

test('AC8: `.claude/worktrees` (a dot-segment root, the consumer value) is accepted and splits the repo root', async () => {
  const wt = '/repo/.claude/worktrees/h'
  const { result, logs, find } = await runHunt({ answers: {
    'project-config': configAnswer({ ...FIXTURE_CONFIG, worktreeRoot: '.claude/worktrees' }),
    scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  assert.equal(result.status, 'awaiting_user_deploy')
  assert.ok(logs.includes('Repo root: /repo'), logs.join('\n'))
  assert.ok(find('scaffold:')[0].prompt.includes('git worktree add .claude/worktrees/h -b feat/h'))
})

test('D6: host-side seats read their role skill from the PACK (/pack/.agents/skills/<role>/SKILL.md); container seats keep the checkout path + the seat-profile note', async () => {
  const { find } = await runHunt()
  const expect = [['spec', 'spec'], ['alpha:', 'alpha'], ['shepherd:', 'shepherd'], ['tracker:', 'tracker']]
  for (const [label, role] of expect) {
    const c = find(label)[0]
    assert.ok(c, label)
    assert.ok(c.prompt.includes(`/pack/.agents/skills/${role}/SKILL.md`), `${label} reads the pack skill`)
    assert.doesNotMatch(c.prompt, /read your full instructions at \.agents\/skills\//, label)
  }
  assert.ok(find('alpha:')[0].prompt.includes('Follow /pack/.agents/skills/alpha/SKILL.md § Model Pool Selection.'))
  assert.ok(find('watchdog:')[0].prompt.includes('Read /pack/.agents/skills/watchdog/SKILL.md for the full Watchdog instructions.'))
  for (const label of ['bloodhound:', 'pointer:']) {
    assert.match(find(label)[0].prompt, /Read \.agents\/skills\/(bloodhound|pointer)\/SKILL\.md \(if present in this checkout; otherwise your seat profile carries the role\) and follow it\./, label)
  }
  // the GLM Shepherd seat reads the worktree's copy with the same note
  const glm = await runHunt({ answers: { 'shepherd-seat': { shepherdPin: 'glm:5.3', complianceCritical: false, shepherdFamilies: [] } } })
  assert.ok(glm.find('shepherd-glm')[0].prompt.includes(`${WT}/.agents/skills/shepherd/SKILL.md (if present in this checkout; otherwise your seat profile carries the role)`))
})

test('AC7: no workflow names the retired sync-runtime script; both carry exactly one null stamp line and identical stamp/root helpers', () => {
  const RUN = readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
  for (const [n, s] of [['hunt-pipeline.js', CANON_HP], ['campaign-runner.js', RUN]]) {
    assert.ok(!s.includes(RETIRED_SYNC), n)
    assert.doesNotMatch(s, /\$\{repoRoot\}\/scripts\/podman-vibe/, n)
    assert.equal(s.match(/^const WOLFPACK_STAMP = null \/\/ wolfpack-stamp\b.*$/gm).length, 1, n)
  }
  const body = (src, re) => { const m = re.exec(src); assert.ok(m, String(re)); return m[0] }
  const stampRe = /const checkWorkflowStamp = async \(who, label, phaseName\) => \{\n[\s\S]*?\n\}\n/
  const rootRe = /const requireWorktreeRoot = \(who, value\) => \{\n[\s\S]*?\n\}\n/
  assert.equal(body(CANON_HP, stampRe), body(RUN, stampRe), 'checkWorkflowStamp identical')
  assert.equal(body(CANON_HP, rootRe), body(RUN, rootRe), 'requireWorktreeRoot identical')
})

// ════════════════════════════════════════════════════════════════════════════
// pack-install-model × seat-handoff-writes — the rebase conflict resolutions (human-notes
// 2026-10-20). Each hunk kept BOTH hunts' text; these pin that the merged prompts carry both
// halves together, so a later conflict resolution cannot silently drop either side.
// ════════════════════════════════════════════════════════════════════════════

const SEAT_NOTE = '(if present in this checkout; otherwise your seat profile carries the role)'

test('rebase hunk 3: one Bloodhound prompt carries the skill-read note AND the handoff write instruction', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE } })
  const bh = find('bloodhound:')[0].prompt
  assert.ok(bh.includes(`Read .agents/skills/bloodhound/SKILL.md ${SEAT_NOTE} and follow it.`), 'pack-install-model half')
  assert.match(bh, /SANDBOXED SEAT HANDOFF \(mandatory for the Vibe seat\)/, 'seat-handoff-writes half (HANDOFF_NOTE)')
  assert.ok(bh.includes('Write .wolfpack/plans/h/.seat-out/bloodhound-r1/review-1.md with the write_file tool'))
  // the old unannotated read must not survive next to the annotated one
  assert.doesNotMatch(bh, /Read \.agents\/skills\/bloodhound\/SKILL\.md and follow it/)
})

test('rebase hunk 3: every Pointer round prompt carries the skill-read note AND its own handoff out dir', async () => {
  const { find } = await runHunt({ answers: { alpha: ORANGE, pointer: issuesThenApprove,
    'shepherd-rewrite': { findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true } } })
  const ptrs = find('pointer:')
  assert.equal(ptrs.length, 2)
  for (const [i, c] of ptrs.entries()) {
    const n = i + 1
    assert.ok(c.prompt.includes(`Read .agents/skills/pointer/SKILL.md ${SEAT_NOTE} and follow it.`), `round ${n}: skill-read note`)
    assert.match(c.prompt, /SANDBOXED SEAT HANDOFF \(mandatory for the Vibe seat\)/, `round ${n}: HANDOFF_NOTE`)
    assert.ok(c.prompt.includes(`Write .wolfpack/plans/h/.seat-out/pointer-r${n}/pointer-review-${n}.md with the write_file tool`), `round ${n}`)
    assert.doesNotMatch(c.prompt, /Read \.agents\/skills\/pointer\/SKILL\.md and follow it/)
  }
})

test('rebase hunk 3: the GLM Shepherd rework prompt carries the skill-read note AND the Pointer sidecar path', async () => {
  const { find } = await runHunt({ answers: { 'shepherd-seat': GLM_SEAT, pointer: issuesThenApprove,
    'shepherd-glm': (p) => (/addressing Pointer code-review round/.test(p)
      ? { outcome: 'done', exitCode: 0, changedFiles: ['app/x.py'], committed: true, findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true }
      : { outcome: 'done', exitCode: 0, changedFiles: ['app/x.py'], committed: true }) } })
  const rw = find('shepherd-glm').map(c => c.prompt).find(p => /addressing Pointer code-review round 1/.test(p))
  assert.ok(rw, 'the GLM rework ran')
  assert.ok(rw.includes(`Read ${WT}/.agents/skills/shepherd/SKILL.md ${SEAT_NOTE} (skip shell steps) and the full review at\n${PD}/pointer-review-1.md (pipeline notes, if any: ${PD}/seat-notes/pointer-review-1.md).`), rw)
})

test('rebase hunk 3: the step-4.6 PASS-only staging rules use the configured worktree root, and live inside the seat-handoff-writes 4.6 block', async () => {
  const wt = '/repo/.wt/hunts/h'
  const { find } = await runHunt({ answers: {
    'project-config': configAnswer({ ...FIXTURE_CONFIG, worktreeRoot: '.wt/hunts' }),
    scaffold: { worktreePath: wt, planDir: `${wt}/.wolfpack/plans/h` } } })
  const wd = find('watchdog:')[0].prompt
  const at = wd.indexOf('4.6 PASS-ONLY ACTIONS (YOU, the shim agent — never the certifier seat).')
  assert.ok(at >= 0, 'the seat-handoff-writes 4.6 block is present')
  const block = wd.slice(at, wd.indexOf('\n\n', at))
  assert.ok(block.includes('worktree plan files into main at .wt/hunts/<slug>/… paths'), block)
  assert.ok(block.includes('stage a path that begins with `.wt/hunts/`'), block)
  assert.doesNotMatch(block, /\.agents\/worktrees/)
  // exactly one staging-rules block (the merge did not leave the pre-handoff copy behind)
  assert.equal(wd.split('STRICT staging rules').length - 1, 1, 'one staging-rules block')
})

test('rebase hunk 4: CLAUDE_SELF_CERTIFY_STEP resolves PACK_SKILLS from Wolfpack home at run time (no literal, no undefined)', async () => {
  const { find } = await runHunt({ answers: {
    alpha: ORANGE, 'shepherd-seat': OFFLOAD_SEAT,
    tracker: { verdict: 'TESTS_PASS', provider: 'mistral' },
    pointer: { ...BASE.pointer, provider: 'mistral' },
    watchdog: { verdict: 'PASS', provider: 'claude', deniedTools: [], toolAccess: SHELL_OK },
  } })
  const wd = find('watchdog:')[0].prompt
  // FIXTURE_CONFIG's Wolfpack home is /pack — the real interpolation, independent of claudeConst's binding
  assert.ok(wd.includes('following the watchdog role skill it names (/pack/.agents/skills/watchdog/SKILL.md)'), 'pack watchdog skill named')
  assert.ok(!wd.includes('${PACK_SKILLS}'), 'no unexpanded placeholder')
  assert.doesNotMatch(wd, /undefined\/\.agents\/skills/)
  // and the source declares PACK_SKILLS before the top-level constant that reads it (no TDZ at load)
  assert.ok(SRC.indexOf('const PACK_SKILLS = ') > 0 && SRC.indexOf('const PACK_SKILLS = ') < SRC.indexOf('const CLAUDE_SELF_CERTIFY_STEP = '))
})

// ════════════════════════════════════════════════════════════════════════════
// workflow-meta-runtime: the Workflow runtime STRIPS the `export const meta` block, so runtime
// code must not reference `meta`; the run-start probes must agree on one host repo; pipeline
// (config) errors in the review fan-out park with their text verbatim.
// ════════════════════════════════════════════════════════════════════════════
const checkFnText = (src) => {
  const a = src.indexOf('const checkWorkflowStamp = async')
  assert.ok(a >= 0, 'checkWorkflowStamp present')
  return src.slice(a, src.indexOf('\n}\n', a) + 3)
}

test('workflow-meta-runtime AC1/AC5: the stripped script launches and reaches the resume probe (no ReferenceError)', async () => {
  const { find } = await runHunt()
  assert.equal(find('resume-probe:').length, 1)
})

test('workflow-meta-runtime AC5: no runtime code references `meta`, and the guard goes red when one does', async () => {
  assert.deepEqual(runtimeMetaRefs(stripMeta(CANON_HP)), [])
  const bad = CANON_HP.replace('`${WORKFLOW_NAME}.js`', '`${meta.name}.js`')
  assert.notEqual(bad, CANON_HP, 'the mutation applied')
  assert.ok(runtimeMetaRefs(stripMeta(bad)).length > 0, 'the guard flags the mutated source')
  await assert.rejects(runHunt({ src: stripMeta(bad) }), /meta is not defined/)
})

test('workflow-meta-runtime AC2: WORKFLOW_NAME equals the meta block name; no meta.name access in the body', () => {
  const { meta, body } = splitMeta(CANON_HP)
  assert.equal(meta.name, 'hunt-pipeline')
  assert.match(body, /^const WORKFLOW_NAME = 'hunt-pipeline'$/m)
  assert.doesNotMatch(body, /\bmeta\.name\b/)
})

test('workflow-meta-runtime AC3: checkWorkflowStamp and the probe helpers are byte-identical in both workflows', () => {
  const runnerSrc = readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
  assert.equal(checkFnText(CANON_HP), checkFnText(runnerSrc))
  for (const re of [/^const PROBE_NO_CD = .*$/m, /^const probeRoot = .*$/m, /^let hostRepoRoot = .*$/m]) {
    assert.equal(CANON_HP.match(re)[0], runnerSrc.match(re)[0], String(re))
  }
})

test('workflow-meta-runtime AC6: both probes run with no cd, print PROBE_PWD, and require cwd', async () => {
  const { find } = await runHunt()
  for (const label of ['project-config:h', 'workflow-stamp:h']) {
    const c = find(label)[0]
    assert.ok(c.prompt.includes('do NOT cd anywhere'), label)
    assert.ok(c.prompt.includes('echo "PROBE_PWD=$(pwd)";'), label)
    assert.ok(!c.prompt.includes('From the repo root (your starting directory)'), label)
    assert.ok(c.opts.schema.required.includes('cwd'), label)
  }
})

test('workflow-meta-runtime AC7: probes that disagree on the host repo THROW naming both paths; nothing is scaffolded', async () => {
  const cases = [
    ['stamp probe cwd and checker consumer both elsewhere', { 'workflow-stamp': stampAnswer({ consumer: '/other' }, undefined, '/other') }],
    ['stamp probe cwd elsewhere, consumer matches', { 'workflow-stamp': stampAnswer({}, undefined, '/other') }],
    ['checker consumer elsewhere, stamp cwd matches', { 'workflow-stamp': stampAnswer({ consumer: '/other' }) }],
    ['config probe elsewhere', { 'project-config': configAnswer(FIXTURE_CONFIG, '/other') }],
  ]
  for (const [why, ans] of cases) {
    const { ran, answers } = NO_STATE()
    await assert.rejects(runHunt({ answers: { ...answers, ...ans } }), (e) => {
      assert.match(e.message, /HOST REPO DRIFTED/, why)
      assert.match(e.message, /\/repo[\s\S]*\/other|\/other[\s\S]*\/repo/, why)
      return true
    })
    assert.deepEqual(ran, [], why)
  }
})

test('workflow-meta-runtime AC7: trailing slashes are normalized (no realpath) and the run proceeds', async () => {
  const { result } = await runHunt({ answers: { 'project-config': configAnswer(FIXTURE_CONFIG, '/repo/'), 'workflow-stamp': stampAnswer({ consumer: '/repo/' }, undefined, '/repo//') } })
  assert.equal(result.status, 'awaiting_user_deploy')
})

test('workflow-meta-runtime AC8: a missing / relative cwd fails closed', async () => {
  {
    const { ran, answers } = NO_STATE()
    const { cwd, ...noCwd } = configAnswer()('')
    await assert.rejects(runHunt({ answers: { ...answers, 'project-config': noCwd, 'workflow-stamp': () => { ran.push('workflow-stamp'); return stampAnswer() } } }),
      /project-config probe did not report the directory it ran in/)
    assert.deepEqual(ran, [], 'no stamp probe, no scaffold')
  }
  for (const stampCwd of [undefined, 'repo', '']) {
    const { ran, answers } = NO_STATE()
    const { cwd, ...noCwd } = stampAnswer()
    await assert.rejects(runHunt({ answers: { ...answers, 'workflow-stamp': stampCwd === undefined ? noCwd : stampAnswer({}, undefined, stampCwd) } }),
      /HOST REPO DRIFTED[\s\S]*\(not reported\)/, String(stampCwd))
    assert.deepEqual(ran, [], String(stampCwd))
  }
  {
    const { ran, answers } = NO_STATE()
    await assert.rejects(runHunt({ answers: { ...answers, 'project-config': configAnswer(FIXTURE_CONFIG, 'repo') } }),
      /project-config probe did not report the directory it ran in/)
    assert.deepEqual(ran, [])
  }
})

test('workflow-meta-runtime (4): a Bloodhound prompt-build throw parks review_error with the error VERBATIM — no seat ran, no outage guess', async () => {
  const msg = 'cfg-boom: plan dir (/x) is not inside the worktree (/y)'
  const mutated = SRC.replace('buildPrompt: buildBloodhoundPrompt,', `buildPrompt: () => { throw new Error('${msg}') },`)
  assert.notEqual(mutated, SRC, 'the mutation applied')
  const { result, find } = await runHunt({ src: mutated })
  assert.equal(result.status, 'parked:review_error')
  assert.equal(result.pipelineError, msg)
  assert.equal(find('bloodhound:').length, 0, 'no seat ran')
  const parks = find('park:')
  assert.equal(parks.length, 1)
  const pp = parks[0].prompt
  assert.ok(pp.includes(msg), 'verbatim error text')
  assert.ok(pp.includes('- error: "cfg-boom'), 'parked.md error bullet')
  assert.ok(pp.includes('"error": "cfg-boom'), 'metadata park.error')
  assert.doesNotMatch(pp, /likely a model outage or quota exhaustion/)
  assert.match(pp, /plan review could not start/)
})

test('workflow-meta-runtime (4): a Pointer prompt-build throw parks review_error with the error VERBATIM — no seat ran', async () => {
  const msg = 'cfg-boom: plan dir (/x) is not inside the worktree (/y)'
  const mutated = SRC.replace('buildPrompt: buildPointerPrompt,', `buildPrompt: () => { throw new Error('${msg}') },`)
  assert.notEqual(mutated, SRC, 'the mutation applied')
  const { result, find } = await runHunt({ src: mutated })
  assert.equal(result.status, 'parked:review_error')
  assert.equal(result.pipelineError, msg)
  assert.equal(find('pointer:').length, 0, 'no seat ran')
  const parks = find('park:')
  assert.equal(parks.length, 1)
  const pp = parks[0].prompt
  assert.ok(pp.includes(msg))
  assert.ok(pp.includes('- error: "cfg-boom'))
  assert.ok(pp.includes('"error": "cfg-boom'))
  assert.doesNotMatch(pp, /likely a model outage or quota exhaustion/)
  assert.match(pp, /code review could not start/)
})

test('workflow-meta-runtime (4): a REAL seat-handoff guard throw (plan dir outside the worktree) parks with its own text', async () => {
  const mutated = SRC.replace('const SEAT_OUT = (name) => `${planDir}/.seat-out/${name}`', 'const SEAT_OUT = (name) => `/elsewhere/.seat-out/${name}`')
  assert.notEqual(mutated, SRC, 'the mutation applied')
  const { result, find } = await runHunt({ src: mutated })
  assert.equal(result.status, 'parked:review_error')
  assert.equal(find('bloodhound:').length, 0)
  assert.ok(find('park:')[0].prompt.includes('seat-handoff-writes: the plan dir'))
})

test('workflow-meta-runtime: the harness parallel() nulls a throwing unit like the runtime — a throwing seat parks review_error, it does not reject', async () => {
  const { result } = await runHunt({ answers: { bloodhound: () => { throw new Error('seat died') } } })
  assert.equal(result.verdict, 'PARKED')
  assert.equal(result.reason, 'review_error')
})

// ════════════════════════════════════════════════════════════════════════════
// scripts-unfork (AC7): every pack script runs from the Wolfpack home, never the hosting repo.
// The default fixture IS consumer-hosted: repo /repo (which has no scripts/ dir at all — nothing
// in this harness can resolve one), pack home /pack (FIXTURE_CONFIG → Wolfpack home).
// ════════════════════════════════════════════════════════════════════════════
const PACK_SCRIPT_RE = /wolfpack-(routing|toolcheck|usage|timing|model-stats|lessons|config|window-gate|chain)\.(mjs|sh)/g

test('AC7 consumer-hosted: every router / toolcheck / usage / timing / model-stats / lessons command names /pack/scripts/, never the repo', async () => {
  const { calls, result } = await runHunt({ args: { usageOffload: { reason: 'weekly pace' } }, answers: { 'usage-offload': { ok: true, reason: 'weekly pace' } } })
  assert.equal(result.status === undefined || typeof result.status === 'string', true)
  const seen = new Set()
  for (const c of calls) {
    assert.doesNotMatch(c.prompt, /\/repo\/scripts\/wolfpack-/, `${c.label}: a consuming-repo script path`)
    assert.doesNotMatch(c.prompt, /(^|[\s'"`(])\.\/scripts\/(lib\/)?wolfpack-/m, `${c.label}: a ./scripts/ invocation`)
    assert.doesNotMatch(c.prompt, /(node|bash|sh) +['"]?scripts\/(lib\/)?wolfpack-/, `${c.label}: a repo-relative invocation`)
    for (const m of c.prompt.matchAll(PACK_SCRIPT_RE)) {
      // the char run before the name must end in the pack dir, or be the probe's $PACK variable
      const before = c.prompt.slice(Math.max(0, m.index - 16), m.index)
      assert.ok(before.endsWith('/pack/scripts/') || before.endsWith('$PACK/scripts/') || before.endsWith('<pack>/scripts/'),
        `${c.label}: ${m[0]} is not under the pack home (…${before})`)
      seen.add(m[1])
    }
  }
  for (const s of ['routing', 'toolcheck', 'usage', 'timing', 'model-stats', 'lessons', 'config']) assert.ok(seen.has(s), `no prompt ran wolfpack-${s}`)
  // the exact command shapes
  const by = (p) => calls.find(c => c.label.startsWith(p)).prompt
  assert.ok(by('alpha:').includes(`node '/pack/scripts/wolfpack-routing.mjs' '${PD}'`))
  assert.ok(by('usage-offload:').includes(`node '/pack/scripts/wolfpack-usage.mjs' record-offload`))
  assert.ok(by('toolcheck-preflight:').includes(`node '/pack/scripts/wolfpack-toolcheck.mjs' --shim '/pack/scripts/podman-vibe.sh'`))
  const wd = by('watchdog:')
  assert.ok(wd.includes(`node '/pack/scripts/wolfpack-timing.mjs' '${PD}'`))
  assert.ok(wd.includes(`node '/pack/scripts/wolfpack-model-stats.mjs' --stamp`))
  assert.ok(wd.includes(`bash '/pack/scripts/wolfpack-lessons.sh'`))
})

test('AC7 the stamp CLI is set only once the pack home resolves: the config / stamp probes carry no heartbeat stamp', async () => {
  const { calls } = await runHunt()
  for (const label of ['project-config:h', 'workflow-stamp:h']) {
    const c = calls.find(x => x.label === label)
    assert.ok(c, label)
    assert.doesNotMatch(c.prompt, /wolfpack-usage\.mjs/, `${label} predates the pack home`)
  }
  assert.ok(calls.find(x => x.label.startsWith('scaffold:')).prompt.includes('node "/pack/scripts/wolfpack-usage.mjs" stamp'))
})

test('AC7 config probe, env leg: WOLFPACK_HOME in the WORKFLOW env is injected as a literal PACK=\'…\' — the seat\'s own env is never consulted', async () => {
  const { calls } = await runHunt({ env: { WOLFPACK_HOME: '/pack' } })
  const p = calls[0]
  assert.equal(p.label, 'project-config:h')
  assert.ok(p.prompt.includes(`PACK='/pack'; echo "PROBE_PWD=$(pwd)"; echo "PACK_HOME=$PACK"; node "$PACK/scripts/wolfpack-config.mjs" --json wolfpack-config.md 2>&1; echo "CONFIG_RC=$?"`), p.prompt)
  assert.doesNotMatch(p.prompt, /\$WOLFPACK_HOME/)
  assert.doesNotMatch(p.prompt, /VERBATIM — do NOT expand/)
  assert.match(p.prompt, /pack = the path after PACK_HOME= VERBATIM/)
  // a home with a space is shq-quoted, and still matched by the resolver
  const sp = await runHunt({ env: { WOLFPACK_HOME: '/pa ck/home' } })
  assert.ok(sp.calls[0].prompt.includes(`PACK='/pa ck/home'; echo`))
  assert.ok(sp.logs.some(l => l.startsWith('Pack home (WOLFPACK_HOME): /pa ck/home — from env WOLFPACK_HOME')), sp.logs.join('\n'))
})

test('AC7 config probe, key leg (env unset): the seat copies Wolfpack home VERBATIM; the shell expands only a leading ~ (deviation 2)', async () => {
  for (const env of [{}, { WOLFPACK_HOME: '' }, { WOLFPACK_HOME: '   ' }]) {
    const { calls } = await runHunt({ env })
    const p = calls[0].prompt
    assert.match(p, /Wolfpack home\*\*: its backticked path, VERBATIM — do NOT expand `~`, resolve symlinks or substitute any other path/, JSON.stringify(env))
    // run-observability AC12: the key leg SINGLE-quotes the copied home (no $ / backtick expansion)
    assert.ok(p.includes(`PACK='<home>'; case "$PACK" in "~"|"~/"*) PACK="$HOME\${PACK#"~"}" ;; esac; echo "PROBE_PWD=$(pwd)"; echo "PACK_HOME=$PACK"; node "$PACK/scripts/wolfpack-config.mjs"`), p)
    assert.match(p, /inside the single quotes \(the config reader refuses a pack home that contains a single quote\)/)
    assert.doesNotMatch(p, /PACK='(?!<home>')/)   // no env-leg literal is injected
    assert.equal(p.includes('PACK="<home>"'), false)
  }
  // the probe's case line is the reader's expandHome rule — run it for real on the key shapes
  for (const [key, want] of [['~/pk', `${process.env.HOME}/pk`], ['~', process.env.HOME], ['/abs/pk', '/abs/pk'], ['~other/pk', '~other/pk'], ['', '']]) {
    const out = execFileSync('bash', ['-c', `PACK='${key}'; case "$PACK" in "~"|"~/"*) PACK="$HOME\${PACK#"~"}" ;; esac; printf %s "$PACK"`], { encoding: 'utf8' })
    assert.equal(out, want, key)
  }
  // run-observability AC12: a config-derived home with $ / backticks is INERT under the single quotes
  // (the old double-quoted leg expanded them).
  for (const key of ['/opt/$HOME/pk', '/opt/`echo hi`/pk', '/opt/$(echo x)/pk']) {
    const out = execFileSync('bash', ['-c', `PACK='${key}'; case "$PACK" in "~"|"~/"*) PACK="$HOME\${PACK#"~"}" ;; esac; printf %s "$PACK"`], { encoding: 'utf8' })
    assert.equal(out, key, key)
  }
})

test('AC7 probe-equality: a probe pack equal up to trailing slashes passes; a different / empty / missing pack throws naming both paths — before any scaffold', async () => {
  const ok = await runHunt({ answers: { 'project-config': { ...configAnswer()(''), pack: '/pack//' } } })
  assert.ok(ok.logs.some(l => l.startsWith('Pack home (WOLFPACK_HOME): /pack')), ok.logs.join('\n'))
  for (const pack of ['/other', '', undefined, 'pack', '/pack/sub']) {
    const ran = []
    const rec = (l) => () => { ran.push(l); return {} }
    const ans = { ...configAnswer()('') }
    if (pack === undefined) delete ans.pack; else ans.pack = pack
    await assert.rejects(runHunt({ answers: { 'project-config': ans, 'workflow-stamp': rec('workflow-stamp'), 'resume-probe': rec('resume-probe'), scaffold: rec('scaffold') } }), (e) => {
      assert.ok(e.message.startsWith(`hunt-pipeline: h: the config probe ran the reader from '${pack ?? ''}' but the pack home resolves to '/pack' (wolfpack-config.md → Project Identity → Wolfpack home)`), e.message)
      assert.match(e.message, /Fix: make WOLFPACK_HOME and wolfpack-config\.md → Wolfpack home name the same absolute path, then relaunch\.$/)
      return true
    }, String(pack))
    assert.deepEqual(ran, [], `${pack}: nothing ran after the probe`)
  }
  // env leg: the resolved home is the ENV value — a probe that used the config key instead mismatches
  await assert.rejects(runHunt({ env: { WOLFPACK_HOME: '/envpack' }, answers: { 'project-config': { ...configAnswer()(''), pack: '/pack' } } }),
    /the config probe ran the reader from '\/pack' but the pack home resolves to '\/envpack' \(env WOLFPACK_HOME\)/)
})

test("AC7 both examiner gates off + a Claude writer: the plan review PARKS no_cross_family_reviewer (the pipeline twin of the router's exit 3)", async () => {
  const { result, find } = await runHunt({ env: { WOLFPACK_ENABLE_GLM: '0', WOLFPACK_ENABLE_MISTRAL_AUTO: '0' } })
  assert.equal(result.status, 'parked:no_cross_family_reviewer', JSON.stringify(result))
  assert.equal(find('bloodhound:').length, 0, 'no same-family (Claude) plan review')
  assert.equal(find('shepherd').length, 0)
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// run-observability — composed fingerprints (AC1–AC3), boundary usage gate (AC4–AC6),
// SHA-stamped pipeline test record (AC7–AC10), parked-skill rows. Plan-final § Tests.
// ════════════════════════════════════════════════════════════════════════════════════════════
import {
  CLAIM_CLASSES, SYMBOL_NONE, normalizeFingerprintFile, normalizeSymbol, normalizeClaimClass, findingFingerprint,
  fingerprintFinding, newConvergenceHistory, classifyConvergence, commitRound, suspectedSymbolDrift,
} from './lib/review-convergence.mjs'

const OSC = JSON.parse(readFileSync(join(here, 'fixtures', 'review-oscillation.json'), 'utf8'))
const oscCase = (name) => OSC.cases.find(c => c.name === name)
// The REAL Orange convergence knobs (hunt-pipeline.js CONVERGENCE_BY_TIER.Orange); floor = baseRounds.
const ORANGE_CONV = { baseRounds: 2, planSmellBound: 12, critPersist: 3, maxRounds: 6 }
// Replay a fixture case's rounds through the REAL classifier; returns per-round {fps, verdict, drift}.
function replay(rounds, cfg = ORANGE_CONV) {
  const history = newConvergenceHistory()
  return rounds.map((raw, i) => {
    const findings = raw.map(fingerprintFinding)
    const drift = suspectedSymbolDrift(history, findings)
    const verdict = classifyConvergence({ round: i + 1, findings, history, cfg, floor: cfg.baseRounds })
    commitRound(history, findings, verdict.cumulativeCrit)
    return { fps: findings.map(f => f.fingerprint), verdict, drift }
  })
}
const fpAt = (c, [round, idx]) => fingerprintFinding(c.rounds[round - 1][idx]).fingerprint

test('run-observability AC1: findingFingerprint composes file::symbol::claim_class with every normalization', () => {
  assert.equal(findingFingerprint({ file: 'app/x.py', symbol: 'load_rows', claimClass: 'logic-error' }), 'app/x.py::load_rows::logic-error')
  // missing symbol → '-', unknown / missing class → 'other'
  assert.equal(findingFingerprint({ file: 'app/x.py', claimClass: 'logic-error' }), `app/x.py::${SYMBOL_NONE}::logic-error`)
  assert.equal(findingFingerprint({ file: 'app/x.py', symbol: 'f', claimClass: 'made-up-class' }), 'app/x.py::f::other')
  assert.equal(findingFingerprint({ file: 'app/x.py', symbol: 'f' }), 'app/x.py::f::other')
  // /workspace/ and ./ prefixes, backslashes, doubled slashes
  for (const f of ['/workspace/app/x.py', './app/x.py', '/app/x.py', 'app//x.py', 'app\\x.py', '././/app/x.py'])
    assert.equal(findingFingerprint({ file: f, symbol: 'f', claimClass: 'leak' }), 'app/x.py::f::leak', f)
  // every plan revision (and no file) → 'plan'
  for (const f of ['.wolfpack/plans/h/plan.md', '.wolfpack/plans/h/plan-revised-2.md', '/workspace/.wolfpack/plans/h/plan-final.md', '', null, undefined])
    assert.equal(normalizeFingerprintFile(f), 'plan', String(f))
  assert.equal(normalizeFingerprintFile('docs/plan.md'), 'docs/plan.md')   // only the hunt plan dir normalizes
  for (const { file, normalized } of OSC.plan_file_normalization) assert.equal(normalizeFingerprintFile(file), normalized)
  // symbol: quotes, a leading keyword, a trailing (...), case, whitespace
  for (const [raw, want] of [['`loadRows`', 'loadrows'], ['function loadRows()', 'loadrows'], ['def load_rows(a, b)', 'load_rows'],
    ['class Foo', 'foo'], ['§ Files to Modify', 'files-to-modify'], ['section Design Alternatives', 'design-alternatives'], ['  ', SYMBOL_NONE], [null, SYMBOL_NONE]])
    assert.equal(normalizeSymbol(raw), want, String(raw))
  // claim class: case and _/space → '-'
  assert.equal(normalizeClaimClass('Missing_Handling'), 'missing-handling')
  assert.equal(normalizeClaimClass('silent fallback'), 'silent-fallback')
  assert.equal(CLAIM_CLASSES.length, 17)
  assert.ok(CLAIM_CLASSES.includes('other'))
  assert.ok(Object.isFrozen(CLAIM_CLASSES))
  // fingerprintFinding never mutates and OVERWRITES a seat-supplied fingerprint; claimClass alias accepted
  const seat = { file: 'a.js', symbol: 'f', claim_class: 'leak', fingerprint: 'a.js:seat-slug' }
  const out = fingerprintFinding(seat)
  assert.equal(out.fingerprint, 'a.js::f::leak')
  assert.equal(seat.fingerprint, 'a.js:seat-slug')
  assert.equal(fingerprintFinding({ file: 'a.js', symbol: 'f', claimClass: 'leak' }).fingerprint, 'a.js::f::leak')
})

test("run-observability AC1: a '::' inside a symbol cannot add a leg; suspectedSymbolDrift still recovers file + class from a 4-leg string", () => {
  assert.equal(normalizeSymbol('Foo::bar'), 'foo-bar')
  const fp = findingFingerprint({ file: 'a.js', symbol: 'Foo::bar', claimClass: 'logic-error' })
  assert.equal(fp.split('::').length, 3)
  assert.equal(fp, 'a.js::foo-bar::logic-error')
  // a hand-built history whose fp has 4 legs (defensive split: first = file, last = class)
  const history = { fpRounds: [new Set(['a.js::ns::old::logic-error']), new Set(['b.js::z::leak'])], counts: [1, 1], cumulativeCritFps: new Set(), critStreak: new Map() }
  const drift = suspectedSymbolDrift(history, [{ fingerprint: 'a.js::new::logic-error' }])
  assert.deepEqual(drift, [{ file: 'a.js', claimClass: 'logic-error', was: 'ns::old', now: 'new' }])
})

test('run-observability AC1: core drift — the convergence block is byte-identical (minus export) in the module and hunt-pipeline.js', () => {
  const RE = /\/\/ ── BEGIN wolfpack-convergence core[^\n]*\n[\s\S]*?\/\/ ── END wolfpack-convergence core ──/
  const mod = readFileSync(join(here, 'lib', 'review-convergence.mjs'), 'utf8').match(RE)
  const wf = readFileSync(join(here, '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8').match(RE)
  assert.ok(mod, 'core markers missing in scripts/lib/review-convergence.mjs')
  assert.ok(wf, 'core markers missing in hunt-pipeline.js')
  assert.match(mod[0], /^export function classifyConvergence/m)
  assert.match(mod[0], /^export function suspectedSymbolDrift/m)
  assert.equal(wf[0], mod[0].replace(/^export /gm, ''))
  assert.doesNotMatch(mod[0], /\.agents\//)
  // the module has no imports (pure; the workflow runner cannot import)
  assert.doesNotMatch(readFileSync(join(here, 'lib', 'review-convergence.mjs'), 'utf8'), /^import /m)
  // the old inline classifier is gone (exactly one definition in the workflow)
  const src = readFileSync(join(here, '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
  assert.equal((src.match(/^function classifyConvergence\(/gm) || []).length, 1)
  assert.equal((src.match(/^const isCriticalSev = /gm) || []).length, 1)
})

test('run-observability AC1: both grounding prompts pass symbol + claim_class through; the verdict contract lists every class', async () => {
  const { find } = await runHunt({ answers: { pointer: issuesThenApprove } })
  for (const p of [find('bloodhound:')[0].prompt, find('pointer:')[0].prompt]) {
    assert.match(p, /6\.5 FINGERPRINT PARTS/)
    assert.match(p, /file \+ symbol \+ claim_class/)
    assert.match(p, /Do NOT invent, reword or compute a fingerprint/)
    assert.match(p, /\/claim\/evidence\/symbol\/claim_class/)
    assert.doesNotMatch(p, /\/claim\/evidence\/FINGERPRINT/)
    assert.doesNotMatch(p, /compute a coarse `fingerprint`/)
    assert.match(p, /"symbol": "functionOrSection"/)
    assert.ok(p.includes(`"claim_class" is EXACTLY one of: ${CLAIM_CLASSES.join(', ')}`), 'the contract interpolates the closed list')
    for (const c of CLAIM_CLASSES) assert.ok(p.includes(c), c)
  }
})

test('run-observability AC1: a seat fingerprint is overwritten before classification (the pointer park context shows the composed one)', async () => {
  // A CRITICAL with the SAME {file, symbol, class} three rounds running, each round with a DIFFERENT
  // seat slug: under the seat slug it would never be "stuck"; under the composed fp it parks at r3.
  const crit = (n) => ({ id: 1, severity: 'CRITICAL', title: 't', file: './app/x.py', line: 1, claim: 'c', evidence: 'e',
    symbol: 'load', claim_class: 'data-integrity', fingerprint: `app/x.py:slug-${n}` })
  const { result, find } = await runHunt({ answers: { alpha: { ...ORANGE, pointerRounds: 3 },
    pointer: (_p, _o, n) => ({ verdict: 'ISSUES_FOUND', findings: 1, findingsList: [crit(n)], provider: 'mistral' }),
    'shepherd-rewrite': { findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true } } })
  assert.equal(result.status, 'parked:open_critical', JSON.stringify(result))
  assert.equal(find('pointer:').length, 3)
  assert.ok(find('park:h:open_critical')[0].prompt.includes('app/x.py::load::data-integrity'))
})

test('run-observability AC2: the recorded FALSE collisions no longer park oscillation (F1; F2 R2 vs R3)', () => {
  const f1 = oscCase('F1')
  assert.equal(f1.label, 'false_collision')
  assert.notEqual(fpAt(f1, f1.expect.differ[0]), fpAt(f1, f1.expect.differ[1]))
  const r1 = replay(f1.rounds)
  for (const r of r1) assert.doesNotMatch(r.verdict.detail, /oscillation/)
  assert.ok(r1.every(r => r.verdict.action === 'continue'), JSON.stringify(r1.map(r => r.verdict)))
  // the OLD seat slugs (both 'web/js/calendar.js:fragile-js-test') DID park at R3 — the replay proves the regression
  const old = newConvergenceHistory()
  const oldRounds = f1.rounds.map((rs, i) => rs.map(f => ({ ...f, fingerprint: i === 1 ? 'docs/setup.md:x' : 'web/js/calendar.js:fragile-js-test' })))
  let oldVerdict
  oldRounds.forEach((fs, i) => { oldVerdict = classifyConvergence({ round: i + 1, findings: fs, history: old, cfg: ORANGE_CONV, floor: 2 }); commitRound(old, fs, oldVerdict.cumulativeCrit) })
  assert.equal(oldVerdict.action, 'park_non_convergence')
  assert.match(oldVerdict.detail, /oscillation/)
  // F2: R2 (submitShiftForm) and R3 (eventDidMount) are different defects
  const f2 = oscCase('F2')
  assert.notEqual(fpAt(f2, f2.expect.differ[0]), fpAt(f2, f2.expect.differ[1]))
  const r2 = replay(f2.rounds)
  assert.equal(r2[2].verdict.action, 'continue', 'R3 is not a return of R2')
})

test('run-observability AC3: GENUINE returns still park — F2 R5 and F3 R3 oscillate; the 3-round CRITICAL parks open_critical', () => {
  const f2 = oscCase('F2')
  assert.equal(fpAt(f2, f2.expect.same[0]), fpAt(f2, f2.expect.same[1]))
  const r2 = replay(f2.rounds)
  for (let i = 0; i < f2.expect.oscillation_at - 1; i++) assert.doesNotMatch(r2[i].verdict.detail, /oscillation/, `F2 R${i + 1}`)
  const at5 = r2[f2.expect.oscillation_at - 1].verdict
  assert.equal(at5.action, 'park_non_convergence')
  assert.match(at5.detail, /oscillation: fingerprint "web\/js\/calendar\.js::eventdidmount::missing-handling" returned/)
  const f3 = oscCase('F3')
  assert.notEqual(fpAt(f3, f3.expect.differ[0]), fpAt(f3, f3.expect.differ[1]))
  assert.equal(fpAt(f3, f3.expect.same[0]), fpAt(f3, f3.expect.same[1]))
  const r3 = replay(f3.rounds)
  assert.equal(r3[1].verdict.action, 'continue', 'F3 R2 is distinct')
  assert.equal(r3[2].verdict.action, 'park_non_convergence')
  assert.match(r3[2].verdict.detail, /oscillation: fingerprint "hooks\/guard\.sh::exec_re::security"/)
  const cs = oscCase('critical-stuck')
  const rc = replay(cs.rounds)
  assert.equal(rc[cs.expect.action_at.round - 1].verdict.action, cs.expect.action_at.action)
  assert.equal(rc[0].verdict.action, 'continue')
  assert.equal(rc[1].verdict.action === 'park_open_critical', false)
})

test('run-observability AC2/AC3: the fixture file is labelled, generic and covers every label', () => {
  const labels = new Set(OSC.cases.map(c => c.label))
  for (const l of ['false_collision', 'genuine_return', 'critical_stuck']) assert.ok(labels.has(l), l)
  for (const c of OSC.cases) for (const r of c.rounds) for (const f of r) {
    assert.ok(f.file && f.severity && f.claim_class, `${c.name}: ${JSON.stringify(f)}`)
    assert.ok(CLAIM_CLASSES.includes(f.claim_class), `${c.name}: closed class ${f.claim_class}`)
    assert.equal('fingerprint' in f, false, 'the fixture never carries a seat fingerprint')
  }
})

test('run-observability: suspectedSymbolDrift is log-only — a renamed returning defect is reported, never parked', () => {
  const rounds = [
    [{ severity: 'LOW', file: 'a.js', symbol: 'foo', claim_class: 'logic-error' }],
    [{ severity: 'LOW', file: 'b.js', symbol: 'bar', claim_class: 'leak' }],
    [{ severity: 'LOW', file: 'a.js', symbol: 'fooCaller', claim_class: 'logic-error' }],
  ]
  const r = replay(rounds)
  assert.deepEqual(r[2].drift, [{ file: 'a.js', claimClass: 'logic-error', was: 'foo', now: 'foocaller' }])
  assert.notEqual(r[2].verdict.action, 'park_non_convergence')
  assert.deepEqual(r[0].drift, [])   // < 2 rounds of history
  assert.deepEqual(r[1].drift, [])
  // F1 R3 (different class) and F2 R3 (present in N-1 → not "fixed") are NOT drift
  assert.deepEqual(replay(oscCase('F1').rounds)[2].drift, [])
  assert.deepEqual(replay(oscCase('F2').rounds)[2].drift, [])
  // an exact-match return is the classifier's job, not drift
  assert.deepEqual(replay(oscCase('F3').rounds)[2].drift, [])
  // deduped: two findings with the same rename report once
  const dup = replay([rounds[0], rounds[1], [rounds[2][0], { ...rounds[2][0], title: 'again' }]])
  assert.equal(dup[2].drift.length, 1)
})

// The pipeline end to end on a Bloodhound history: answers carry {file, symbol, claim_class} (+ an
// optional seat fingerprint the pipeline must ignore).
const bhRounds = (rounds, seatFp) => (_p, _o, n) => {
  if (n > rounds.length) return { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'glm', status: 'glm' }
  const list = rounds[n - 1].map((f, i) => ({ id: i + 1, title: f.title || 't', claim: 'c', evidence: 'e', line: 1, ...f, ...(seatFp ? { fingerprint: seatFp(n) } : {}) }))
  return { verdict: 'ISSUES_FOUND', findings: list.length, findingsList: list, provider: 'glm', status: 'glm' }
}
const REVISE_OK = { findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true }

test('run-observability AC2 (pipeline): F1 replayed through Bloodhound does NOT park non_convergence at round 3 — even with the old colliding seat slug', async () => {
  const f1 = oscCase('F1')
  const { result, find, logs } = await runHunt({ answers: { alpha: { ...ORANGE, bloodhoundRounds: 2 },
    bloodhound: bhRounds(f1.rounds, (n) => (n === 2 ? 'docs/setup.md:x' : 'web/js/calendar.js:fragile-js-test')),
    'alpha-revise': REVISE_OK } })
  assert.notEqual(result.status, 'parked:non_convergence', JSON.stringify(result))
  assert.equal(find('park:h:non_convergence').length, 0)
  assert.equal(find('bloodhound:').length, 4, 'three ISSUES rounds, approved at round 4')
  assert.ok(logs.some(l => /Bloodhound APPROVED at round 4/.test(l)))
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
})

test('run-observability AC3 (pipeline): F3 replayed through Pointer still parks the genuine return at round 3', async () => {
  const f3 = oscCase('F3')
  const { result, find } = await runHunt({ answers: { alpha: { ...ORANGE, pointerRounds: 2 },
    pointer: (_p, _o, n) => ({ verdict: 'ISSUES_FOUND', provider: 'mistral',
      findingsList: f3.rounds[Math.min(n, 3) - 1].map((f, i) => ({ id: i + 1, claim: 'c', evidence: 'e', line: 1, ...f })) }),
    'shepherd-rewrite': REVISE_OK } })
  assert.equal(result.status, 'parked:non_convergence', JSON.stringify(result))
  assert.equal(find('pointer:').length, 3)
  assert.match(find('park:h:non_convergence')[0].prompt, /oscillation: fingerprint "hooks\/guard\.sh::exec_re::security"/)
})

test('run-observability (pipeline): a renamed returning defect logs "suspected oscillation (symbol drift" and does not park at round 3', async () => {
  const rounds = [
    [{ severity: 'LOW', file: 'a.js', symbol: 'foo', claim_class: 'logic-error' }],
    [{ severity: 'LOW', file: 'b.js', symbol: 'bar', claim_class: 'leak' }],
    [{ severity: 'LOW', file: 'a.js', symbol: 'fooCaller', claim_class: 'logic-error' }],
  ]
  const { result, logs, find } = await runHunt({ answers: { alpha: { ...ORANGE, bloodhoundRounds: 2 },
    bloodhound: bhRounds(rounds), 'alpha-revise': REVISE_OK } })
  assert.ok(logs.some(l => /⚠ suspected oscillation \(symbol drift: foo vs foocaller\) at a\.js \[logic-error\] — not parked on/.test(l)), logs.filter(l => /suspect/.test(l)).join('\n'))
  assert.equal(find('park:h:non_convergence').length, 0)
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
})

// ─── AC4–AC6: the boundary usage gate ───
const GATED = ['Spec', 'Plan', 'Review', 'Debrief', 'Implement', 'Code Review', 'Test', 'Certify']
const PHASE_FIRST_AGENT = { Spec: 'spec:', Plan: 'alpha:', Review: 'bloodhound:', Debrief: 'debrief:', Implement: 'shepherd:',
  'Code Review': 'pointer:', Test: 'tracker:', Certify: 'watchdog:' }
const gateAns = (decision, exitCode, extra = {}) => ({ exitCode, output: JSON.stringify({ decision, exit: exitCode, reason: `r-${decision}`, source: 'live', degraded: false, mode: 'boundary', ...extra }) })
const gateAt = (phase, ans) => (_p, opts) => (opts.label === `usage-gate:h:${phase}` ? (typeof ans === 'function' ? ans() : ans) : BASE['usage-gate'])

test('run-observability AC4: a fresh run gates EVERY agent phase once, in order, each before that phase\'s first agent; never at Verify', async () => {
  const { calls, result } = await runHunt({})
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  const gates = calls.filter(c => c.label.startsWith('usage-gate:'))
  assert.deepEqual(gates.map(c => c.label), GATED.map(p => `usage-gate:h:${p}`))
  const idx = (pred) => calls.findIndex(pred)
  let prevAgent = -1
  for (const p of GATED) {
    const g = idx(c => c.label === `usage-gate:h:${p}`)
    const a = idx(c => c.label.startsWith(PHASE_FIRST_AGENT[p]))
    assert.ok(a > g, `${p}: gate before ${PHASE_FIRST_AGENT[p]}`)
    assert.ok(g > prevAgent, `${p}: gate after the previous phase's agent`)
    prevAgent = a
  }
  const g0 = gates[0]
  assert.equal(g0.opts.model, 'sonnet')
  assert.ok(g0.prompt.includes(`node '/pack/scripts/wolfpack-window-gate.mjs' --json --boundary --phase 'Spec' --record '${PD}/usage-gate.jsonl'; echo "GATE_RC=$?"`), g0.prompt)
  assert.match(g0.prompt, /Exit 10 is a NORMAL "defer"/)
  assert.doesNotMatch(g0.prompt, /--record-note/)   // nothing pending
  assert.ok(calls.findIndex(c => c.label.startsWith('verify:')) > calls.findIndex(c => c.label === 'usage-gate:h:Certify'))
  // the result carries every gate outcome
  assert.deepEqual(result.usageGateEvents.map(e => [e.phase, e.kind]), GATED.map(p => [p, 'proceed']))
})

test('run-observability AC4: a defer at the Implement boundary parks model_quota cleanly — no Shepherd runs', async () => {
  const { result, find, logs } = await runHunt({ answers: { 'usage-gate': gateAt('Implement', gateAns('defer', 10, { reset_at: '2026-10-21T05:00:00.000Z', reason: 'boundary: 5h 96% ≥ 95%' })) } })
  assert.equal(result.status, 'parked:model_quota', JSON.stringify(result))
  assert.equal(result.reason, 'model_quota')
  assert.equal(result.verdict, 'PARKED')
  assert.equal(result.resumePhase, 'Implement')
  assert.equal(result.resetAt, '2026-10-21T05:00:00.000Z')
  // (the shepherd-SEAT probe belongs to Plan; no implementer of any family runs)
  assert.equal(find('shepherd:').length + find('shepherd-glm').length + find('shepherd-fallback').length, 0)
  assert.equal(find('pointer:').length + find('tracker:').length + find('watchdog:').length + find('test-record').length, 0)
  const park = find('park:h:model_quota')
  assert.equal(park.length, 1)
  assert.match(park[0].prompt, /resume_phase: Implement/)
  assert.ok(logs.some(l => /⏸ h: usage window cannot carry Implement \(boundary: 5h 96% ≥ 95%\) — parking model_quota at the boundary; resumes after 2026-10-21T05:00:00\.000Z/.test(l)))
  assert.deepEqual(result.usageGateEvents.at(-1), { phase: 'Implement', kind: 'defer', decision: 'defer', degraded: false, why: 'boundary: 5h 96% ≥ 95%' })
})

test('run-observability AC4: a defer at the very first boundary (Spec) runs no phase agent at all', async () => {
  const { result, find } = await runHunt({ answers: { 'usage-gate': gateAt('Spec', gateAns('defer', 10)) } })
  assert.equal(result.status, 'parked:model_quota')
  assert.equal(result.resumePhase, 'Spec')
  assert.equal(find('spec:').length + find('alpha:').length, 0)
})

test('run-observability AC5: an UNAVAILABLE gate (null) proceeds LOUDLY; the next gate carries the note via --record-note', async () => {
  const { result, find, logs } = await runHunt({ answers: { 'usage-gate': gateAt('Plan', () => null) } })
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  assert.ok(logs.some(l => /⚠ USAGE GATE UNAVAILABLE at Plan \(the gate agent returned no result\) — proceeding UNGATED; recorded in usage-gate\.jsonl/.test(l)))
  assert.equal(find('alpha:').length, 1, 'Plan ran')
  const next = find('usage-gate:h:Review')[0].prompt
  const m = /--record-note '([^']*)'/.exec(next)
  assert.ok(m, next)
  assert.deepEqual(JSON.parse(m[1]), [{ at_phase: 'Plan', kind: 'gate_unavailable', why: 'the gate agent returned no result' }])
  // flushed exactly once
  assert.doesNotMatch(find('usage-gate:h:Debrief')[0].prompt, /--record-note/)
  assert.ok(result.usageGateEvents.some(e => e.phase === 'Plan' && e.kind === 'gate_unavailable' && e.degraded === true && e.decision === null))
})

test('run-observability AC5: garbled / inconsistent gate relays are UNAVAILABLE (proceed + recorded), never a fabricated decision', async () => {
  for (const [ans, why] of [
    [{ exitCode: 0, output: 'not json' }, /no parseable JSON decision/],
    [gateAns('defer', 0), /decision "defer" inconsistent with exit 0/],
    [gateAns('proceed', 10), /decision "proceed" inconsistent with exit 10/],
    [{ exitCode: 7, output: '{}' }, /unexpected gate exit 7/],
  ]) {
    const { result, logs, find } = await runHunt({ answers: { 'usage-gate': gateAt('Debrief', ans) } })
    assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY', JSON.stringify(ans))
    const l = logs.find(x => /USAGE GATE UNAVAILABLE at Debrief/.test(x))
    assert.ok(l, JSON.stringify(ans))
    assert.match(l, why)
    assert.equal(find('debrief:').length, 1)
    assert.match(find('usage-gate:h:Implement')[0].prompt, /--record-note '.*gate_unavailable/)
  }
})

test('run-observability AC5: a gate ERROR (exit 1, or decision error) parks usage_gate_error — never model_quota, no phase agent', async () => {
  for (const ans of [{ exitCode: 1, output: '' }, gateAns('error', 1, { reason: 'WOLFPACK_5H_BOUNDARY_MAX_PCT must be a number' }), gateAns('error', 0)]) {
    const { result, find } = await runHunt({ answers: { 'usage-gate': gateAt('Plan', ans) } })
    assert.equal(result.status, 'parked:usage_gate_error', JSON.stringify(ans))
    assert.equal(result.reason, 'usage_gate_error')
    assert.equal(result.resumePhase, 'Plan')
    assert.equal(find('alpha:').length, 0)
    assert.equal(find('park:h:model_quota').length, 0)
    const park = find('park:h:usage_gate_error')
    assert.equal(park.length, 1)
    assert.match(park[0].prompt, /resume_phase: Plan/)
    assert.match(park[0].prompt, /redirect/)
    assert.match(park[0].prompt, /an invalid WOLFPACK_\* threshold is the usual cause/)
  }
})

test('run-observability AC5: a DEGRADED proceed is logged loudly and recorded degraded on the result', async () => {
  const { result, logs } = await runHunt({ answers: { 'usage-gate': gateAt('Test', gateAns('proceed', 0, { degraded: true, degraded_reason: 'snapshot 30 min old', source: 'transcript_estimate' })) } })
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  assert.ok(logs.some(l => /⚠ USAGE GATE DEGRADED at Test: snapshot 30 min old \(source transcript_estimate\) — decision proceed; recorded/.test(l)))
  assert.ok(result.usageGateEvents.some(e => e.phase === 'Test' && e.kind === 'proceed' && e.degraded === true))
  assert.ok(logs.some(l => /^usage gate Spec: proceed — /.test(l)))
})

test('run-observability AC5: an unavailable gate at Certify (the LAST gated phase) is on the certified result; a later park flushes it to usage-gate.jsonl', async () => {
  const ok = await runHunt({ answers: { 'usage-gate': gateAt('Certify', () => null) } })
  assert.equal(ok.result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  assert.ok(ok.result.usageGateEvents.some(e => e.phase === 'Certify' && e.kind === 'gate_unavailable'), JSON.stringify(ok.result.usageGateEvents))
  // the same, with the FINAL record failing afterwards: the park agent is the flush channel
  const bad = await runHunt({ answers: { 'usage-gate': gateAt('Certify', () => null),
    'test-record': (p) => recordAnswer(stageOf(p), stageOf(p) === 'final' ? { pass: false, summary: 'test-all: 9 passed, 1 failed' } : {}) } })
  assert.equal(bad.result.status, 'parked:final_test_record_failed')
  const park = bad.find('park:h:final_test_record_failed')[0].prompt
  assert.match(park, /USAGE-GATE RECORD/)
  assert.ok(park.includes(`${PD}/usage-gate.jsonl`))
  assert.match(park, /"kind":"pipeline_note","note":\{"at_phase":"Certify","kind":"gate_unavailable"/)
  assert.match(park, /"usage_gate_events" = \[.*"phase":"Certify","kind":"gate_unavailable"/)
  assert.ok(bad.result.usageGateEvents.some(e => e.phase === 'Certify' && e.kind === 'gate_unavailable'))
})

test('run-observability AC5: with nothing pending, the write-only agents carry no flush step', async () => {
  const { find } = await runHunt({ answers: { 'usage-gate': gateAt('Implement', gateAns('defer', 10)) } })
  assert.doesNotMatch(find('park:h:model_quota')[0].prompt, /USAGE-GATE RECORD/)
})

test('run-observability AC6: a boundary model_quota park auto-resumes AT that phase — no re-plan, the first gate is Implement', async () => {
  const probe = { fresh: false, status: 'parked:model_quota', parkResumePhase: 'Implement', resumePhase: 'Implement', tier: 'Yellow',
    worktreePath: WT, planDir: PD, worktreeExists: true, branchExists: true, trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }
  const { result, find, calls } = await runHunt({ answers: { 'resume-probe': probe } })
  assert.equal(find('alpha').length + find('bloodhound').length + find('debrief').length + find('spec:').length, 0)
  assert.equal(find('shepherd:').length, 1)
  assert.equal(calls.filter(c => c.label.startsWith('usage-gate:'))[0].label, 'usage-gate:h:Implement')
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
})

// ─── AC7–AC10: the SHA-stamped pipeline test record ───
test('run-observability AC7: the Test phase relays wolfpack-test-record.mjs ensure (shq-quoted, rc-file wait) and runs no suite itself', async () => {
  const { find, logs } = await runHunt({})
  const tr = find('test-record:h:tracker')
  assert.equal(tr.length, 1)
  const p = tr[0].prompt
  assert.equal(tr[0].opts.model, 'sonnet')
  assert.equal(tr[0].opts.phase, 'Test')
  assert.ok(p.includes(`node '/pack/scripts/wolfpack-test-record.mjs' ensure --json --stage tracker --record-dir '${PD}' --repo '${WT}'`), p)
  assert.ok(p.includes(`--repo '${WT}' --timeout-min 55`), 'the record script must time out before the ~60-min shim relay')
  assert.ok(p.includes(`${PD}/.test-record-tracker.rc`), 'the rc-file wait')
  assert.match(p, /Do NOT run tests yourself, do NOT summarise, do NOT edit, stage or commit any file/)
  assert.equal(p.includes('bash scripts/test-all.sh'), false, 'the relay never runs the test command itself')
  // tracker record comes AFTER the tracker and BEFORE the watchdog
  const order = find('').map(c => c.label)
  assert.ok(order.indexOf('test-record:h:tracker') > order.indexOf('tracker:h'))
  assert.ok(order.indexOf('test-record:h:tracker') < order.findIndex(l => l.startsWith('watchdog:')))
  assert.ok(logs.some(l => /🧪 test record \(tracker\) bbbbbbbbbbbb: PASS — test-all: 1 passed, 0 failed \[ran in repo\] log /.test(l)))
  // the Tracker is told the record, not its report, gates Certify
  const trk = find('tracker:')[0].prompt
  assert.match(trk, /PIPELINE TEST RECORD: after you return TESTS_PASS the pipeline itself runs bash scripts\/test-all\.sh at the committed HEAD/)
  assert.match(trk, /commit EVERY test file before returning/)
})

test('run-observability AC8: a FAILING tracker record bounces at Test even though Tracker said TESTS_PASS — no Certify', async () => {
  const { result, find, logs } = await runHunt({ answers: { 'test-record': (p) => recordAnswer(stageOf(p), { pass: false, summary: 'test-all: 33 passed, 1 failed', reason: 'suite exit 1' }) } })
  assert.equal(result.verdict, 'TESTS_FAIL', JSON.stringify(result))
  assert.equal(result.testRecord.pass, false)
  assert.equal(result.testRecord.stage, 'tracker')
  assert.equal(result.testRecord.commit, REC_SHA)
  assert.equal(result.testRecord.summary, 'test-all: 33 passed, 1 failed')
  assert.equal(find('watchdog').length, 0)
  assert.equal(find('usage-gate:h:Certify').length, 0)
  assert.equal(find('test-rewrite').length, 1)
  assert.ok(logs.some(l => /⛔ pipeline test record FAILED at b{40}: test-all: 33 passed, 1 failed \(Tracker reported TESTS_PASS\) — bouncing at Test; Certify not entered/.test(l)))
})

test('run-observability AC8: the bounce routes to Implement, whose rewrite directive points at the record log', async () => {
  const probe = { fresh: false, status: 'test_rewrite_needed', resumePhase: 'Implement', tier: 'Yellow',
    worktreePath: WT, planDir: PD, worktreeExists: true, branchExists: true, trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }
  const { find } = await runHunt({ answers: { 'resume-probe': probe } })
  const shep = [...find('shepherd:'), ...find('shepherd-rewrite')].map(c => c.prompt).join('\n')
  assert.ok(shep.includes(`If ${PD}/test-record-tracker.json exists with "pass": false, the PIPELINE's full-suite run failed (Tracker may have reported a pass) — read ${PD}/test-record-tracker.log first`), 'rewrite directive')
})

test('run-observability AC8: an UNTRUSTED record fails closed → parked:test_record_error (never a bounce, never certified)', async () => {
  const cases = [
    ['commit ≠ head', { head: 'c'.repeat(40) }],
    ['short commit', { commit: 'abc', head: 'abc' }],
    ['command mismatch', { command: 'true' }],
    ['verdict command mismatch', { verdict_command: 'exit 0' }],
    ['stage mismatch', { stage: 'final' }],
    ['exit/pass disagree', { exitCode: 0, pass: false }],
    ['exit 2 but pass', { exitCode: 2 }],
    ['script infra error', { exitCode: 1 }],
    ['non-integer exit', { exit: '0' }],
    ['no log', { log: '' }],
  ]
  for (const [name, over] of cases) {
    const { result, find } = await runHunt({ answers: { 'test-record': (p) => {
      const a = recordAnswer(stageOf(p), over)
      if (over.stage) { const o = JSON.parse(a.output); o.stage = over.stage; a.output = JSON.stringify(o) }
      return a
    } } })
    assert.equal(result.status, 'parked:test_record_error', `${name}: ${JSON.stringify(result)}`)
    assert.equal(result.resumePhase, 'Test', name)
    assert.equal(find('watchdog').length, 0, name)
    assert.equal(find('test-rewrite').length, 0, name)
    assert.match(find('park:h:test_record_error')[0].prompt, /resume_phase: Test/, name)
  }
  for (const out of [{ exitCode: 0, output: 'garbled, no json' }, { exitCode: 5, output: '{}' }]) {
    const { result } = await runHunt({ answers: { 'test-record': out } })
    assert.equal(result.status, 'parked:test_record_error', JSON.stringify(out))
  }
})

test('run-observability AC8: a test-record relay that returns null 3x parks model_quota at Test', async () => {
  const { result, find, logs } = await runHunt({ answers: { 'test-record': () => null } })
  assert.equal(result.status, 'parked:model_quota')
  assert.equal(result.resumePhase, 'Test')
  assert.equal(find('test-record:h:tracker').length, 3)
  assert.equal(find('watchdog').length, 0)
  assert.ok(logs.some(l => /↻ test-record:h:tracker dropped mid-response — retry 3\/3/.test(l)))
  assert.match(find('park:h:model_quota')[0].prompt, /resume_phase: Test/)
})

test('run-observability AC8: a non-PASS Tracker verdict takes no record (the Tracker bounce is enough)', async () => {
  const { find, result } = await runHunt({ answers: { tracker: { verdict: 'REWRITE_NEEDED' } } })
  assert.equal(find('test-record').length, 0)
  assert.notEqual(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
})

test('run-observability AC9: a fresh run takes exactly ONE tracker record (no second one at Certify); the Watchdog reuses it', async () => {
  const { find } = await runHunt({})
  assert.equal(find('test-record:h:tracker').length, 1)
  assert.equal(find('test-record:h:tracker')[0].opts.phase, 'Test')
  const wd = find('watchdog:')[0].prompt
  assert.ok(wd.includes(`${PD}/test-record-tracker.json`))
  assert.match(wd, /Run git rev-parse HEAD: if it EQUALS the record's "commit", the record IS this certification's test result/)
  assert.match(wd, /do NOT re-run the full suite/)
  assert.doesNotMatch(wd, /and the project's test command yourself\./)
  assert.match(wd, /After this commit the pipeline re-takes the record at the FINAL HEAD \(test-record-final\.json\)/)
})

test('run-observability AC9: a resume at Certify takes the tracker record at Certify entry (reused when HEAD did not move); a failing one bounces', async () => {
  const reused = await runHunt({ answers: { 'resume-probe': RESUME_AT_CERTIFY, 'test-record': (p) => recordAnswer(stageOf(p), { reused: true }) } })
  const t = reused.find('test-record:h:tracker')
  assert.equal(t.length, 1)
  assert.equal(t[0].opts.phase, 'Certify')
  assert.equal(reused.find('tracker:').length, 0)
  assert.ok(reused.logs.some(l => /🧪 test record \(tracker\) .*\[reused in repo\]/.test(l)))
  const order = reused.calls.map(c => c.label)
  assert.ok(order.indexOf('usage-gate:h:Certify') < order.indexOf('test-record:h:tracker'))
  assert.ok(order.indexOf('test-record:h:tracker') < order.findIndex(l => l.startsWith('watchdog:')))
  assert.equal(reused.result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  const failing = await runHunt({ answers: { 'resume-probe': RESUME_AT_CERTIFY, 'test-record': (p) => recordAnswer(stageOf(p), { pass: false, summary: 'x failed' }) } })
  assert.equal(failing.result.verdict, 'TESTS_FAIL')
  assert.equal(failing.find('watchdog').length, 0)
  assert.equal(failing.find('test-rewrite').length, 1)
  const dead = await runHunt({ answers: { 'resume-probe': RESUME_AT_CERTIFY, 'test-record': () => null } })
  assert.equal(dead.result.status, 'parked:model_quota')
  assert.equal(dead.result.resumePhase, 'Certify')
})

test('run-observability AC10: the FINAL record is taken at Verify entry after the Watchdog; a pass certifies', async () => {
  const { result, find, calls } = await runHunt({})
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  const f = find('test-record:h:final')
  assert.equal(f.length, 1)
  assert.ok(f[0].prompt.includes(`ensure --json --stage final --record-dir '${PD}' --repo '${WT}'`))
  const order = calls.map(c => c.label)
  const fi = order.indexOf('test-record:h:final')
  assert.ok(fi > order.findIndex(l => l.startsWith('watchdog:')))
  assert.ok(fi < order.indexOf('compliance-gate:h'), 'before the compliance gate')
  assert.ok(fi < order.indexOf('verify:h'))
})

test('run-observability AC10: a FAILING final record parks final_test_record_failed — never CERTIFIED, no verify', async () => {
  const { result, find } = await runHunt({ answers: { 'test-record': (p) => recordAnswer(stageOf(p), stageOf(p) === 'final' ? { pass: false, summary: 'test-all: 38 passed, 1 failed' } : {}) } })
  assert.equal(result.status, 'parked:final_test_record_failed', JSON.stringify(result))
  assert.equal(result.verdict, 'PARKED')
  assert.equal(result.reason, 'final_test_record_failed')
  assert.equal(result.testRecord.stage, 'final')
  assert.equal(result.testRecord.pass, false)
  assert.equal(find('verify').length + find('compliance-gate').length, 0)
  const park = find('park:h:final_test_record_failed')[0].prompt
  assert.match(park, /resume_phase: Verify/)
  assert.match(park, /redirect/)
  assert.match(park, /The full suite FAILS at the final HEAD b{40} \(after the certify commit\) — test-all: 38 passed, 1 failed\. The hunt is NOT mergeable/)
  assert.ok(park.includes(`record: ${PD}/test-record-final.json`))
  // an untrusted / dead final record parks at Verify too
  const err = await runHunt({ answers: { 'test-record': (p) => recordAnswer(stageOf(p), stageOf(p) === 'final' ? { command: 'true' } : {}) } })
  assert.equal(err.result.status, 'parked:test_record_error')
  assert.equal(err.result.resumePhase, 'Verify')
  const dead = await runHunt({ answers: { 'test-record': (p) => (stageOf(p) === 'final' ? null : recordAnswer('tracker')) } })
  assert.equal(dead.result.status, 'parked:model_quota')
  assert.equal(dead.result.resumePhase, 'Verify')
})

test('run-observability AC10: a resume at Verify re-takes the final record (no watchdog, no tracker record)', async () => {
  const probe = { ...RESUME_AT_CERTIFY, status: 'certified', resumePhase: 'Verify' }
  const { find, result } = await runHunt({ answers: { 'resume-probe': probe } })
  assert.equal(find('watchdog').length, 0)
  assert.equal(find('test-record:h:tracker').length, 0)
  assert.equal(find('test-record:h:final').length, 1)
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
})

test('run-observability AC10: chain mode also takes the final record before its certified return; a failing one parks', async () => {
  const ok = await runHunt({ args: CHAIN_ARGS })
  assert.equal(ok.find('test-record:h:final').length, 1)
  assert.equal(ok.find('verify').length, 0)
  assert.match(ok.result.verdict, /^CERTIFIED/)
  assert.ok(Array.isArray(ok.result.usageGateEvents))
  const bad = await runHunt({ args: CHAIN_ARGS, answers: { 'test-record': (p) => recordAnswer(stageOf(p), stageOf(p) === 'final' ? { pass: false } : {}) } })
  assert.equal(bad.result.status, 'parked:final_test_record_failed')
})

test('run-observability: the parked skill registers usage_gate_error, test_record_error and final_test_record_failed (redirect) and the boundary model_quota', () => {
  const skill = readFileSync(join(PACK_ROOT, '.agents', 'skills', 'parked', 'SKILL.md'), 'utf8')
  for (const reason of ['usage_gate_error', 'test_record_error', 'final_test_record_failed']) {
    const row = skill.split('\n').find(l => new RegExp(`^\\|.*\`${reason}\``).test(l))
    assert.ok(row, `a ${reason} row`)
    assert.match(row, /redirect/, reason)
  }
  const q = skill.split('\n').find(l => /^\|.*`model_quota`/.test(l))
  assert.match(q, /phase boundary/)
})

// ════════════════════════════════════════════════════════════════════════════
// merge-and-state-hygiene AC13: a Tracker bounce loops back to Implement IN THIS RUN (bounded by
// tracker_rounds per budget window, then parks non_convergence); round numbers persist/continue.
// ════════════════════════════════════════════════════════════════════════════
const failThenPass = (fails) => (_p, _o, n) => ({ verdict: n <= fails ? 'TESTS_FAIL' : 'TESTS_PASS' })
const RESUME_BOUNCE = { fresh: false, resumePhase: 'Implement', tier: 'Yellow', worktreePath: WT, planDir: PD,
  worktreeExists: true, branchExists: true, trackerRounds: 1, pointerRounds: 1, bloodhoundRounds: 1 }
const trackerReports = (calls) => calls.map(c => (/tracker-report-(\d+)\.md/.exec(c.prompt) || [])[1])

test('AC13: Tracker TESTS_FAIL then PASS → loops Implement → Code Review → Test in the same run, then certifies', async () => {
  const { result, find, logs } = await runHunt({ answers: { tracker: failThenPass(1) } })
  assert.notEqual(result.verdict, 'TESTS_FAIL', JSON.stringify(result))
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY', JSON.stringify(result))
  const shep = find('shepherd:')
  assert.equal(shep.length, 2, 'fresh build + one bounce re-entry')
  assert.doesNotMatch(shep[0].prompt, /REWRITE ENTRY/)
  assert.match(shep[1].prompt, /REWRITE ENTRY — Tracker round 1 \(NOT a fresh build\)/)
  assert.ok(shep[1].prompt.includes(`${PD}/tracker-report-1.md`))
  const trk = find('tracker:')
  assert.equal(trk.length, 2)
  assert.deepEqual(trackerReports(trk), ['1', '2'], 'Tracker report numbering continues across the bounce')
  assert.match(trk[1].prompt, /This is Tracker round 2 of at most 2 in this budget window \(absolute round 2\)/)
  const tr = find('test-rewrite')
  assert.equal(tr.length, 1)
  assert.match(tr[0].prompt, /"tracker_round" = 1\b/)
  assert.equal(find('watchdog:').length, 1)
  assert.ok(logs.some(l => /↻ h: Tracker TESTS_FAIL \(round 1\/2\) — looping back to Implement in this run\./.test(l)), logs.join('\n'))
  // Pointer file numbering continues across the bounce: round 1 approved, the re-entry reviews as r2
  assert.deepEqual(find('pointer:').map(c => c.opts.label), ['pointer:h:r1:full', 'pointer:h:r2:full'])
  assert.ok(find('pointer:')[1].prompt.includes('pointer-review-2.md'))
  assert.equal(find('pointer:')[1].prompt.includes('pointer-review-1.md'), false, 'the second entry never overwrites round 1')
})

test('AC13: REWRITE_NEEDED bounces exactly like TESTS_FAIL', async () => {
  const { result, find } = await runHunt({ answers: { tracker: (_p, _o, n) => ({ verdict: n === 1 ? 'REWRITE_NEEDED' : 'TESTS_PASS' }) } })
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  assert.equal(find('shepherd:').length, 2)
})

test('AC13: the test-rewrite record persists tracker_round on EVERY bounce (the ALREADY clause is conditioned on the round)', async () => {
  const { result, find } = await runHunt({ answers: { alpha: { ...BASE.alpha, trackerRounds: 2 }, tracker: failThenPass(2) } })
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY', JSON.stringify(result))
  const tr = find('test-rewrite')
  assert.equal(tr.length, 2)
  assert.match(tr[0].prompt, /"tracker_round" = 1\b/)
  assert.match(tr[1].prompt, /"tracker_round" = 2\b/, 'a stale test_rewrite_needed status still persists the new round')
  for (const c of tr) {
    const already = c.prompt.split('\n').filter(l => /ALREADY/.test(l))
    assert.ok(already.length >= 1)
    for (const l of already) assert.match(l, /tracker_round/, `ALREADY clause must name tracker_round: ${l}`)
    assert.doesNotMatch(c.prompt, /ALREADY "test_rewrite_needed", leave the file unchanged/, 'no unconditional no-op')
    assert.doesNotMatch(c.prompt, /do NOT alter tracker_round\b(?!s)/)
  }
  assert.deepEqual(trackerReports(find('tracker:')), ['1', '2', '3'])
  assert.equal(find('shepherd:').length, 3)
})

test('AC13: Tracker always failing → bounces tracker_rounds times, then parks non_convergence (never certifies)', async () => {
  const { result, find, logs } = await runHunt({ answers: { tracker: { verdict: 'TESTS_FAIL' } } })
  assert.equal(result.status, 'parked:non_convergence', JSON.stringify(result))
  assert.equal(result.verdict, 'PARKED')
  assert.equal(find('tracker:').length, 2, 'trackerRounds 1 → at most 2 Tracker runs')
  assert.equal(find('shepherd:').length, 2)
  assert.equal(find('watchdog:').length, 0)
  assert.equal(find('verify').length, 0)
  const park = find('park:h:non_convergence')
  assert.equal(park.length, 1)
  assert.match(park[0].prompt, /"tracker_cap_park_round" = 2\b/)
  assert.match(park[0].prompt, /resume_phase: Implement/)
  assert.ok(park[0].prompt.includes(`${PD}/tracker-report-2.md`))
  assert.ok(logs.some(l => /tests still failing after 1 Tracker bounce\(s\) \(cap 1\)\. Parking non_convergence/.test(l)), logs.join('\n'))
})

test('AC13 (A9): the Pointer half already reworks in-run — ISSUES_FOUND then APPROVED → one shepherd-rewrite, then Test + Certify', async () => {
  const { result, find } = await runHunt({ answers: {
    alpha: { ...BASE.alpha, pointerRounds: 2 },
    pointer: issuesThenApprove,
    'shepherd-rewrite': { findingsAddressed: [{ id: 1, disposition: 'ACCEPTED', justification: 'x' }], allAddressed: true },
  } })
  assert.equal(find('shepherd-rewrite').length, 1)
  assert.equal(find('tracker:').length, 1)
  assert.equal(find('watchdog:').length, 1)
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
})

test('AC13 resume: test_rewrite_needed names the round DONE (trackerRoundDone), not the cap; the next Tracker continues the numbering', async () => {
  const { find } = await runHunt({ answers: {
    'resume-probe': { ...RESUME_BOUNCE, status: 'test_rewrite_needed', trackerRounds: 3, trackerRoundDone: 2, trackerCapParkRound: 0 },
  } })
  const s = find('shepherd:')[0].prompt
  assert.match(s, /REWRITE ENTRY — Tracker round 2 /)
  assert.ok(s.includes(`${PD}/tracker-report-2.md`))
  assert.equal(s.includes('tracker-report-3.md'), false, 'the cap (3) is not the round number')
  assert.deepEqual(trackerReports(find('tracker:')), ['3'])
})

test('AC13 resume: code_rewrite_needed names pointerRoundDone (not the pointerRounds cap); falls back to the cap when absent', async () => {
  const a = await runHunt({ answers: { 'resume-probe': { ...RESUME_BOUNCE, status: 'code_rewrite_needed', pointerRounds: 2, pointerRoundDone: 1 } } })
  const sa = a.find('shepherd:')[0].prompt
  assert.match(sa, /REWRITE ENTRY — Pointer round 1 /)
  assert.ok(sa.includes(`${PD}/pointer-review-1.md`))
  assert.equal(sa.includes('pointer-review-2.md'), false)
  // the next Pointer entry continues the numbering after the round done
  assert.equal(a.find('pointer:')[0].opts.label, 'pointer:h:r2:full')
  const b = await runHunt({ answers: { 'resume-probe': { ...RESUME_BOUNCE, status: 'code_rewrite_needed', pointerRounds: 2 } } })
  assert.match(b.find('shepherd:')[0].prompt, /REWRITE ENTRY — Pointer round 2 /)
})

test('AC13 cap-park rework: rework_needed after a Tracker-cap park → REWRITE ENTRY for that report + the human notes; a Watchdog REWORK stays a fresh build', async () => {
  const cap = await runHunt({ answers: { 'resume-probe': { ...RESUME_BOUNCE, status: 'rework_needed', trackerRoundDone: 2, trackerCapParkRound: 2 } } })
  const s = cap.find('shepherd:')[0].prompt
  assert.match(s, /REWRITE ENTRY — Tracker round 2 /)
  assert.ok(s.includes(`${PD}/tracker-report-2.md`))
  assert.ok(s.includes(`${PD}/human-notes.md (LAST dated HUMAN block) overrides the report`))
  for (const capRound of [0, 1]) {   // no cap park, or a Tracker run since it (trackerRoundDone 2 > 1)
    const wd = await runHunt({ answers: { 'resume-probe': { ...RESUME_BOUNCE, status: 'rework_needed', trackerRoundDone: 2, trackerCapParkRound: capRound } } })
    assert.doesNotMatch(wd.find('shepherd:')[0].prompt, /REWRITE ENTRY/, `capPark ${capRound}`)
  }
})

test('AC13 budget window: resolving a Tracker-cap park opens a FRESH budget; numbering continues (3, 4)', async () => {
  const probe = { ...RESUME_BOUNCE, status: 'rework_needed', trackerRounds: 1, trackerRoundDone: 2, trackerCapParkRound: 2 }
  const ok = await runHunt({ answers: { 'resume-probe': probe, tracker: failThenPass(1) } })
  assert.equal(ok.result.verdict, 'CERTIFIED_AWAITING_DEPLOY', JSON.stringify(ok.result))
  assert.deepEqual(trackerReports(ok.find('tracker:')), ['3', '4'])
  assert.match(ok.find('tracker:')[0].prompt, /This is Tracker round 1 of at most 2 in this budget window \(absolute round 3\)/)
  assert.equal(ok.find('park:h:non_convergence').length, 0)
  assert.equal(ok.find('watchdog:').length, 1)
  const bad = await runHunt({ answers: { 'resume-probe': probe, tracker: { verdict: 'TESTS_FAIL' } } })
  assert.equal(bad.result.status, 'parked:non_convergence')
  assert.equal(bad.find('tracker:').length, 2, 'the fresh window allows exactly trackerRounds + 1 runs')
  assert.match(bad.find('park:h:non_convergence')[0].prompt, /"tracker_cap_park_round" = 4\b/)
})

test('AC13 budget window: option B (code_reviewed → re-run Test) after a cap park also gets the fresh window', async () => {
  const probe = { ...RESUME_BOUNCE, status: 'code_reviewed', resumePhase: 'Test', trackerRounds: 1, trackerRoundDone: 2, trackerCapParkRound: 2 }
  const { result, find } = await runHunt({ answers: { 'resume-probe': probe, tracker: failThenPass(1) } })
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY', JSON.stringify(result))
  assert.equal(find('shepherd:').length, 1, 'one in-run bounce to Implement')
  assert.match(find('shepherd:')[0].prompt, /REWRITE ENTRY — Tracker round 3 /)
})

test('AC13 crash resume: no park in between opens NO fresh budget — a relaunch never buys extra bounces', async () => {
  const probe = { ...RESUME_BOUNCE, status: 'test_rewrite_needed', trackerRounds: 1, trackerRoundDone: 1, trackerCapParkRound: 0 }
  const { result, find } = await runHunt({ answers: { 'resume-probe': probe, tracker: { verdict: 'TESTS_FAIL' } } })
  assert.equal(result.status, 'parked:non_convergence', JSON.stringify(result))
  assert.equal(find('tracker:').length, 1, 'window round 2 > cap 1 on the first run after the relaunch')
  assert.match(find('park:h:non_convergence')[0].prompt, /"tracker_cap_park_round" = 2\b/)
})

test('AC13: the resume probe reports pointerRoundDone / trackerRoundDone / trackerCapParkRound (prompt + schema)', async () => {
  const { find } = await runHunt({})
  const rp = find('resume-probe')[0]
  for (const k of ['pointerRoundDone', 'trackerRoundDone', 'trackerCapParkRound']) {
    assert.match(rp.prompt, new RegExp(`- ${k}: metadata\\.`), k)
    assert.equal(rp.opts.schema.properties[k].type, 'number', k)
  }
})

test('AC13: the parked skill routes a Tracker-cap non_convergence park (rework_needed / code_reviewed, counters untouched)', () => {
  const s = readFileSync(join(PACK_ROOT, '.agents', 'skills', 'parked', 'SKILL.md'), 'utf8')
  assert.match(s, /A Tracker-cap `non_convergence` park \(parked at Test, `resume_phase: Implement`\) → `rework_needed`/)
  assert.match(s, /Leave `tracker_round` \/ `tracker_cap_park_round`\s+untouched/)
})

// ─── merge-and-state-hygiene AC7: proposed_version changes only through wolfpack-version.mjs ───
test('AC7: every prompt that mentions proposed_version (bar the scaffold) carries the wolfpack-version.mjs set rule', async () => {
  const { calls, find } = await runHunt({})
  const hits = calls.filter(c => /proposed_version/.test(c.prompt) && !c.label.startsWith('scaffold'))
  assert.ok(hits.length >= 3, hits.map(c => c.label).join(', '))
  for (const c of hits) assert.ok(c.prompt.includes("wolfpack-version.mjs' set --plan-dir"), c.label)
  for (const p of ['alpha:', 'debrief', 'watchdog:']) {
    assert.match(find(p)[0].prompt, /VERSION PROVENANCE \(hard rule\): never hand-edit metadata\.proposed_version/, p)
  }
  assert.ok(find('alpha:')[0].prompt.includes("'/pack/scripts/wolfpack-version.mjs' set --plan-dir '"), 'the pack script, shq-quoted')
  assert.match(find('scaffold')[0].prompt, /proposed_version: \{ bump: null, tag: null, set_by: null \}/)
  assert.match(SRC, /the LAST dated HUMAN block is the current direction \(a block headed \\`SEAT NOTE \(not\s+human direction\)\\`/)
  const runner = readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
  assert.doesNotMatch(runner, /proposed_version["']?\s*[=:]/, 'campaign-runner.js never writes proposed_version')
})

test('AC7: an Alpha revision round also carries the provenance rule', async () => {
  const { find } = await runHunt({ answers: { bloodhound: (_p, _o, n) => (n === 1
    ? { verdict: 'ISSUES_FOUND', findings: 1, findingsList: [FINDING], provider: 'glm', status: 'glm' }
    : { verdict: 'APPROVED', findings: 0, findingsList: [], provider: 'glm', status: 'glm' }),
    alpha: { ...BASE.alpha, bloodhoundRounds: 2 } } })
  const rev = find('alpha-revise')
  assert.ok(rev.length >= 1)
  assert.match(rev[0].prompt, /VERSION PROVENANCE \(hard rule\)/)
})

// ─── merge-and-state-hygiene AC16: Certify uses the worktree shim when the hunt changes it ───
const certShimPathFn = () => {
  const lines = SRC.split('\n')
  const i = lines.findIndex(l => l.startsWith('const SHIM_SOURCES = '))
  const body = lines.slice(i, i + 4).join('\n')   // SHIM_SOURCES + the 3-line certShimPath arrow
  return new Function(`${body}\nreturn { SHIM_SOURCES, certShimPath }`)()
}

test('AC16: certShimPath picks the worktree shim only when the diff touches a shim source AND the worktree holds a shim', () => {
  const { SHIM_SOURCES, certShimPath } = certShimPathFn()
  assert.deepEqual(SHIM_SOURCES, ['scripts/podman-vibe.sh', 'scripts/lib/wolfpack-ratelimit.sh', 'scripts/lib/wolfpack-sandbox.sh'])
  const base = { packShim: '/pack/scripts/podman-vibe.sh', worktreePath: WT }
  for (const f of SHIM_SOURCES) {
    assert.equal(certShimPath({ ...base, changed: [f], worktreeShimExists: true }), `${WT}/scripts/podman-vibe.sh`, f)
  }
  assert.equal(certShimPath({ ...base, changed: [], worktreeShimExists: true }), base.packShim, 'no shim change')
  assert.equal(certShimPath({ ...base, changed: ['scripts/other.sh'], worktreeShimExists: true }), base.packShim, 'unrelated change')
  assert.equal(certShimPath({ ...base, changed: ['scripts/podman-vibe.sh'], worktreeShimExists: false }), base.packShim, 'shim absent in the worktree')
  assert.equal(certShimPath({ ...base, changed: ['scripts/podman-vibe.sh'], worktreeShimExists: 'yes' }), base.packShim, 'only boolean true counts')
  assert.equal(certShimPath({ ...base, changed: null, worktreeShimExists: true }), base.packShim)
})

test('AC16: a hunt that changes the shim certifies on the WORKTREE shim; review seats keep the pack shim', async () => {
  const { find, logs, result } = await runHunt({ answers: { 'cert-shim-probe': { changed: ['scripts/podman-vibe.sh'], worktreeShimExists: true } } })
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY')
  const wd = find('watchdog:')[0].prompt
  assert.ok(hasHandoffCall(wd, `'${WT}/scripts/podman-vibe.sh'`, ' wolfpack-watchdog-glm '), 'GLM certify on the worktree shim')
  assert.ok(hasHandoffCall(wd, `'${WT}/scripts/podman-vibe.sh'`, ' wolfpack-watchdog '), 'Mistral certify on the worktree shim')
  assert.equal(wd.includes(`'/pack/scripts/podman-vibe.sh'`), false)
  assert.ok(find('pointer:')[0].prompt.includes(`'/pack/scripts/podman-vibe.sh'`), 'the Pointer keeps the pack shim')
  assert.ok(logs.some(l => l.startsWith(`Certify seat shim: ${WT}/scripts/podman-vibe.sh (the hunt worktree shim`)), logs.join('\n'))
  const probe = find('cert-shim-probe')[0]
  assert.equal(probe.opts.label, 'cert-shim-probe:h')
  assert.equal(probe.opts.model, 'sonnet')
  assert.match(probe.prompt, /Read-only probe\. Do NOT modify/)
  assert.ok(probe.prompt.includes(`diff --name-only main..HEAD -- 'scripts/podman-vibe.sh' 'scripts/lib/wolfpack-ratelimit.sh' 'scripts/lib/wolfpack-sandbox.sh'`), probe.prompt)
})

test('AC16: the default (no shim change) certifies on the pack shim and logs why', async () => {
  const { find, logs } = await runHunt({})
  assert.ok(hasHandoffCall(find('watchdog:')[0].prompt, `'/pack/scripts/podman-vibe.sh'`, ' wolfpack-watchdog '))
  assert.ok(logs.some(l => l.startsWith('Certify seat shim: /pack/scripts/podman-vibe.sh (the pack shim')), logs.join('\n'))
  assert.equal(find('cert-shim-probe-retry').length, 0, 'a valid first answer needs no retry')
})

test('AC16: an invalid probe answer is retried ONCE; still invalid → parks cert_shim_probe_failed (fail closed), never certifies', async () => {
  for (const bad of [{}, null, { changed: 'scripts/podman-vibe.sh', worktreeShimExists: true }, { changed: [], worktreeShimExists: 'no' }]) {
    const { result, find } = await runHunt({ answers: { 'cert-shim-probe': () => bad } })
    assert.equal(result.status, 'parked:cert_shim_probe_failed', JSON.stringify(bad))
    assert.equal(find('cert-shim-probe').length, 2, 'probe + one retry')
    assert.equal(find('cert-shim-probe-retry').length, 1)
    assert.equal(find('watchdog:').length, 0)
    assert.equal(find('verify').length, 0)
    assert.match(find('park:h:cert_shim_probe_failed')[0].prompt, /resume_phase: Certify/)
  }
})

test('AC16: an invalid first answer then a valid retry certifies with the RETRY\'s shim', async () => {
  const { result, find } = await runHunt({ answers: {
    'cert-shim-probe': (_p, o) => (o.label.startsWith('cert-shim-probe-retry') ? { changed: ['scripts/lib/wolfpack-sandbox.sh'], worktreeShimExists: true } : {}),
  } })
  assert.equal(result.verdict, 'CERTIFIED_AWAITING_DEPLOY', JSON.stringify(result))
  assert.ok(hasHandoffCall(find('watchdog:')[0].prompt, `'${WT}/scripts/podman-vibe.sh'`, ' wolfpack-watchdog '))
})

test('AC16: the parked skill registers cert_shim_probe_failed (clarify → re-run Certify)', () => {
  const skill = readFileSync(join(PACK_ROOT, '.agents', 'skills', 'parked', 'SKILL.md'), 'utf8')
  const row = skill.split('\n').find(l => /^\|.*`cert_shim_probe_failed`/.test(l))
  assert.ok(row)
  assert.match(row, /clarify → re-run Certify/)
})

// ── wave-auto-smoke (A-7/A-8): test isolation for stage fix/polish hunts; busy re-takes ──────
const ISO_CONFIG = { ...FIXTURE_CONFIG, integrationTestArgs: '--isolated-db {campaign}' }
const ISO_CMD = "bash scripts/test-all.sh --isolated-db 'c1'"
const isoRecord = (over = {}) => (p) => recordAnswer(stageOf(p), { command: ISO_CMD, ...over })

test('wave-auto-smoke: testIsolation → every test-command mention is the composed isolated command; the record must carry it', async () => {
  const { result, find, logs } = await runHunt({ args: { testIsolation: 'c1' },
    answers: { 'project-config': configAnswer(ISO_CONFIG), 'test-record': isoRecord() } })
  assert.notEqual(result.status, 'parked:test_record_error', JSON.stringify(result))
  const tr = find('tracker:')[0].prompt
  assert.ok(tr.includes(`- Run tests using: ${ISO_CMD}`), tr)
  assert.ok(tr.includes(`the pipeline itself runs ${ISO_CMD} at the committed HEAD`))
  assert.ok(tr.includes(`Tests run ONLY via \`${ISO_CMD}\``), 'the TOOLING POLICY line')
  const sh = find('shepherd:')[0].prompt
  assert.ok(sh.includes(`NEVER invoke the project's test command (\`${ISO_CMD}\`)`))
  assert.ok(logs.some(l => l === `🧪 h: tests run on the isolated test DB of c1 (${ISO_CMD})`), logs.join('\n'))
  // a record taken with the PLAIN command is not this hunt's record → fail closed
  const plain = await runHunt({ args: { testIsolation: 'c1' }, answers: { 'project-config': configAnswer(ISO_CONFIG) } })
  assert.equal(plain.result.status, 'parked:test_record_error')
})

test('wave-auto-smoke: no isolation → exactly the configured test command (every non-fix hunt is unchanged)', async () => {
  const { find } = await runHunt({ answers: { 'project-config': configAnswer(ISO_CONFIG) } })
  const tr = find('tracker:')[0].prompt
  assert.ok(tr.includes('- Run tests using: bash scripts/test-all.sh\n'), tr)
  assert.doesNotMatch(tr, /--isolated-db/)
})

test('wave-auto-smoke: the stored metadata.test_isolation sticks on resume; a conflicting arg / bad value / missing Integration test args fail loud', async () => {
  const resumed = await runHunt({ answers: { 'project-config': configAnswer(ISO_CONFIG), 'test-record': isoRecord(),
    'resume-probe': (p) => ({ fresh: true, testIsolation: 'c1' }) } })
  assert.ok(resumed.find('tracker:')[0].prompt.includes(`- Run tests using: ${ISO_CMD}`))
  assert.match(resumed.find('resume-probe:')[0].prompt, /testIsolation: metadata\.test_isolation if a non-empty string, else ""/)
  await assert.rejects(runHunt({ args: { testIsolation: 'c2' }, answers: { 'project-config': configAnswer(ISO_CONFIG), 'resume-probe': { fresh: true, testIsolation: 'c1' } } }),
    /test_isolation c1 ≠ args\.testIsolation c2/)
  for (const bad of ['Bad', 'c1;rm', 'a'.repeat(42)]) {
    await assert.rejects(runHunt({ args: { testIsolation: bad } }), /invalid testIsolation/, bad)
  }
  await assert.rejects(runHunt({ answers: { 'resume-probe': { fresh: true, testIsolation: 'Bad Name' } } }), /metadata\.test_isolation .* is invalid/)
  await assert.rejects(runHunt({ args: { testIsolation: 'c1' } }), /has test isolation c1 but wolfpack-config\.md has no Project Identity → Integration test args/)
})

test('wave-auto-smoke A-8: a tempfail (exit 75) record is re-taken at once and never scored as a Test bounce', async () => {
  const { result, find, logs } = await runHunt({ answers: { 'test-record': (p, o, n) => recordAnswer(stageOf(p),
    stageOf(p) === 'tracker' && n <= 2 ? { pass: false, tempfail: true, exit: 75, summary: 'test DB busy' } : {}) } })
  assert.notEqual(result.status, 'parked:test_record_error', JSON.stringify(result))
  assert.equal(find('test-record:h:tracker').length, 3)
  assert.ok(logs.some(l => l === '↻ test-record:h:tracker test DB busy — retry 1/8'), logs.join('\n'))
  assert.ok(logs.some(l => l === '↻ test-record:h:tracker test DB busy — retry 2/8'))
  assert.equal(find('shepherd:').length, 1, 'no Implement bounce for a busy record')
})

test('wave-auto-smoke A-8: MAX_BUSY_RETRIES exhausted → fail closed test_record_error (9 records, no bounce)', async () => {
  const { result, find, logs } = await runHunt({ answers: { 'test-record': (p) => recordAnswer(stageOf(p), { pass: false, tempfail: true, exit: 75 }) } })
  assert.equal(result.status, 'parked:test_record_error')
  assert.equal(find('test-record:h:tracker').length, 9)
  assert.ok(logs.some(l => /test DB busy 9 times — giving up/.test(l)), logs.join('\n'))
  assert.equal(find('shepherd:').length, 1)
})
