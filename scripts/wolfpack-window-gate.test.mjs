// Tests for wolfpack-window-gate.mjs — run: node --test scripts/wolfpack-window-gate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  usageTokens, parseTranscript, computeDecision, collectEvents, PROCEED, DEFER,
} from './wolfpack-window-gate.mjs'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HOUR = 60 * 60 * 1000
const WIN = 5 * HOUR
const NOW = Date.parse('2026-06-07T12:00:00Z')

test('usageTokens sums every bucket the rate-limit counts', () => {
  assert.equal(usageTokens({
    input_tokens: 100, output_tokens: 50,
    cache_creation_input_tokens: 10, cache_read_input_tokens: 5,
  }), 165)
  assert.equal(usageTokens(null), 0)
  assert.equal(usageTokens({}), 0)
})

test('parseTranscript extracts usage events, skips noise', () => {
  const body = [
    '',
    'not json',
    JSON.stringify({ timestamp: '2026-06-07T11:00:00Z', message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
    JSON.stringify({ type: 'user', message: { role: 'user' } }),            // no usage
    JSON.stringify({ message: { usage: { input_tokens: 0, output_tokens: 0 } } }), // zero
    JSON.stringify({ message: { usage: { output_tokens: 7 } } }),           // no timestamp → skipped
  ].join('\n')
  const events = parseTranscript(body)
  assert.equal(events.length, 1)
  assert.equal(events[0].tokens, 15)
  assert.equal(events[0].ts, Date.parse('2026-06-07T11:00:00Z'))
})

test('disabled gate (no limit) → proceed, loud, gateEnabled=false', () => {
  for (const limit of [0, null, NaN, undefined]) {
    const d = computeDecision({ events: [], nowMs: NOW, limit, headroomPct: 15, windowMs: WIN, readOk: true })
    assert.equal(d.decision, 'proceed')
    assert.equal(d.exit, PROCEED)
    assert.equal(d.gateEnabled, false)
    assert.match(d.reason, /DISABLED/)
  }
})

test('enabled but unreadable transcripts → fail closed (defer) with reset_at', () => {
  const d = computeDecision({ events: [], nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: false })
  assert.equal(d.decision, 'defer')
  assert.equal(d.exit, DEFER)
  assert.equal(d.reset_at, new Date(NOW + WIN).toISOString())
})

test('plenty of headroom → proceed', () => {
  const events = [{ ts: NOW - HOUR, tokens: 100_000 }]
  const d = computeDecision({ events, nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: true })
  assert.equal(d.decision, 'proceed')
  assert.equal(d.used, 100_000)
  assert.equal(d.remaining, 900_000)
})

test('over headroom → defer; reset_at = oldest in-window + window', () => {
  const oldest = NOW - 2 * HOUR
  const events = [
    { ts: oldest, tokens: 500_000 },
    { ts: NOW - HOUR, tokens: 400_000 },
  ]
  // used 900k of 1M, headroom 15% = 150k, remaining 100k < 150k → defer
  const d = computeDecision({ events, nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: true })
  assert.equal(d.decision, 'defer')
  assert.equal(d.exit, DEFER)
  assert.equal(d.used, 900_000)
  assert.equal(d.reset_at, new Date(oldest + WIN).toISOString())
})

test('usage OUTSIDE the rolling window is not counted', () => {
  const events = [
    { ts: NOW - 6 * HOUR, tokens: 900_000 },  // aged out (>5h)
    { ts: NOW - HOUR, tokens: 50_000 },        // in window
  ]
  const d = computeDecision({ events, nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: true })
  assert.equal(d.decision, 'proceed')
  assert.equal(d.used, 50_000)
})

test('exactly at the headroom boundary is NOT a defer (remaining == headroom)', () => {
  // used 850k of 1M, remaining 150k, headroom 150k → remaining < headroom is false → proceed
  const events = [{ ts: NOW - HOUR, tokens: 850_000 }]
  const d = computeDecision({ events, nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: true })
  assert.equal(d.decision, 'proceed')
  // one token more tips it over
  const d2 = computeDecision({ events: [{ ts: NOW - HOUR, tokens: 850_001 }], nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: true })
  assert.equal(d2.decision, 'defer')
})

test('empty in-window with readOk → proceed, reset_at = now (capacity full)', () => {
  const d = computeDecision({ events: [], nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: true })
  assert.equal(d.decision, 'proceed')
  assert.equal(d.used, 0)
  assert.equal(d.reset_at, new Date(NOW).toISOString())
})

test('collectEvents: missing dir → readOk false (fail-closed)', () => {
  const { events, readOk } = collectEvents(join(tmpdir(), 'wolfpack-no-such-dir-xyz'), Date.now() - WIN)
  assert.equal(readOk, false)
  assert.equal(events.length, 0)
})

test('collectEvents: dir with a readable recent transcript → readOk true + events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfgate-'))
  try {
    const line = JSON.stringify({ timestamp: new Date(Date.now() - HOUR).toISOString(), message: { usage: { input_tokens: 100, output_tokens: 20 } } })
    writeFileSync(join(dir, 'a.jsonl'), line + '\n')
    const { events, readOk } = collectEvents(dir, Date.now() - WIN)
    assert.equal(readOk, true)
    assert.equal(events.length, 1)
    assert.equal(events[0].tokens, 120)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('collectEvents: file older than the window is SKIPPED but still counts as read OK', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfgate-'))
  try {
    const f = join(dir, 'old.jsonl')
    // content has an in-window-looking ts, but mtime is ancient → must be skipped by mtime
    writeFileSync(f, JSON.stringify({ timestamp: new Date().toISOString(), message: { usage: { input_tokens: 999999 } } }) + '\n')
    const ancient = (Date.now() - 100 * HOUR) / 1000
    utimesSync(f, ancient, ancient)
    const { events, readOk } = collectEvents(dir, Date.now() - WIN)
    assert.equal(readOk, true)          // a skip is not a failure
    assert.equal(events.length, 0)      // skipped, so its tokens are not counted
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ════════════════════════════════════════════════════════════════════════════
// usage-limit-gate — live snapshot decision core (AC2/AC3/AC4, A-6, A-7, A-11).
// This block is kept byte-identical with consuming-project copies until scripts-unfork reconciles them.
// ════════════════════════════════════════════════════════════════════════════
import {
  computeUsageDecision, thresholdsFromEnv, readSnapshot, normTier, isValidWindow,
  flatten, snapshotUnusableReason, DEFAULT_THRESHOLDS, WEEK_MS, WEEKLY_UNAVAILABLE_NOTE,
} from './wolfpack-window-gate.mjs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const DAY = 24 * HOUR
const sec = (ms) => ms / 1000
const GATE = join(dirname(fileURLToPath(import.meta.url)), 'wolfpack-window-gate.mjs')
const ALWAYS_KEYS = ['decision', 'exit', 'reason', 'reset_at', 'source', 'degraded', 'gateEnabled',
  'offload', 'five_hour_pct', 'seven_day_pct', 'weekly_pace']

// Snapshot builder: 5h used/reset-in, 7d used/day-of-week (elapsed days), captured 1 min ago.
function snap({ fh = 10, fhResetInMs = 2 * HOUR, sd = 20, sdDay = 3.5, capturedAgoMs = 60 * 1000,
  five_hour, seven_day } = {}) {
  const rl = {}
  rl.five_hour = five_hour !== undefined ? five_hour
    : { used_percentage: fh, resets_at: sec(NOW + fhResetInMs) }
  const sdw = seven_day !== undefined ? seven_day
    : { used_percentage: sd, resets_at: sec(NOW + (7 - sdDay) * DAY) }
  if (sdw !== null) rl.seven_day = sdw
  if (five_hour === null) delete rl.five_hour
  return { rate_limits: rl, captured_at: new Date(NOW - capturedAgoMs).toISOString() }
}
const decide = (snapshot, tier = 'Yellow', thresholds = DEFAULT_THRESHOLDS, extra = {}) =>
  computeUsageDecision({ snapshot, nowMs: NOW, tier, thresholds, ...extra })
const noNaN = (obj) => JSON.stringify(obj, (k, v) => {
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`non-finite number at ${k}`)
  return v
})

test('usage: normTier is case-insensitive; missing/unknown ⇒ Red (A-11)', () => {
  assert.equal(normTier('orange'), 'Orange')
  assert.equal(normTier(' YELLOW '), 'Yellow')
  assert.equal(normTier(undefined), 'Red')
  assert.equal(normTier(''), 'Red')
  assert.equal(normTier('Purple'), 'Red')
})

test('usage: isValidWindow requires finite used_percentage AND finite resets_at > 0 (A-7)', () => {
  assert.equal(isValidWindow({ used_percentage: 5, resets_at: 1 }), true)
  for (const w of [null, undefined, {}, { used_percentage: 5 }, { used_percentage: 5, resets_at: null },
    { used_percentage: 5, resets_at: '1760000000' }, { used_percentage: 5, resets_at: 0 },
    { used_percentage: 5, resets_at: -3 }, { used_percentage: NaN, resets_at: 5 },
    { used_percentage: '5', resets_at: 5 }, { used_percentage: 5, resets_at: Infinity }]) {
    assert.equal(isValidWindow(w), false, JSON.stringify(w))
  }
})

test('usage AC2: 5h ceiling — non-Red 79.9 proceeds / 80 defers; reset_at = five_hour.resets_at; source live', () => {
  for (const tier of ['Green', 'Blue', 'Yellow', 'Orange']) {
    const ok = decide(snap({ fh: 79.9, sd: 10 }), tier)
    assert.equal(ok.decision, 'proceed', tier)
    assert.equal(ok.exit, PROCEED)
    assert.equal(ok.source, 'live')
    assert.equal(ok.degraded, false)
    assert.equal(ok.gateEnabled, true)
    const s = snap({ fh: 80, sd: 10 })
    const d = decide(s, tier)
    assert.equal(d.decision, 'defer', tier)
    assert.equal(d.exit, DEFER)
    assert.equal(d.source, 'live')
    assert.equal(d.reset_at, new Date(s.rate_limits.five_hour.resets_at * 1000).toISOString())
    assert.match(d.reason, /5h window: 80% ≥ 80%/)
  }
})

test('usage AC2: Red ceiling 70 — 69.9 proceeds / 70 defers; unknown / missing tier ⇒ Red', () => {
  // call the core directly: decide()'s default parameter would turn `undefined` into Yellow
  const raw = (snapshot, tier) => computeUsageDecision({ snapshot, nowMs: NOW, tier, thresholds: DEFAULT_THRESHOLDS })
  for (const tier of ['Red', 'red', undefined, 'bogus']) {
    assert.equal(raw(snap({ fh: 69.9, sd: 10 }), tier).decision, 'proceed', String(tier))
    const d = raw(snap({ fh: 70, sd: 10 }), tier)
    assert.equal(d.decision, 'defer', String(tier))
    assert.equal(d.tier, 'Red')
  }
  // 75 is fine for Orange but a defer for Red.
  assert.equal(decide(snap({ fh: 75, sd: 10 }), 'Orange').decision, 'proceed')
  assert.equal(decide(snap({ fh: 75, sd: 10 }), 'Red').decision, 'defer')
})

test('usage AC2: thresholds env-overridable; invalid values THROW (fail loud, never default)', () => {
  const th = thresholdsFromEnv({ WOLFPACK_5H_START_MAX_PCT: '50' })
  assert.equal(th.fiveHourMaxPct, 50)
  assert.equal(th.fiveHourMaxPctRed, 70)      // others keep defaults
  assert.equal(decide(snap({ fh: 55, sd: 10 }), 'Yellow', th).decision, 'defer')
  assert.equal(decide(snap({ fh: 45, sd: 10 }), 'Yellow', th).decision, 'proceed')
  const all = thresholdsFromEnv({
    WOLFPACK_USAGE_STALE_MINUTES: '30', WOLFPACK_5H_START_MAX_PCT: '85', WOLFPACK_5H_START_MAX_PCT_RED: '60',
    WOLFPACK_WEEKLY_PACE_POINTS: '5', WOLFPACK_WEEKLY_DEFER_PCT: '95',
  })
  assert.deepEqual(all, { staleMinutes: 30, fiveHourMaxPct: 85, fiveHourMaxPctRed: 60, weeklyPacePoints: 5, weeklyDeferPct: 95 })
  assert.deepEqual(thresholdsFromEnv({}), { staleMinutes: 10, fiveHourMaxPct: 80, fiveHourMaxPctRed: 70, weeklyPacePoints: 15, weeklyDeferPct: 90 })
  for (const [k, v] of [['WOLFPACK_5H_START_MAX_PCT', 'abc'], ['WOLFPACK_5H_START_MAX_PCT', '101'],
    ['WOLFPACK_5H_START_MAX_PCT_RED', '-1'], ['WOLFPACK_WEEKLY_PACE_POINTS', 'NaN'],
    ['WOLFPACK_WEEKLY_DEFER_PCT', 'Infinity'], ['WOLFPACK_USAGE_STALE_MINUTES', '0'],
    ['WOLFPACK_USAGE_STALE_MINUTES', '-5']]) {
    assert.throws(() => thresholdsFromEnv({ [k]: v }), new RegExp(k), `${k}=${v}`)
  }
})

test('usage AC4: on-pace (day 3.5, used 50) ⇒ pace 0, no offload', () => {
  const d = decide(snap({ fh: 10, sd: 50, sdDay: 3.5 }))
  assert.equal(d.decision, 'proceed')
  assert.equal(d.seven_day.elapsed_share, 0.5)
  assert.equal(d.seven_day.pace, 0)
  assert.equal(d.weekly_pace, 0)
  assert.equal(d.offload, false)
  assert.equal('offload_reason' in d, false)
})

test('usage AC4: ahead (day 2, used 45) ⇒ pace ≈ +16.4 ⇒ proceed + offload with a reason', () => {
  const d = decide(snap({ fh: 10, sd: 45, sdDay: 2 }))
  assert.equal(d.decision, 'proceed')
  assert.equal(d.exit, PROCEED)
  assert.equal(d.seven_day.pace, 16.4)
  assert.equal(d.weekly_pace, 16.4)
  assert.equal(d.offload, true)
  assert.match(d.offload_reason, /weekly pace \+16\.4/)
})

test('usage AC4: pace EXACTLY 15 ⇒ no offload (strictly ">")', () => {
  const d = decide(snap({ fh: 10, sd: 65, sdDay: 3.5 }))
  assert.equal(d.seven_day.pace, 15)
  assert.equal(d.offload, false)
  // and the override knob moves the line
  const th = thresholdsFromEnv({ WOLFPACK_WEEKLY_PACE_POINTS: '14.9' })
  assert.equal(decide(snap({ fh: 10, sd: 65, sdDay: 3.5 }), 'Yellow', th).offload, true)
})

test('usage AC4: weekly ≥ 90 ⇒ defer ALL tiers, reset_at = seven_day.resets_at', () => {
  for (const tier of ['Green', 'Yellow', 'Red']) {
    const s = snap({ fh: 5, sd: 90, sdDay: 6 })
    const d = decide(s, tier)
    assert.equal(d.decision, 'defer')
    assert.equal(d.exit, DEFER)
    assert.equal(d.reset_at, new Date(s.rate_limits.seven_day.resets_at * 1000).toISOString())
    assert.match(d.reason, /^weekly cap: 7d 90% ≥ 90%/)
  }
  assert.equal(decide(snap({ fh: 5, sd: 89.9, sdDay: 6.5 })).decision, 'proceed')
  const th = thresholdsFromEnv({ WOLFPACK_WEEKLY_DEFER_PCT: '95' })
  assert.equal(decide(snap({ fh: 5, sd: 92, sdDay: 6.9 }), 'Yellow', th).decision, 'proceed')
})

test('usage AC4: a window that JUST reset (resets_at ≈ now+7d, used 2) ⇒ elapsed ≈ 0, pace 2, no offload', () => {
  const d = decide(snap({ fh: 1, sd: 2, sdDay: 0 }))
  assert.equal(d.decision, 'proceed')
  assert.equal(d.seven_day.elapsed_share, 0)
  assert.equal(d.seven_day.pace, 2)
  assert.equal(d.offload, false)
})

test('usage: weekly-90 AND 5h-85 tie ⇒ the WEEKLY reason / reset wins', () => {
  const s = snap({ fh: 85, sd: 90, sdDay: 6 })
  const d = decide(s, 'Red')
  assert.equal(d.decision, 'defer')
  assert.match(d.reason, /^weekly cap/)
  assert.equal(d.reset_at, new Date(s.rate_limits.seven_day.resets_at * 1000).toISOString())
})

test('usage: 5h defer outranks offload (no offload flag on a defer)', () => {
  const d = decide(snap({ fh: 95, sd: 45, sdDay: 2 }))
  assert.equal(d.decision, 'defer')
  assert.equal(d.offload, false)
  assert.equal('offload_reason' in d, false)
})

test('usage AC3: missing / unparseable / stale / five_hour missing / future captured_at ⇒ degraded transcript_estimate', () => {
  const cases = {
    missing: [null, 'snapshot missing (/x)'],
    stale11: [snap({ capturedAgoMs: 11 * 60 * 1000 }), null],
    noFiveHour: [snap({ five_hour: null }), null],
    future: [snap({ capturedAgoMs: -5 * 60 * 1000 }), null],
    badCapturedAt: [{ ...snap(), captured_at: 'yesterday-ish' }, null],
    noCapturedAt: [{ rate_limits: snap().rate_limits }, null],
  }
  for (const [name, [s, err]] of Object.entries(cases)) {
    const d = decide(s, 'Yellow', DEFAULT_THRESHOLDS, { snapshotError: err })
    assert.equal(d.source, 'transcript_estimate', name)
    assert.equal(d.degraded, true, name)
    assert.ok(d.degraded_reason, name)
    assert.equal(d.offload, false, name)
    assert.equal(d.five_hour_pct, null, name)
    assert.equal(d.seven_day_pct, null, name)
    assert.equal(d.weekly_pace, null, name)
  }
  assert.match(decide(snap({ capturedAgoMs: 11 * 60 * 1000 })).degraded_reason, /11 min old/)
  assert.match(decide(snap({ capturedAgoMs: -5 * 60 * 1000 })).degraded_reason, /future/)
  // 9 min old is still fresh; a 30-min stale window via env makes 11 min fresh too.
  assert.equal(decide(snap({ capturedAgoMs: 9 * 60 * 1000 })).source, 'live')
  const th = thresholdsFromEnv({ WOLFPACK_USAGE_STALE_MINUTES: '30' })
  assert.equal(decide(snap({ capturedAgoMs: 11 * 60 * 1000 }), 'Yellow', th).source, 'live')
})

test('usage AC3: degraded path delegates to the estimate (estimate defer is preserved, never relabelled live)', () => {
  let called = 0
  const estimate = () => { called++; return computeDecision({ events: [{ ts: NOW - HOUR, tokens: 950_000 }], nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: true }) }
  const d = decide(null, 'Yellow', DEFAULT_THRESHOLDS, { estimate, snapshotError: 'snapshot missing' })
  assert.equal(called, 1)
  assert.equal(d.decision, 'defer')
  assert.equal(d.exit, DEFER)
  assert.equal(d.gateEnabled, true)
  assert.equal(d.used, 950_000)
  assert.equal(d.source, 'transcript_estimate')
  assert.equal(d.degraded, true)
  // live path never calls the estimate
  let liveCalls = 0
  decide(snap(), 'Yellow', DEFAULT_THRESHOLDS, { estimate: () => { liveCalls++; return {} } })
  assert.equal(liveCalls, 0)
  // no estimate configured ⇒ proceed, gateEnabled false (A-8: proceed, loudly)
  const off = decide(null)
  assert.equal(off.decision, 'proceed')
  assert.equal(off.gateEnabled, false)
  assert.equal(off.degraded, true)
})

test('usage A-6: five_hour resets_at already past on a fresh snapshot ⇒ 0%, reset_since_capture, no defer from the stale number', () => {
  const s = snap({ fh: 95, fhResetInMs: -10 * 60 * 1000, sd: 20, sdDay: 3.5 })
  const d = decide(s, 'Red')
  assert.equal(d.decision, 'proceed')
  assert.equal(d.five_hour.used_pct, 0)
  assert.equal(d.five_hour_pct, 0)
  assert.equal(d.five_hour.reset_since_capture, true)
  assert.equal(d.five_hour.captured_used_pct, 95)
  assert.equal(d.seven_day.reset_since_capture, false)
})

test('usage A-6: seven_day resets_at already past ⇒ 7d 0%, pace 0, no offload / defer from the stale number', () => {
  const s = snap({ fh: 10, sd: 99, seven_day: { used_percentage: 99, resets_at: sec(NOW - HOUR) } })
  const d = decide(s)
  assert.equal(d.decision, 'proceed')
  assert.equal(d.seven_day.used_pct, 0)
  assert.equal(d.seven_day.pace, 0)
  assert.equal(d.seven_day.elapsed_share, 0)
  assert.equal(d.seven_day.reset_since_capture, true)
  assert.equal(d.seven_day.captured_used_pct, 99)
  assert.equal(d.five_hour.reset_since_capture, false)
  assert.equal(d.offload, false)
  assert.equal(d.weekly_pace, 0)
})

test('usage A-7: seven_day missing ⇒ live 5h decision, seven_day null, weekly_note, offload false', () => {
  const d = decide(snap({ fh: 30, seven_day: null }))
  assert.equal(d.source, 'live')
  assert.equal(d.degraded, false)
  assert.equal(d.decision, 'proceed')
  assert.equal(d.seven_day, null)
  assert.equal(d.seven_day_pct, null)
  assert.equal(d.weekly_pace, null)
  assert.equal(d.offload, false)
  assert.equal(d.weekly_note, WEEKLY_UNAVAILABLE_NOTE)
  // 5h still enforced without the weekly window
  assert.equal(decide(snap({ fh: 85, seven_day: null })).decision, 'defer')
})

test('usage A-7: seven_day at 95 with NO resets_at ⇒ invalid: live 5h, no weekly defer, never NaN', () => {
  for (const sdw of [{ used_percentage: 95 }, { used_percentage: 95, resets_at: null }, { used_percentage: 95, resets_at: 'soon' }]) {
    const d = decide(snap({ fh: 30, seven_day: sdw }))
    assert.equal(d.decision, 'proceed')
    assert.equal(d.seven_day, null)
    assert.equal(d.weekly_pace, null)
    assert.equal(d.offload, false)
    assert.equal(d.weekly_note, WEEKLY_UNAVAILABLE_NOTE)
    noNaN(d)
  }
})

test('usage A-7: five_hour with used_percentage only (no / null / string resets_at) ⇒ degraded, never a throw', () => {
  for (const fhw of [{ used_percentage: 50 }, { used_percentage: 50, resets_at: null }, { used_percentage: 50, resets_at: '123' }, { resets_at: 123 }]) {
    let d
    assert.doesNotThrow(() => { d = decide(snap({ five_hour: fhw })) })
    assert.equal(d.degraded, true)
    assert.equal(d.source, 'transcript_estimate')
    assert.match(d.degraded_reason, /five_hour/)
    noNaN(d)
  }
})

test('usage: output contract — every always-present key on live AND degraded; flat mirrors equal nested on live', () => {
  const live = decide(snap({ fh: 42.4, sd: 45, sdDay: 2 }))
  const degraded = decide(null)
  const weekly = decide(snap({ seven_day: null }))
  for (const [name, d] of Object.entries({ live, degraded, weekly })) {
    for (const k of ALWAYS_KEYS) assert.ok(k in d, `${name} lacks ${k}`)
    noNaN(d)
  }
  assert.equal(live.five_hour_pct, live.five_hour.used_pct)
  assert.equal(live.five_hour_pct, 42.4)            // raw, not rounded
  assert.equal(live.seven_day_pct, live.seven_day.used_pct)
  assert.equal(live.weekly_pace, live.seven_day.pace)
  assert.equal(degraded.offload, false)
  // nested objects never reuse the overnight driver's sed-scraped top-level names
  for (const nested of [live.five_hour, live.seven_day]) {
    for (const k of ['decision', 'reason', 'reset_at']) assert.equal(k in nested, false, k)
  }
})

test('usage: flatten fills missing contract keys with null and drops offload_reason when not offloading', () => {
  const f = flatten({ five_hour: null, seven_day: null, offload_reason: 'x' })
  for (const k of ALWAYS_KEYS) assert.ok(k in f, k)
  assert.equal(f.offload, false)
  assert.equal('offload_reason' in f, false)
  assert.equal(f.decision, null)
})

test('usage: readSnapshot — missing / unparseable / non-object never throw; valid parses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfsnap-'))
  try {
    assert.match(readSnapshot(join(dir, 'nope.json')).error, /missing/)
    writeFileSync(join(dir, 'bad.json'), '{not json')
    assert.match(readSnapshot(join(dir, 'bad.json')).error, /unparseable/)
    writeFileSync(join(dir, 'arr.json'), '[1,2]')
    assert.match(readSnapshot(join(dir, 'arr.json')).error, /not a JSON object/)
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(snap()))
    const r = readSnapshot(join(dir, 'ok.json'))
    assert.equal(r.ok, true)
    assert.equal(r.snapshot.rate_limits.five_hour.used_percentage, 10)
    const throwing = { existsSync: () => true, readFileSync: () => { throw new Error('EACCES') } }
    assert.equal(readSnapshot('/x', throwing).ok, false)
    assert.equal(snapshotUnusableReason(null, NOW, DEFAULT_THRESHOLDS, 'boom'), 'boom')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('usage: weekly math — elapsed share clamps to [0,1] for resets_at further than 7d out', () => {
  const d = decide(snap({ fh: 1, sd: 3, seven_day: { used_percentage: 3, resets_at: sec(NOW + 8 * DAY) } }))
  assert.equal(d.seven_day.elapsed_share, 0)
  assert.equal(d.seven_day.pace, 3)
  assert.equal(WEEK_MS, 7 * DAY)
})

// ─── CLI (subprocess) — the stderr warnings must appear WITH --json (AC3, A-7) ───
function runGate(args, { snapshot, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wfcli-'))
  try {
    const snapPath = join(dir, 'claude-usage.json')
    if (snapshot !== undefined) writeFileSync(snapPath, typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot))
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WOLFPACK_')))
    const r = spawnSync(process.execPath, [GATE, ...args, '--snapshot', snapPath], {
      env: { ...clean, WOLFPACK_TRANSCRIPT_DIR: join(dir, 'no-transcripts'), ...env }, encoding: 'utf8',
    })
    let json = null
    try { json = JSON.parse(r.stdout) } catch { /* asserted by callers */ }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const liveSnap = ({ fh = 20, sd = 30, sdDayAgo = 3.5 } = {}) => {
  const now = Date.now()
  return {
    rate_limits: {
      five_hour: { used_percentage: fh, resets_at: Math.floor((now + 2 * HOUR) / 1000) },
      ...(sd == null ? {} : { seven_day: { used_percentage: sd, resets_at: Math.floor((now + (7 - sdDayAgo) * DAY) / 1000) } }),
    },
    captured_at: new Date(now - 30 * 1000).toISOString(),
  }
}

test('usage CLI: fresh snapshot --json --tier Red ⇒ source live, exit 0; 75% ⇒ exit 10 defer', () => {
  const ok = runGate(['--json', '--tier', 'Red'], { snapshot: liveSnap({ fh: 20 }) })
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(ok.json.source, 'live')
  assert.equal(ok.json.decision, 'proceed')
  assert.equal(ok.stdout.trim().split('\n').length, 1)        // one JSON line
  assert.doesNotMatch(ok.stderr, /DEGRADED/)
  const d = runGate(['--json', '--tier', 'red'], { snapshot: liveSnap({ fh: 75 }) })
  assert.equal(d.code, 10)
  assert.equal(d.json.decision, 'defer')
  assert.equal(d.json.exit, 10)
  // the same 75% proceeds for Orange
  assert.equal(runGate(['--json', '--tier', 'Orange'], { snapshot: liveSnap({ fh: 75 }) }).code, 0)
})

test('usage CLI AC3: missing / unparseable snapshot ⇒ degraded JSON AND a stderr DEGRADED warning with --json', () => {
  for (const snapshot of [undefined, '{garbage']) {
    const r = runGate(['--json', '--tier', 'Yellow'], { snapshot })
    assert.equal(r.code, 0)                                  // A-8: unconfigured estimate ⇒ proceed, loudly
    assert.equal(r.json.source, 'transcript_estimate')
    assert.equal(r.json.degraded, true)
    assert.equal(r.json.gateEnabled, false)
    assert.match(r.stderr, /DEGRADED/)
    for (const k of ALWAYS_KEYS) assert.ok(k in r.json, k)
  }
})

test('usage CLI AC3: stale snapshot with the estimate configured but unreadable ⇒ fail-closed defer (exit 10), degraded', () => {
  const s = liveSnap()
  s.captured_at = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const r = runGate(['--json'], { snapshot: s, env: { WOLFPACK_CLAUDE_WINDOW_LIMIT: '1000000', WOLFPACK_AGENT_WINDOW_LIMIT: '1000000' } })
  assert.equal(r.code, 10)
  assert.equal(r.json.decision, 'defer')
  assert.equal(r.json.degraded, true)
  assert.match(r.json.degraded_reason, /min old/)
  assert.match(r.stderr, /DEGRADED/)
})

test('usage CLI A-7: weekly window unusable ⇒ live 5h + the weekly-unavailable stderr warning with --json', () => {
  const s = liveSnap({ fh: 20, sd: null })
  s.rate_limits.seven_day = { used_percentage: 95 }
  const r = runGate(['--json', '--tier', 'Yellow'], { snapshot: s })
  assert.equal(r.code, 0)
  assert.equal(r.json.source, 'live')
  assert.equal(r.json.seven_day, null)
  assert.equal(r.json.weekly_pace, null)
  assert.match(r.stderr, /weekly figures unavailable/)
})

test('usage CLI: offload is announced on stderr with --json too', () => {
  const r = runGate(['--json', '--tier', 'Yellow'], { snapshot: liveSnap({ fh: 10, sd: 45, sdDayAgo: 2 }) })
  assert.equal(r.code, 0)
  assert.equal(r.json.offload, true)
  assert.match(r.stderr, /OFFLOAD/)
})

test('usage CLI: an invalid threshold env is a hard error — exit 1, stderr names the variable', () => {
  const r = runGate(['--json'], { snapshot: liveSnap(), env: { WOLFPACK_5H_START_MAX_PCT: 'eighty' } })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /WOLFPACK_5H_START_MAX_PCT/)
  assert.equal(r.stdout, '')
})

test('usage CLI: non-json mode prints the pace line and the resume hint on a defer', () => {
  const r = runGate(['--tier', 'Yellow'], { snapshot: liveSnap({ fh: 85, sd: 30 }) })
  assert.equal(r.code, 10)
  assert.match(r.stderr, /DEFER \[live\]/)
  assert.match(r.stderr, /pace/)
  assert.match(r.stderr, /resume after/)
})

// ─── Pointer r2 F1 — the degraded-fallback estimate knobs hard-error (never fail open) ───
import { estimateConfigFromEnv, estimateFromEnv } from './wolfpack-window-gate.mjs'
import { readFileSync as readSrc } from 'node:fs'

test('r2 F1: estimateConfigFromEnv — unset/blank ⇒ defaults 15% / 5h; valid overrides parse', () => {
  assert.deepEqual(estimateConfigFromEnv({}), { headroomPct: 15, windowHours: 5 })
  assert.deepEqual(estimateConfigFromEnv({ WOLFPACK_WINDOW_HEADROOM_PCT: '', WOLFPACK_WINDOW_HOURS: '  ' }), { headroomPct: 15, windowHours: 5 })
  assert.deepEqual(estimateConfigFromEnv({ WOLFPACK_WINDOW_HEADROOM_PCT: '0', WOLFPACK_WINDOW_HOURS: '2.5' }), { headroomPct: 0, windowHours: 2.5 })
  assert.deepEqual(estimateConfigFromEnv({ WOLFPACK_WINDOW_HEADROOM_PCT: '100' }), { headroomPct: 100, windowHours: 5 })
})

test('r2 F1: estimateConfigFromEnv — malformed / out-of-range knobs THROW naming the variable', () => {
  for (const v of ['abc', '-1', '100.5', 'NaN', 'Infinity', '15%']) {
    assert.throws(() => estimateConfigFromEnv({ WOLFPACK_WINDOW_HEADROOM_PCT: v }), /WOLFPACK_WINDOW_HEADROOM_PCT=.*invalid/, v)
  }
  for (const v of ['0', '-5', 'five', 'Infinity']) {
    assert.throws(() => estimateConfigFromEnv({ WOLFPACK_WINDOW_HOURS: v }), /WOLFPACK_WINDOW_HOURS=.*invalid.*> 0/, v)
  }
})

test('r2 F1: estimateFromEnv throws on a malformed knob even with the estimate enabled — never NaN ⇒ always-proceed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfest-'))
  try {
    for (const env of [
      { WOLFPACK_CLAUDE_WINDOW_LIMIT: '1000', WOLFPACK_WINDOW_HEADROOM_PCT: 'x' },
      { WOLFPACK_CLAUDE_WINDOW_LIMIT: '1000', WOLFPACK_WINDOW_HOURS: '0' },
      { WOLFPACK_WINDOW_HOURS: 'bogus' },                     // estimate disabled — still validated
    ]) assert.throws(() => estimateFromEnv(env, NOW, dir), /invalid/, JSON.stringify(env))
    // valid knobs still produce a finite decision
    const ok = estimateFromEnv({ WOLFPACK_CLAUDE_WINDOW_LIMIT: '1000', WOLFPACK_WINDOW_HEADROOM_PCT: '20' }, NOW, dir)
    assert.ok(ok && typeof ok === 'object')
    noNaN(ok)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('r2 F1 CLI: a malformed estimate knob exits 1 even when a FRESH live snapshot means the estimate is never consulted', () => {
  for (const env of [{ WOLFPACK_WINDOW_HEADROOM_PCT: 'fifteen' }, { WOLFPACK_WINDOW_HOURS: '-1' }]) {
    const r = runGate(['--json', '--tier', 'Yellow'], { snapshot: liveSnap({ fh: 10 }), env })
    assert.equal(r.code, 1, `${JSON.stringify(env)}: ${r.stderr}`)
    assert.match(r.stderr, new RegExp(Object.keys(env)[0]))
    assert.match(r.stderr, /wolfpack-window-gate: ERROR/)
    assert.equal(r.stdout, '', 'no decision JSON on a config error')
  }
  // ...and on the degraded path too (missing snapshot): exit 1, not a silent proceed
  const deg = runGate(['--json'], { env: { WOLFPACK_CLAUDE_WINDOW_LIMIT: '1000', WOLFPACK_WINDOW_HEADROOM_PCT: 'x' } })
  assert.equal(deg.code, 1)
  assert.equal(deg.stdout, '')
})

test('r2 F1 CLI: WOLFPACK_CLAUDE_WINDOW_LIMIT unset / 0 stays the documented estimate opt-out (proceed, loud), not an error', () => {
  for (const lim of [undefined, '0']) {
    const r = runGate(['--json'], { env: lim === undefined ? {} : { WOLFPACK_CLAUDE_WINDOW_LIMIT: lim } })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.json.degraded, true)
    assert.equal(r.json.gateEnabled, false)
  }
})

test('r1 F2: the gate carries the WOLFPACK_GATE_PROTOCOL=1 marker in the exact form the runner preflight greps', () => {
  const src = readSrc(GATE, 'utf8')
  const hits = src.match(/WOLFPACK_GATE_PROTOCOL=[0-9]*/g) || []
  assert.ok(hits.length >= 1, 'marker missing — the runner would drop to the legacy-degraded gate')
  assert.equal(hits[0], 'WOLFPACK_GATE_PROTOCOL=1', 'the FIRST match is what `grep -o … | head -1` returns')
})
