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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RUNNER = readFileSync(join(here, '..', '.agents', 'workflows', 'campaign-runner.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

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

const hunt = (slug, extra = {}) => ({ slug, description: `do ${slug}`, tier: 'Yellow', mode: 'feature', dependsOn: [], status: 'ready_for_alpha', ...extra })
const tick = () => new Promise(r => setImmediate(r))

async function runRunner({ hunts, gate = () => PROCEED, maxParallel = 2, usageProtocol = 1, workflowDelayTicks = 3,
  capability, gatePresent = true, gateProtocol = 1, depCheck = { allMerged: true }, workflowResult = (a) => ({ slug: a.slug, verdict: 'CERTIFIED_AWAITING_DEPLOY' }) } = {}) {
  const events = []
  const logs = []
  const gateCalls = []
  const workflowCalls = []
  const inFlight = new Set()
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    events.push({ type: 'agent', label })
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
      (m) => logs.push(String(m)), () => {}, { total: 0, remaining: () => 1e12 }, { env: {} }, workflow)
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
    assert.match(g.prompt, /node scripts\/wolfpack-window-gate\.mjs --json --tier Red\b/)
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
  assert.match(cap.prompt, /test -f scripts\/wolfpack-window-gate\.mjs && echo present/)
  assert.match(cap.prompt, /grep -o 'WOLFPACK_GATE_PROTOCOL=\[0-9\]\*' scripts\/wolfpack-window-gate\.mjs/)
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
  assert.match(error.message, /scripts\/wolfpack-window-gate\.mjs is MISSING/)
  assert.match(error.message, /wolfpack-sync-runtime\.sh/)
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
  assert.ok(logs.some(l => /⚠ STALE USAGE GATE: scripts\/wolfpack-window-gate\.mjs predates usage-limit-gate/.test(l)), logs.join('\n'))
  assert.ok(logs.some(l => /STALE USAGE GATE.*wolfpack-sync-runtime\.sh/.test(l)))
  assert.equal(logs.some(l => /Usage gate capability OK/.test(l)), false)
  assert.equal(gateCalls.length, 1)
  const g = gateCalls[0]
  assert.equal(g.label, 'usage-gate-legacy:a')
  assert.equal(g.opts.model, 'sonnet')
  assert.match(g.prompt, /READ-ONLY/)
  assert.match(g.prompt, /node scripts\/wolfpack-window-gate\.mjs --json\n/)
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
