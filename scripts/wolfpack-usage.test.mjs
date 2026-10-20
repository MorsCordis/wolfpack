// Tests for wolfpack-usage.mjs (usage-limit-gate AC7/AC8/AC9) — run: node --test scripts/wolfpack-usage.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  hudPct, formatOneLiner, jsonView, updateUsageDelta, reading, aggregateRateLimits,
  stamp, recordOffload, currentUsage,
} from './wolfpack-usage.mjs'
import { computeUsageDecision, computeDecision, DEFAULT_THRESHOLDS } from './wolfpack-window-gate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHIM = join(HERE, 'wolfpack-usage')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-16T12:00:00Z')            // a Friday
const sec = (ms) => ms / 1000

function snapshot({ now = NOW, fh = 42.4, fhReset = Date.parse('2026-10-16T14:05:00Z'), sd = 61, sdReset = now + 3.5 * DAY, noWeek = false } = {}) {
  const rl = { five_hour: { used_percentage: fh, resets_at: sec(fhReset) } }
  if (!noWeek) rl.seven_day = { used_percentage: sd, resets_at: sec(sdReset) }
  return { rate_limits: rl, captured_at: new Date(now - 60 * 1000).toISOString() }
}
const decide = (snap, nowMs = NOW, extra = {}) =>
  computeUsageDecision({ snapshot: snap, nowMs, tier: 'Red', thresholds: DEFAULT_THRESHOLDS, ...extra })
const tmp = () => mkdtempSync(join(tmpdir(), 'wfusage-'))
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2))
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ─── one-liner (AC8) ───
test('hudPct matches claude-hud rounding (round, clamp 0..100)', () => {
  assert.equal(hudPct(42.4), 42)
  assert.equal(hudPct(42.5), 43)
  assert.equal(hudPct(-3), 0)
  assert.equal(hudPct(140), 100)
})

test('one-liner: live — hud-rounded %, HH:MM for the 5h reset, ddd HH:MM for a reset > 24h away, pace, "live"', () => {
  const line = formatOneLiner(decide(snapshot()), NOW, 'UTC')
  assert.equal(line, 'Claude 5h 42% (resets 14:05) · week 61% (pace +11, resets Tue 00:00) · live')
  assert.doesNotMatch(line, /DEGRADED/)
})

test('one-liner: weekly missing ⇒ "week n/a", still live', () => {
  assert.equal(formatOneLiner(decide(snapshot({ noWeek: true })), NOW, 'UTC'), 'Claude 5h 42% (resets 14:05) · week n/a · live')
})

