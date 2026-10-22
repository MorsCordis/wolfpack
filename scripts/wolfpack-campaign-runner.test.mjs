#!/usr/bin/env node
// scripts/wolfpack-campaign-runner.test.mjs — scenario tests for the in-runner USAGE GATE
// (usage-limit-gate AC5/AC6) in .agents/workflows/campaign-runner.js.
// Run: node --test scripts/wolfpack-campaign-runner.test.mjs
//
// Same stub technique as wolfpack-hunt-pipeline.test.mjs: the WHOLE runner body runs for
// real with agent / workflow / log / phase / budget stubbed. Every agent() and workflow()
// call is appended to one ordered event log, so a test can assert that the gate ran once
// per NEW hunt, BEFORE that hunt's workflow('hunt-pipeline'), and never while a hunt is
// mid-flight on the same worker.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripMeta, splitMeta, runtimeMetaRefs } from './lib/workflow-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// workflow-meta-runtime: load the way the Workflow runtime does — the `export const meta` block is
// REMOVED, not rewritten to `const meta` (which kept `meta` defined and hid a ReferenceError).
const RUNNER = stripMeta(readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8'))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const RETIRED_SYNC = ['wolfpack', 'sync', 'runtime'].join('-')   // built, so AC7's literal git grep stays empty

const PROCEED = { decision: 'proceed', exitCode: 0, source: 'live', degraded: false, offload: false,
  reason: '5h 20% < 80% start ceiling (Yellow); week 30% (pace +2)', reset_at: '2026-10-16T14:00:00.000Z',
  five_hour_pct: 20, seven_day_pct: 30, weekly_pace: 2 }
const OFFLOAD = { ...PROCEED, offload: true, offload_reason: 'weekly pace +16.4 points ahead', weekly_pace: 16.4 }
const DEFER5H = { decision: 'defer', exitCode: 10, source: 'live', degraded: false, offload: false,
  reason: '5h window: 85% ≥ 80% start ceiling (Yellow) — defer until the 5h window resets',
  reset_at: '2026-10-16T15:05:00.000Z', five_hour_pct: 85, seven_day_pct: 40, weekly_pace: 1 }
const DEFERWEEK = { ...DEFER5H, reason: 'weekly cap: 7d 92% ≥ 90% — defer all new hunts', reset_at: '2026-10-19T06:00:00.000Z' }
// The degraded shape: ONLY the schema-required fields (no figures, no offload).
const DEGRADED = { decision: 'proceed', exitCode: 0, source: 'transcript_estimate', degraded: true }

// wolfpack-self-hosting (AC10): the runner's project-config probe relays the reader's JSON.
// The default answer is a generic consumer WITH a deploy step; a scenario overrides it.
const FIXTURE_CONFIG = { name: 'fixture-project', testCommand: 'bash scripts/test-all.sh', worktreeLinks: [],
  complianceAreas: null, compliancePaths: [], devDeployCommand: 'deploy-x', changelogFile: 'CHANGELOG.md',
  tagPattern: 'v[0-9]*', backlogFile: 'TODO.md', missing: [], problems: [],
  wolfpackHome: '/pack',   // exec-layer-into-pack: Project Identity → Wolfpack home
  worktreeRoot: '.agents/worktrees' }   // pack-install-model: Project Identity → Worktree root (required)
// scripts-unfork: the probe also reports the PACK it ran the reader from (PACK_HOME=). Simulate the
// seat: the env leg's injected literal `PACK='<home>'` (shq-quoted) in the prompt wins; otherwise the
// seat copied the config key (the reader JSON's wolfpackHome). Callers pass the probe prompt.
const probePack = (prompt, keyHome) => {
  const m = /PACK='((?:[^']|'\\'')*)'; echo /.exec(prompt || '')   // env leg only (the key leg is now `PACK='<home>'; case`)
  return m ? m[1].replace(/'\\''/g, "'") : (typeof keyHome === 'string' ? keyHome : '')
}
const configAnswer = (cfg = FIXTURE_CONFIG, cwd = '/repo', prompt = '') =>
  ({ exitCode: 0, output: JSON.stringify(cfg, null, 2), cwd, pack: probePack(prompt, cfg.wolfpackHome) })
// pack-install-model (AC5): the runner's run-start stamp probe relays `wolfpack-workflows.mjs check --json`.
// Default: both workflows are the pack's canonical files, as the UNSTAMPED canonical RUNNER expects.
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

const hunt = (slug, extra = {}) => ({ slug, description: `do ${slug}`, tier: 'Yellow', mode: 'feature', dependsOn: [], status: 'ready_for_alpha', ...extra })
const tick = () => new Promise(r => setImmediate(r))

async function runRunner({ hunts, gate = () => PROCEED, maxParallel = 2, usageProtocol = 1, workflowDelayTicks = 3,
  capability, gatePresent = true, gateProtocol = 1, depCheck = { allMerged: true }, workflowResult = (a) => ({ slug: a.slug, verdict: 'CERTIFIED_AWAITING_DEPLOY' }),
  projectConfig = (p) => configAnswer(undefined, undefined, p), stamp = () => stampAnswer(), env = {} } = {}) {
  const events = []
  const logs = []
  const gateCalls = []
  const workflowCalls = []
  const inFlight = new Set()
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    events.push({ type: 'agent', label })
    if (label === 'project-config') { events[events.length - 1].prompt = prompt; events[events.length - 1].opts = opts; return projectConfig(prompt) }
    if (label === 'workflow-stamp') { events[events.length - 1].prompt = prompt; events[events.length - 1].opts = opts; return stamp() }
    if (label === 'parse-campaign') return { waves: [{ number: 1, hunts }] }
    if (label === 'pipeline-capability') {
      events[events.length - 1].prompt = prompt
      events[events.length - 1].opts = opts
      if (capability !== undefined) return capability
      return { path: '.claude/workflows/hunt-pipeline.js', protocol: 3, usageProtocol, gatePresent, gateProtocol }
    }
    if (label.startsWith('usage-gate:') || label.startsWith('usage-gate-legacy:')) {
      const slug = label.slice(label.indexOf(':') + 1)
      gateCalls.push({ slug, label, prompt, opts, inFlight: [...inFlight] })
      await tick()
      const v = gate(slug, gateCalls.length)
      return v == null ? null : JSON.parse(JSON.stringify(v))
    }
    if (label.startsWith('dep-check:')) return depCheck
    if (label === 'crosswave-dep-check') return { merged: [] }
    return {}
  }
  const workflow = async (name, a) => {
    workflowCalls.push({ name, args: a })
    events.push({ type: 'workflow-start', slug: a.slug })
    inFlight.add(a.slug)
    for (let i = 0; i < workflowDelayTicks; i++) await tick()
    inFlight.delete(a.slug)
    events.push({ type: 'workflow-end', slug: a.slug })
    return workflowResult(a)
  }
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'process', 'workflow', RUNNER)
  let result, error
  try {
    result = await fn({ campaign: 'c', maxParallel }, agent, async (f) => Promise.all(f.map(x => x())),
      (m) => logs.push(String(m)), () => {}, { total: 0, remaining: () => 1e12 }, { env }, workflow)
  } catch (e) { error = e }
  events.push({ type: 'return' })
  return { result, error, events, logs, gateCalls, workflowCalls }
}

// For each workflow-start, the hunt's own gate call happened EARLIER in the event log.
function assertGateBeforeEachWorkflow(events) {
  events.forEach((e, i) => {
    if (e.type !== 'workflow-start') return
    const gi = events.findIndex(x => x.type === 'agent' && x.label === `usage-gate:${e.slug}`)
    assert.ok(gi >= 0 && gi < i, `gate for ${e.slug} must precede its workflow (gate@${gi}, workflow@${i})`)
  })
}

test('AC5: the gate runs exactly once per NEW hunt, before its workflow — never mid-hunt', async () => {
  const { result, error, events, gateCalls, workflowCalls } = await runRunner({ hunts: [hunt('a'), hunt('b'), hunt('c')] })
  assert.equal(error, undefined, error && error.stack)
  assert.equal(result.verdict, 'WAVE_COMPLETE_AWAITING_RELEASE')
  assert.deepEqual(gateCalls.map(g => g.slug).sort(), ['a', 'b', 'c'])
  assert.equal(workflowCalls.length, 3)
  assertGateBeforeEachWorkflow(events)
  // never consulted again for a hunt that is already running
  for (const g of gateCalls) assert.equal(g.inFlight.includes(g.slug), false)
  for (const w of workflowCalls) assert.equal(w.args.usageOffload, null)
})

test('AC5: the gate agent is a READ-ONLY sonnet step running the gate with the normalised tier', async () => {
  const { gateCalls } = await runRunner({ hunts: [hunt('a', { tier: 'red' }), hunt('b', { tier: '' })], maxParallel: 1 })
  assert.equal(gateCalls.length, 2)
  for (const g of gateCalls) {
    assert.equal(g.opts.model, 'sonnet')
    assert.match(g.prompt, /READ-ONLY/)
    // scripts-unfork: the PACK's gate (FIXTURE_CONFIG Wolfpack home /pack), shq-quoted
    assert.ok(g.prompt.includes(`node '/pack/scripts/wolfpack-window-gate.mjs' --json --tier Red\n`), g.prompt)
    assert.doesNotMatch(g.prompt, /node scripts\/wolfpack-/)
    assert.match(g.prompt, /Never invent a proceed\/defer/)
    assert.deepEqual(g.opts.schema.required, ['decision', 'source', 'degraded', 'exitCode'])
    assert.deepEqual(g.opts.schema.properties.decision.enum, ['proceed', 'defer', 'error'])
  }
})

test('AC6: offload ⇒ usageOffload {reason} passed to hunt-pipeline for THAT hunt only', async () => {
  const { workflowCalls, logs } = await runRunner({
    hunts: [hunt('a'), hunt('b')], maxParallel: 1, gate: (slug) => (slug === 'b' ? OFFLOAD : PROCEED) })
  const by = Object.fromEntries(workflowCalls.map(w => [w.args.slug, w.args]))
  assert.equal(by.a.usageOffload, null)
  assert.deepEqual(by.b.usageOffload, { reason: 'weekly pace +16.4 points ahead' })
  assert.ok(logs.some(l => /usage gate b \(Yellow\): proceed \+ OFFLOAD/.test(l)), logs.join('\n'))
})

test('AC5: defer ⇒ WAVE_PAUSED_QUOTA with resetAt; no further workflow; the in-flight hunt finishes FIRST', async () => {
  const { result, error, events, workflowCalls, logs } = await runRunner({
    hunts: [hunt('a'), hunt('b'), hunt('c')], maxParallel: 2, workflowDelayTicks: 6,
    gate: (slug) => (slug === 'a' ? PROCEED : DEFER5H) })
  assert.equal(error, undefined, error && error.stack)
  assert.equal(result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.equal(result.completed, false)
  assert.equal(result.resetAt, DEFER5H.reset_at)
  assert.deepEqual(result.usage, { source: 'live', reason: DEFER5H.reason })
  assert.deepEqual(result.quotaDeferredHunts, [])
  assert.deepEqual(result.deferredHunts.map(h => h.slug), ['b', 'c'])
  assert.deepEqual(result.certifiedHunts, ['a'])
  assert.deepEqual(workflowCalls.map(w => w.args.slug), ['a'])
  // a was in flight when b deferred — it finished before the runner returned (AC5: nothing half-started)
  const endA = events.findIndex(e => e.type === 'workflow-end' && e.slug === 'a')
  const ret = events.findIndex(e => e.type === 'return')
  assert.ok(endA >= 0 && endA < ret)
  assert.ok(logs.some(l => /⛔ Usage gate: 5h window: 85%.*not starting b; resume after 2026-10-16T15:05:00\.000Z/.test(l)), logs.join('\n'))
  // c was never even gated once the pause was set
  assert.equal(events.filter(e => e.label === 'usage-gate:c').length, 0)
})

test('AC5: defer on the very first hunt ⇒ nothing scaffolded at all; weekly reset_at carried through', async () => {
  const { result, workflowCalls } = await runRunner({ hunts: [hunt('a'), hunt('b')], maxParallel: 1, gate: () => DEFERWEEK })
  assert.equal(result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.equal(result.resetAt, DEFERWEEK.reset_at)
  assert.match(result.usage.reason, /^weekly cap/)
  assert.equal(workflowCalls.length, 0)
  assert.deepEqual(result.deferredHunts.map(h => h.slug), ['a', 'b'])
})

test('AC5: gate FAILURE throws loud before scaffolding — null, error, exit 1 + fabricated proceed, defer with exit 0', async () => {
  const bad = {
    'null result': null,
    'decision error': { decision: 'error', exitCode: 1, source: '', degraded: true, reason: 'node: cannot find module' },
    'exit 1 + fabricated proceed': { ...PROCEED, exitCode: 1 },
    'defer with exit 0': { ...DEFER5H, exitCode: 0 },
    'proceed with exit 10': { ...PROCEED, exitCode: 10 },
    'exit -1 (did not run)': { decision: 'error', exitCode: -1, source: '', degraded: true, reason: 'missing' },
  }
  for (const [name, v] of Object.entries(bad)) {
    const { error, workflowCalls } = await runRunner({ hunts: [hunt('a'), hunt('b')], maxParallel: 1, gate: () => v })
    assert.ok(error, `${name}: must throw`)
    assert.match(error.message, /campaign-runner: usage gate unavailable \(.*\) — not starting a/, name)
    assert.equal(workflowCalls.length, 0, `${name}: nothing scaffolded`)
  }
})

test('AC5: a gate failure mid-pool lets the in-flight hunt FINISH, then throws (no half-started hunt)', async () => {
  const { error, events, workflowCalls } = await runRunner({
    hunts: [hunt('a'), hunt('b'), hunt('c')], maxParallel: 2, workflowDelayTicks: 6,
    gate: (slug) => (slug === 'a' ? PROCEED : null) })
  assert.ok(error)
  assert.match(error.message, /usage gate unavailable \(no schema-valid gate result\) — not starting b/)
  assert.deepEqual(workflowCalls.map(w => w.args.slug), ['a'])
  const endA = events.findIndex(e => e.type === 'workflow-end' && e.slug === 'a')
  assert.ok(endA >= 0 && endA < events.findIndex(e => e.type === 'return'))
})

test('AC5: degraded gate output (only decision/source/degraded/exitCode) ⇒ proceeds, DEGRADED log, no usageOffload', async () => {
  const { result, error, workflowCalls, logs } = await runRunner({ hunts: [hunt('a')], gate: () => DEGRADED })
  assert.equal(error, undefined, error && error.stack)
  assert.equal(result.verdict, 'WAVE_COMPLETE_AWAITING_RELEASE')
  assert.equal(workflowCalls.length, 1)
  assert.equal(workflowCalls[0].args.usageOffload, null)
  assert.ok(logs.some(l => /⚠ USAGE GATE DEGRADED \(a\)/.test(l)), logs.join('\n'))
  assert.ok(logs.some(l => /INACTIVE/.test(l)))
})

test('AC5: dependent hunts are gated too, and their workflow gains tier / mode / usageOffload', async () => {
  const { workflowCalls, events } = await runRunner({
    hunts: [hunt('a'), hunt('b', { dependsOn: ['a'], tier: 'Orange', mode: 'update' })], maxParallel: 2,
    gate: (slug) => (slug === 'b' ? OFFLOAD : PROCEED) })
  assertGateBeforeEachWorkflow(events)
  const b = workflowCalls.find(w => w.args.slug === 'b')
  assert.ok(b, 'dependent ran')
  assert.equal(b.args.tier, 'Orange')
  assert.equal(b.args.mode, 'update')
  assert.deepEqual(b.args.usageOffload, { reason: OFFLOAD.offload_reason })
  // gated AFTER the dep-check (a BLOCKED dependent never triggers a gate call)
  const dep = events.findIndex(e => e.label === 'dep-check:b')
  const gb = events.findIndex(e => e.label === 'usage-gate:b')
  assert.ok(dep >= 0 && dep < gb)
})

test('AC5: a deferred dependent ⇒ WAVE_PAUSED_QUOTA with the dependent tail deferred', async () => {
  const { result, workflowCalls } = await runRunner({
    hunts: [hunt('a'), hunt('b', { dependsOn: ['a'] }), hunt('c', { dependsOn: ['a'] })],
    gate: (slug) => (slug === 'a' ? PROCEED : DEFER5H) })
  assert.equal(result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.deepEqual(result.deferredHunts.map(h => h.slug), ['b', 'c'])
  assert.equal(result.resetAt, DEFER5H.reset_at)
  assert.deepEqual(workflowCalls.map(w => w.args.slug), ['a'])
})

test('AC5: a BLOCKED dependent (deps not merged) is never gated', async () => {
  const { gateCalls } = await runRunner({ hunts: [hunt('a'), hunt('b', { dependsOn: ['a'] })], depCheck: { allMerged: false, notMerged: ['a'], certified: ['a'] } })
  assert.deepEqual(gateCalls.map(g => g.slug), ['a'])
})

test('preflight: a runtime hunt-pipeline without WOLFPACK_USAGE_PROTOCOL ⇒ STALE PIPELINE warning (not a throw)', async () => {
  const stale = await runRunner({ hunts: [hunt('a')], usageProtocol: 0 })
  assert.equal(stale.error, undefined)
  assert.ok(stale.logs.some(l => /⚠ STALE PIPELINE: runtime hunt-pipeline predates the usage gate/.test(l)), stale.logs.join('\n'))
  const fresh = await runRunner({ hunts: [hunt('a')], usageProtocol: 1 })
  assert.equal(fresh.logs.some(l => /predates the usage gate/.test(l)), false)
})

test('claims stay serialised: with maxParallel 3 no hunt is claimed (or scaffolded) twice', async () => {
  const hs = ['a', 'b', 'c', 'd', 'e'].map(s => hunt(s))
  const { workflowCalls, gateCalls } = await runRunner({ hunts: hs, maxParallel: 3 })
  assert.deepEqual(workflowCalls.map(w => w.args.slug).sort(), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(gateCalls.map(g => g.slug).sort(), ['a', 'b', 'c', 'd', 'e'])
})

// ════════════════════════════════════════════════════════════════════════════
// Pointer r1 F2 / r2 F3 — capability preflight for the GATE SCRIPT and a null probe.
// ════════════════════════════════════════════════════════════════════════════
// The pre-usage-limit-gate gate's REAL --json output (captured from wolfpack main@2c6a94e
// scripts/wolfpack-window-gate.mjs, run with no limit configured). The agent adds exitCode.
const LEGACY_PROCEED = { decision: 'proceed', exitCode: 0, gateEnabled: false,
  reason: 'window gate DISABLED — set WOLFPACK_AGENT_WINDOW_LIMIT to enable rate-limit gating',
  used: null, remaining: null, reset_at: null }
const LEGACY_DEFER = { decision: 'defer', exitCode: 10, gateEnabled: true,
  reason: 'estimated 5h window: 900/1000 used — defer', used: 900, remaining: 100, reset_at: '2026-10-16T15:00:00.000Z' }

test('preflight probe: prompt greps WOLFPACK_GATE_PROTOCOL in the gate script; schema REQUIRES gatePresent + gateProtocol', async () => {
  const { events } = await runRunner({ hunts: [hunt('a')] })
  const cap = events.find(e => e.label === 'pipeline-capability')
  assert.ok(cap.prompt.includes(`test -f '/pack/scripts/wolfpack-window-gate.mjs' && echo present`), cap.prompt)
  assert.ok(cap.prompt.includes(`grep -o 'WOLFPACK_GATE_PROTOCOL=[0-9]*' '/pack/scripts/wolfpack-window-gate.mjs'`), cap.prompt)
  assert.doesNotMatch(cap.prompt, / scripts\/wolfpack-/, 'never the consuming repo copy')
  assert.deepEqual(cap.opts.schema.required, ['protocol', 'gatePresent', 'gateProtocol'])
  assert.equal(cap.opts.schema.properties.gatePresent.type, 'boolean')
  assert.equal(cap.opts.schema.properties.gateProtocol.type, 'number')
})

test('preflight: a current gate (protocol 1) logs capability OK and uses the full gate (no legacy)', async () => {
  const { error, logs, gateCalls } = await runRunner({ hunts: [hunt('a')] })
  assert.equal(error, undefined, error && error.stack)
  assert.ok(logs.some(l => /Usage gate capability OK: gate protocol 1/.test(l)), logs.join('\n'))
  assert.equal(logs.some(l => /STALE USAGE GATE/.test(l)), false)
  assert.equal(gateCalls[0].label, 'usage-gate:a')
})

test('preflight: a MISSING gate script throws ONCE, naming the fix — nothing gated, nothing scaffolded', async () => {
  const { error, gateCalls, workflowCalls, events } = await runRunner({ hunts: [hunt('a'), hunt('b')], gatePresent: false })
  assert.ok(error, 'must throw')
  assert.match(error.message, /\/pack\/scripts\/wolfpack-window-gate\.mjs is MISSING/)
  assert.match(error.message, /Fix: the pack at \/pack has no scripts\/wolfpack-window-gate\.mjs \(or it predates the usage gate\) — point WOLFPACK_HOME \/ Wolfpack home at an up-to-date wolfpack checkout, then relaunch\./)
  assert.ok(!error.message.includes(RETIRED_SYNC))
  assert.equal(gateCalls.length, 0)
  assert.equal(workflowCalls.length, 0)
  assert.equal(events.filter(e => e.label === 'pipeline-capability').length, 1, 'probe runs once')
})

test('preflight: a gatePresent-less probe answer (pre-r1 probe shape) is treated as MISSING, never as a working gate', async () => {
  const { error, workflowCalls } = await runRunner({ hunts: [hunt('a')],
    capability: { path: '.claude/workflows/hunt-pipeline.js', protocol: 3, usageProtocol: 1 } })
  assert.match(String(error && error.message), /MISSING/)
  assert.equal(workflowCalls.length, 0)
})

test('preflight r2 F3: a NULL probe result is a PROBE failure (not a stale diagnosis) — throws before any hunt', async () => {
  const { error, gateCalls, workflowCalls } = await runRunner({ hunts: [hunt('a')], capability: null })
  assert.ok(error, 'must throw')
  assert.match(error.message, /pipeline-capability probe returned no result/)
  assert.match(error.message, /UNKNOWN/)
  assert.match(error.message, /not a stale-pipeline diagnosis/)
  assert.doesNotMatch(error.message, /is STALE/, 'must not send the operator to re-sync')
  assert.equal(gateCalls.length, 0)
  assert.equal(workflowCalls.length, 0)
})

test('preflight: an EMPTY-object probe result still fails loud (protocol 0 ⇒ STALE examiner), not a null-probe message', async () => {
  const { error } = await runRunner({ hunts: [hunt('a')], capability: {} })
  assert.match(String(error && error.message), /STALE .*examiner protocol 0/)
})

test('legacy gate (no WOLFPACK_GATE_PROTOCOL): loud STALE USAGE GATE warning; legacy step without --tier; LEGACY schema', async () => {
  const { error, logs, gateCalls, result } = await runRunner({ hunts: [hunt('a', { tier: 'Red' })], gateProtocol: 0, gate: () => LEGACY_PROCEED })
  assert.equal(error, undefined, error && error.stack)
  assert.equal(result.verdict, 'WAVE_COMPLETE_AWAITING_RELEASE')
  assert.ok(logs.some(l => /⚠ STALE USAGE GATE: \/pack\/scripts\/wolfpack-window-gate\.mjs predates usage-limit-gate/.test(l)), logs.join('\n'))
  assert.ok(logs.some(l => /STALE USAGE GATE.*point WOLFPACK_HOME \/ Wolfpack home at an up-to-date wolfpack checkout/.test(l)))
  assert.equal(logs.some(l => l.includes(RETIRED_SYNC)), false)
  assert.equal(logs.some(l => /Usage gate capability OK/.test(l)), false)
  assert.equal(gateCalls.length, 1)
  const g = gateCalls[0]
  assert.equal(g.label, 'usage-gate-legacy:a')
  assert.equal(g.opts.model, 'sonnet')
  assert.match(g.prompt, /READ-ONLY/)
  assert.ok(g.prompt.includes(`node '/pack/scripts/wolfpack-window-gate.mjs' --json\n`), g.prompt)
  assert.doesNotMatch(g.prompt, /--tier/, 'the legacy gate does not know --tier')
  assert.match(g.prompt, /Never invent a proceed\/defer/)
  assert.deepEqual(g.opts.schema.required, ['decision', 'exitCode'])
  assert.deepEqual(g.opts.schema.properties.decision.enum, ['proceed', 'defer', 'error'])
  // the real legacy output carries every LEGACY schema field (exitCode added by the agent)
  for (const k of Object.keys(g.opts.schema.properties)) assert.ok(k in LEGACY_PROCEED, k)
})

test('legacy gate: proceed is LABELLED degraded (legacy_gate) and NEVER offloads, even if the agent claims offload', async () => {
  const { workflowCalls, logs } = await runRunner({ hunts: [hunt('a'), hunt('b')], maxParallel: 1, gateProtocol: 0,
    gate: (slug) => (slug === 'b' ? { ...LEGACY_PROCEED, offload: true, offload_reason: 'forged' } : LEGACY_PROCEED) })
  assert.deepEqual(workflowCalls.map(w => w.args.slug), ['a', 'b'])
  for (const w of workflowCalls) assert.equal(w.args.usageOffload, null)
  assert.ok(logs.some(l => /⚠ USAGE GATE DEGRADED \(a\)/.test(l)), logs.join('\n'))
  assert.ok(logs.some(l => /STALE gate script/.test(l)), 'the degraded reason names the stale gate')
  assert.equal(logs.some(l => /OFFLOAD/.test(l)), false)
})

test('legacy gate: its transcript-estimate DEFER still gates ⇒ WAVE_PAUSED_QUOTA with its reset_at', async () => {
  const { result, workflowCalls } = await runRunner({ hunts: [hunt('a'), hunt('b')], maxParallel: 1, gateProtocol: 0,
    gate: (slug) => (slug === 'a' ? LEGACY_PROCEED : LEGACY_DEFER) })
  assert.equal(result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.equal(result.resetAt, LEGACY_DEFER.reset_at)
  assert.deepEqual(result.deferredHunts.map(h => h.slug), ['b'])
  assert.deepEqual(workflowCalls.map(w => w.args.slug), ['a'])
})

test('legacy gate: failures still throw loud — null, error, exit 1, decision/exit mismatch', async () => {
  for (const bad of [null, { decision: 'error', exitCode: 1, reason: 'boom' },
    { decision: 'proceed', exitCode: 1 }, { decision: 'defer', exitCode: 0 }, { decision: 'proceed', exitCode: 10 }]) {
    const { error, workflowCalls } = await runRunner({ hunts: [hunt('a')], gateProtocol: 0, gate: () => bad })
    assert.ok(error, `must throw for ${JSON.stringify(bad)}`)
    assert.equal(workflowCalls.length, 0, `nothing scaffolded for ${JSON.stringify(bad)}`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// CHAIN MODE (campaign-chain-mode) — runChain() driven through the whole runner body.
// The chain-* agents are the deterministic wolfpack-chain.mjs CLI steps; here they are
// stubbed by label so each scenario controls init / sync-main / overlap / merge-hunt results.
// ════════════════════════════════════════════════════════════════════════════
import { execFileSync as chainExec } from 'node:child_process'

const CHAIN_CAP = { path: '.claude/workflows/hunt-pipeline.js', protocol: 3, usageProtocol: 1, gatePresent: true, gateProtocol: 1,
  chainProtocol: 1, chainScriptPresent: true }
const ch = (slug, extra = {}) => ({ slug, description: `do ${slug}`, tier: 'Yellow', mode: 'feature', dependsOn: [], status: 'ready_for_alpha',
  migrationApps: [], revertedBecause: null, heldOn: [], ...extra })
const CERT = (a) => ({ slug: a.slug, verdict: 'CERTIFIED_AWAITING_DEPLOY', status: 'certified' })

// Generic runner: any runner source, a parse result, and per-label stubs.
async function runAny(src, { parse, args, capability = CHAIN_CAP, gate = () => PROCEED, workflowResult = CERT,
  init, sync, overlap, merge, depCheck = { allMerged: true }, crosswave = { merged: [] }, projectConfig = (p) => configAnswer(undefined, undefined, p), stamp = () => stampAnswer(),
  cron, budget = { total: 0, remaining: () => 1e12 }, extra } = {}) {
  const events = []
  const logs = []
  const workflowCalls = []
  const agentCalls = []
  const counts = {}
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    agentCalls.push({ label, prompt, opts })
    events.push({ type: 'agent', label })
    if (extra) { const v = await extra(label, prompt, opts); if (v !== undefined) return v }   // wave-auto-smoke stage stubs
    if (label === 'project-config') return projectConfig(prompt)
    if (label === 'workflow-stamp') return stamp()
    if (label === 'parse-campaign') return JSON.parse(JSON.stringify(parse))
    if (label === 'pipeline-capability') return capability == null ? null : { ...capability }
    if (label.startsWith('usage-gate:') || label.startsWith('usage-gate-legacy:')) {
      const v = gate(label.slice(label.indexOf(':') + 1)); return v == null ? null : JSON.parse(JSON.stringify(v))
    }
    if (label.startsWith('dep-check:')) return depCheck
    if (label === 'crosswave-dep-check') return crosswave
    if (cron && label.startsWith('cron-')) return cron(label, prompt)   // campaign-cron-resume (AC11)
    counts[label] = (counts[label] || 0) + 1
    if (label === 'chain-init') return init ? init(prompt) : { status: 'created', branch: 'campaign/c1', sha: 'a1b2c3d4e5f6a7b8', exitCode: 0 }
    if (label.startsWith('chain-sync-main:')) return sync ? sync(label, counts[label]) : { status: 'up_to_date', sha: 's', files: [], warning: null, exitCode: 0 }
    if (label.startsWith('chain-overlap:')) return overlap ? overlap(label.slice('chain-overlap:'.length), counts[label]) : { held: false, overlaps: {}, noDiff: [], exitCode: 0 }
    if (label.startsWith('chain-merge:')) {
      const slug = label.slice('chain-merge:'.length)
      return merge ? merge(slug, counts[label]) : { status: 'merged', commit: `merge-${slug}-0000000`, stamped: 'merged_to_campaign', exitCode: 0 }
    }
    return {}
  }
  const workflow = async (name, a) => {
    workflowCalls.push({ name, args: a })
    events.push({ type: 'workflow-start', slug: a.slug })
    await tick()
    events.push({ type: 'workflow-end', slug: a.slug })
    return workflowResult(a)
  }
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'process', 'workflow', src)
  let result, error
  try {
    result = await fn(args, agent, async (f) => Promise.all(f.map(x => x())), (m) => logs.push(String(m)), () => {},
      budget, { env: {} }, workflow)
  } catch (e) { error = e }
  events.push({ type: 'return' })
  const idx = (pred) => events.findIndex(pred)
  return { result, error, events, logs, workflowCalls, agentCalls, idx,
    labels: events.filter(e => e.type === 'agent').map(e => e.label),
    wf: workflowCalls.map(w => w.args.slug) }
}
const parseOf = (waves, top = {}) => ({ waves: waves.map((hunts, i) => ({ number: i + 1, hunts })), ...top })
const runChainRunner = (waves, { top = { chainMode: false, chainBranch: '' }, args = {}, ...rest } = {}) =>
  runAny(RUNNER, { parse: parseOf(waves, top), args: { campaignSlug: 'c1', chain: true, ...args }, ...rest })
const mergedStamp = (stamped) => (slug) => ({ status: 'merged', commit: `merge-${slug}-0000000`, stamped: typeof stamped === 'function' ? stamped(slug) : stamped, exitCode: 0 })
const noErr = (r) => assert.equal(r.error, undefined, r.error && r.error.stack)

// ── 1. AC1 differential: barrier mode vs the pre-hunt runner ─────────────────
// Pinned to the last pre-hunt commit that touched the runner (plan A-16); overridable.
const BARRIER_BASELINE_REF = process.env.WOLFPACK_BARRIER_BASELINE_REF || 'df56d3f40d43ca14f1a7647c0343813307173de7'
function baselineRunner() {
  try {
    return stripMeta(chainExec('git', ['show', `${BARRIER_BASELINE_REF}:.agents/workflows/campaign-runner.js`], { cwd: join(here, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch { return null }
}
test('AC1: barrier mode (no chain) is identical to the pre-hunt runner — labels, workflow args, return value', async (t) => {
  const base = baselineRunner()
  if (!base) {
    // A skip means AC1's differential was NOT executed — report it as uncovered, never as a pass.
    t.skip(`AC1 NOT EXECUTED: baseline ref ${BARRIER_BASELINE_REF} cannot be resolved (shallow clone?) — set WOLFPACK_BARRIER_BASELINE_REF`)
    return
  }
  assert.doesNotMatch(base, /runChain|WOLFPACK_CHAIN_RUNNER/, 'the baseline really predates chain mode')
  const waves = [[hunt('a'), hunt('b'), hunt('c')], [hunt('d')]]
  const results = {
    a: { slug: 'a', verdict: 'CERTIFIED_AWAITING_DEPLOY' },
    b: { slug: 'b', verdict: 'PARKED', status: 'parked:open_critical', reason: 'open_critical' },
    c: { slug: 'c', verdict: 'PARKED', status: 'parked:compliance_review', reason: 'compliance_review' },
    d: { slug: 'd', verdict: 'CERTIFIED_AWAITING_DEPLOY' },
  }
  const opts = { parse: parseOf(waves), args: { campaignSlug: 'c1', maxParallel: 1 }, capability: { ...CHAIN_CAP, chainProtocol: 0, chainScriptPresent: false },
    workflowResult: (a) => ({ ...results[a.slug] }) }
  const old = await runAny(base, opts)
  const now = await runAny(RUNNER, opts)
  noErr(old); noErr(now)
  // wolfpack-self-hosting adds ONE label (the project-config probe) and pack-install-model ONE more
  // (the workflow-stamp probe) the baseline predates; everything else must stay identical.
  assert.equal(now.labels.filter(l => l === 'project-config').length, 1)
  assert.equal(now.labels.filter(l => l === 'workflow-stamp').length, 1)
  const sansProbe = (ls) => ls.filter(l => l !== 'project-config' && l !== 'workflow-stamp')
  assert.deepEqual(sansProbe(now.labels), old.labels)
  assert.deepEqual(now.workflowCalls, old.workflowCalls)
  for (const w of now.workflowCalls) assert.equal('baseBranch' in w.args, false)
  assert.deepEqual(now.result, old.result)
  assert.equal(now.labels.some(l => l.startsWith('chain-')), false)
  // also with the parse returning the new chain fields set to their barrier values
  const now2 = await runAny(RUNNER, { ...opts, parse: parseOf(waves.map(w => w.map(h => ({ ...h, migrationApps: [], revertedBecause: null, heldOn: [], baseBranch: '' }))), { chainMode: false, chainBranch: '' }) })
  noErr(now2)
  assert.deepEqual(sansProbe(now2.labels), old.labels)
  assert.deepEqual(now2.result, old.result)
})

// ── 2–4. AC2 opt-in and sticky ───────────────────────────────────────────────
test('AC2 first run: chain:true → chain-init (with --graph) before any workflow; every workflow gets baseBranch campaign/c1', async () => {
  const r = await runChainRunner([[ch('a', { migrationApps: ['billing'] }), ch('b', { dependsOn: ['a'] })]], { top: {} })
  noErr(r)
  const init = r.agentCalls.find(c => c.label === 'chain-init')
  assert.ok(init, 'chain-init ran')
  assert.ok(r.idx(e => e.label === 'chain-init') < r.idx(e => e.type === 'workflow-start'))
  assert.ok(init.prompt.includes(`node '/pack/scripts/wolfpack-chain.mjs' init --campaign 'c1' --graph '`), init.prompt)
  const graph = JSON.parse(init.prompt.match(/--graph '([^']*)'/)[1])
  assert.deepEqual(graph, { a: { dependsOn: [], migrationApps: ['billing'] }, b: { dependsOn: ['a'], migrationApps: [] } })
  assert.equal(init.opts.model, 'sonnet')
  assert.deepEqual(r.wf, ['a', 'b'])
  for (const w of r.workflowCalls) assert.equal(w.args.baseBranch, 'campaign/c1')
  assert.ok(r.logs.some(l => /⛓ CHAIN MODE: c1 → campaign\/c1 \(max-parallel 1/.test(l)), r.logs.join('\n'))
  assert.ok(r.logs.some(l => /Chain branch created: campaign\/c1 @ a1b2c3d4e5f6/.test(l)))
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  assert.equal(r.result.mode, 'chain')
  assert.equal(r.result.branch, 'campaign/c1')
})
test('AC2 adopt: chain-init returns adopted → the run proceeds and logs it', async () => {
  const r = await runChainRunner([[ch('a')]], { init: () => ({ status: 'adopted', branch: 'campaign/c1', sha: 'ffffeeeeddddcccc', exitCode: 0 }) })
  noErr(r)
  assert.ok(r.logs.some(l => /Chain branch adopted: campaign\/c1 @ ffffeeeedddd/.test(l)), r.logs.join('\n'))
  assert.deepEqual(r.wf, ['a'])
})
test('AC2 sticky: parse chainMode:true without the chain arg → loud sticky log, then the chain path', async () => {
  const r = await runChainRunner([[ch('a')]], { args: { chain: undefined }, top: { chainMode: true, chainBranch: 'campaign/c1' } })
  noErr(r)
  assert.ok(r.logs.some(l => /⚠ CHAIN MODE \(sticky\): c1 was started with --chain — continuing in chain mode on campaign\/c1/.test(l)), r.logs.join('\n'))
  assert.ok(r.labels.includes('chain-init'))
  assert.equal(r.workflowCalls[0].args.baseBranch, 'campaign/c1')
  // with the flag given, no sticky warning
  const r2 = await runChainRunner([[ch('a')]], { top: { chainMode: true, chainBranch: 'campaign/c1' } })
  assert.equal(r2.logs.some(l => /sticky/.test(l)), false)
})
test('AC2 dropped-field guard: chain state on disk with chainMode absent/false and no flag → throws, nothing runs', async () => {
  const cases = [
    { name: 'merged_to_campaign hunt, chainMode absent', waves: [[ch('a', { status: 'merged_to_campaign' }), ch('b')]], top: {} },
    { name: 'merged_to_campaign hunt, chainMode false', waves: [[ch('a', { status: 'merged_to_campaign' }), ch('b')]], top: { chainMode: false, chainBranch: '' } },
    { name: 'pending hunt with baseBranch', waves: [[ch('b', { baseBranch: 'campaign/c1' })]], top: { chainMode: false, chainBranch: '' } },
    { name: 'held hunt', waves: [[ch('b', { status: 'certified_held_overlap' })]], top: {} },
    { name: 'chain block only (crash after chain-init)', waves: [[ch('b')]], top: { chainMode: false, chainBranch: 'campaign/c1' } },
  ]
  for (const c of cases) {
    const r = await runChainRunner(c.waves, { args: { chain: undefined }, top: c.top })
    assert.ok(r.error, `${c.name}: must throw`)
    assert.match(r.error.message, /CHAIN STATE WITHOUT CHAIN MODE/, c.name)
    assert.match(r.error.message, /Re-run with --chain/, c.name)
    assert.equal(r.workflowCalls.length, 0, c.name)
    assert.equal(r.labels.some(l => l.startsWith('chain-')), false, c.name)
  }
})
test('AC2: the parse schema REQUIRES chainMode/chainBranch and the per-hunt chain fields', async () => {
  const r = await runChainRunner([[ch('a')]])
  const p = r.agentCalls.find(c => c.label === 'parse-campaign')
  const sch = p.opts.schema
  for (const k of ['waves', 'chainMode', 'chainBranch']) assert.ok(sch.required.includes(k), k)
  const item = sch.properties.waves.items.properties.hunts.items
  for (const k of ['slug', 'description', 'migrationApps', 'revertedBecause', 'heldOn']) assert.ok(item.required.includes(k), k)
  assert.equal(item.required.includes('baseBranch'), false, 'baseBranch is optional')
  assert.match(p.prompt, /chainMode = true iff \.wolfpack\/campaigns\/c1\/metadata\.json has chain\.mode === "chain"/)
  assert.match(p.prompt, /"merged_to_campaign"/)
})
test('AC2 reverted-dependent guard: reverted_with_dependency with revertedBecause absent / null / "" → throws naming it, before chain-init', async () => {
  for (const rb of [undefined, null, '']) {
    const h = ch('x', { status: 'reverted_with_dependency', revertedBecause: rb })
    if (rb === undefined) delete h.revertedBecause
    const r = await runChainRunner([[ch('h', { status: 'merged_to_campaign' }), h]])
    assert.ok(r.error, `revertedBecause=${JSON.stringify(rb)}`)
    assert.match(r.error.message, /REVERTED DEPENDENT WITHOUT reverted_because: x/)
    assert.equal(r.labels.includes('chain-init'), false)
    assert.equal(r.workflowCalls.length, 0)
  }
})
test('chain mode validates the campaign slug before naming the branch', async () => {
  const r = await runChainRunner([[ch('a')]], { args: { campaignSlug: 'Bad Slug' } })
  assert.match(String(r.error && r.error.message), /invalid campaign slug "Bad Slug" for chain mode/)
  assert.equal(r.labels.includes('chain-init'), false)
})

// ── 5. AC2 switch a barrier campaign to chain at a wave start ────────────────
test('AC2 switch: barrier wave 1 already merged to main, chain:true → wave 1 is skipped (not re-run), wave 2 runs on the campaign branch', async () => {
  const r = await runChainRunner([[ch('a', { status: 'merged' }), ch('b', { status: 'merged' })], [ch('c', { dependsOn: ['a'] })]])
  noErr(r)
  assert.deepEqual(r.wf, ['c'])
  assert.equal(r.workflowCalls[0].args.baseBranch, 'campaign/c1')
  assert.ok(r.logs.some(l => /Wave 1: nothing to run or merge — skipping/.test(l)))
  assert.equal(r.labels.includes('chain-merge:a'), false)
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
})

// ── 6. AC5 waves don't stop ──────────────────────────────────────────────────
test('AC5: 3 waves in ONE run — one workflow per hunt, each merged after it certifies and before the next wave starts; no barrier printout', async () => {
  const r = await runChainRunner([[ch('a'), ch('b')], [ch('c')], [ch('d'), ch('e')]])
  noErr(r)
  assert.deepEqual(r.wf, ['a', 'b', 'c', 'd', 'e'])
  const waveOf = { a: 1, b: 1, c: 2, d: 3, e: 3 }
  for (const s of Object.keys(waveOf)) {
    const end = r.idx(e => e.type === 'workflow-end' && e.slug === s)
    const m = r.idx(e => e.label === `chain-merge:${s}`)
    assert.ok(m > end, `${s} merged after it certified`)
    const nextWaveStart = r.idx(e => e.type === 'workflow-start' && waveOf[e.slug] === waveOf[s] + 1)
    if (nextWaveStart !== -1) assert.ok(m < nextWaveStart, `${s} merged before wave ${waveOf[s] + 1} starts`)
    assert.equal(r.labels.filter(l => l === `chain-merge:${s}`).length, 1)
  }
  assert.equal(r.logs.some(l => /Pipeline STOPS here|RELEASE QUEUE/.test(l)), false, r.logs.join('\n'))
  assert.ok(r.logs.some(l => /Wave 1 → campaign\/c1: merged \[a, b\], held \[\], waiting \[\]/.test(l)))
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  assert.equal(r.result.completed, true)
  assert.deepEqual(r.result.campaignMergedHunts, ['a', 'b', 'c', 'd', 'e'])
  const mergeCall = r.agentCalls.find(c => c.label === 'chain-merge:a')
  assert.ok(mergeCall.prompt.includes(`node '/pack/scripts/wolfpack-chain.mjs' merge-hunt --campaign 'c1' --hunt 'a'`), mergeCall.prompt)
  assert.match(mergeCall.prompt, /do NOT run any git command yourself/)
  assert.equal(mergeCall.opts.model, 'sonnet')
})
test('A-14: a same-wave dependent forks only after its dependency is merged into the campaign branch', async () => {
  const r = await runChainRunner([[ch('a'), ch('b', { dependsOn: ['a'] })]])
  noErr(r)
  assert.ok(r.idx(e => e.label === 'chain-merge:a') < r.idx(e => e.type === 'workflow-start' && e.slug === 'b'))
  assert.ok(r.idx(e => e.label === 'chain-merge:b') > r.idx(e => e.type === 'workflow-end' && e.slug === 'b'))
})

// ── 7. AC7 main merged in at each wave start ─────────────────────────────────
test('AC7: chain-sync-main:w<N> runs before each wave is scaffolded; a conflict → CAMPAIGN_PARKED_MAIN_CONFLICT, nothing scaffolded', async () => {
  const ok = await runChainRunner([[ch('a')], [ch('b')]])
  noErr(ok)
  assert.ok(ok.idx(e => e.label === 'chain-sync-main:w1') < ok.idx(e => e.type === 'workflow-start' && e.slug === 'a'))
  assert.ok(ok.idx(e => e.label === 'chain-sync-main:w2') < ok.idx(e => e.type === 'workflow-start' && e.slug === 'b'))
  assert.ok(ok.idx(e => e.label === 'chain-sync-main:w2') > ok.idx(e => e.label === 'chain-merge:a'))
  assert.match(ok.agentCalls.find(c => c.label === 'chain-sync-main:w1').prompt, /'\/pack\/scripts\/wolfpack-chain\.mjs' sync-main --campaign 'c1'/)
  const bad = await runChainRunner([[ch('a')], [ch('b')]], { sync: () => ({ status: 'conflict', files: ['app/models.py', 'TODO.md'], sha: 's', exitCode: 0 }) })
  noErr(bad)
  assert.equal(bad.result.verdict, 'CAMPAIGN_PARKED_MAIN_CONFLICT')
  assert.deepEqual(bad.result.conflictFiles, ['app/models.py', 'TODO.md'])
  assert.equal(bad.result.completed, false)
  assert.equal(bad.workflowCalls.length, 0)
  assert.ok(bad.logs.some(l => /main → campaign\/c1 merge CONFLICTED \(wave 1 start\): app\/models\.py, TODO\.md/.test(l)))
  // a conflict at a LATER wave start keeps the earlier wave's merges and stops before wave 2
  const late = await runChainRunner([[ch('a')], [ch('b')]], { sync: (label) => (label === 'chain-sync-main:w2' ? { status: 'conflict', files: ['x'], exitCode: 0 } : { status: 'up_to_date', exitCode: 0 }) })
  assert.equal(late.result.verdict, 'CAMPAIGN_PARKED_MAIN_CONFLICT')
  assert.deepEqual(late.wf, ['a'])
  assert.ok(late.labels.includes('chain-merge:a'))
})
test('AC7: the sync-main warning (origin/main not an ancestor) is logged', async () => {
  const r = await runChainRunner([[ch('a')]], { sync: () => ({ status: 'merged', sha: 's', files: [], warning: 'origin/main is not an ancestor of local main', exitCode: 0 }) })
  noErr(r)
  assert.ok(r.logs.some(l => /⚠ origin\/main is not an ancestor of local main/.test(l)))
})
test('chain CLI failures throw loud with the step named (null result, status error, non-zero exit)', async () => {
  for (const bad of [null, { status: 'error', reason: 'boom', exitCode: 2 }, { status: 'merged', exitCode: 2 }]) {
    const r = await runChainRunner([[ch('a')]], { merge: () => bad })
    assert.ok(r.error, JSON.stringify(bad))
    assert.match(r.error.message, /chain step chain-merge:a (returned no result|failed)/)
  }
  const r2 = await runChainRunner([[ch('a')]], { merge: () => ({ status: 'weird', exitCode: 0 }) })
  assert.match(String(r2.error && r2.error.message), /returned an unknown status "weird"/)
  const r3 = await runChainRunner([[ch('a')]], { init: () => ({ status: 'error', reason: 'no main', exitCode: 2 }) })
  assert.match(String(r3.error && r3.error.message), /chain step chain-init failed: no main/)
  assert.equal(r3.workflowCalls.length, 0)
})

// ── 8. AC6 runner side ───────────────────────────────────────────────────────
test('AC6 (runner): one hunt\'s merge conflict holds only that hunt; the rest of the wave still merges', async () => {
  const r = await runChainRunner([[ch('b'), ch('c')]], {
    merge: (slug) => (slug === 'b' ? { status: 'conflict', stage: 'rebase', files: ['CHANGELOG.md'], exitCode: 0 } : mergedStamp('merged_to_campaign')(slug)) })
  noErr(r)
  assert.ok(r.labels.includes('chain-merge:c'))
  assert.deepEqual(r.result.blockedHunts.map(b => [b.slug, b.status, b.resolve]), [['b', 'parked:campaign_merge_conflict', '/resolve b']])
  assert.deepEqual(r.result.campaignMergedHunts, ['c'])
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
  assert.ok(r.logs.some(l => /b: auto-merge into campaign\/c1 CONFLICTED \(rebase: CHANGELOG\.md\)/.test(l)))
})

// ── 9. AC8 dependencies satisfied by the campaign branch ─────────────────────
test('AC8: a wave-2 hunt depending on a campaign-merged wave-1 hunt runs (no BLOCKED, no main dep-check)', async () => {
  const r = await runChainRunner([[ch('a', { status: 'merged_to_campaign' })], [ch('d', { dependsOn: ['a'] })]])
  noErr(r)
  assert.deepEqual(r.wf, ['d'])
  assert.equal(r.logs.some(l => /BLOCKED/.test(l)), false)
  assert.equal(r.labels.some(l => l.startsWith('dep-check') || l === 'crosswave-dep-check'), false)
  // pending-compliance and released deps count as met too (A1)
  const r2 = await runChainRunner([[ch('a', { status: 'merged_to_campaign_pending_compliance' }), ch('m', { status: 'merged' })], [ch('d', { dependsOn: ['a', 'm'] })]])
  assert.deepEqual(r2.wf, ['d'])
})
test('a dependency on a slug outside the campaign waits loudly (unknown_dep), never assumed met', async () => {
  const r = await runChainRunner([[ch('a', { dependsOn: ['ghost'] }), ch('b')]])
  noErr(r)
  assert.deepEqual(r.wf, ['b'])
  assert.deepEqual(r.result.waitingHunts, [{ slug: 'a', on: 'ghost', rule: 'unknown_dep' }])
  assert.ok(r.logs.some(l => /a waits: depends on ghost, which is not a hunt of this campaign/.test(l)))
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
})

// ── 10 / 12. AC9 push-through + AC13 awaiting-human verdict ──────────────────
test('AC9/AC13: past a parked hunt — rule a and rule b waiters wait, an independent hunt runs; overlap is judged before its merge', async () => {
  const waves = [[ch('b', { migrationApps: ['Billing'] })], [ch('e', { dependsOn: ['b'] }), ch('f', { migrationApps: ['billing'] }), ch('g')], [ch('t', { dependsOn: ['e'] })]]
  const r = await runChainRunner(waves, {
    workflowResult: (a) => (a.slug === 'b' ? { slug: 'b', verdict: 'PARKED', status: 'parked:open_critical', reason: 'open_critical' } : CERT(a)) })
  noErr(r)
  assert.deepEqual(r.wf, ['b', 'g'])
  assert.ok(r.idx(e => e.label === 'chain-overlap:g') < r.idx(e => e.label === 'chain-merge:g'))
  assert.match(r.agentCalls.find(c => c.label === 'chain-overlap:g').prompt, /overlap --campaign 'c1' --hunt 'g' --blockers 'b'/)
  assert.deepEqual(r.result.waitingHunts, [
    { slug: 'e', on: 'b', rule: 'a' },
    { slug: 'f', on: 'b', rule: 'b' },
    { slug: 't', on: 'b', rule: 'a' },
  ])
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
  assert.deepEqual(r.result.blockedHunts, [{ slug: 'b', status: 'parked:open_critical', resolve: '/resolve b', waiting: ['e', 'f', 't'] }])
  assert.deepEqual(r.result.campaignMergedHunts, ['g'])
  assert.ok(r.logs.some(l => /⛔ b \[parked:open_critical\] {2}→ {2}\/resolve b {3}\(waiting on it: e, f, t\)/.test(l)), r.logs.join('\n'))
  assert.ok(r.logs.some(l => /f waits: shares migration app\(s\) billing with blocked b/.test(l)))
  assert.ok(r.logs.some(l => /t waits: depends on blocked b \(via t → e → b\)/.test(l)))
  assert.equal(r.labels.some(l => l === 'chain-sync-main:final'), false, 'no final sync when not ready')
})
test('AC9 rule c: overlap held:true → no merge, the hunt is listed held (certified, unmerged)', async () => {
  const r = await runChainRunner([[ch('b', { status: 'parked:open_critical' }), ch('g')]], {
    overlap: () => ({ held: true, overlaps: { b: ['app/views.py'] }, noDiff: [], exitCode: 0 }) })
  noErr(r)
  assert.equal(r.labels.includes('chain-merge:g'), false)
  assert.deepEqual(r.result.heldHunts, [{ slug: 'g', status: 'certified_held_overlap', heldOn: ['b'] }])
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
  assert.ok(r.logs.some(l => /⏸ g: certified but HELD unmerged — its diff overlaps blocked b \(app\/views\.py\)/.test(l)))
})
test('AC9: a blocker with no diff yet is logged (rules a/b only) and the hunt still merges', async () => {
  const r = await runChainRunner([[ch('b', { status: 'needs_spec' }), ch('g')]], {
    overlap: () => ({ held: false, overlaps: {}, noDiff: ['b'], exitCode: 0 }) })
  noErr(r)
  assert.ok(r.labels.includes('chain-merge:g'))
  assert.ok(r.logs.some(l => /g: no diff yet for b — only rules a\/b applied against them/.test(l)))
  assert.deepEqual(r.result.blockedHunts.map(b => [b.slug, b.resolve]), [['b', '/spec b']])
})
test('AC9: without blockers no overlap step runs at all', async () => {
  const r = await runChainRunner([[ch('a'), ch('b')]])
  assert.equal(r.labels.some(l => l.startsWith('chain-overlap:')), false)
})
test('Pointer r1 F6: a held hunt re-judged by a later merge step is logged and listed ONCE', async () => {
  const r = await runChainRunner([[ch('b', { status: 'parked:open_critical' }), ch('g', { status: 'certified' }), ch('a'), ch('x', { dependsOn: ['a'] }), ch('y', { dependsOn: ['a'] })]], {
    overlap: (slug) => (slug === 'g' ? { held: true, overlaps: { b: ['f.py'] }, noDiff: [], exitCode: 0 } : { held: false, overlaps: {}, noDiff: [], exitCode: 0 }) })
  noErr(r)
  assert.ok(r.labels.filter(l => l === 'chain-overlap:g').length >= 2, 'g is re-judged by each merge step')
  assert.equal(r.logs.filter(l => /⏸ g: certified but HELD unmerged/.test(l)).length, 1)
  assert.ok(r.logs.some(l => /Wave 1 → campaign\/c1: merged \[a, x, y\], held \[g\], waiting \[\]/.test(l)), r.logs.join('\n'))
  assert.deepEqual(r.result.heldHunts.map(h => h.slug), ['g'])
})
test('a hunt that did not certify (no result / FLAWED_PLAN) is failed and blocks only its conflicts for the rest of the run', async () => {
  const r = await runChainRunner([[ch('a'), ch('z')], [ch('b', { dependsOn: ['a'] }), ch('c')]], {
    workflowResult: (a) => (a.slug === 'a' ? { slug: 'a', verdict: 'FLAWED_PLAN' } : a.slug === 'z' ? null : CERT(a)) })
  noErr(r)
  assert.deepEqual(r.wf, ['a', 'z', 'c'])
  assert.deepEqual(r.result.failedHunts, ['a', 'z'])
  assert.deepEqual(r.result.waitingHunts, [{ slug: 'b', on: 'a', rule: 'a' }])
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
})

// ── 11. AC11 merged-awaiting-compliance ──────────────────────────────────────
test('AC11 (runner): a CERTIFIED_PENDING_COMPLIANCE hunt is merged (pending compliance), its dependent builds on it, verdict READY', async () => {
  const r = await runChainRunner([[ch('r', { tier: 'Red' })], [ch('x', { dependsOn: ['r'] })]], {
    workflowResult: (a) => (a.slug === 'r' ? { slug: 'r', verdict: 'CERTIFIED_PENDING_COMPLIANCE', status: 'certified_pending_compliance', reason: 'compliance_review' } : CERT(a)),
    merge: mergedStamp((s) => (s === 'r' ? 'merged_to_campaign_pending_compliance' : 'merged_to_campaign')) })
  noErr(r)
  assert.deepEqual(r.wf, ['r', 'x'])
  assert.ok(r.labels.includes('chain-merge:r'))
  assert.deepEqual(r.result.pendingComplianceHunts, ['r'])
  assert.deepEqual(r.result.campaignMergedHunts, ['r', 'x'])
  assert.deepEqual(r.result.blockedHunts, [])
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  assert.ok(r.logs.some(l => /r → campaign\/c1 .*merged, awaiting compliance sign-off at the release/.test(l)))
})

// ── 12. AC13 resume + quota ──────────────────────────────────────────────────
test('AC13 resume: campaign-merged hunts are never re-run', async () => {
  const r = await runChainRunner([[ch('a', { status: 'merged_to_campaign' }), ch('b', { status: 'merged_to_campaign_pending_compliance' })], [ch('c')]])
  noErr(r)
  assert.deepEqual(r.wf, ['c'])
  assert.equal(r.labels.includes('chain-merge:a'), false)
})
test('AC13: a usage defer mid-chain → WAVE_PAUSED_QUOTA with mode chain; a re-run resumes from the deferred hunt', async () => {
  const r = await runChainRunner([[ch('a'), ch('b')], [ch('c')]], { gate: (slug) => (slug === 'b' ? DEFER5H : PROCEED) })
  noErr(r)
  assert.equal(r.result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.equal(r.result.mode, 'chain')
  assert.equal(r.result.branch, 'campaign/c1')
  assert.equal(r.result.resetAt, DEFER5H.reset_at)
  assert.deepEqual(r.wf, ['a'])
  assert.deepEqual(r.result.deferredHunts.map(h => h.slug), ['b'])
  assert.deepEqual(r.result.certifiedHunts, ['a'])
  // the pause returns BEFORE the merge step; the certified hunt is merged on the re-run (on-disk status)
  const again = await runChainRunner([[ch('a', { status: 'certified' }), ch('b')], [ch('c')]])
  noErr(again)
  assert.deepEqual(again.wf, ['b', 'c'])
  assert.ok(again.labels.includes('chain-merge:a'))
  assert.equal(again.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
})
test('Pointer r1 F7: chain pause returns count a pending-compliance certification as certified', async () => {
  const r = await runChainRunner([[ch('r'), ch('b')]], {
    gate: (slug) => (slug === 'b' ? DEFER5H : PROCEED),
    workflowResult: (a) => ({ slug: a.slug, verdict: 'CERTIFIED_PENDING_COMPLIANCE', status: 'certified_pending_compliance' }) })
  noErr(r)
  assert.equal(r.result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.deepEqual(r.result.certifiedHunts, ['r'])
  // the dependent-tail defer path too
  const r2 = await runChainRunner([[ch('r'), ch('d', { dependsOn: ['r'] })]], {
    gate: (slug) => (slug === 'd' ? DEFER5H : PROCEED),
    workflowResult: (a) => ({ slug: a.slug, verdict: 'CERTIFIED_PENDING_COMPLIANCE', status: 'certified_pending_compliance' }),
    merge: mergedStamp('merged_to_campaign_pending_compliance') })
  noErr(r2)
  assert.equal(r2.result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.deepEqual(r2.result.certifiedHunts, ['r'])
  assert.equal(r2.result.mode, 'chain')
})
test('AC13: a parked:model_quota result → WAVE_PAUSED_QUOTA at the end (auto-resumes), other hunts still merge', async () => {
  const r = await runChainRunner([[ch('a'), ch('q')]], {
    workflowResult: (a) => (a.slug === 'q' ? { slug: 'q', verdict: 'PARKED', status: 'parked:model_quota', reason: 'model_quota' } : CERT(a)) })
  noErr(r)
  assert.equal(r.result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.deepEqual(r.result.quotaDeferredHunts, ['q'])
  assert.deepEqual(r.result.campaignMergedHunts, ['a'])
  // a parsed model-quota hunt is re-run (it is pending, not blocked)
  const again = await runChainRunner([[ch('a', { status: 'merged_to_campaign' }), ch('q', { status: 'parked:model_quota' })]])
  assert.deepEqual(again.wf, ['q'])
})
test('AC13: a gate failure throws loud after in-flight hunts finish', async () => {
  const r = await runChainRunner([[ch('a'), ch('b')]], { gate: (slug) => (slug === 'b' ? null : PROCEED) })
  assert.match(String(r.error && r.error.message), /usage gate unavailable .* not starting b/)
  assert.deepEqual(r.wf, ['a'])
})

// ── 13. crash-safety ─────────────────────────────────────────────────────────
test('crash-safety: a hunt that certified in a crashed run (on disk: certified) is merged in its wave, with no workflow', async () => {
  const r = await runChainRunner([[ch('a', { status: 'certified' })], [ch('b')]])
  noErr(r)
  assert.deepEqual(r.wf, ['b'])
  assert.ok(r.idx(e => e.label === 'chain-merge:a') < r.idx(e => e.type === 'workflow-start' && e.slug === 'b'))
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
})

// ── 14. preflight ────────────────────────────────────────────────────────────
test('preflight: chain mode with chainProtocol 0 or absent → STALE PIPELINE for chain mode; missing chain script → MISSING; barrier unaffected', async () => {
  for (const cap of [{ ...CHAIN_CAP, chainProtocol: 0 }, (({ chainProtocol, ...rest }) => rest)(CHAIN_CAP)]) {
    const r = await runChainRunner([[ch('a')]], { capability: cap })
    assert.match(String(r.error && r.error.message), /STALE PIPELINE for chain mode/)
    assert.equal(r.workflowCalls.length, 0)
    assert.equal(r.labels.includes('chain-init'), false)
  }
  const ns = await runChainRunner([[ch('a')]], { capability: { ...CHAIN_CAP, chainScriptPresent: false } })
  assert.match(String(ns.error && ns.error.message), /\/pack\/scripts\/wolfpack-chain\.mjs is MISSING/)
  const barrier = await runChainRunner([[ch('a')]], { args: { chain: undefined }, capability: { ...CHAIN_CAP, chainProtocol: 0, chainScriptPresent: false } })
  noErr(barrier)
  assert.equal(barrier.result.verdict, 'WAVE_COMPLETE_AWAITING_RELEASE')
  const cap = barrier.agentCalls.find(c => c.label === 'pipeline-capability')
  assert.match(cap.prompt, /grep -o 'WOLFPACK_CHAIN_PROTOCOL=\[0-9\]\*'/)
  assert.ok(cap.prompt.includes(`test -f '/pack/scripts/wolfpack-chain.mjs' && echo present`), cap.prompt)
})
test('the runner carries the WOLFPACK_CHAIN_RUNNER=1 marker the launch command greps for', () => {
  assert.match(RUNNER, /^\/\/ WOLFPACK_CHAIN_RUNNER=1$/m)
})

// ── 15. reapply (A-12) ───────────────────────────────────────────────────────
test('A-12 reapply: a reverted dependent merges once its reverted_because hunt is campaign-merged again; otherwise it waits', async () => {
  const ready = await runChainRunner([[ch('h', { status: 'merged_to_campaign' }), ch('x', { status: 'reverted_with_dependency', revertedBecause: 'h', dependsOn: ['h'] })]])
  noErr(ready)
  assert.ok(ready.labels.includes('chain-merge:x'))
  assert.equal(ready.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  const wait = await runChainRunner([[ch('h', { status: 'parked:reverted_from_campaign' }), ch('x', { status: 'reverted_with_dependency', revertedBecause: 'h', dependsOn: ['h'] })]])
  noErr(wait)
  assert.equal(wait.labels.includes('chain-merge:x'), false)
  assert.equal(wait.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
  const bx = wait.result.blockedHunts.find(b => b.slug === 'x')
  assert.equal(bx.resolve, 'auto: re-merges after h')
  assert.deepEqual(wait.result.blockedHunts.find(b => b.slug === 'h').waiting, ['x'])
})
test('Pointer r1 F1 (A-12 circular wait): a re-certified H merges FIRST, then its reverted dependent reapplies — even when they share an app and D depends on H', async () => {
  const D = ch('d', { status: 'reverted_with_dependency', revertedBecause: 'h', dependsOn: ['h'], migrationApps: ['billing'] })
  const recert = await runChainRunner([[ch('h', { status: 'certified', migrationApps: ['billing'] }), D]])
  noErr(recert)
  assert.ok(recert.idx(e => e.label === 'chain-merge:h') >= 0)
  assert.ok(recert.idx(e => e.label === 'chain-merge:h') < recert.idx(e => e.label === 'chain-merge:d'))
  assert.equal(recert.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  // H still pending (resumed after /resolve): it runs, certifies, merges, then D reapplies
  const pend = await runChainRunner([[ch('h', { status: 'implementing', migrationApps: ['billing'] }), D]])
  noErr(pend)
  assert.deepEqual(pend.wf, ['h'])
  assert.ok(pend.idx(e => e.label === 'chain-merge:h') < pend.idx(e => e.label === 'chain-merge:d'))
  assert.equal(pend.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  // an UNRELATED parked hunt sharing the app still blocks H (rule b)
  const other = await runChainRunner([[ch('z', { status: 'parked:open_critical', migrationApps: ['billing'] }), ch('h', { status: 'certified', migrationApps: ['billing'] }), D]])
  noErr(other)
  assert.equal(other.labels.includes('chain-merge:h'), false)
  assert.deepEqual(other.result.waitingHunts.find(w => w.slug === 'h'), { slug: 'h', on: 'z', rule: 'b' })
})
test('Pointer r2 F1: a reapply waits for its OWN dependency\'s reapply (D before E when E depends on D, both reverted because of H)', async () => {
  // E is listed BEFORE D; both were reverted with H; E depends on D. Reapplying E onto a tip
  // without D's change can apply cleanly and still be semantically broken.
  const r = await runChainRunner([[
    ch('h', { status: 'certified' }),
    ch('e', { status: 'reverted_with_dependency', revertedBecause: 'h', dependsOn: ['d'] }),
    ch('d', { status: 'reverted_with_dependency', revertedBecause: 'h', dependsOn: ['h'] }),
  ]])
  noErr(r)
  const order = r.labels.filter(l => l.startsWith('chain-merge:'))
  assert.deepEqual(order, ['chain-merge:h', 'chain-merge:d', 'chain-merge:e'])
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
})

// ── 15a. final sync ──────────────────────────────────────────────────────────
test('15a final sync: everything already campaign-merged → zero workflows, exactly one chain-sync-main:final, READY; a conflict there → MAIN_CONFLICT', async () => {
  const waves = [[ch('a', { status: 'merged_to_campaign' })], [ch('b', { status: 'merged_to_campaign' })]]
  const r = await runChainRunner(waves)
  noErr(r)
  assert.equal(r.workflowCalls.length, 0)
  assert.deepEqual(r.labels.filter(l => l.startsWith('chain-sync-main')), ['chain-sync-main:final'])
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  assert.ok(r.logs.some(l => /Release it: \/release-campaign c1/.test(l)))
  const c = await runChainRunner(waves, { sync: () => ({ status: 'conflict', files: ['README.md'], exitCode: 0 }) })
  noErr(c)
  assert.equal(c.result.verdict, 'CAMPAIGN_PARKED_MAIN_CONFLICT')
  assert.equal(c.result.at, 'final sync before release')
  assert.deepEqual(c.result.conflictFiles, ['README.md'])
})
test('15a: a run ending CAMPAIGN_AWAITING_HUMAN makes no final sync and points at --checkpoint', async () => {
  const r = await runChainRunner([[ch('a'), ch('b', { status: 'parked:open_critical' })]])
  noErr(r)
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
  assert.equal(r.labels.includes('chain-sync-main:final'), false)
  assert.ok(r.logs.some(l => /\/release-campaign c1 --checkpoint/.test(l)))
})

// ── Pointer r1 (round 3) F1: the runner's rule-(c) hold shares the CLI's HOLDABLE_STATUSES ──
test('Pointer r1 F1 (round 3): a reapply-ready reverted dependent held by rule c KEEPS reverted_with_dependency and still blocks an overlapping hunt', async () => {
  // b is parked (an unrelated blocker). h re-certified and merges first, so d (reverted because
  // of h) is reapply-ready; d's diff overlaps b → held. d must stay reverted_with_dependency in the
  // live map, so it is still a blocker when g is judged: g's overlap call names b AND d.
  const r = await runChainRunner([[
    ch('b', { status: 'parked:open_critical' }),
    ch('h', { status: 'certified' }),
    ch('d', { status: 'reverted_with_dependency', revertedBecause: 'h', dependsOn: ['h'] }),
    ch('g', { status: 'certified' }),
  ]], {
    overlap: (slug) => (slug === 'd' ? { held: true, overlaps: { b: ['app/shared.py'] }, noDiff: [], exitCode: 0 }
      : slug === 'g' ? { held: true, overlaps: { d: ['app/d.py'] }, noDiff: [], exitCode: 0 }
        : { held: false, overlaps: {}, noDiff: [], exitCode: 0 }) })
  noErr(r)
  assert.deepEqual(r.labels.filter(l => l.startsWith('chain-merge:')), ['chain-merge:h'], 'only h merges: d is held, g is held on d')
  assert.match(r.agentCalls.find(c => c.label === 'chain-overlap:d').prompt, /--hunt 'd' --blockers 'b'/)
  assert.match(r.agentCalls.find(c => c.label === 'chain-overlap:g').prompt, /--hunt 'g' --blockers 'b,d'/,
    'the held reverted dependent is still a blocker for g')
  const bd = r.result.blockedHunts.find(x => x.slug === 'd')
  assert.ok(bd, 'd is reported among the blocked hunts (its status was not clobbered)')
  assert.equal(bd.status, 'reverted_with_dependency')
  assert.equal(r.result.heldHunts.some(x => x.slug === 'd'), false, 'd is not misclassified as certified_held_overlap')
  assert.deepEqual(r.result.heldHunts, [{ slug: 'g', status: 'certified_held_overlap', heldOn: ['d'] }])
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
  assert.ok(r.logs.some(l => /⏸ d: certified but HELD unmerged — its diff overlaps blocked b \(app\/shared\.py\)/.test(l)), r.logs.join('\n'))
})
test('Pointer r1 F1 (round 3): a held certified_pending_compliance hunt keeps its status in the live map; a plain certified one becomes certified_held_overlap', async () => {
  const r = await runChainRunner([[
    ch('b', { status: 'parked:open_critical' }),
    ch('red', { status: 'certified_pending_compliance' }),
    ch('g', { status: 'certified' }),
  ]], { overlap: () => ({ held: true, overlaps: { b: ['x.py'] }, noDiff: [], exitCode: 0 }) })
  noErr(r)
  assert.equal(r.labels.some(l => l.startsWith('chain-merge:')), false)
  assert.deepEqual(r.result.heldHunts, [
    { slug: 'red', status: 'certified_pending_compliance', heldOn: ['b'] },
    { slug: 'g', status: 'certified_held_overlap', heldOn: ['b'] },
  ])
})

// ════════════════════════════════════════════════════════════════════════════
// wolfpack-self-hosting (AC10): the runner's project-config probe + config-driven release queue.
// ════════════════════════════════════════════════════════════════════════════
test('AC10 (a): a failing / garbled / empty project-config probe THROWS before any hunt is gated or launched', async () => {
  const cases = [
    [{ exitCode: 2, output: '{"missing":["testCommand"]}\n✗ wolfpack-config: missing testCommand' }, /the reader exited 2: ✗ wolfpack-config: missing testCommand/],
    [{ exitCode: 0, output: 'not json' }, /no parseable JSON object/],
    [{ exitCode: 0, output: JSON.stringify({ ...FIXTURE_CONFIG, compliancePaths: null }) }, /compliancePaths is not an array/],
    [{ exitCode: 0, output: JSON.stringify({ ...FIXTURE_CONFIG, testCommand: 7 }) }, /testCommand is not a string/],
    [null, /the project-config probe returned no result/],
  ]
  for (const [ans, why] of cases) {
    const { error, events, gateCalls, workflowCalls } = await runRunner({ hunts: [hunt('a')], projectConfig: () => ans })
    assert.ok(error, JSON.stringify(ans))
    assert.match(error.message, /^campaign-runner: wolfpack-config\.md is missing or incomplete — no hunt may start\./)
    assert.match(error.message, why)
    assert.equal(gateCalls.length, 0)
    assert.equal(workflowCalls.length, 0)
    const labels = events.filter(e => e.type === 'agent').map(e => e.label)
    assert.equal(labels[labels.length - 1], 'project-config', `${JSON.stringify(ans)}: nothing after the probe ran (${labels})`)
    assert.equal(labels.some(l => /^(usage-gate|dep-check|chain-)/.test(l)), false, String(labels))
  }
})

test('AC10: the runner probe is a read-only sonnet step in phase Parse running the exact reader command, before any hunt is gated or launched', async () => {
  const { error, events, logs } = await runRunner({ hunts: [hunt('a')] })
  assert.equal(error, undefined, error && error.stack)
  const agents = events.filter(e => e.type === 'agent')
  const i = agents.findIndex(e => e.label === 'project-config')
  // pack-install-model (D9): the config probe moved to the very start of Parse — the event order is
  // now project-config, workflow-stamp, parse-campaign, pipeline-capability.
  assert.equal(i, 0, 'the config probe is the FIRST agent call')
  assert.deepEqual(agents.slice(0, 4).map(e => e.label), ['project-config', 'workflow-stamp', 'parse-campaign', 'pipeline-capability'])
  const pc = agents[i]
  assert.ok(pc)
  const firstGate = agents.findIndex(e => e.label.startsWith('usage-gate:'))
  assert.ok(firstGate > i, 'before any hunt is gated')
  assert.ok(events.findIndex(e => e.type === 'workflow-start') > events.indexOf(pc), 'before any hunt launches')
  assert.equal(pc.opts.model, 'sonnet')
  assert.equal(pc.opts.phase, 'Parse')
  // scripts-unfork: the PACK's reader, and the probe reports the PACK it used
  assert.match(pc.prompt, /echo "PACK_HOME=\$PACK"; node "\$PACK\/scripts\/wolfpack-config\.mjs" --json wolfpack-config\.md 2>&1; echo "CONFIG_RC=\$\?"/)
  assert.deepEqual(pc.opts.schema.required, ['exitCode', 'output', 'cwd', 'pack'])
  assert.ok(logs.some(l => l === 'Project config: fixture-project — tests: bash scripts/test-all.sh; deploy: deploy-x'), logs.join('\n'))
})

const releaseBlock = (logs) => {
  const i = logs.findIndex(l => /^Release this wave/.test(l))
  return i < 0 ? null : logs.slice(i, i + 8)
}

test('AC10 (b): devDeployCommand null → the release queue says "no deploy step" and omits smoke-wave + redeploy lines', async () => {
  const { error, logs } = await runRunner({ hunts: [hunt('a')], projectConfig: () => configAnswer({ ...FIXTURE_CONFIG, devDeployCommand: null }) })
  assert.equal(error, undefined, error && error.stack)
  const rel = releaseBlock(logs)
  assert.ok(rel, logs.join('\n'))
  assert.match(rel[1], /^ {2}1\. \/merge-wave \S+ 1 /)
  assert.equal(rel[2], '  2. (no deploy step — wolfpack-config.md declares none)')
  assert.equal(rel[3], '  3. (no smoke-wave — nothing is deployed)')
  assert.equal(logs.some(l => /\/smoke-wave /.test(l)), false)
  assert.equal(logs.some(l => /redeploy, re-smoke/.test(l)), false)
  assert.equal(logs.some(l => /deploy-dev/.test(l)), false)
  assert.ok(logs.some(l => /deploy: none$/.test(l)))
})

test('AC10 (c): devDeployCommand "deploy-x" → the release queue shows `2. deploy-x`, smoke-wave and the revert note', async () => {
  const { error, logs } = await runRunner({ hunts: [hunt('a')] })
  assert.equal(error, undefined, error && error.stack)
  const rel = releaseBlock(logs)
  assert.ok(rel, logs.join('\n'))
  assert.match(rel[2], /^ {2}2\. deploy-x {3}\(ONE deploy for the whole wave — wolfpack-config\.md → Dev deploy command\)$/)
  assert.match(rel[3], /^ {2}3\. \/smoke-wave \S+ 1 /)
  assert.ok(logs.some(l => /redeploy, re-smoke that hunt only/.test(l)))
  assert.equal(logs.some(l => /deploy-dev/.test(l)), false, 'no hard-coded consumer deploy function')
})

// ─── exec-layer-into-pack: the runner resolves WOLFPACK_HOME before any hunt (AC3) ─────────
test('AC3 (a): env WOLFPACK_HOME wins over the key — logged with its source; nothing is passed to the hunts', async () => {
  const { error, logs, workflowCalls } = await runRunner({ hunts: [hunt('a')], env: { WOLFPACK_HOME: '/envpack/' } })
  assert.equal(error, undefined, error && error.stack)
  assert.ok(logs.includes('Pack home (WOLFPACK_HOME): /envpack — from env WOLFPACK_HOME'), logs.join('\n'))
  assert.equal(workflowCalls.length, 1)
  assert.equal(JSON.stringify(workflowCalls[0].args).includes('envpack'), false, 'each hunt resolves for itself')
  assert.equal('wolfpackHome' in workflowCalls[0].args, false)
})

test('AC3 (b): env unset or blank → the config key is used', async () => {
  for (const env of [{}, { WOLFPACK_HOME: '' }, { WOLFPACK_HOME: ' ' }]) {
    const { error, logs, workflowCalls } = await runRunner({ hunts: [hunt('a')], env })
    assert.equal(error, undefined, error && error.stack)
    assert.ok(logs.includes('Pack home (WOLFPACK_HOME): /pack — from wolfpack-config.md → Project Identity → Wolfpack home'), logs.join('\n'))
    assert.equal(workflowCalls.length, 1)
  }
})

test('AC3 (c): neither env nor key → throws naming WOLFPACK_HOME and the key, BEFORE any hunt is gated, parsed or launched', async () => {
  for (const cfg of [{ ...FIXTURE_CONFIG, wolfpackHome: null }, (({ wolfpackHome, ...rest }) => rest)(FIXTURE_CONFIG)]) {
    const { error, events, workflowCalls, gateCalls } = await runRunner({ hunts: [hunt('a')], env: {}, projectConfig: () => configAnswer(cfg) })
    assert.ok(error, 'throws')
    assert.match(error.message, /^campaign-runner: WOLFPACK_HOME is not set and wolfpack-config\.md has no Wolfpack home — the pack's execution shims are never looked up in the consuming repo\. Fix: export WOLFPACK_HOME=/)
    assert.match(error.message, /"- \*\*Wolfpack home:\*\* `<path>`" under ## Project Identity in wolfpack-config\.md/)
    assert.equal(workflowCalls.length, 0)
    assert.equal(gateCalls.length, 0)
    const agents = events.filter(e => e.type === 'agent').map(e => e.label)
    assert.deepEqual(agents.slice(agents.indexOf('project-config') + 1), [], `nothing after the config probe (${agents})`)
  }
  // a relative value is refused too
  const rel = await runRunner({ hunts: [hunt('a')], env: { WOLFPACK_HOME: 'pack' } })
  assert.match(rel.error && rel.error.message, /campaign-runner: env WOLFPACK_HOME is not an absolute path \('pack'\)/)
  assert.equal(rel.workflowCalls.length, 0)
})

test('AC3 parity: resolveWolfpackHome is identical in both workflows apart from the env accessor', () => {
  const pipeline = readFileSync(join(here, '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
  const body = (src) => {
    const m = /const resolveWolfpackHome = \(who\) => \{\n[\s\S]*?\n\}\n/.exec(src)
    assert.ok(m, 'resolveWolfpackHome found')
    return m[0]
  }
  const a = body(RUNNER).replace(/_envRunner\(/g, 'ENV(')
  const b = body(pipeline).replace(/_env\(/g, 'ENV(')
  assert.equal(a, b)
  assert.match(a, /ENV\('WOLFPACK_HOME'\)/)
  assert.doesNotMatch(RUNNER, /repoRoot\}?\/scripts\/(podman-vibe|run-pipeline-sandbox)\.sh/, 'AC4 grep (runner)')
})

// ════════════════════════════════════════════════════════════════════════════
// pack-install-model (AC5, D9): the runner's run-start stamp check, the Worktree root key and
// the hunt-pipeline gate — all before parse-campaign. STAMPED sources come from the REAL generator.
// ════════════════════════════════════════════════════════════════════════════
import { render as renderWorkflow } from './wolfpack-workflows.mjs'
const CANON_RUNNER = readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
const RUNNER_STAMP = { workflow: 'campaign-runner.js', commit: 'b'.repeat(40), version: 'v0.2.0-1-gbbbbbbb', source: `sha256:${'5'.repeat(64)}` }
const stampedRunner = (stamp = RUNNER_STAMP) => stripMeta(renderWorkflow(CANON_RUNNER, stamp))
const agentLabels = (events) => events.filter(e => e.type === 'agent').map(e => e.label)
const assertStoppedAtStamp = (r, why) => {
  assert.ok(r.error, `${why}: must throw`)
  assert.deepEqual(agentLabels(r.events), ['project-config', 'workflow-stamp'], `${why}: nothing after the stamp probe`)
  assert.equal(r.workflowCalls.length, 0, why)
}

test('AC5 runner: the stamp probe is a read-only sonnet Parse step running the pack checker, right after the config probe', async () => {
  const { error, events, logs } = await runRunner({ hunts: [hunt('a')] })
  assert.equal(error, undefined, error && error.stack)
  const p = events.find(e => e.label === 'workflow-stamp')
  assert.equal(p.opts.model, 'sonnet')
  assert.equal(p.opts.phase, 'Parse')
  assert.deepEqual(p.opts.schema.required, ['exitCode', 'output', 'cwd'])
  assert.ok(p.prompt.includes(`node '/pack/scripts/wolfpack-workflows.mjs' check --pack '/pack' --consumer "$(pwd)" --json 2>&1; echo "STAMP_RC=$?"`))
  assert.ok(logs.includes('Workflow version: campaign-runner.js canonical — pack v0.2.0-1-gaaaaaaa @ aaaaaaaaaaaa (/repo/.claude/workflows/campaign-runner.js)'), logs.join('\n'))
})

test('AC5 runner: a STAMPED runner whose stamp is current logs its version line and runs the campaign', async () => {
  const r = await runAny(stampedRunner(), { parse: { waves: [{ number: 1, hunts: [hunt('a')] }] }, args: { campaignSlug: 'c1' },
    stamp: () => stampAnswer({ runner: 'current', hunt: 'current', canonicalSource: RUNNER_STAMP.source, runnerExtra: { stamp: RUNNER_STAMP } }) })
  noErr(r)
  assert.ok(r.logs.includes(`Workflow version: campaign-runner.js v0.2.0-1-gbbbbbbb @ bbbbbbbbbbbb (source sha256:555555555555…) — current against the pack at /pack`), r.logs.join('\n'))
  assert.deepEqual(r.wf, ['a'])
})

test('AC5 runner: a STAMPED runner that is stale throws before parse-campaign and before any workflow()', async () => {
  for (const [state, re] of [['stale', /campaign-runner\.js is stale\. Fix: bash '\/pack\/install\.sh' --consumer '\/repo', then restart Claude Code and relaunch\./],
    ['current', /is already regenerated: this session is running a CACHED older copy — restart Claude Code/]]) {
    const r = await runAny(stampedRunner(), { parse: { waves: [{ number: 1, hunts: [hunt('a')] }] }, args: { campaignSlug: 'c1' }, stamp: () => stampAnswer({ runner: state }) })
    assertStoppedAtStamp(r, state)
    assert.match(r.error.message, /^campaign-runner: STALE WORKFLOW — this run is campaign-runner\.js v0\.2\.0-1-gbbbbbbb @ bbbbbbbbbbbb/)
    assert.match(r.error.message, re)
  }
})

test('AC5 runner: a STAMPED runner with a matching source but its own entry modified / unstamped throws before parse-campaign', async () => {
  for (const state of ['modified', 'unstamped', 'missing']) {
    const r = await runAny(stampedRunner(), { parse: { waves: [{ number: 1, hunts: [hunt('a')] }] }, args: { campaignSlug: 'c1' },
      stamp: () => stampAnswer({ runner: state, canonicalSource: RUNNER_STAMP.source }) })
    assertStoppedAtStamp(r, state)
    assert.ok(r.error.message.startsWith(`campaign-runner: /repo/.claude/workflows/campaign-runner.js is ${state} — its stamp matches the pack but the copy on disk is not the generated bytes.`), r.error.message)
    assert.match(r.error.message, /restart Claude Code/)
  }
})

test('AC5 runner: the runtime hunt-pipeline.js entry not current/canonical → throws naming it, before parse-campaign', async () => {
  for (const state of ['stale', 'missing', 'modified', 'unstamped', 'foreign-link']) {
    const r = await runRunner({ hunts: [hunt('a')], stamp: () => stampAnswer({ hunt: state }) })
    assertStoppedAtStamp(r, state)
    assert.equal(r.error.message, `campaign-runner: the runtime hunt-pipeline.js is ${state} — no hunt may start. Fix: bash '/pack/install.sh' --consumer '/repo', then restart Claude Code and relaunch.`)
  }
  // not reported at all → throws too (fail closed)
  const res = stampResult(); res.workflows = res.workflows.filter(w => w.name !== 'hunt-pipeline.js')
  const r = await runRunner({ hunts: [hunt('a')], stamp: () => ({ exitCode: 0, output: JSON.stringify(res), cwd: '/repo' }) })
  assertStoppedAtStamp(r, 'not reported')
  assert.match(r.error.message, /the runtime hunt-pipeline\.js is not reported — no hunt may start/)
  // a current hunt-pipeline next to the canonical runner proceeds
  const ok = await runRunner({ hunts: [hunt('a')], stamp: () => stampAnswer({ hunt: 'current' }) })
  assert.equal(ok.error, undefined, ok.error && ok.error.stack)
  assert.equal(ok.workflowCalls.length, 1)
})

test('AC5 runner: a null / exit-2 / garbled stamp probe throws (fail closed) before parse-campaign', async () => {
  for (const [ans, re] of [[null, /workflow stamp probe returned no result/], [{ exitCode: 2, output: 'boom' }, /stamp check failed \(exit 2\)/],
    [{ exitCode: 0, output: 'nope' }, /held no checker result/]]) {
    const r = await runRunner({ hunts: [hunt('a')], stamp: () => ans })
    assertStoppedAtStamp(r, JSON.stringify(ans))
    assert.match(r.error.message, /^campaign-runner: /)
    assert.match(r.error.message, re)
  }
})

test('D9 runner: a config without Worktree root throws the key fix (not a ReferenceError) before the stamp probe and parse-campaign', async () => {
  for (const cfg of [(({ worktreeRoot, ...rest }) => rest)(FIXTURE_CONFIG), { ...FIXTURE_CONFIG, worktreeRoot: null }, { ...FIXTURE_CONFIG, worktreeRoot: '../x' }]) {
    const r = await runRunner({ hunts: [hunt('a')], projectConfig: () => configAnswer(cfg) })
    assert.ok(r.error, JSON.stringify(cfg))
    assert.equal(r.error instanceof ReferenceError, false, r.error.stack)
    assert.match(r.error.message, /^campaign-runner: wolfpack-config\.md (has no Worktree root|→ Worktree root '\.\.\/x' is not a repo-relative path)/)
    assert.match(r.error.message, /Fix: add "- \*\*Worktree root:\*\* `<dir>`" under ## Project Identity/)
    assert.deepEqual(agentLabels(r.events), ['project-config'])
    assert.equal(r.workflowCalls.length, 0)
  }
})

test('D9 runner: the parse prompt reads hunt status from the configured Worktree root', async () => {
  const r = await runAny(RUNNER, { parse: { waves: [{ number: 1, hunts: [hunt('a')] }] }, args: { campaignSlug: 'c1' },
    projectConfig: () => configAnswer({ ...FIXTURE_CONFIG, worktreeRoot: '.wt/hunts' }) })
  noErr(r)
  const p = r.agentCalls.find(c => c.label === 'parse-campaign').prompt
  assert.ok(p.includes('.wt/hunts/<slug>/.wolfpack/plans/<slug>/metadata.json FIRST if it exists'), p)
  assert.doesNotMatch(p, /\.agents\/worktrees/)
  assert.ok(r.logs.includes('Worktree root: .wt/hunts (wolfpack-config.md → Project Identity)'))
})

test('AC7 runner: no fix text names the retired sync-runtime script; stale-pipeline fixes name install.sh --consumer', async () => {
  assert.ok(!CANON_RUNNER.includes(RETIRED_SYNC))
  const { error } = await runRunner({ hunts: [hunt('a')], capability: { path: '.claude/workflows/hunt-pipeline.js', protocol: 0, gatePresent: true, gateProtocol: 1 } })
  assert.match(String(error && error.message), /Regenerate it: bash '\/pack\/install\.sh' --consumer <this repo> \(then restart Claude Code\), then relaunch\./)
  const legacy = await runRunner({ hunts: [hunt('a')], usageProtocol: 0 })
  assert.ok(legacy.logs.some(l => /predates the usage gate .* regenerate it: bash '\/pack\/install\.sh' --consumer <this repo>/.test(l)), legacy.logs.join('\n'))
})

// ════════════════════════════════════════════════════════════════════════════
// workflow-meta-runtime: the Workflow runtime STRIPS the `export const meta` block, so runtime
// code must not reference `meta`; the run-start probes must agree on one host repo.
// ════════════════════════════════════════════════════════════════════════════
test('workflow-meta-runtime AC1/AC5: the stripped runner launches and reaches the stamp probe (no ReferenceError)', async () => {
  const r = await runRunner({ hunts: [hunt('a')] })
  assert.equal(r.error, undefined, r.error && r.error.stack)
  assert.ok(agentLabels(r.events).includes('workflow-stamp'))
})

test('workflow-meta-runtime AC5: no runtime code references `meta`, and the guard goes red when one does', async () => {
  assert.deepEqual(runtimeMetaRefs(stripMeta(CANON_RUNNER)), [])
  const bad = CANON_RUNNER.replace('`${WORKFLOW_NAME}.js`', '`${meta.name}.js`')
  assert.notEqual(bad, CANON_RUNNER, 'the mutation applied')
  assert.ok(runtimeMetaRefs(stripMeta(bad)).length > 0, 'the guard flags the mutated source')
  const r = await runAny(stripMeta(bad), { parse: { waves: [{ number: 1, hunts: [hunt('a')] }] }, args: { campaignSlug: 'c1' } })
  assert.match(String(r.error && r.error.message), /meta is not defined/)
})

test('workflow-meta-runtime AC2: WORKFLOW_NAME equals the meta block name; no meta.name access in the body', () => {
  const { meta, body } = splitMeta(CANON_RUNNER)
  assert.equal(meta.name, 'campaign-runner')
  assert.match(body, /^const WORKFLOW_NAME = 'campaign-runner'$/m)
  assert.doesNotMatch(body, /\bmeta\.name\b/)
})

test('workflow-meta-runtime AC6: both runner probes run with no cd, print PROBE_PWD, and require cwd', async () => {
  const { events } = await runRunner({ hunts: [hunt('a')] })
  for (const label of ['project-config', 'workflow-stamp']) {
    const e = events.find(x => x.label === label)
    assert.ok(e.prompt.includes('do NOT cd anywhere'), label)
    assert.ok(e.prompt.includes('echo "PROBE_PWD=$(pwd)";'), label)
    assert.ok(!e.prompt.includes('From the repo root (your starting directory)'), label)
    assert.ok(e.opts.schema.required.includes('cwd'), label)
  }
})

test('workflow-meta-runtime AC7: probes that disagree on the host repo THROW naming both paths; nothing after the stamp probe runs', async () => {
  const cases = [
    ['stamp probe cwd and checker consumer both elsewhere', { stamp: () => stampAnswer({ consumer: '/other' }, undefined, '/other') }],
    ['stamp probe cwd elsewhere', { stamp: () => stampAnswer({}, undefined, '/other') }],
    ['checker consumer elsewhere', { stamp: () => stampAnswer({ consumer: '/other' }) }],
    ['config probe elsewhere', { projectConfig: () => configAnswer(FIXTURE_CONFIG, '/other') }],
  ]
  for (const [why, over] of cases) {
    const r = await runRunner({ hunts: [hunt('a')], ...over })
    assertStoppedAtStamp(r, why)
    assert.match(r.error.message, /^campaign-runner: HOST REPO DRIFTED/, why)
    assert.match(r.error.message, /\/repo[\s\S]*\/other|\/other[\s\S]*\/repo/, why)
  }
})

test('workflow-meta-runtime AC7: trailing slashes are normalized (no realpath) and the run proceeds', async () => {
  const r = await runRunner({ hunts: [hunt('a')], projectConfig: () => configAnswer(FIXTURE_CONFIG, '/repo/'),
    stamp: () => stampAnswer({ consumer: '/repo/' }, undefined, '/repo//') })
  assert.equal(r.error, undefined, r.error && r.error.stack)
  assert.equal(r.workflowCalls.length, 1)
})

test('workflow-meta-runtime AC8: a missing / relative cwd fails closed', async () => {
  {
    const { cwd, ...noCwd } = configAnswer()
    const r = await runRunner({ hunts: [hunt('a')], projectConfig: () => noCwd })
    assert.match(String(r.error && r.error.message), /project-config probe did not report the directory it ran in/)
    assert.deepEqual(agentLabels(r.events), ['project-config'])
  }
  {
    const r = await runRunner({ hunts: [hunt('a')], projectConfig: () => configAnswer(FIXTURE_CONFIG, 'repo') })
    assert.match(String(r.error && r.error.message), /project-config probe did not report the directory it ran in/)
    assert.deepEqual(agentLabels(r.events), ['project-config'])
  }
  for (const stampCwd of [undefined, 'repo', '']) {
    const { cwd, ...noCwd } = stampAnswer()
    const r = await runRunner({ hunts: [hunt('a')], stamp: () => (stampCwd === undefined ? noCwd : stampAnswer({}, undefined, stampCwd)) })
    assertStoppedAtStamp(r, String(stampCwd))
    assert.match(r.error.message, /HOST REPO DRIFTED[\s\S]*\(not reported\)/, String(stampCwd))
  }
})

// ── scripts-unfork (AC7): consumer-hosted — every pack script from the Wolfpack home ─────────
// repo /repo has no scripts/ dir; FIXTURE_CONFIG's Wolfpack home is /pack.
test('AC7 consumer-hosted runner: window-gate / chain / capability-probe / config commands all name the pack home, never the repo', async () => {
  const r = await runChainRunner([[ch('a'), ch('b')], [ch('c')]])
  noErr(r)
  const seen = new Set()
  for (const c of r.agentCalls) {
    assert.doesNotMatch(c.prompt, /\/repo\/scripts\/wolfpack-/, `${c.label}: a consuming-repo script path`)
    assert.doesNotMatch(c.prompt, /(^|[\s'"`(])\.\/scripts\/(lib\/)?wolfpack-/m, `${c.label}: a ./scripts/ invocation`)
    assert.doesNotMatch(c.prompt, /(node|bash|sh|test -f|grep -o '[^']*') +['"]?scripts\/(lib\/)?wolfpack-/, `${c.label}: a repo-relative path`)
    for (const m of c.prompt.matchAll(/wolfpack-(window-gate|chain|config|usage)\.mjs/g)) {
      const before = c.prompt.slice(Math.max(0, m.index - 16), m.index)
      assert.ok(before.endsWith('/pack/scripts/') || before.endsWith('$PACK/scripts/') || before.endsWith('<pack>/scripts/') || before.endsWith('has no scripts/'),
        `${c.label}: ${m[0]} is not under the pack home (…${before})`)
      seen.add(m[1])
    }
  }
  for (const s of ['window-gate', 'chain', 'config']) assert.ok(seen.has(s), `no runner prompt ran wolfpack-${s}`)
  const by = (p) => r.agentCalls.find(c => c.label.startsWith(p)).prompt
  assert.ok(by('usage-gate:a').includes(`node '/pack/scripts/wolfpack-window-gate.mjs' --json --tier Yellow`))
  assert.ok(by('chain-init').includes(`node '/pack/scripts/wolfpack-chain.mjs' init`))
  assert.ok(by('chain-merge:a').includes(`node '/pack/scripts/wolfpack-chain.mjs' merge-hunt`))
  assert.ok(by('pipeline-capability').includes(`test -f '/pack/scripts/wolfpack-chain.mjs' && echo present`))
})

test('AC7 runner config probe: env leg injects PACK=\'<env>\'; a mismatching probe pack throws before parse — the helpers match hunt-pipeline\'s', async () => {
  const env = await runRunner({ hunts: [hunt('a')], env: { WOLFPACK_HOME: '/pack' } })
  assert.equal(env.error, undefined, env.error && env.error.stack)
  const p = env.events.find(e => e.label === 'project-config').prompt
  assert.ok(p.includes(`PACK='/pack'; echo "PROBE_PWD=$(pwd)"; echo "PACK_HOME=$PACK"; node "$PACK/scripts/wolfpack-config.mjs"`), p)
  assert.doesNotMatch(p, /\$WOLFPACK_HOME/)
  const key = await runRunner({ hunts: [hunt('a')] })
  assert.match(key.events.find(e => e.label === 'project-config').prompt, /VERBATIM — do NOT expand `~`/)
  for (const pack of ['/other', '']) {
    const bad = await runRunner({ hunts: [hunt('a')], projectConfig: () => ({ ...configAnswer(), pack }) })
    assert.match(String(bad.error && bad.error.message), new RegExp(`^campaign-runner: the config probe ran the reader from '${pack.replace(/\//g, '\\/')}' but the pack home resolves to '\\/pack'`))
    assert.deepEqual(agentLabels(bad.events), ['project-config'], 'nothing after the probe')
  }
  const slash = await runRunner({ hunts: [hunt('a')], projectConfig: () => ({ ...configAnswer(), pack: '/pack/' }) })
  assert.equal(slash.error, undefined, slash.error && slash.error.stack)
  // byte-identical probe helpers in both workflows (the plan's "body identical" rule)
  const HP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.agents', 'workflows', 'hunt-pipeline.js'), 'utf8')
  const RN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
  const grab = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, start); return src.slice(i, src.indexOf('\n}\n', i) + 3) }
  for (const start of ['const configProbeCommand = (envHome) => {', 'const requireProbedPack = (who, home) => {']) {
    assert.equal(grab(HP, start), grab(RN, start), start)
  }
  for (const line of ['let probedPackHome = \'\'']) { assert.ok(HP.includes(line) && RN.includes(line), line) }
})


// ════════════════════════════════════════════════════════════════════════════
// campaign-cron-resume AC11 — the chain runner's cron events (disarm + phone pages).
// Each event is ONE sonnet agent step running `bash '<pack>/scripts/wolfpack-cron-resume.sh' …`;
// the stub answers cron-* labels so a scenario can see (and break) them.
// ════════════════════════════════════════════════════════════════════════════
const CRON_OK = () => ({ exitCode: 0, output: 'ok' })
const cronCalls = (r) => r.agentCalls.filter(c => c.label.startsWith('cron-'))
const cronCmd = (c) => {
  const m = /bash '\/pack\/scripts\/wolfpack-cron-resume\.sh' (.*)\n/.exec(c.prompt)
  assert.ok(m, `the cron step runs the pack CLI: ${c.prompt}`)
  return m[1]
}

test('AC11 (a): all hunts certify + merge → CAMPAIGN_READY_FOR_RELEASE → one cron-finish: event ready-for-release', async () => {
  const r = await runChainRunner([[ch('a'), ch('b')], [ch('c')]], { cron: CRON_OK })
  noErr(r)
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  const cc = cronCalls(r)
  assert.deepEqual(cc.map(c => c.label), ['cron-finish'])
  assert.equal(cronCmd(cc[0]), "event ready-for-release --campaign 'c1'")
  assert.equal(cc[0].opts.model, 'sonnet')
  assert.deepEqual(cc[0].opts.schema.required, ['exitCode', 'output'])
  assert.match(cc[0].prompt, /Modify nothing else/)
  // after every merge (the finish is the LAST agent step)
  assert.equal(r.labels[r.labels.length - 1], 'cron-finish')
})

test('AC11: all merged but a compliance sign-off owed → event waiting-on-you merged_awaiting_compliance, not ready-for-release', async () => {
  const r = await runChainRunner([[ch('a', { status: 'merged_to_campaign' }), ch('b', { status: 'merged_to_campaign_pending_compliance' })]], { cron: CRON_OK })
  noErr(r)
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  const fin = cronCalls(r).filter(c => c.label === 'cron-finish')
  assert.equal(fin.length, 1)
  assert.equal(cronCmd(fin[0]), "event waiting-on-you --campaign 'c1' --status merged_awaiting_compliance")
})

test('AC13: a cron event the CLI dropped (lock busy) or failed to page is logged as a warning, run continues', async () => {
  for (const output of ['dropped: state lock busy', 'ok: park notification FAILED: http_500']) {
    const r = await runChainRunner([[ch('a'), ch('b')]], { cron: () => ({ exitCode: 0, output }) })
    noErr(r)
    assert.ok(r.logs.some(l => /⚠ cron event cron-finish: exit 0/.test(l)), output)
  }
})

test('AC11 (b): a parked hunt with the rest waiting → cron-park:<slug> (event park …), then event waiting-on-you', async () => {
  const waves = [[ch('b')], [ch('e', { dependsOn: ['b'] })]]
  const r = await runChainRunner(waves, { cron: CRON_OK,
    workflowResult: (a) => (a.slug === 'b' ? { slug: 'b', verdict: 'PARKED', status: 'parked:open_critical', reason: 'open_critical' } : CERT(a)) })
  noErr(r)
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
  const cc = cronCalls(r)
  assert.deepEqual(cc.map(c => c.label), ['cron-park:b', 'cron-finish'])
  assert.equal(cronCmd(cc[0]), "event park --campaign 'c1' --hunt 'b' --status 'parked:open_critical' --reason 'open_critical'")
  assert.equal(cronCmd(cc[1]), "event waiting-on-you --campaign 'c1' --status 'campaign_awaiting_human'")
  // the park page follows that hunt's own result, before the next hunt's work
  assert.ok(r.idx(e => e.type === 'workflow-end' && e.slug === 'b') < r.idx(e => e.label === 'cron-park:b'))
})

test('AC11 (c): one park among certifying hunts → exactly one cron-park call; needs_spec pages with reason needs_spec', async () => {
  const r = await runChainRunner([[ch('a'), ch('p'), ch('c')]], { cron: CRON_OK,
    workflowResult: (a) => (a.slug === 'p' ? { slug: 'p', verdict: 'NEEDS_SPEC', status: 'needs_spec' } : CERT(a)) })
  noErr(r)
  const parks = cronCalls(r).filter(c => c.label.startsWith('cron-park:'))
  assert.deepEqual(parks.map(c => c.label), ['cron-park:p'])
  assert.equal(cronCmd(parks[0]), "event park --campaign 'c1' --hunt 'p' --status 'needs_spec' --reason 'needs_spec'")
})

test('AC11 (c2): a parked DEPENDENT (the dependent path) pages too', async () => {
  const r = await runChainRunner([[ch('a'), ch('d', { dependsOn: ['a'] })]], { cron: CRON_OK,
    workflowResult: (a) => (a.slug === 'd' ? { slug: 'd', verdict: 'PARKED', status: 'parked:non_convergence', reason: 'non_convergence' } : CERT(a)) })
  noErr(r)
  const parks = cronCalls(r).filter(c => c.label.startsWith('cron-park:'))
  assert.deepEqual(parks.map(c => c.label), ['cron-park:d'])
})

test('AC11 (d): parked:model_quota never pages (it auto-resumes)', async () => {
  const r = await runChainRunner([[ch('a'), ch('q')]], { cron: CRON_OK,
    workflowResult: (a) => (a.slug === 'q' ? { slug: 'q', verdict: 'PARKED', status: 'parked:model_quota', reason: 'model_quota' } : CERT(a)) })
  noErr(r)
  assert.equal(cronCalls(r).filter(c => c.label.startsWith('cron-park:')).length, 0)
  assert.equal(r.result.verdict, 'WAVE_PAUSED_QUOTA')
})

test('AC11 (e): WAVE_PAUSED_QUOTA with resetAt → note-pause --reset-at; WAVE_PAUSED_BUDGET → event waiting-on-you', async () => {
  const q = await runChainRunner([[ch('a'), ch('b')]], { cron: CRON_OK, gate: (slug) => (slug === 'b' ? DEFER5H : PROCEED) })
  noErr(q)
  assert.equal(q.result.verdict, 'WAVE_PAUSED_QUOTA')
  const qf = cronCalls(q).filter(c => c.label === 'cron-finish')
  assert.equal(qf.length, 1)
  assert.equal(cronCmd(qf[0]), `note-pause --campaign 'c1' --reset-at '${DEFER5H.reset_at}'`)

  let left = 1e6   // the run's budget is spent by hunt a (the per-run runaway breaker)
  const b = await runChainRunner([[ch('a'), ch('b')]], { cron: CRON_OK, args: { maxParallel: 1 },
    budget: { total: 1e6, remaining: () => left }, workflowResult: (a) => { left = 1000; return CERT(a) } })
  noErr(b)
  assert.equal(b.result.verdict, 'WAVE_PAUSED_BUDGET')
  const bf = cronCalls(b).filter(c => c.label === 'cron-finish')
  assert.equal(bf.length, 1)
  assert.equal(cronCmd(bf[0]), "event waiting-on-you --campaign 'c1' --status wave_paused_budget")
})

test('AC11: CAMPAIGN_PARKED_MAIN_CONFLICT → waiting-on-you; a parked:model_quota pause without resetAt → note-exit', async () => {
  const waves = [[ch('a', { status: 'merged_to_campaign' })]]
  const c = await runChainRunner(waves, { cron: CRON_OK, sync: () => ({ status: 'conflict', files: ['README.md'], exitCode: 0 }) })
  noErr(c)
  assert.equal(c.result.verdict, 'CAMPAIGN_PARKED_MAIN_CONFLICT')
  assert.equal(cronCmd(cronCalls(c).find(x => x.label === 'cron-finish')), "event waiting-on-you --campaign 'c1' --status 'campaign_parked_main_conflict'")
  const q = await runChainRunner([[ch('q')]], { cron: CRON_OK,
    workflowResult: (a) => ({ slug: a.slug, verdict: 'PARKED', status: 'parked:model_quota', reason: 'model_quota' }) })
  noErr(q)
  assert.equal(q.result.verdict, 'WAVE_PAUSED_QUOTA')
  const fin = cronCmd(cronCalls(q).find(x => x.label === 'cron-finish'))
  if (q.result.resetAt) assert.match(fin, /^note-pause --campaign 'c1' --reset-at /)
  else assert.equal(fin, "note-exit --campaign 'c1' --verdict 'WAVE_PAUSED_QUOTA'")
})

test('AC11 (f): runChain throws → note-exit --verdict error (cron-exit:error), then the error propagates', async () => {
  const r = await runChainRunner([[ch('a'), ch('b')]], { cron: CRON_OK, gate: (slug) => (slug === 'b' ? null : PROCEED) })
  assert.ok(r.error, 'the runner still throws')
  const cc = cronCalls(r)
  assert.deepEqual(cc.map(c => c.label), ['cron-exit:error'])
  assert.equal(cronCmd(cc[0]), "note-exit --campaign 'c1' --verdict error")
})

test('AC11 (g): a cron step that fails (exit 1 / throws / null) never changes the runner result — ⚠ log only', async () => {
  const waves = [[ch('b')], [ch('e', { dependsOn: ['b'] })]]
  const wr = (a) => (a.slug === 'b' ? { slug: 'b', verdict: 'PARKED', status: 'parked:open_critical', reason: 'open_critical' } : CERT(a))
  const ok = await runChainRunner(waves, { cron: CRON_OK, workflowResult: wr })
  noErr(ok)
  for (const [name, cron] of [
    ['exit 1', () => ({ exitCode: 1, output: 'ERROR: boom' })],
    ['throws', () => { throw new Error('agent crashed') }],
    ['null', () => null],
  ]) {
    const r = await runChainRunner(waves, { cron, workflowResult: wr })
    noErr(r)
    assert.deepEqual(r.result, ok.result, name)
    assert.deepEqual(r.wf, ok.wf, name)
    assert.ok(r.logs.some(l => /⚠ cron event cron-park:b/.test(l)), `${name}: ${r.logs.join('\n')}`)
    assert.ok(r.logs.some(l => /⚠ cron event cron-finish/.test(l)), name)
  }
})

test('AC11 (h): unattended: true is echoed in the chain result and logged once; absent → false', async () => {
  const u = await runChainRunner([[ch('a')]], { cron: CRON_OK, args: { unattended: true } })
  noErr(u)
  assert.equal(u.result.unattended, true)
  assert.equal(u.logs.filter(l => /UNATTENDED run/.test(l)).length, 1)
  const a = await runChainRunner([[ch('a')]], { cron: CRON_OK })
  noErr(a)
  assert.equal(a.result.unattended, false)
  assert.equal(a.logs.some(l => /UNATTENDED run/.test(l)), false)
  const s = await runChainRunner([[ch('a')]], { cron: CRON_OK, args: { unattended: 'yes' } })
  assert.equal(s.result.unattended, false, 'only a literal true')
})

test('AC11 (i): barrier mode makes no cron call at all', async () => {
  const waves = [[hunt('a'), hunt('b')]]
  const r = await runAny(RUNNER, { parse: parseOf(waves), args: { campaignSlug: 'c1', maxParallel: 1 },
    capability: { ...CHAIN_CAP, chainProtocol: 0, chainScriptPresent: false }, cron: CRON_OK,
    workflowResult: (a) => (a.slug === 'b' ? { slug: 'b', verdict: 'PARKED', status: 'parked:open_critical', reason: 'open_critical' } : { slug: a.slug, verdict: 'CERTIFIED_AWAITING_DEPLOY' }) })
  noErr(r)
  assert.equal(cronCalls(r).length, 0)
})

test('AC11: the campaign and hunt slugs reach the cron CLI shell-quoted', async () => {
  const r = await runChainRunner([[ch('h-1')]], { cron: CRON_OK,
    workflowResult: (a) => ({ slug: a.slug, verdict: 'PARKED', status: 'parked:open_critical', reason: 'open_critical' }) })
  noErr(r)
  const park = cronCalls(r).find(c => c.label === 'cron-park:h-1')
  assert.equal(cronCmd(park), "event park --campaign 'c1' --hunt 'h-1' --status 'parked:open_critical' --reason 'open_critical'")
})

// ════════════════════════════════════════════════════════════════════════════
// POST-MERGE STAGE (wave-auto-smoke) — postMergeStage() driven through the whole runner.
// Every stage step is a relay of ONE wolfpack-smoke-stage.mjs / wolfpack-release.mjs /
// wolfpack-test-record.mjs CLI call; here a stateful fake answers each relay label with the
// CLI's JSON (as {exitCode, output}), so a scenario controls one step and asserts the sequence.
// ════════════════════════════════════════════════════════════════════════════
const STAGE_CONFIG = { ...FIXTURE_CONFIG, postMergeStage: true, integrationTestArgs: '--isolated-db {campaign}' }
const TIP = 'c'.repeat(40)
const REPORT = 'http://100.64.0.7:8766/c1/'
const relayOut = (obj, exitCode) => ({ exitCode: exitCode ?? (obj && obj.status === 'error' ? 2 : 0), output: JSON.stringify(obj) })
const waveOf = (prompt) => Number((/--wave (\d+)/.exec(prompt) || [])[1] || 0)
const mergedOf = (prompt) => ((/--merged '([^']*)'/.exec(prompt) || [])[1] || '').split(',').filter(Boolean)
// The default (green) CLI answers, by relay label.
function stageDefaults(label, prompt) {
  if (label === 'stage-check-config') return { status: 'ok', post_merge_stage: true, tenants: { surgical: 's.example.dev', mobile: 'm.example.dev' } }
  if (label === 'stage-begin') {
    if (prompt.includes('--resume-only')) return { status: 'ok', action: 'resume-only', created: true, staged_from_wave: 1, not_staged_below: null, rearmed: null, unstaged: [], current: null, pruned: [] }
    const polish = (/--polish '([^']*)'/.exec(prompt) || [])[1]
    return { status: 'ok', action: 'new', wave: waveOf(prompt), step: 'begin', campaign_sha: TIP, iteration: polish ? 2 : 1, merged: mergedOf(prompt), polish: polish || null,
      polish_merge: polish ? 'f'.repeat(40) : null, polish_issues: polish ? ['ISS-p'] : [], pruned: [] }
  }
  if (label.startsWith('stage-session')) return { status: 'ok', sessions: {}, problems: [], session_drops: [] }
  if (label === 'stage-deploy' || label === 'stage-migrate') return { status: 'ok', exit: 0, sha: TIP, log: '/l' }
  if (label === 'stage-ensure-tenants') return { status: 'ok', exit: 0, notices: [] }
  if (label === 'stage-suites') return { status: 'ok', labels: ['billing'], full: false, reason: 'touched apps: billing', record_labels: 'billing', empty: false, command: "t --isolated-db 'c1' billing" }
  if (label === 'stage-integration') return { schema: 1, stage: 'integration', commit: TIP, pass: true }
  if (label === 'stage-ingest-integration') return { status: 'ok', action: 'pass', findings: 0, warnings: [] }
  if (label === 'stage-plan-smoke') return { status: 'ok', plan: '/r/stage/wave-1/smoke-plan.json', raw_path: '/r/stage/wave-1/smoke-raw-cccccccccccc.json', raw_exists: false, pairs: 3 }
  if (label.startsWith('stage-worktree')) return { status: 'ok' }
  if (label === 'stage-ingest-smoke') return { status: 'ok', verdicts: { a: 'PASS' }, findings: 0, results: '/w/results.json' }
  if (label === 'stage-triage') return { status: 'ok', pending: { fix: {}, block: {} }, classified: [], campaign_blocks: [], block_text: {} }
  if (label === 'stage-report') return { status: 'ok', report_url: REPORT, dir: '/reports/c1' }
  if (label === 'stage-polish-plan') return { status: 'ok', items: [], open_set: null, reason: 'no open log items' }
  if (label === 'stage-iterate') return { status: 'ok', iteration: 2, campaign_sha: 'd'.repeat(40) }
  if (label.startsWith('stage-')) return { status: 'ok' }   // finish, park, resolve, record-fix, smoke-failed, reclassify, fix-scaffold…
  return undefined
}
// A scenario's `stage(label, prompt, n)` returns a CLI object (or undefined → default); n counts that label.
async function runStage(waves, { stage, probe, smoke, planner, cfg = STAGE_CONFIG, ...rest } = {}) {
  const n = {}
  const extra = (label, prompt) => {
    if (label === 'project-config') return configAnswer(cfg, undefined, prompt)
    if (label === 'stage-browser-probe') return probe ? probe() : { available: true, tools_seen: ['mcp__chrome-devtools__list_pages'], error: null }
    if (label.startsWith('stage-smoke:')) return smoke ? smoke(label) : { raw_path: '/r/stage/wave-1/smoke-raw-cccccccccccc.json' }
    if (/^stage-(fix|polish)-plan:/.test(label)) return planner ? planner(label) : { status: 'ok', plan: '/p/plan-final.md', acceptance: '/p/acceptance.md' }
    if (!label.startsWith('stage-')) return undefined
    n[label] = (n[label] || 0) + 1
    const own = stage ? stage(label, prompt, n[label]) : undefined
    const obj = own !== undefined ? own : stageDefaults(label, prompt)
    if (obj && obj.__raw) return obj.__raw   // a scenario that hands back the relay's raw answer
    return relayOut(obj)
  }
  return runChainRunner(waves, { extra, ...rest })
}
const stageLabels = (r) => r.labels.filter(l => l.startsWith('stage-'))
const promptOf = (r, label) => (r.agentCalls.find(c => c.label === label) || {}).prompt || ''

test('stage AC1: a chain wave runs the stage in order after its merges; green → finish, report; Report line logged', async () => {
  const r = await runStage([[ch('a')]], { cron: CRON_OK })
  noErr(r)
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  const want = ['stage-check-config', 'stage-begin', 'stage-begin', 'stage-session:before', 'stage-deploy', 'stage-migrate', 'stage-ensure-tenants',
    'stage-session', 'stage-suites', 'stage-integration', 'stage-ingest-integration', 'stage-plan-smoke', 'stage-worktree-add', 'stage-browser-probe',
    'stage-smoke:w1', 'stage-ingest-smoke', 'stage-worktree-remove', 'stage-triage', 'stage-finish', 'stage-report']
  const got = stageLabels(r)
  assert.deepEqual(got.slice(0, want.length), want, got.join('\n'))
  // every stage step comes after the wave's merge
  assert.ok(r.idx(e => e.label === 'chain-merge:a') < r.idx(e => e.label === 'stage-session:before'))
  assert.match(promptOf(r, 'stage-deploy'), /wolfpack-smoke-stage\.mjs' deploy --campaign 'c1'/)
  assert.ok(r.agentCalls.filter(c => c.label === 'stage-begin')[1].prompt.includes("--wave 1 --merged 'a'"))
  const rec = promptOf(r, 'stage-integration')
  assert.match(rec, /wolfpack-test-record\.mjs' run --json --stage integration .* --labels 'billing' --campaign 'c1' --timeout-min 55/)
  assert.equal(r.agentCalls.find(c => c.label === 'stage-smoke:w1').opts.model, 'opus')
  assert.equal(r.agentCalls.find(c => c.label === 'stage-deploy').opts.model, 'sonnet')
  assert.match(r.agentCalls.find(c => c.label === 'stage-smoke:w1').prompt, /smoke-chain\.md EXACTLY/)
  assert.deepEqual(r.result.stage.reportUrl, REPORT)
  assert.ok(r.logs.some(l => l === `Report: ${REPORT}`), r.logs.join('\n'))
  const fin = cronCalls(r).find(c => c.label === 'cron-finish')
  assert.equal(cronCmd(fin), `event ready-for-release --campaign 'c1' --report-url '${REPORT}'`, 'AC30/AC35: the page carries report_url')
})

test('stage A-3: off → one log line and the chain labels are exactly as before (no stage-* agent)', async () => {
  const off = await runStage([[ch('a'), ch('b')]], { cfg: FIXTURE_CONFIG })
  noErr(off)
  assert.deepEqual(stageLabels(off), [])
  assert.ok(off.logs.some(l => /^post-merge stage: off/.test(l)))
  assert.equal(off.result.stage, undefined)
  const plain = await runChainRunner([[ch('a'), ch('b')]])
  assert.deepEqual(off.labels, plain.labels)
})

test('stage: barrier mode never runs the stage, even with the stage on', async () => {
  const r = await runAny(RUNNER, { parse: parseOf([[hunt('a')]]), args: { campaignSlug: 'c1', maxParallel: 1 },
    capability: { ...CHAIN_CAP, chainProtocol: 0, chainScriptPresent: false }, projectConfig: (p) => configAnswer(STAGE_CONFIG, undefined, p) })
  noErr(r)
  assert.deepEqual(r.labels.filter(l => l.startsWith('stage-')), [])
})

test('stage AC13: a check-config problem → CAMPAIGN_PARKED_STAGE smoke_config_missing before any wave or stage step', async () => {
  const r = await runStage([[ch('a')]], { cron: CRON_OK,
    stage: (l) => (l === 'stage-check-config' ? { status: 'error', code: 'smoke_config_missing', reason: 'post-merge stage config: Deployment Notes → Smoke tenants (mobile): missing', problems: ['Deployment Notes → Smoke tenants (mobile): missing'] } : undefined) })
  noErr(r)
  assert.deepEqual([r.result.verdict, r.result.parkReason], ['CAMPAIGN_PARKED_STAGE', 'smoke_config_missing'])
  assert.deepEqual(r.result.problems, ['Deployment Notes → Smoke tenants (mobile): missing'])
  assert.deepEqual(stageLabels(r), ['stage-check-config'])
  assert.equal(r.wf.length, 0, 'no hunt runs')
  assert.equal(cronCmd(cronCalls(r).find(c => c.label === 'cron-finish')), "event waiting-on-you --campaign 'c1' --status 'parked:smoke_config_missing'")
})

test('stage: an empty wave skips ("nothing new"), and wave N+1 starts only after wave N\'s stage resolved (AC4)', async () => {
  const r = await runStage([[ch('a')], [ch('b', { dependsOn: ['a'] })], [ch('c')]],
    { workflowResult: (a) => (a.slug === 'b' ? { slug: 'b', verdict: 'PARKED', status: 'parked:open_critical' } : CERT(a)) })
  noErr(r)
  assert.ok(r.logs.some(l => l === 'post-merge stage: nothing new on campaign/c1'), r.logs.join('\n'))
  const begins = r.agentCalls.filter(c => c.label === 'stage-begin' && !c.prompt.includes('--resume-only')).map(c => waveOf(c.prompt))
  assert.deepEqual(begins, [1, 3])
  // wave 3's hunt is scaffolded only after wave 1's stage finished
  const fin1 = r.idx(e => e.label === 'stage-finish')
  assert.ok(fin1 < r.idx(e => e.type === 'workflow-start' && e.slug === 'c'))
})

test('stage AC2: resume mid-stage — same tip, step smoke → no deploy; re-armed park is logged', async () => {
  const r = await runStage([[ch('a', { status: 'merged_to_campaign' })]], {
    stage: (l, p) => {
      if (l === 'stage-begin' && p.includes('--resume-only')) return { status: 'ok', action: 'resume-only', created: false, staged_from_wave: 1, rearmed: 'smoke_browser_unavailable', unstaged: [], current: { wave: 1, step: 'smoke', result: null, campaign_sha: TIP, iteration: 1 } }
      if (l === 'stage-begin') return { status: 'ok', action: 'resume', wave: 1, step: 'smoke', campaign_sha: TIP, iteration: 1, merged: ['a'], polish: null, polish_issues: [] }
      return undefined
    } })
  noErr(r)
  const got = stageLabels(r)
  assert.ok(!got.includes('stage-deploy') && !got.includes('stage-migrate') && !got.includes('stage-plan-smoke'), got.join(','))
  assert.ok(got.includes('stage-triage') && got.includes('stage-finish'))
  assert.ok(r.logs.some(l => /post-merge stage: re-armed parked:smoke_browser_unavailable at smoke/.test(l)), r.logs.join('\n'))
})

test('stage AC2: "parked at smoke → hand-run raw file present → campaign re-run ingests it" (no probe, no smoke agent)', async () => {
  const r = await runStage([[ch('a', { status: 'merged_to_campaign' })]], {
    stage: (l, p) => {
      if (l === 'stage-begin' && p.includes('--resume-only')) return { status: 'ok', action: 'resume-only', rearmed: 'smoke_browser_unavailable', unstaged: [], current: { wave: 1, step: 'integration', result: null } }
      if (l === 'stage-begin') return { status: 'ok', action: 'resume', wave: 1, step: 'integration', campaign_sha: TIP, iteration: 1, merged: ['a'] }
      if (l === 'stage-plan-smoke') return { status: 'ok', plan: '/p.json', raw_path: '/raw.json', raw_exists: true }
      return undefined
    } })
  noErr(r)
  const got = stageLabels(r)
  assert.ok(got.includes('stage-ingest-smoke') && got.includes('stage-triage'))
  assert.equal(got.includes('stage-browser-probe'), false)
  assert.equal(got.some(l => l.startsWith('stage-smoke:')), false)
  assert.match(promptOf(r, 'stage-ingest-smoke'), /--raw '\/raw\.json'/)
})

test('stage AC2: a crash between merge and stage — the relaunch stages the unstaged wave (suites included) before the waves', async () => {
  const r = await runStage([[ch('a', { status: 'merged_to_campaign' })], [ch('b', { status: 'merged_to_campaign' })]], {
    stage: (l, p) => {
      if (l === 'stage-begin' && p.includes('--resume-only')) return { status: 'ok', action: 'resume-only', rearmed: null, unstaged: [{ wave: 2, merged: ['b'] }], current: null }
      return undefined
    } })
  noErr(r)
  assert.ok(r.logs.some(l => l === 'post-merge stage: wave 2 merged without a stage (crash recovery)'), r.logs.join('\n'))
  const rr = r.agentCalls.find(c => c.label === 'stage-begin' && c.prompt.includes('--resume-only'))
  assert.match(rr.prompt, /--merged-by-wave '\{"1":\["a"\],"2":\["b"\]\}'/)
  const b2 = r.agentCalls.find(c => c.label === 'stage-begin' && !c.prompt.includes('--resume-only'))
  assert.match(b2.prompt, /--wave 2 --merged 'b'/)
  assert.ok(stageLabels(r).includes('stage-integration'))
})

test('stage AC3: a usage defer before the smoke agent → WAVE_PAUSED_QUOTA, no probe / smoke agent', async () => {
  const r = await runStage([[ch('a')]], { cron: CRON_OK, gate: (slug) => (slug.startsWith('stage:') ? DEFER5H : PROCEED) })
  noErr(r)
  assert.equal(r.result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.equal(r.result.resetAt, DEFER5H.reset_at)
  const got = stageLabels(r)
  assert.ok(got.includes('stage-ingest-integration'))
  assert.equal(got.includes('stage-browser-probe'), false)
  assert.ok(got.includes('stage-worktree-remove'), 'the smoke worktree is removed even on the pause')
  assert.ok(r.labels.includes('usage-gate:stage:c1:w1:smoke'))
  assert.equal(cronCmd(cronCalls(r).find(c => c.label === 'cron-finish')), `note-pause --campaign 'c1' --reset-at '${DEFER5H.reset_at}'`)
})

test('stage AC7: deploy fails twice → parked dev_deploy_failed, one page, no smoke agent call', async () => {
  const r = await runStage([[ch('a')]], { cron: CRON_OK,
    stage: (l, p, k) => (l === 'stage-deploy' ? { status: 'ok', exit: 1, attempts: k, last_line: 'build failed', log: '/d.log' } : undefined) })
  noErr(r)
  assert.deepEqual([r.result.verdict, r.result.parkReason], ['CAMPAIGN_PARKED_STAGE', 'dev_deploy_failed'])
  const got = stageLabels(r)
  assert.equal(got.filter(l => l === 'stage-deploy').length, 2)
  assert.ok(got.includes('stage-park:dev_deploy_failed'))
  assert.match(promptOf(r, 'stage-park:dev_deploy_failed'), /--step 'deploy'/)
  assert.equal(got.some(l => l.startsWith('stage-smoke:') || l === 'stage-migrate'), false)
  assert.equal(cronCalls(r).filter(c => c.label === 'cron-finish').length, 1)
  assert.match(cronCmd(cronCalls(r).find(c => c.label === 'cron-finish')), /--status 'parked:dev_deploy_failed' --report-url/)
})

test('stage AC7: migrate fails with a migrating hunt → it is blocked and reverted, then the tip is re-verified', async () => {
  let reverted = false
  const r = await runStage([[ch('a'), ch('b')]], { cron: CRON_OK,
    stage: (l, p, k) => {
      if (l === 'stage-migrate' && k === 1) return { status: 'ok', exit: 3, attempts: 1, migrating_hunts: ['a'], log: '/m.log' }
      if (l === 'stage-triage' && !reverted) return { status: 'ok', pending: { fix: {}, block: { a: ['ISS-m'] } }, classified: [{ id: 'ISS-m', hunt: 'a', outcome: 'block', rule: 'deploy_or_migration', reasoning: 'migrate failed' }], campaign_blocks: [], block_text: { a: { summary: 'The post-merge stage blocked a', evidence: '/m.log', question: 'What should a do?' } } }
      if (l === 'stage-revert:a') { reverted = true; return { status: 'reverted', campaign_sha: 'e'.repeat(40), reverted: [{ slug: 'a', revert_commit: 'r1' }] } }
      return undefined
    } })
  noErr(r)
  const got = stageLabels(r)
  assert.equal(got.includes('stage-ensure-tenants') && got.indexOf('stage-ensure-tenants') < got.indexOf('stage-revert:a'), false, 'never smoked over a failed migration')
  assert.ok(got.indexOf('stage-revert:a') < got.lastIndexOf('stage-deploy'), 'the reverted tip is redeployed')
  const rv = promptOf(r, 'stage-revert:a')
  assert.match(rv, /wolfpack-release\.mjs' revert --campaign 'c1' --hunt 'a' --reason 'post-merge stage: ISS-m' --summary 'The post-merge stage blocked a' --evidence '\/m\.log' --issues 'ISS-m' --question 'What should a do\?'/)
  assert.ok(got.includes('stage-resolve:a'))
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN', 'the reverted hunt waits on a human')
  assert.ok(r.result.blockedHunts.some(b => b.slug === 'a' && b.status === 'parked:reverted_from_campaign'))
  const park = cronCalls(r).find(c => c.label === 'cron-park:a')
  assert.equal(cronCmd(park), `event park --campaign 'c1' --hunt 'a' --status 'parked:reverted_from_campaign' --reason 'reverted_from_campaign' --report-url '${REPORT}'`, 'AC25: only the allowlisted fields + report_url')
})

test('stage AC14/AC13: session REFUSED → smoke_config_missing naming Smoke login hook; unreachable → smoke_browser_unreachable', async () => {
  const refused = await runStage([[ch('a')]], {
    stage: (l) => (l === 'stage-session:before' ? { status: 'ok', sessions: {}, problems: [{ tenant: 'mobile', host: 'm.example.dev', kind: 'refused', detail: 'REFUSED bad password file' }] } : undefined) })
  noErr(refused)
  assert.deepEqual([refused.result.verdict, refused.result.parkReason], ['CAMPAIGN_PARKED_STAGE', 'smoke_config_missing'])
  assert.match(refused.result.parkDetail, /Smoke login hook/)
  assert.equal(stageLabels(refused).includes('stage-deploy'), false)
  const dead = await runStage([[ch('a')]], {
    stage: (l) => (l === 'stage-session' ? { status: 'ok', sessions: {}, problems: [{ tenant: 'surgical', host: 's.example.dev', kind: 'unreachable', detail: 'exit 3' }] } : undefined) })
  noErr(dead)
  assert.equal(dead.result.parkReason, 'smoke_browser_unreachable')
  const drop = await runStage([[ch('a')]], { stage: (l) => (l === 'stage-session' ? { status: 'ok', sessions: {}, problems: [], session_drops: ['m.example.dev'] } : undefined) })
  noErr(drop)
  assert.ok(drop.logs.some(l => /signed out after the deploy on m\.example\.dev — logged for Cecil/.test(l)))
  assert.equal(drop.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
})

test('stage A-0: the browser probe fails → parked smoke_browser_unavailable with the /smoke-chain fallback; no smoke agent', async () => {
  const r = await runStage([[ch('a')]], { probe: () => ({ available: false, tools_seen: [], error: 'mcp__chrome-devtools__list_pages not available' }) })
  noErr(r)
  assert.equal(r.result.parkReason, 'smoke_browser_unavailable')
  assert.match(r.result.parkDetail, /\/smoke-chain c1 1/)
  assert.equal(stageLabels(r).some(l => l.startsWith('stage-smoke:')), false)
  assert.ok(stageLabels(r).includes('stage-worktree-remove'))
})

test('stage S6: "smoke agent fails twice → parked:smoke_agent_failed"; "fails once then succeeds → no park"', async () => {
  const twice = await runStage([[ch('a')]], {
    smoke: () => ({ raw_path: '' }),
    stage: (l, p, k) => (l === 'stage-smoke-failed' ? { status: 'ok', attempts: k, renamed: null } : undefined) })
  noErr(twice)
  assert.equal(twice.result.parkReason, 'smoke_agent_failed')
  assert.equal(twice.labels.filter(l => l === 'stage-smoke:w1').length, 2)
  assert.equal(stageLabels(twice).includes('stage-triage'), false)
  // an invalid raw file the first time, a valid one the second
  const once = await runStage([[ch('a')]], {
    stage: (l, p, k) => (l === 'stage-ingest-smoke' && k === 1 ? { status: 'error', code: 'smoke_raw_invalid', reason: 'smoke raw results: missing result for a/1@mobile', attempts: 1, renamed: '/x.invalid-1.json' } : undefined) })
  noErr(once)
  assert.equal(once.labels.filter(l => l === 'stage-smoke:w1').length, 2)
  assert.equal(once.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  // invalid twice → park
  const bad = await runStage([[ch('a')]], {
    stage: (l, p, k) => (l === 'stage-ingest-smoke' ? { status: 'error', code: 'smoke_raw_invalid', reason: 'bad', attempts: k } : undefined) })
  noErr(bad)
  assert.equal(bad.result.parkReason, 'smoke_agent_failed')
})

test('stage S5: a busy integration record is re-taken; an unattributed failure parks integration_unattributed', async () => {
  const busy = await runStage([[ch('a')]], {
    stage: (l, p, k) => (l === 'stage-ingest-integration' && k === 1 ? { status: 'ok', action: 'retake', busy: true, busy_retries: 1, warnings: [] } : undefined) })
  noErr(busy)
  assert.equal(busy.labels.filter(l => l === 'stage-integration').length, 2)
  assert.ok(busy.logs.some(l => /test DB busy — re-taking \(1\)/.test(l)))
  const un = await runStage([[ch('a')]], {
    stage: (l) => (l === 'stage-ingest-integration' ? { status: 'ok', action: 'park', code: 'integration_unattributed', reason: 'failing test(s) no wave hunt touched: users.tests.U', warnings: [] } : undefined) })
  noErr(un)
  assert.deepEqual([un.result.parkReason, un.result.parkDetail], ['integration_unattributed', 'failing test(s) no wave hunt touched: users.tests.U'])
  // a relay that cannot run the record twice → integration_infra
  const infra = await runStage([[ch('a')]], { stage: (l) => (l === 'stage-integration' ? { __raw: { exitCode: 1, output: '{"status":"error","error":"no Test command"}' } } : undefined) })
  noErr(infra)
  assert.equal(infra.result.parkReason, 'integration_infra')
  // an empty suite set skips the record
  const empty = await runStage([[ch('a')]], { stage: (l) => (l === 'stage-suites' ? { status: 'ok', labels: [], full: false, reason: 'no app touched', empty: true } : undefined) })
  noErr(empty)
  assert.equal(empty.labels.includes('stage-integration'), false)
})

test('stage AC21: "fix round" — scaffold → planner → hunt-pipeline (campaign base, isolation) → merge --fix-of → record-fix → redeploy + re-smoke', async () => {
  let fixed = false
  const r = await runStage([[ch('a')]], { cron: CRON_OK,
    stage: (l, p) => {
      if (l === 'stage-triage' && !fixed) return { status: 'ok', pending: { fix: { a: ['ISS-1'] }, block: {} }, classified: [{ id: 'ISS-1', hunt: 'a', outcome: 'fix', rule: 'clear_defect', reasoning: 'a/2: clear defect' }], campaign_blocks: [] }
      if (l === 'stage-fix-scaffold:a') return { status: 'ok', slug: 'fix-a-smoke-1', parent_hunt: 'a', tier: 'Yellow', branch: 'feat/fix-a-smoke-1', worktree: '/r/.wt/fix-a-smoke-1', plan_dir: '/r/.wt/fix-a-smoke-1/.wolfpack/plans/fix-a-smoke-1', base_sha: TIP, issues: ['ISS-1'], description: 'Smoke fix round 1 for a' }
      if (l === 'stage-record-fix:fix-a-smoke-1') { fixed = true; return { status: 'ok', fix_rounds: 1 } }
      return undefined
    },
    merge: (slug) => (slug === 'fix-a-smoke-1'
      ? { exitCode: 0, output: JSON.stringify({ status: 'merged', commit: '1'.repeat(40), stamped: 'merged_to_campaign', fix_of: 'a' }) }
      : { status: 'merged', commit: `merge-${slug}-0000000`, stamped: 'merged_to_campaign', exitCode: 0 }) })
  noErr(r)
  const got = r.labels
  const i = (l) => got.indexOf(l)
  assert.ok(i('stage-fix-scaffold:a') >= 0, got.join('\n'))
  assert.ok(i('stage-fix-scaffold:a') < i('stage-fix-plan:fix-a-smoke-1'))
  const wf = r.workflowCalls.find(w => w.args.slug === 'fix-a-smoke-1')
  assert.ok(wf, 'hunt-pipeline ran the fix hunt')
  assert.equal(wf.name, 'hunt-pipeline')
  assert.deepEqual([wf.args.baseBranch, wf.args.testIsolation, wf.args.campaign, wf.args.mode], ['campaign/c1', 'c1', 'c1', 'update'])
  assert.ok(wf.args.crossExaminer, 'a cross examiner is assigned')
  assert.ok(r.idx(e => e.label === 'stage-fix-plan:fix-a-smoke-1') < r.idx(e => e.type === 'workflow-start' && e.slug === 'fix-a-smoke-1'))
  assert.match(promptOf(r, 'chain-merge:fix-a-smoke-1'), /merge-hunt --campaign 'c1' --hunt 'fix-a-smoke-1' --fix-of 'a'/)
  assert.match(promptOf(r, 'stage-record-fix:fix-a-smoke-1'), new RegExp(`--hunt 'a' --fix 'fix-a-smoke-1' --commit '${'1'.repeat(40)}' --issues 'ISS-1'`))
  assert.ok(i('stage-record-fix:fix-a-smoke-1') < i('stage-iterate'))
  assert.equal(got.filter(l => l === 'stage-deploy').length, 2, 'the fix tip is redeployed')
  assert.equal(got.filter(l => l === 'stage-smoke:w1').length, 2, 'and re-smoked')
  assert.ok(r.labels.includes('usage-gate:stage:c1:w1:fix:a'), 'AC3: the fix round is gated')
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
  // A wave that needed a fix round is `resolved`, not `green` (smoke-stage.json result contract:
  // green = nothing failed; resolved = every failure fixed, logged or blocked-and-reverted).
  assert.equal(r.result.stage.result, 'resolved')
  assert.match(r.agentCalls.filter(c => c.label === 'stage-finish').pop().prompt, /--result resolved/)
})

test('stage AC22: a fix round that does not certify → the hunt blocks (fix_review_failed) and is reverted', async () => {
  const r = await runStage([[ch('a')]], { cron: CRON_OK,
    workflowResult: (a) => (a.slug === 'fix-a-smoke-1' ? { slug: a.slug, verdict: 'PARKED', status: 'parked:non_convergence' } : CERT(a)),
    stage: (l, p, k) => {
      if (l === 'stage-triage' && k === 1) return { status: 'ok', pending: { fix: { a: ['ISS-1'] }, block: {} }, classified: [{ id: 'ISS-1', hunt: 'a', outcome: 'fix', rule: 'clear_defect', reasoning: 'x' }], campaign_blocks: [] }
      if (l === 'stage-fix-scaffold:a') return { status: 'ok', slug: 'fix-a-smoke-1', parent_hunt: 'a', tier: 'Yellow', branch: 'feat/fix-a-smoke-1', worktree: '/w', plan_dir: '/w/p', base_sha: TIP, issues: ['ISS-1'], description: 'd' }
      if (l === 'stage-reclassify:a') return { status: 'ok', hunt: 'a', ids: ['ISS-1'], block_text: { summary: 'blocked a (fix_review_failed)', evidence: 'ISS-1', question: 'q' } }
      if (l === 'stage-revert:a') return { status: 'reverted', campaign_sha: 'e'.repeat(40), reverted: [{ slug: 'a' }] }
      return undefined
    } })
  noErr(r)
  assert.match(promptOf(r, 'stage-reclassify:a'), /--rule fix_review_failed --reason 'fix-a-smoke-1: PARKED \(parked:non_convergence\)'/)
  assert.ok(r.labels.indexOf('stage-reclassify:a') < r.labels.indexOf('stage-revert:a'))
  assert.equal(r.labels.some(l => l.startsWith('stage-record-fix')), false)
  assert.equal(r.labels.includes('chain-merge:fix-a-smoke-1'), false, 'an uncertified fix never merges')
  assert.equal(r.result.verdict, 'CAMPAIGN_AWAITING_HUMAN')
})

test('stage AC24: block → revert → redeploy → the next wave runs the non-conflicting hunt and holds the dependent', async () => {
  let reverted = false
  const r = await runStage([[ch('a'), ch('x')], [ch('d', { dependsOn: ['a'] }), ch('y')]], { cron: CRON_OK,
    stage: (l, p) => {
      if (l === 'stage-triage' && waveOf(p) === 1 && !reverted) return { status: 'ok', pending: { fix: {}, block: { a: ['ISS-b'] } }, classified: [{ id: 'ISS-b', hunt: 'a', outcome: 'block', rule: 'default_block', reasoning: 'r' }], campaign_blocks: [], block_text: {} }
      if (l === 'stage-revert:a') { reverted = true; return { status: 'reverted', campaign_sha: 'e'.repeat(40), reverted: [{ slug: 'a' }] } }
      return undefined
    } })
  noErr(r)
  assert.ok(r.wf.includes('y'), 'the non-conflicting next-wave hunt runs')
  assert.equal(r.wf.includes('d'), false, 'the dependent of the reverted hunt is held')
  assert.ok(r.idx(e => e.label === 'stage-revert:a') < r.idx(e => e.type === 'workflow-start' && e.slug === 'y'))
})

// smoke-stage.json result contract: `green` = nothing failed in that wave's stage run; `resolved` =
// something failed and was fixed, logged or blocked-and-reverted (Tracker r1 finding 3).
const finishResults = (r) => r.agentCalls.filter(c => c.label === 'stage-finish')
  .map(c => (/--result (\S+)/.exec(c.prompt) || [])[1])

test('stage result: a clean wave finishes green; a logged-only finding finishes resolved', async () => {
  let r = await runStage([[ch('a')]], { cron: CRON_OK })
  noErr(r)
  assert.deepEqual(finishResults(r), ['green'])
  assert.equal(r.result.stage.result, 'green')
  r = await runStage([[ch('a')]], { cron: CRON_OK,
    stage: (l) => (l === 'stage-triage'
      ? { status: 'ok', pending: { fix: {}, block: {} }, classified: [{ id: 'ISS-l', hunt: 'a', outcome: 'log', rule: 'polish', reasoning: 'r' }], campaign_blocks: [], block_text: {} }
      : undefined) })
  noErr(r)
  assert.deepEqual(finishResults(r), ['resolved'])
})

test('stage result: block → revert → clean re-verify finishes that wave resolved; the next clean wave stays green', async () => {
  let reverted = false
  const r = await runStage([[ch('a'), ch('x')], [ch('y')]], { cron: CRON_OK,
    stage: (l, p) => {
      if (l === 'stage-triage' && !reverted) return { status: 'ok', pending: { fix: {}, block: { a: ['ISS-b'] } }, classified: [{ id: 'ISS-b', hunt: 'a', outcome: 'block', rule: 'default_block', reasoning: 'r' }], campaign_blocks: [], block_text: {} }
      if (l === 'stage-revert:a') { reverted = true; return { status: 'reverted', campaign_sha: 'e'.repeat(40), reverted: [{ slug: 'a' }] } }
      return undefined
    } })
  noErr(r)
  assert.ok(r.labels.includes('stage-iterate'), 'the revert re-verifies the reverted tip')
  assert.deepEqual(finishResults(r), ['resolved', 'green'])
})

test('stage result: a RESUMED re-verify (persisted iteration 2, empty triage) still finishes resolved', async () => {
  // The resume-safe half of the fix: the iteration counter lives in stage state, so a runner that
  // crashed after the fix round and resumes at the re-verify cannot forget the wave had findings.
  const r = await runStage([[ch('a', { status: 'merged_to_campaign' })]], {
    stage: (l, p) => {
      if (l === 'stage-begin' && p.includes('--resume-only')) return { status: 'ok', action: 'resume-only', created: false, staged_from_wave: 1, rearmed: null, unstaged: [], current: { wave: 1, step: 'smoke', result: null, campaign_sha: 'd'.repeat(40), iteration: 2 } }
      if (l === 'stage-begin') return { status: 'ok', action: 'resume', wave: 1, step: 'smoke', campaign_sha: 'd'.repeat(40), iteration: 2, merged: ['a'], polish: null, polish_issues: [] }
      return undefined
    } })
  noErr(r)
  assert.deepEqual(finishResults(r), ['resolved'])
  assert.equal(r.result.stage.result, 'resolved')
})

test('stage AC26: "revert stub exit 2 → parked:campaign_revert_failed", one page, no next-wave scaffold', async () => {
  const r = await runStage([[ch('a')], [ch('b')]], { cron: CRON_OK,
    stage: (l) => {
      if (l === 'stage-triage') return { status: 'ok', pending: { fix: {}, block: { a: ['ISS-b'] } }, classified: [], campaign_blocks: [], block_text: {} }
      if (l === 'stage-revert:a') return { status: 'error', reason: 'git revert of a\'s merge conflicted (x.py) — nothing reverted' }
      return undefined
    } })
  noErr(r)
  assert.deepEqual([r.result.verdict, r.result.parkReason], ['CAMPAIGN_PARKED_STAGE', 'campaign_revert_failed'])
  assert.match(r.result.parkDetail, /conflicted.*campaign\/c1 unchanged/)
  assert.equal(r.wf.includes('b'), false)
  assert.equal(cronCalls(r).filter(c => c.label === 'cron-finish').length, 1)
  assert.equal(cronCalls(r).some(c => c.label.startsWith('cron-park:')), false)
})

test('stage: an unmapped stage CLI error → stage_cli_error naming the step (never a silent skip)', async () => {
  const r = await runStage([[ch('a')]], { stage: (l) => (l === 'stage-ensure-tenants' ? { __raw: { exitCode: 2, output: 'Traceback: boom' } } : undefined) })
  noErr(r)
  assert.equal(r.result.parkReason, 'stage_cli_error')
  assert.match(r.result.parkDetail, /^stage-ensure-tenants: stage-ensure-tenants: no parseable JSON \(exit 2\): Traceback: boom/)
  const cfgErr = await runStage([[ch('a')]], { stage: (l) => (l === 'stage-plan-smoke' ? { status: 'error', code: 'smoke_config_missing', key: 'Deployment Notes → Wave report dir command', reason: 'wave-dir failed', detail: 'cannot create' } : undefined) })
  noErr(cfgErr)
  assert.equal(cfgErr.result.parkReason, 'smoke_config_missing')
  assert.match(cfgErr.result.parkDetail, /Deployment Notes → Wave report dir command — wave-dir failed \(cannot create\)/)
  assert.equal(cfgErr.labels.some(l => l.startsWith('stage-smoke:') || l === 'stage-browser-probe'), false)
  const hl = await runStage([[ch('a')]], { stage: (l) => (l === 'stage-triage' ? { status: 'ok', pending: { fix: {}, block: {} }, classified: [], campaign_blocks: ['ISS-c'] } : undefined) })
  noErr(hl)
  assert.equal(hl.result.parkReason, 'stage_cli_error')
  assert.match(hl.result.parkDetail, /ISS-c block with no hunt to revert/)
})

test('stage AC27: "polish wave" — one polish hunt, merge --polish, a polish iteration, items polished', async () => {
  let polished = false
  let r0 = 0
  const r = await runStage([[ch('a')]], { cron: CRON_OK,
    stage: (l, p) => {
      if (l === 'stage-polish-plan') return polished ? { status: 'ok', items: [] } : { status: 'ok', items: [{ id: 'ISS-p', hunt: 'a' }, { id: 'ISS-q', hunt: 'a' }], open_set: 'h'.repeat(40) }
      if (l === 'stage-polish-scaffold') return { status: 'ok', slug: 'polish-c1', tier: 'Blue', branch: 'feat/polish-c1', worktree: '/w', plan_dir: '/w/p', base_sha: TIP, issues: ['ISS-p', 'ISS-q'], description: 'Polish wave' }
      if (l === 'stage-begin' && p.includes('--polish')) return { status: 'ok', action: 'new', wave: 1, step: 'begin', campaign_sha: TIP, iteration: 2, merged: [], polish: 'polish-c1', polish_merge: 'f'.repeat(40), polish_issues: ['ISS-p', 'ISS-q'] }
      if (l === 'stage-suites' && p.includes('--polish')) return { status: 'ok', labels: ['scheduler'], full: false, reason: 'touched apps: scheduler', record_labels: 'scheduler', empty: false }
      if (l === 'stage-triage' && r0 > 0) return { status: 'ok', polish: { slug: 'polish-c1', regressions: [], fixed: ['ISS-p'], still_failing: ['ISS-q'] }, classified: [] }
      if (l === 'stage-triage') { r0++; return undefined }
      if (l === 'stage-resolve-polished') { polished = true; return { status: 'ok' } }
      return undefined
    },
    merge: (slug) => (slug === 'polish-c1'
      ? { exitCode: 0, output: JSON.stringify({ status: 'merged', commit: 'f'.repeat(40), polish: true }) }
      : { status: 'merged', commit: `merge-${slug}-0000000`, stamped: 'merged_to_campaign', exitCode: 0 }) })
  noErr(r)
  assert.match(promptOf(r, 'chain-merge:polish-c1'), /--hunt 'polish-c1' --polish/)
  assert.ok(r.workflowCalls.some(w => w.args.slug === 'polish-c1' && w.args.testIsolation === 'c1' && w.args.baseBranch === 'campaign/c1'))
  assert.ok(r.agentCalls.some(c => c.label === 'stage-begin' && /--wave 1 --polish 'polish-c1'/.test(c.prompt)))
  assert.match(r.agentCalls.filter(c => c.label === 'stage-integration').pop().prompt, /--labels 'scheduler'/, 'the polish iteration runs the polish merge\'s suite set')
  assert.match(promptOf(r, 'stage-resolve-polished'), /--ids 'ISS-p' --resolution polished --polish-slug 'polish-c1' --polish-result merged/)
  assert.match(promptOf(r, 'stage-resolve-unpolished'), /--ids 'ISS-q' --resolution 'needs Cecil'/)
  assert.ok(r.labels.includes('usage-gate:stage:c1:polish'))
  assert.equal(r.result.verdict, 'CAMPAIGN_READY_FOR_RELEASE')
})

test('stage AC28: "polish regression → polish merge reverted", items need Cecil, one re-verify on the reverted tip (no second polish)', async () => {
  let triage = 0
  const r = await runStage([[ch('a')]], { cron: CRON_OK,
    stage: (l, p) => {
      if (l === 'stage-polish-plan') return triage > 1 ? { status: 'ok', items: [], reason: 'this open set was already polished once' } : { status: 'ok', items: [{ id: 'ISS-p' }], open_set: 'h'.repeat(40) }
      if (l === 'stage-polish-scaffold') return { status: 'ok', slug: 'polish-c1', tier: 'Blue', worktree: '/w', plan_dir: '/w/p', base_sha: TIP, issues: ['ISS-p'], description: 'd' }
      if (l === 'stage-triage') {
        triage++
        if (triage === 2) return { status: 'ok', polish: { slug: 'polish-c1', regressions: [{ id: 'ISS-new', what: 'billing.tests.X' }], fixed: [], still_failing: [] }, classified: [] }
      }
      if (l === 'stage-revert-polish') return { status: 'reverted', revert_commit: 'r'.repeat(40), campaign_sha: 'r'.repeat(40) }
      if (l === 'stage-iterate') return { status: 'ok', iteration: 3, campaign_sha: 'r'.repeat(40) }
      return undefined
    },
    merge: (slug) => (slug === 'polish-c1'
      ? { exitCode: 0, output: JSON.stringify({ status: 'merged', commit: 'f'.repeat(40), polish: true }) }
      : { status: 'merged', commit: `merge-${slug}-0000000`, stamped: 'merged_to_campaign', exitCode: 0 }) })
  noErr(r)
  assert.match(promptOf(r, 'stage-revert-polish'), new RegExp(`revert-merge --campaign 'c1' --commit '${'f'.repeat(40)}' --reason 'polish change broke billing.tests.X'`))
  assert.match(promptOf(r, 'stage-resolve-polish'), /--ids 'ISS-p' --resolution 'needs Cecil' --reason 'polish change broke billing\.tests\.X' --polish-slug 'polish-c1' --polish-result reverted/)
  assert.match(promptOf(r, 'stage-iterate'), /iterate --campaign 'c1' --clear-polish/)
  assert.equal(r.labels.filter(l => l === 'stage-triage').length, 3, 'wave 1, the polish iteration, one re-verify')
  assert.equal(r.workflowCalls.filter(w => w.args.slug.startsWith('polish-')).length, 1, 'no second polish wave')
  assert.equal(r.labels.filter(l => l === 'stage-polish-plan').length, 1)
})

test('stage: a WAVE_PAUSED_QUOTA verdict from the waves never runs the polish wave or the report', async () => {
  const r = await runStage([[ch('a'), ch('b')]], { maxParallel: 1, args: { maxParallel: 1 }, gate: (slug) => (slug === 'b' ? DEFER5H : PROCEED) })
  noErr(r)
  assert.equal(r.result.verdict, 'WAVE_PAUSED_QUOTA')
  assert.equal(r.labels.includes('stage-polish-plan'), false)
})

test('stage resume: fix-scaffold reports an already-landed fix → record-fix with its commit, no fix pipeline, no second merge', async () => {
  let fixed = false
  const r = await runStage([[ch('a')]], { cron: CRON_OK,
    stage: (l) => {
      if (l === 'stage-triage' && !fixed) return { status: 'ok', pending: { fix: { a: ['ISS-1'] }, block: {} }, classified: [{ id: 'ISS-1', hunt: 'a', outcome: 'fix', rule: 'clear_defect', reasoning: 'a/2: clear defect' }], campaign_blocks: [] }
      if (l === 'stage-fix-scaffold:a') return { status: 'ok', slug: 'fix-a-smoke-1', parent_hunt: 'a', tier: 'Yellow', branch: 'feat/fix-a-smoke-1', worktree: null, plan_dir: null, base_sha: TIP, issues: ['ISS-1'], description: null, reused: true, landed: { commit: '2'.repeat(40) } }
      if (l === 'stage-record-fix:fix-a-smoke-1') { fixed = true; return { status: 'ok', fix_rounds: 1 } }
      return undefined
    } })
  noErr(r)
  assert.equal(r.workflowCalls.some(w => w.args.slug === 'fix-a-smoke-1'), false, 'the fix hunt is not re-run')
  assert.equal(r.labels.includes('chain-merge:fix-a-smoke-1'), false, 'and not merged twice')
  assert.match(promptOf(r, 'stage-record-fix:fix-a-smoke-1'), new RegExp(`--commit '${'2'.repeat(40)}' --issues 'ISS-1'`))
  assert.ok(r.labels.indexOf('stage-record-fix:fix-a-smoke-1') < r.labels.indexOf('stage-iterate'))
})