test('one-liner: negative pace is signed', () => {
  const line = formatOneLiner(decide(snapshot({ sd: 20 })), NOW, 'UTC')
  assert.match(line, /week 20% \(pace -30,/)
})

test('one-liner A-6: reset-since-capture is labelled for the 5h window AND, separately, the 7d window', () => {
  const fh = formatOneLiner(decide(snapshot({ fhReset: NOW - 5 * 60 * 1000 })), NOW, 'UTC')
  assert.match(fh, /^Claude 5h 0% \(reset since capture\) · week 61%/)
  const sd = formatOneLiner(decide(snapshot({ sdReset: NOW - HOUR })), NOW, 'UTC')
  assert.match(sd, /^Claude 5h 42% \(resets 14:05\) · 7d 0% \(reset since capture\) · live$/)
  const both = formatOneLiner(decide(snapshot({ fhReset: NOW - 1000, sdReset: NOW - 1000 })), NOW, 'UTC')
  assert.equal(both, 'Claude 5h 0% (reset since capture) · 7d 0% (reset since capture) · live')
})

test('one-liner: degraded — DEGRADED with the reason; no estimate / estimate % / unreadable variants', () => {
  const none = formatOneLiner(decide(null, NOW, { snapshotError: 'snapshot missing (/x)' }), NOW, 'UTC')
  assert.equal(none, 'Claude 5h ? (no estimate configured) · week n/a · DEGRADED (snapshot missing (/x))')
  const stale = { ...snapshot(), captured_at: new Date(NOW - 23 * 60 * 1000).toISOString() }
  const est = () => computeDecision({ events: [{ ts: NOW - HOUR, tokens: 370_000 }], nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: 5 * HOUR, readOk: true })
  assert.equal(formatOneLiner(decide(stale, NOW, { estimate: est }), NOW, 'UTC'),
    'Claude 5h ~37% est. · week n/a · DEGRADED (snapshot 23 min old (stale > 10 min))')
  const unreadable = () => computeDecision({ events: [], nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: 5 * HOUR, readOk: false })
  assert.match(formatOneLiner(decide(null, NOW, { estimate: unreadable }), NOW, 'UTC'), /5h \? \(estimate unreadable\).*DEGRADED/)
})

test('jsonView: exactly the 8 documented fields, raw numbers', () => {
  const v = jsonView(decide(snapshot()))
  assert.deepEqual(Object.keys(v).sort(), ['captured_at', 'degraded', 'five_hour_pct', 'five_hour_resets_at', 'seven_day_pct', 'seven_day_resets_at', 'source', 'weekly_pace'])
  assert.equal(v.five_hour_pct, 42.4)
  assert.equal(v.source, 'live')
  assert.equal(v.degraded, false)
  const dv = jsonView(decide(null))
  assert.equal(dv.degraded, true)
  assert.equal(dv.five_hour_resets_at, null)
  assert.equal(dv.seven_day_resets_at, null)
})

// ─── usage_delta (AC7) ───
test('updateUsageDelta: start set ONCE, end refreshed every stamp, deltas recomputed', () => {
  const r1 = reading(decide(snapshot({ fh: 10, sd: 40 })), new Date(NOW).toISOString())
  const r2 = reading(decide(snapshot({ now: NOW + HOUR / 2, fh: 25, sd: 43, sdReset: NOW + 3.5 * DAY }), NOW + HOUR / 2), new Date(NOW + HOUR / 2).toISOString())
  const r3 = reading(decide(snapshot({ now: NOW + HOUR, fh: 30.5, sd: 44, sdReset: NOW + 3.5 * DAY }), NOW + HOUR), new Date(NOW + HOUR).toISOString())
  let ud = updateUsageDelta(undefined, r1)
  assert.deepEqual(ud.start, r1)
  assert.deepEqual(ud.end, r1)
  assert.equal(ud.five_hour_delta, 0)
  ud = updateUsageDelta(ud, r2)
  ud = updateUsageDelta(ud, r3)
  assert.deepEqual(ud.start, r1)
  assert.deepEqual(ud.end, r3)
  assert.equal(ud.five_hour_delta, 20.5)
  assert.equal(ud.seven_day_delta, 4)
  assert.equal(ud.window_reset_during_hunt, false)
  assert.deepEqual(ud.windows_reset, [])
  for (const k of ['at', 'five_hour_pct', 'seven_day_pct', 'five_hour_resets_at', 'seven_day_resets_at', 'source', 'degraded']) {
    assert.ok(k in ud.start, k)
  }
  assert.equal(ud.start.source, 'live')
})

test('updateUsageDelta: a 5h reset crossed between start and end ⇒ window_reset_during_hunt, five_hour_delta null (never negative); 7d delta positive', () => {
  const start = reading(decide(snapshot({ fh: 60, fhReset: NOW + HOUR, sd: 40 })), new Date(NOW).toISOString())
  const endNow = NOW + 2 * HOUR
  const end = reading(decide(snapshot({ now: endNow, fh: 8, fhReset: endNow + 4 * HOUR, sd: 47, sdReset: NOW + 3.5 * DAY }), endNow), new Date(endNow).toISOString())
  const ud = updateUsageDelta(updateUsageDelta(undefined, start), end)
  assert.equal(ud.window_reset_during_hunt, true)
  assert.deepEqual(ud.windows_reset, ['five_hour'])
  assert.equal(ud.five_hour_delta, null)
  assert.equal(ud.seven_day_delta, 7)
})

test('updateUsageDelta: a degraded reading yields null deltas, not NaN / a fabricated number', () => {
  const live = reading(decide(snapshot({ fh: 10 })), new Date(NOW).toISOString())
  const deg = reading(decide(null, NOW + HOUR), new Date(NOW + HOUR).toISOString())
  const ud = updateUsageDelta(updateUsageDelta(undefined, live), deg)
  assert.equal(ud.end.source, 'transcript_estimate')
  assert.equal(ud.end.degraded, true)
  assert.equal(ud.five_hour_delta, null)
  assert.equal(ud.seven_day_delta, null)
  const ud2 = updateUsageDelta(updateUsageDelta(undefined, deg), live)
  assert.equal(ud2.five_hour_delta, null)
  assert.equal(ud2.window_reset_during_hunt, false)
})

// ─── mistral_rate_limits (AC9) ───
test('aggregateRateLimits: both families, shared-key 429 total, last_at, garbage / unknown-kind lines counted as unparsed', () => {
  const lines = [
    JSON.stringify({ ts: 1760600000, family: 'glm', kind: '429' }),
    JSON.stringify({ ts: 1760600100, family: 'glm', kind: '429' }),
    JSON.stringify({ ts: 1760600050, family: 'mistral', kind: '429' }),
    JSON.stringify({ ts: 1760600200, family: 'mistral', kind: 'transient' }),
    JSON.stringify({ ts: 1760600300, family: 'glm', kind: 'breaker_open' }),
    'this is not json',
    JSON.stringify({ ts: 1, family: 'glm', kind: 'weird' }),
    JSON.stringify({ ts: 1, kind: '429' }),
    '',
  ].join('\n')
  const a = aggregateRateLimits(lines)
  assert.deepEqual(a.glm, { '429': 2, transient: 0, breaker_open: 1 })
  assert.deepEqual(a.mistral, { '429': 1, transient: 1, breaker_open: 0 })
  assert.equal(a.shared_key_429_total, 3)
  assert.equal(a.last_at, new Date(1760600300 * 1000).toISOString())
  assert.equal(a.unparsed_lines, 3)
  const empty = aggregateRateLimits('')
  assert.deepEqual(empty, { shared_key_429_total: 0, last_at: null, unparsed_lines: 0,
    glm: { '429': 0, transient: 0, breaker_open: 0 }, mistral: { '429': 0, transient: 0, breaker_open: 0 } })
})

// ─── stamp (A-4) ───
function planFixture({ meta = { feature: 'x', status: 'planning', tier: 'Orange', nested: { keep: 1 } } } = {}) {
  const d = tmp()
  const planDir = join(d, 'plan')
  const hb = join(d, 'hb.json')
  const snapPath = join(d, 'claude-usage.json')
  spawnSync('mkdir', ['-p', planDir])
  if (meta !== null) writeJson(join(planDir, 'metadata.json'), meta)
  return { d, planDir, hb, snapPath, env: { WOLFPACK_USAGE_SNAPSHOT: snapPath } }
}

test('stamp: heartbeat.usage written, every other heartbeat field preserved; missing heartbeat ⇒ created', () => {
  const f = planFixture()
  try {
    writeJson(f.snapPath, snapshot({ fh: 33, sd: 50 }))
    writeJson(f.hb, { hunt: 'x', phase: 'Plan', detail: 'd', agent: 'working', extra: [1, 2] })
    stamp({ heartbeat: f.hb, env: f.env, nowMs: NOW })
    const hb = readJson(f.hb)
    assert.deepEqual({ hunt: hb.hunt, phase: hb.phase, detail: hb.detail, agent: hb.agent, extra: hb.extra },
      { hunt: 'x', phase: 'Plan', detail: 'd', agent: 'working', extra: [1, 2] })
    assert.deepEqual(Object.keys(hb.usage).sort(), ['captured_at', 'five_hour_pct', 'seven_day_pct', 'source', 'weekly_pace'])
    assert.equal(hb.usage.five_hour_pct, 33)
    assert.equal(hb.usage.seven_day_pct, 50)
    assert.equal(hb.usage.source, 'live')
    rmSync(f.hb)
    stamp({ heartbeat: f.hb, env: f.env, nowMs: NOW })
    assert.equal(readJson(f.hb).usage.five_hour_pct, 33)
    assert.equal('usage_delta' in readJson(join(f.planDir, 'metadata.json')), false)  // no --plan-dir ⇒ metadata untouched
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

test('stamp --plan-dir: start-once / end-refresh sequence; metadata fields preserved; no tmp files left', () => {
  const f = planFixture()
  try {
    writeJson(f.snapPath, snapshot({ fh: 10, sd: 40 }))
    stamp({ heartbeat: f.hb, planDir: f.planDir, env: f.env, nowMs: NOW })
    const m1 = readJson(join(f.planDir, 'metadata.json'))
    assert.equal(m1.usage_delta.start.five_hour_pct, 10)
    assert.equal(m1.usage_delta.end.five_hour_pct, 10)
    const later = NOW + HOUR
    writeJson(f.snapPath, snapshot({ now: later, fh: 35, sd: 44 }))
    stamp({ heartbeat: f.hb, planDir: f.planDir, env: f.env, nowMs: later })
    const m2 = readJson(join(f.planDir, 'metadata.json'))
    assert.equal(m2.usage_delta.start.five_hour_pct, 10)
    assert.equal(m2.usage_delta.start.at, new Date(NOW).toISOString())
    assert.equal(m2.usage_delta.end.five_hour_pct, 35)
    assert.equal(m2.usage_delta.end.at, new Date(later).toISOString())
    assert.equal(m2.usage_delta.five_hour_delta, 25)
    assert.equal(m2.usage_delta.seven_day_delta, 4)
    assert.equal(m2.usage_delta.window_reset_during_hunt, false)
    assert.deepEqual([m2.feature, m2.status, m2.tier, m2.nested], ['x', 'planning', 'Orange', { keep: 1 }])
    assert.equal('mistral_rate_limits' in m2, false)          // no jsonl ⇒ not invented
    assert.deepEqual(readdirSync(f.planDir), ['metadata.json'])
    assert.equal(readdirSync(f.d).filter(n => n.endsWith('.tmp')).length, 0)
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

test('stamp --plan-dir: missing snapshot is NOT an error — records source/degraded (disclosure)', () => {
  const f = planFixture()
  try {
    const r = stamp({ heartbeat: f.hb, planDir: f.planDir, env: f.env, nowMs: NOW })
    assert.equal(r.heartbeat.usage.source, 'transcript_estimate')
    const m = readJson(join(f.planDir, 'metadata.json'))
    assert.equal(m.usage_delta.start.degraded, true)
    assert.equal(m.usage_delta.start.source, 'transcript_estimate')
    assert.equal(m.usage_delta.start.five_hour_pct, null)
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

test('stamp --plan-dir: folds rate-limits.jsonl into mistral_rate_limits', () => {
  const f = planFixture()
  try {
    writeJson(f.snapPath, snapshot())
    writeFileSync(join(f.planDir, 'rate-limits.jsonl'),
      '{"ts":1760600000,"family":"glm","kind":"429"}\n{"ts":1760600001,"family":"mistral","kind":"429"}\ngarbage\n')
    stamp({ heartbeat: f.hb, planDir: f.planDir, env: f.env, nowMs: NOW })
    const m = readJson(join(f.planDir, 'metadata.json'))
    assert.equal(m.mistral_rate_limits.shared_key_429_total, 2)
    assert.equal(m.mistral_rate_limits.glm['429'], 1)
    assert.equal(m.mistral_rate_limits.mistral['429'], 1)
    assert.equal(m.mistral_rate_limits.unparsed_lines, 1)
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

test('stamp --plan-dir: corrupt metadata.json is NOT overwritten (throws; CLI exit 1)', () => {
  const f = planFixture({ meta: null })
  try {
    const metaPath = join(f.planDir, 'metadata.json')
    writeFileSync(metaPath, '{"feature": "x", truncated')
    const before = readFileSync(metaPath, 'utf8')
    assert.throws(() => stamp({ heartbeat: f.hb, planDir: f.planDir, env: f.env, nowMs: NOW }), /unparseable/)
    assert.equal(readFileSync(metaPath, 'utf8'), before)
    const r = spawnSync(SHIM, ['stamp', '--heartbeat', f.hb, '--plan-dir', f.planDir], { env: { ...process.env, ...f.env }, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /wolfpack-usage: ERROR/)
    assert.equal(readFileSync(metaPath, 'utf8'), before)
    // a missing metadata.json is also refused (never fabricated)
    rmSync(metaPath)
    assert.throws(() => stamp({ heartbeat: f.hb, planDir: f.planDir, env: f.env, nowMs: NOW }), /does not exist/)
    assert.equal(existsSync(metaPath), false)
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

test('stamp: a corrupt heartbeat is not overwritten either', () => {
  const f = planFixture()
  try {
    writeFileSync(f.hb, 'not json{')
    assert.throws(() => stamp({ heartbeat: f.hb, env: f.env, nowMs: NOW }), /heartbeat/)
    assert.equal(readFileSync(f.hb, 'utf8'), 'not json{')
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

// ─── record-offload ───
test('recordOffload: first decision sticks (idempotent); preserves other metadata', () => {
  const f = planFixture()
  try {
    const a = recordOffload({ planDir: f.planDir, reason: 'weekly pace +16.4', nowMs: NOW })
    assert.deepEqual(a, { reason: 'weekly pace +16.4', at: new Date(NOW).toISOString() })
    const b = recordOffload({ planDir: f.planDir, reason: 'something else', nowMs: NOW + HOUR })
    assert.deepEqual(b, a)
    const m = readJson(join(f.planDir, 'metadata.json'))
    assert.deepEqual(m.usage_offload, a)
    assert.equal(m.tier, 'Orange')
    assert.deepEqual(m.nested, { keep: 1 })
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

// ─── CLI via the bash shim ───
function cli(args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WOLFPACK_')))
  return spawnSync(SHIM, args, { env: { ...clean, TZ: 'UTC', ...env }, encoding: 'utf8' })
}

test('shim is executable (committed 100755) and forwards args', () => {
  assert.ok(statSync(SHIM).mode & 0o111, 'scripts/wolfpack-usage must be executable')
  const r = cli(['bogus-cmd'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown command "bogus-cmd"/)
})

test('CLI AC8: one-liner live vs DEGRADED; --json fields', () => {
  const d = tmp()
  try {
    const snapPath = join(d, 'claude-usage.json')
    const now = Date.now()
    writeJson(snapPath, snapshot({ now, fh: 42.4, fhReset: now + 2 * HOUR, sd: 61, sdReset: now + 3 * DAY }))
    const live = cli([], { WOLFPACK_USAGE_SNAPSHOT: snapPath })
    assert.equal(live.status, 0, live.stderr)
    assert.match(live.stdout, /^Claude 5h 42% \(resets \d\d:\d\d\) · week 61% \(pace [+-]?[\d.]+, resets \w{3} \d\d:\d\d\) · live\n$/)
    const deg = cli([], { WOLFPACK_USAGE_SNAPSHOT: join(d, 'nonexistent.json'), WOLFPACK_TRANSCRIPT_DIR: join(d, 'none') })
    assert.equal(deg.status, 0)
    assert.match(deg.stdout, /DEGRADED/)
    const js = cli(['--json'], { WOLFPACK_USAGE_SNAPSHOT: snapPath })
    const v = JSON.parse(js.stdout)
    assert.equal(v.five_hour_pct, 42.4)
    assert.equal(v.source, 'live')
    assert.equal(v.degraded, false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('CLI: stamp / record-offload round-trip and argument errors', () => {
  const f = planFixture()
  try {
    writeJson(f.snapPath, snapshot({ now: Date.now(), fhReset: Date.now() + HOUR, sdReset: Date.now() + 2 * DAY }))
    const s = cli(['stamp', '--heartbeat', f.hb, '--plan-dir', f.planDir], f.env)
    assert.equal(s.status, 0, s.stderr)
    assert.match(s.stdout, /^usage stamped: 5h 42.4% · 7d 61% · live/)
    assert.ok(readJson(join(f.planDir, 'metadata.json')).usage_delta.start)
    const o = cli(['record-offload', '--plan-dir', f.planDir, '--reason', 'pace +20'], f.env)
    assert.equal(o.status, 0)
    assert.equal(JSON.parse(o.stdout).reason, 'pace +20')
    assert.equal(cli(['stamp'], f.env).status, 1)
    assert.equal(cli(['record-offload'], f.env).status, 1)
    // an invalid threshold env is a hard error even for the meter
    assert.equal(cli([], { ...f.env, WOLFPACK_WEEKLY_DEFER_PCT: 'x' }).status, 1)
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

test('currentUsage reads the snapshot path from env', () => {
  const d = tmp()
  try {
    const p = join(d, 's.json')
    writeJson(p, snapshot({ fh: 12 }))
    const u = currentUsage({ env: { WOLFPACK_USAGE_SNAPSHOT: p }, nowMs: NOW })
    assert.equal(u.five_hour_pct, 12)
    assert.equal(u.source, 'live')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ─── Pointer r2 F1 — the meter validates the estimate knobs on EVERY reading ───
test('r2 F1: currentUsage throws on a malformed estimate knob even with a fresh live snapshot', () => {
  const d = tmp()
  try {
    const p = join(d, 's.json')
    writeJson(p, snapshot({ fh: 12 }))
    assert.equal(currentUsage({ env: { WOLFPACK_USAGE_SNAPSHOT: p }, nowMs: NOW }).source, 'live')
    assert.throws(() => currentUsage({ env: { WOLFPACK_USAGE_SNAPSHOT: p, WOLFPACK_WINDOW_HEADROOM_PCT: 'x' }, nowMs: NOW }),
      /WOLFPACK_WINDOW_HEADROOM_PCT/)
    assert.throws(() => currentUsage({ env: { WOLFPACK_USAGE_SNAPSHOT: p, WOLFPACK_WINDOW_HOURS: '0' }, nowMs: NOW }),
      /WOLFPACK_WINDOW_HOURS/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('r2 F1 CLI: meter + stamp exit 1 on a malformed estimate knob, and the stamp leaves heartbeat/metadata UNTOUCHED', () => {
  const f = planFixture()
  try {
    writeJson(f.snapPath, snapshot({ now: Date.now(), fhReset: Date.now() + HOUR, sdReset: Date.now() + 2 * DAY }))
    const bad = { ...f.env, WOLFPACK_WINDOW_HOURS: 'five' }
    const m = cli([], bad)
    assert.equal(m.status, 1)
    assert.match(m.stderr, /wolfpack-usage: ERROR — WOLFPACK_WINDOW_HOURS/)
    assert.equal(m.stdout, '')
    assert.equal(cli(['--json'], bad).status, 1)
    const hbBefore = existsSync(f.hb) ? readFileSync(f.hb, 'utf8') : null
    const metaBefore = readFileSync(join(f.planDir, 'metadata.json'), 'utf8')
    const s = cli(['stamp', '--heartbeat', f.hb, '--plan-dir', f.planDir], bad)
    assert.equal(s.status, 1)
    assert.match(s.stderr, /WOLFPACK_WINDOW_HOURS/)
    assert.equal(existsSync(f.hb) ? readFileSync(f.hb, 'utf8') : null, hbBefore, 'heartbeat untouched')
    assert.equal(readFileSync(join(f.planDir, 'metadata.json'), 'utf8'), metaBefore, 'metadata untouched')
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})

// Pointer r3 (judged benign, pinned here): parallel lens-unit fan-out runs several stamps at
// once against ONE heartbeat + ONE metadata.json. The per-pid tmp + rename must keep both files
// parseable with no torn write and no tmp leftovers, and every non-usage field must survive.
test('stamp: 8 concurrent CLI stamps leave heartbeat + metadata parseable, fields preserved, no tmp leftovers', async () => {
  const { spawn } = await import('node:child_process')
  const f = planFixture()
  try {
    const now = Date.now()
    writeJson(f.snapPath, snapshot({ now, fh: 27, fhReset: now + HOUR, sd: 55, sdReset: now + 2 * DAY }))
    writeJson(f.hb, { hunt: 'x', phase: 'Code Review', agent: 'working' })
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WOLFPACK_')))
    const runs = Array.from({ length: 8 }, () => new Promise((res) => {
      const p = spawn(SHIM, ['stamp', '--heartbeat', f.hb, '--plan-dir', f.planDir],
        { env: { ...clean, TZ: 'UTC', ...f.env } })
      let err = ''
      p.stderr.on('data', (c) => { err += c })
      p.on('close', (code) => res({ code, err }))
    }))
    const results = await Promise.all(runs)
    for (const r of results) assert.equal(r.code, 0, r.err)
    const hb = readJson(f.hb)
    assert.deepEqual([hb.hunt, hb.phase, hb.agent], ['x', 'Code Review', 'working'])
    assert.equal(hb.usage.five_hour_pct, 27)
    const m = readJson(join(f.planDir, 'metadata.json'))
    assert.deepEqual([m.feature, m.status, m.tier, m.nested], ['x', 'planning', 'Orange', { keep: 1 }])
    assert.equal(m.usage_delta.start.five_hour_pct, 27)
    assert.equal(m.usage_delta.end.five_hour_pct, 27)
    assert.equal(m.usage_delta.five_hour_delta, 0)
    assert.deepEqual(readdirSync(f.planDir), ['metadata.json'])
    assert.equal(readdirSync(f.d).filter(n => n.endsWith('.tmp')).length, 0)
  } finally { rmSync(f.d, { recursive: true, force: true }) }
})
