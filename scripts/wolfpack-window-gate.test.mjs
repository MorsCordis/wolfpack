// Tests for wolfpack-window-gate.mjs — run: node --test scripts/wolfpack-window-gate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  usageTokens, parseTranscript, computeDecision, collectEvents, PROCEED, DEFER,
} from './wolfpack-window-gate.mjs'
import { mkdtempSync, writeFileSync, utimesSync, rmSync, mkdirSync } from 'node:fs'
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
// ════════════════════════════════════════════════════════════════════════════
import {
  computeUsageDecision, thresholdsFromEnv, readSnapshot, normTier, isValidWindow,
  flatten, snapshotUnusableReason, snapshotStaleOnly, DEFAULT_THRESHOLDS, WEEK_MS, WEEKLY_UNAVAILABLE_NOTE,
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
  assert.deepEqual(all, { staleMinutes: 30, lastKnownMaxMinutes: 120, fiveHourMaxPct: 85, fiveHourMaxPctRed: 60, weeklyPacePoints: 5, weeklyDeferPct: 95,
    fiveHourBoundaryPct: 95, weeklyBoundaryPct: 98 })   // run-observability: boundary ceilings keep their defaults; consolidation-acceptance: last-known max too
  assert.deepEqual(thresholdsFromEnv({}), { staleMinutes: 10, lastKnownMaxMinutes: 120, fiveHourMaxPct: 80, fiveHourMaxPctRed: 70, weeklyPacePoints: 15, weeklyDeferPct: 90,
    fiveHourBoundaryPct: 95, weeklyBoundaryPct: 98 })
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
  const r = runGate(['--json'], { snapshot: s, env: { WOLFPACK_AGENT_WINDOW_LIMIT: '1000000' } })
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
      { WOLFPACK_AGENT_WINDOW_LIMIT: '1000', WOLFPACK_WINDOW_HEADROOM_PCT: 'x' },
      { WOLFPACK_AGENT_WINDOW_LIMIT: '1000', WOLFPACK_WINDOW_HOURS: '0' },
      { WOLFPACK_WINDOW_HOURS: 'bogus' },                     // estimate disabled — still validated
    ]) assert.throws(() => estimateFromEnv(env, NOW, dir), /invalid/, JSON.stringify(env))
    // valid knobs still produce a finite decision
    const ok = estimateFromEnv({ WOLFPACK_AGENT_WINDOW_LIMIT: '1000', WOLFPACK_WINDOW_HEADROOM_PCT: '20' }, NOW, dir)
    assert.ok(ok && typeof ok === 'object')
    assert.equal(ok.gateEnabled, true, 'the estimate really is enabled (it walked the transcript dir)')
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
  const deg = runGate(['--json'], { env: { WOLFPACK_AGENT_WINDOW_LIMIT: '1000', WOLFPACK_WINDOW_HEADROOM_PCT: 'x' } })
  assert.equal(deg.code, 1)
  assert.equal(deg.stdout, '')
})

test('r2 F1 CLI: WOLFPACK_AGENT_WINDOW_LIMIT (or the legacy name) unset / 0 stays the documented estimate opt-out (proceed, loud), not an error', () => {
  for (const env of [{}, { WOLFPACK_AGENT_WINDOW_LIMIT: '0' }, { WOLFPACK_CLAUDE_WINDOW_LIMIT: '0' }]) {
    const r = runGate(['--json'], { env })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.json.degraded, true)
    assert.equal(r.json.gateEnabled, false, JSON.stringify(env))
    // scripts-unfork: the legacy name is live now, so setting it (even to 0) is warned
    assert.equal(/WOLFPACK_CLAUDE_WINDOW_LIMIT is deprecated/.test(r.stderr), 'WOLFPACK_CLAUDE_WINDOW_LIMIT' in env, JSON.stringify(env))
  }
})

test('r1 F2: the gate carries the WOLFPACK_GATE_PROTOCOL=1 marker in the exact form the runner preflight greps', () => {
  const src = readSrc(GATE, 'utf8')
  const hits = src.match(/WOLFPACK_GATE_PROTOCOL=[0-9]*/g) || []
  assert.ok(hits.length >= 1, 'marker missing — the runner would drop to the legacy-degraded gate')
  assert.equal(hits[0], 'WOLFPACK_GATE_PROTOCOL=1', 'the FIRST match is what `grep -o … | head -1` returns')
})

// ─── scripts-unfork (A5): the legacy WOLFPACK_CLAUDE_WINDOW_LIMIT alias + dual transcript layouts ───
import { windowLimitFromEnv, defaultTranscriptDir } from './wolfpack-window-gate.mjs'
import { homedir as osHome } from 'node:os'

test('windowLimitFromEnv: AGENT wins; legacy alone is honoured + warned; equal → used + warned; different → throws; neither → undefined', () => {
  const warns = []
  const w = (m) => warns.push(m)
  const DEP = 'WOLFPACK_CLAUDE_WINDOW_LIMIT is deprecated — rename it WOLFPACK_AGENT_WINDOW_LIMIT'
  assert.equal(windowLimitFromEnv({ WOLFPACK_AGENT_WINDOW_LIMIT: '500' }, w), '500')
  assert.deepEqual(warns, [], 'the current name never warns')
  assert.equal(windowLimitFromEnv({ WOLFPACK_CLAUDE_WINDOW_LIMIT: '700' }, w), '700')
  assert.deepEqual(warns, [DEP])
  warns.length = 0
  assert.equal(windowLimitFromEnv({ WOLFPACK_AGENT_WINDOW_LIMIT: '900', WOLFPACK_CLAUDE_WINDOW_LIMIT: ' 900 ' }, w), '900')
  assert.deepEqual(warns, [DEP], 'equal values: no throw, the warning still fires [review-2 F1]')
  warns.length = 0
  assert.throws(() => windowLimitFromEnv({ WOLFPACK_AGENT_WINDOW_LIMIT: '900', WOLFPACK_CLAUDE_WINDOW_LIMIT: '800' }, w),
    /conflicting window limits: WOLFPACK_AGENT_WINDOW_LIMIT=900 vs WOLFPACK_CLAUDE_WINDOW_LIMIT=800 — keep only WOLFPACK_AGENT_WINDOW_LIMIT/)
  assert.deepEqual(warns, [DEP])
  warns.length = 0
  for (const env of [{}, { WOLFPACK_AGENT_WINDOW_LIMIT: '' }, { WOLFPACK_CLAUDE_WINDOW_LIMIT: '   ' }, { WOLFPACK_AGENT_WINDOW_LIMIT: '  ', WOLFPACK_CLAUDE_WINDOW_LIMIT: '' }]) {
    assert.equal(windowLimitFromEnv(env, w), undefined, JSON.stringify(env))
  }
  assert.deepEqual(warns, [], 'a blank legacy value is "unset" — no warning')
})

test('estimateFromEnv: the legacy name ENABLES the estimate (it walks transcripts) and warns through the given warn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfalias-'))
  try {
    const warns = []
    const on = estimateFromEnv({ WOLFPACK_CLAUDE_WINDOW_LIMIT: '1000' }, NOW, dir, { warn: (m) => warns.push(m) })
    assert.equal(on.gateEnabled, true)
    assert.equal(warns.length, 1)
    const off = estimateFromEnv({}, NOW, dir, { warn: (m) => warns.push(m) })
    assert.equal(off.gateEnabled, false)
    assert.equal(warns.length, 1)
    assert.throws(() => estimateFromEnv({ WOLFPACK_CLAUDE_WINDOW_LIMIT: '1', WOLFPACK_AGENT_WINDOW_LIMIT: '2' }, NOW, dir, { warn: () => {} }), /conflicting window limits/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI alias: legacy only → estimate enabled + ONE deprecation line; both different → exit 1, no JSON; both equal → used, warned', () => {
  const legacy = runGate(['--json'], { env: { WOLFPACK_CLAUDE_WINDOW_LIMIT: '1000000' } })
  assert.equal(legacy.json.gateEnabled, true, legacy.stderr)
  assert.equal(legacy.stderr.split('\n').filter(l => /WOLFPACK_CLAUDE_WINDOW_LIMIT is deprecated/.test(l)).length, 1, legacy.stderr)
  assert.match(legacy.stderr, /^⚠ wolfpack-window-gate: WOLFPACK_CLAUDE_WINDOW_LIMIT is deprecated — rename it WOLFPACK_AGENT_WINDOW_LIMIT$/m)
  const cur = runGate(['--json'], { env: { WOLFPACK_AGENT_WINDOW_LIMIT: '1000000' } })
  assert.equal(cur.json.gateEnabled, true)
  assert.doesNotMatch(cur.stderr, /deprecated/)
  assert.equal(legacy.code, cur.code, 'the alias decides exactly like the current name')
  const conflict = runGate(['--json', '--tier', 'Yellow'], { snapshot: liveSnap({ fh: 10 }), env: { WOLFPACK_CLAUDE_WINDOW_LIMIT: '1', WOLFPACK_AGENT_WINDOW_LIMIT: '2' } })
  assert.equal(conflict.code, 1, conflict.stderr)
  assert.equal(conflict.stdout, '')
  assert.match(conflict.stderr, /wolfpack-window-gate: ERROR — conflicting window limits/)
  const same = runGate(['--json'], { env: { WOLFPACK_CLAUDE_WINDOW_LIMIT: '1000000', WOLFPACK_AGENT_WINDOW_LIMIT: '1000000' } })
  assert.notEqual(same.code, 1, same.stderr)
  assert.equal(same.json.gateEnabled, true)
  assert.match(same.stderr, /WOLFPACK_CLAUDE_WINDOW_LIMIT is deprecated/)
})

test('defaultTranscriptDir: env wins; else the first EXISTING of ~/.agents/projects, ~/.claude/projects; else ~/.agents/projects', () => {
  const h = osHome()
  const A = join(h, '.agents', 'projects'), C = join(h, '.claude', 'projects')
  assert.equal(defaultTranscriptDir({ WOLFPACK_TRANSCRIPT_DIR: '/t/x' }, () => true), '/t/x')
  assert.equal(defaultTranscriptDir({}, (d) => d === C), C, 'only the .claude layout exists')
  assert.equal(defaultTranscriptDir({}, (d) => d === A), A)
  assert.equal(defaultTranscriptDir({}, () => true), A, 'both exist → .agents first')
  assert.equal(defaultTranscriptDir({}, () => false), A, 'neither → the .agents default')
  assert.equal(defaultTranscriptDir({ WOLFPACK_TRANSCRIPT_DIR: '' }, (d) => d === C), C, 'an empty env value is unset')
})

test('defaultTranscriptDir (real fs, HOME overridden): a home with only .claude/projects resolves there', () => {
  const home = mkdtempSync(join(tmpdir(), 'wfhome-'))
  try {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e',
      `import(${JSON.stringify(GATE)}).then(m => process.stdout.write(m.defaultTranscriptDir({})))`],
      { encoding: 'utf8', env: { ...process.env, HOME: home, WOLFPACK_TRANSCRIPT_DIR: '' } })
    assert.equal(run().stdout, join(home, '.claude', 'projects'))
    mkdirSync(join(home, '.agents', 'projects'), { recursive: true })
    assert.equal(run().stdout, join(home, '.agents', 'projects'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ─── run-observability AC4/AC5: the BOUNDARY mode (between phases of a running hunt) ───
import { parseRecordNotes, recordLines, appendRecord } from './wolfpack-window-gate.mjs'
import { readFileSync as readFileSyncRO } from 'node:fs'
const bdecide = (snapshot, tier = 'Yellow', thresholds = DEFAULT_THRESHOLDS) =>
  computeUsageDecision({ snapshot, nowMs: NOW, tier, thresholds, mode: 'boundary' })

test('run-observability AC4: boundary 5h ceiling 95 — 94 proceeds / 95 defers, for every tier (Red too), never offloads', () => {
  for (const tier of ['Green', 'Blue', 'Yellow', 'Orange', 'Red', undefined]) {
    const ok = bdecide(snap({ fh: 94, sd: 10 }), tier)
    assert.equal(ok.decision, 'proceed', String(tier))
    assert.equal(ok.exit, PROCEED)
    assert.equal(ok.mode, 'boundary')
    assert.match(ok.reason, /^boundary: 5h 94% < 95%; week 10% < 98%/)
    const d = bdecide(snap({ fh: 95, sd: 10 }), tier)
    assert.equal(d.decision, 'defer', String(tier))
    assert.equal(d.exit, DEFER)
    assert.equal(d.mode, 'boundary')
    assert.equal(d.reset_at, new Date(NOW + 2 * HOUR).toISOString())
    assert.match(d.reason, /boundary: 5h 95% ≥ 95% — park before the next agent until the 5h window resets/)
    assert.equal(d.offload, false)
  }
  // the Red START ceiling (70) would have deferred at 75; the boundary does not.
  assert.equal(decide(snap({ fh: 75, sd: 10 }), 'Red').decision, 'defer')
  assert.equal(bdecide(snap({ fh: 75, sd: 10 }), 'Red').decision, 'proceed')
})

test('run-observability AC4: boundary weekly ceiling 98 — 97 proceeds / 98 defers with the 7d reset; weekly reason wins a tie', () => {
  assert.equal(bdecide(snap({ fh: 10, sd: 97 })).decision, 'proceed')
  const d = bdecide(snap({ fh: 10, sd: 98, sdDay: 3.5 }))
  assert.equal(d.decision, 'defer')
  assert.match(d.reason, /^boundary: 7d 98% ≥ 98% — park before the next agent/)
  assert.equal(d.reset_at, new Date(NOW + 3.5 * DAY).toISOString())
  const both = bdecide(snap({ fh: 99, sd: 99 }))
  assert.match(both.reason, /7d 99%/)
})

test('run-observability AC4: boundary mode NEVER offloads even far ahead of weekly pace; start mode still does', () => {
  const ahead = snap({ fh: 10, sd: 45, sdDay: 2 })
  assert.equal(decide(ahead).offload, true)
  const b = bdecide(ahead)
  assert.equal(b.decision, 'proceed')
  assert.equal(b.offload, false)
  assert.equal('offload_reason' in b, false)
})

test('run-observability AC4: start mode is unchanged at the same numbers (80 defers Yellow) and is labelled mode start', () => {
  const d = decide(snap({ fh: 80, sd: 10 }), 'Yellow')
  assert.equal(d.decision, 'defer')
  assert.equal(d.mode, 'start')
  assert.match(d.reason, /start ceiling/)
  assert.equal(bdecide(snap({ fh: 80, sd: 10 }), 'Yellow').decision, 'proceed')
})

test('run-observability AC4: boundary thresholds are env-overridable; invalid values THROW naming the variable', () => {
  const th = thresholdsFromEnv({ WOLFPACK_5H_BOUNDARY_MAX_PCT: '90', WOLFPACK_WEEKLY_BOUNDARY_PCT: '92' })
  assert.equal(th.fiveHourBoundaryPct, 90)
  assert.equal(th.weeklyBoundaryPct, 92)
  assert.equal(bdecide(snap({ fh: 90, sd: 10 }), 'Yellow', th).decision, 'defer')
  assert.equal(bdecide(snap({ fh: 10, sd: 92 }), 'Yellow', th).decision, 'defer')
  for (const [k, v] of [['WOLFPACK_5H_BOUNDARY_MAX_PCT', 'abc'], ['WOLFPACK_5H_BOUNDARY_MAX_PCT', '101'],
    ['WOLFPACK_WEEKLY_BOUNDARY_PCT', '-1'], ['WOLFPACK_WEEKLY_BOUNDARY_PCT', 'NaN']]) {
    assert.throws(() => thresholdsFromEnv({ [k]: v }), new RegExp(k), `${k}=${v}`)
  }
})

test('run-observability AC5: a degraded snapshot in boundary mode follows the estimate, labelled mode boundary + degraded', () => {
  const est = () => ({ decision: 'defer', exit: DEFER, reason: 'estimate: over headroom', reset_at: '2026-06-07T13:00:00.000Z', gateEnabled: true })
  const d = computeUsageDecision({ snapshot: null, nowMs: NOW, tier: 'Yellow', estimate: est, mode: 'boundary' })
  assert.equal(d.decision, 'defer')
  assert.equal(d.degraded, true)
  assert.equal(d.source, 'transcript_estimate')
  assert.equal(d.mode, 'boundary')
})

test('run-observability AC5: parseRecordNotes / recordLines / appendRecord — notes first, then the decision; never throws', () => {
  const warned = []
  assert.deepEqual(parseRecordNotes(null), [])
  assert.deepEqual(parseRecordNotes('{bad', (m) => warned.push(m)), [])
  assert.match(warned[0], /--record-note is not JSON/)
  assert.deepEqual(parseRecordNotes('{"a":1}'), [{ a: 1 }])
  assert.deepEqual(parseRecordNotes('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }])
  const lines = recordLines({ at: 'T', notes: [{ k: 1 }], decision: { mode: 'boundary', phase: 'Plan', decision: 'proceed', source: 'live', degraded: false, reason: 'r', five_hour_pct: 5, seven_day_pct: 6, reset_at: null } })
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0], { at: 'T', kind: 'pipeline_note', note: { k: 1 } })
  assert.equal(lines[1].phase, 'Plan')
  assert.equal(lines[1].degraded_reason, null)
  const dir = mkdtempSync(join(tmpdir(), 'wfrec-'))
  try {
    const f = join(dir, 'sub', 'usage-gate.jsonl')
    assert.equal(appendRecord(f, lines), null)
    assert.equal(appendRecord(f, lines.slice(1)), null)
    assert.equal(readFileSyncRO(f, 'utf8').trim().split('\n').length, 3)   // append-only
    assert.equal(appendRecord(null, lines), null)
    assert.equal(appendRecord(f, []), null)
    writeFileSync(join(dir, 'file'), 'x')
    assert.equal(typeof appendRecord(join(dir, 'file', 'x.jsonl'), lines), 'string')   // ENOTDIR → error text, no throw
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('run-observability AC4/AC5 CLI: --boundary --phase --record appends ONE decision line (two with --record-note); exit = the decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfbcli-'))
  try {
    const rec = join(dir, 'plan', 'usage-gate.jsonl')
    const ok = runGate(['--json', '--boundary', '--phase', 'Implement', '--record', rec], { snapshot: liveSnap({ fh: 90 }) })
    assert.equal(ok.code, 0, ok.stderr)
    assert.equal(ok.json.mode, 'boundary')
    assert.equal(ok.json.phase, 'Implement')
    let lines = readFileSyncRO(rec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].phase, 'Implement')
    assert.equal(lines[0].decision, 'proceed')
    assert.equal(lines[0].mode, 'boundary')
    const d = runGate(['--json', '--boundary', '--phase', 'Test', '--record', rec,
      '--record-note', JSON.stringify([{ at_phase: 'Plan', kind: 'gate_unavailable', why: 'null result' }])], { snapshot: liveSnap({ fh: 96 }) })
    assert.equal(d.code, 10)
    assert.equal(d.json.decision, 'defer')
    lines = readFileSyncRO(rec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(lines.length, 3)
    assert.equal(lines[1].kind, 'pipeline_note')
    assert.equal(lines[1].note.kind, 'gate_unavailable')
    assert.equal(lines[2].decision, 'defer')
    assert.equal(lines[2].phase, 'Test')
    // a garbage note is warned + ignored, the decision is still recorded
    const g = runGate(['--json', '--boundary', '--record', rec, '--record-note', 'not-json'], { snapshot: liveSnap({ fh: 10 }) })
    assert.equal(g.code, 0)
    assert.match(g.stderr, /--record-note is not JSON/)
    assert.equal(readFileSyncRO(rec, 'utf8').trim().split('\n').length, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('run-observability AC5 CLI: an unwritable --record path warns + sets record_error but keeps the decision exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfbad-'))
  try {
    writeFileSync(join(dir, 'f'), 'x')
    const bad = join(dir, 'f', 'usage-gate.jsonl')
    const d = runGate(['--json', '--boundary', '--record', bad], { snapshot: liveSnap({ fh: 97 }) })
    assert.equal(d.code, 10)
    assert.equal(d.json.decision, 'defer')
    assert.equal(typeof d.json.record_error, 'string')
    assert.match(d.stderr, /could not record/)
    const ok = runGate(['--json', '--boundary', '--record', bad], { snapshot: liveSnap({ fh: 10 }) })
    assert.equal(ok.code, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('run-observability AC5 CLI: an invalid boundary threshold in boundary mode → exit 1 with a decision:error JSON line, recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfberr-'))
  try {
    const rec = join(dir, 'usage-gate.jsonl')
    const r = runGate(['--json', '--boundary', '--phase', 'Plan', '--record', rec], { snapshot: liveSnap(), env: { WOLFPACK_5H_BOUNDARY_MAX_PCT: 'abc' } })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /WOLFPACK_5H_BOUNDARY_MAX_PCT/)
    assert.equal(r.json.decision, 'error')
    assert.equal(r.json.phase, 'Plan')
    const line = JSON.parse(readFileSyncRO(rec, 'utf8').trim())
    assert.equal(line.decision, 'error')
    // START mode keeps its stdout-silent exit 1
    const s = runGate(['--json'], { snapshot: liveSnap(), env: { WOLFPACK_5H_BOUNDARY_MAX_PCT: 'abc' } })
    assert.equal(s.code, 1)
    assert.equal(s.stdout, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ════════════════════════════════════════════════════════════════════════════
// consolidation-acceptance AC7/AC8 — the BOUNDARY gate decides on the last-known live figures when
// the snapshot is merely stale (nothing renders the status line during a long headless phase), instead
// of the spurious "window gate DISABLED"; the start gate and every broken-snapshot case stay as before.
// ════════════════════════════════════════════════════════════════════════════
const MIN = 60 * 1000
// The shape recorded in the wave-5 usage-gate.jsonl: a valid snapshot (5h 40%, 7d 60%) 12 min old.
const wave5 = (over = {}) => snap({ fh: 40, sd: 60, capturedAgoMs: 12 * MIN, ...over })

test('consolidation-acceptance AC7: boundary + valid snapshot 12 min old → last-known figures, degraded, never DISABLED', () => {
  const d = bdecide(wave5())
  assert.doesNotMatch(d.reason, /DISABLED/)
  assert.equal(d.decision, 'proceed')
  assert.equal(d.exit, PROCEED)
  assert.equal(d.five_hour_pct, 40)
  assert.equal(d.seven_day_pct, 60)
  assert.equal(d.source, 'last_known')
  assert.equal(d.degraded, true)
  assert.equal(d.gateEnabled, true)
  assert.equal(d.mode, 'boundary')
  assert.match(d.degraded_reason, /12 min old/)
  assert.match(d.degraded_reason, /deciding on the last-known live figures/)
  assert.match(d.reason, /^boundary \(last-known, 12 min old\): 5h 40% < 95%; week 60% < 98%/)
  assert.equal(d.captured_at, wave5().captured_at)
  assert.equal(d.offload, false)
  for (const k of ALWAYS_KEYS) assert.ok(k in d, k)
  noNaN(d)
  // an estimate that is NOT configured (the transcript fallback's DISABLED proceed) does not override it
  const disabledEst = () => computeDecision({ events: [], nowMs: NOW, limit: null, headroomPct: 15, windowMs: WIN, readOk: true })
  const d2 = computeUsageDecision({ snapshot: wave5(), nowMs: NOW, tier: 'Yellow', estimate: disabledEst, mode: 'boundary' })
  assert.equal(d2.source, 'last_known')
  assert.doesNotMatch(d2.reason, /DISABLED/)
  // a configured estimate that says proceed does not override it either
  const okEst = () => ({ decision: 'proceed', exit: PROCEED, reason: 'estimate: fine', reset_at: null, gateEnabled: true })
  assert.equal(computeUsageDecision({ snapshot: wave5(), nowMs: NOW, tier: 'Yellow', estimate: okEst, mode: 'boundary' }).source, 'last_known')
})

test('consolidation-acceptance AC7: the same stale snapshot in START mode is unchanged (transcript estimate, DISABLED when unconfigured)', () => {
  const d = decide(wave5())
  assert.equal(d.source, 'transcript_estimate')
  assert.equal(d.degraded, true)
  assert.equal(d.mode, 'start')
  assert.equal(d.five_hour_pct, null)
  assert.equal(d.seven_day_pct, null)
  assert.match(d.reason, /DISABLED/)
  assert.match(d.degraded_reason, /12 min old/)
})

test('consolidation-acceptance AC7: last-known figures still enforce the boundary ceilings (5h 96% / 7d 99% → defer)', () => {
  const d = bdecide(wave5({ fh: 96 }))
  assert.equal(d.decision, 'defer')
  assert.equal(d.exit, DEFER)
  assert.equal(d.source, 'last_known')
  assert.equal(d.degraded, true)
  assert.equal(d.five_hour_pct, 96)
  assert.match(d.reason, /^boundary \(last-known, 12 min old\): 5h 96% ≥ 95%/)
  assert.equal(d.reset_at, new Date(NOW + 2 * HOUR).toISOString())
  const w = bdecide(wave5({ fh: 10, sd: 99 }))
  assert.equal(w.decision, 'defer')
  assert.match(w.reason, /7d 99% ≥ 98%/)
  // a window whose resets_at passed since capture reads 0% (A-6 reset handling applies to last-known too)
  const reset = bdecide(snap({ fh: 99, fhResetInMs: -5 * MIN, sd: 10, capturedAgoMs: 30 * MIN }))
  assert.equal(reset.decision, 'proceed')
  assert.equal(reset.source, 'last_known')
  assert.equal(reset.five_hour_pct, 0)
  // no weekly window: still decides on the 5h figure, week n/a
  const noWeek = bdecide(snap({ fh: 20, seven_day: null, capturedAgoMs: 15 * MIN }))
  assert.equal(noWeek.source, 'last_known')
  assert.equal(noWeek.seven_day_pct, null)
  assert.match(noWeek.reason, /week n\/a/)
})

test('consolidation-acceptance AC7/AC8: beyond WOLFPACK_USAGE_LAST_KNOWN_MAX_MINUTES (default 120) the old loud path runs', () => {
  const old = bdecide(wave5({ capturedAgoMs: 200 * MIN }))
  assert.equal(old.source, 'transcript_estimate')
  assert.match(old.reason, /DISABLED/)
  assert.equal(old.five_hour_pct, null)
  // the edge: exactly at the max still decides; one minute past does not
  assert.equal(bdecide(wave5({ capturedAgoMs: 120 * MIN })).source, 'last_known')
  assert.equal(bdecide(wave5({ capturedAgoMs: 121 * MIN })).source, 'transcript_estimate')
  // the knob moves the line
  const th = thresholdsFromEnv({ WOLFPACK_USAGE_LAST_KNOWN_MAX_MINUTES: '30' })
  assert.equal(th.lastKnownMaxMinutes, 30)
  assert.equal(bdecide(wave5({ capturedAgoMs: 25 * MIN }), 'Yellow', th).source, 'last_known')
  assert.equal(bdecide(wave5({ capturedAgoMs: 35 * MIN }), 'Yellow', th).source, 'transcript_estimate')
  // a fresh snapshot is still plain live (not last_known)
  const fresh = bdecide(wave5({ capturedAgoMs: 1 * MIN }))
  assert.equal(fresh.source, 'live')
  assert.equal(fresh.degraded, false)
})

test('consolidation-acceptance AC8: missing / no-five_hour / future / bad captured_at in boundary mode keep today\'s degraded estimate path', () => {
  const cases = {
    missing: [null, 'snapshot missing (/x)'],
    staleNoFiveHour: [snap({ five_hour: null, capturedAgoMs: 12 * MIN }), null],
    staleBadFiveHour: [snap({ five_hour: { used_percentage: '40', resets_at: sec(NOW + HOUR) }, capturedAgoMs: 12 * MIN }), null],
    future: [snap({ capturedAgoMs: -5 * MIN }), null],
    badCapturedAt: [{ ...wave5(), captured_at: 'yesterday-ish' }, null],
    noCapturedAt: [{ rate_limits: wave5().rate_limits }, null],
    unparseable: [null, 'snapshot unparseable (/x: bad json)'],   // readSnapshot never returns a snapshot WITH an error
  }
  for (const [name, [s, err]] of Object.entries(cases)) {
    const d = computeUsageDecision({ snapshot: s, snapshotError: err, nowMs: NOW, tier: 'Yellow', thresholds: DEFAULT_THRESHOLDS, mode: 'boundary' })
    assert.equal(d.source, 'transcript_estimate', name)
    assert.equal(d.degraded, true, name)
    assert.equal(d.mode, 'boundary', name)
    assert.equal(d.five_hour_pct, null, name)
    assert.match(d.reason, /DISABLED/, `${name}: unconfigured estimate stays loud`)
  }
})

test('consolidation-acceptance AC8: boundary + stale + a CONFIGURED estimate that says defer → the defer wins (fail closed)', () => {
  // configured but unreadable transcripts → computeDecision defers (readOk:false)
  const unreadable = () => computeDecision({ events: [], nowMs: NOW, limit: 1_000_000, headroomPct: 15, windowMs: WIN, readOk: false })
  const d = computeUsageDecision({ snapshot: wave5(), nowMs: NOW, tier: 'Yellow', thresholds: DEFAULT_THRESHOLDS, estimate: unreadable, mode: 'boundary' })
  assert.equal(d.decision, 'defer')
  assert.equal(d.exit, DEFER)
  assert.equal(d.source, 'transcript_estimate')
  assert.equal(d.degraded, true)
  assert.equal(d.mode, 'boundary')
  assert.match(d.degraded_reason, /12 min old/)
  // a configured estimate over headroom also wins over a low last-known reading
  const over = () => ({ decision: 'defer', exit: DEFER, reason: 'estimate: over headroom', reset_at: '2026-06-07T13:00:00.000Z', gateEnabled: true })
  const d2 = computeUsageDecision({ snapshot: wave5({ fh: 5 }), nowMs: NOW, tier: 'Yellow', estimate: over, mode: 'boundary' })
  assert.equal(d2.decision, 'defer')
  assert.equal(d2.reason, 'estimate: over headroom')
})

test('consolidation-acceptance: snapshotStaleOnly is true only for stale-but-valid snapshots within the last-known max', () => {
  const th = DEFAULT_THRESHOLDS
  assert.equal(snapshotStaleOnly(wave5(), NOW, th), true)
  assert.equal(snapshotStaleOnly(wave5({ capturedAgoMs: 5 * MIN }), NOW, th), false, 'fresh is not stale')
  assert.equal(snapshotStaleOnly(wave5({ capturedAgoMs: 10 * MIN }), NOW, th), false, 'exactly at staleMinutes is not stale')
  assert.equal(snapshotStaleOnly(wave5({ capturedAgoMs: 200 * MIN }), NOW, th), false, 'too old')
  assert.equal(snapshotStaleOnly(snap({ five_hour: null, capturedAgoMs: 12 * MIN }), NOW, th), false)
  assert.equal(snapshotStaleOnly(snap({ capturedAgoMs: -5 * MIN }), NOW, th), false, 'future')
  for (const bad of [null, undefined, 'x', 42, {}, { captured_at: 5 }, { ...wave5(), captured_at: 'nope' }]) {
    assert.equal(snapshotStaleOnly(bad, NOW, th), false, JSON.stringify(bad))
  }
})

test('consolidation-acceptance: WOLFPACK_USAGE_LAST_KNOWN_MAX_MINUTES invalid values THROW naming the variable', () => {
  for (const v of ['abc', '0', '-5', 'NaN', 'Infinity']) {
    assert.throws(() => thresholdsFromEnv({ WOLFPACK_USAGE_LAST_KNOWN_MAX_MINUTES: v }), /WOLFPACK_USAGE_LAST_KNOWN_MAX_MINUTES/, v)
  }
  // a CLI with the bad knob is a hard error (exit 1), never a silent default
  const r = runGate(['--json', '--boundary'], { snapshot: liveSnap(), env: { WOLFPACK_USAGE_LAST_KNOWN_MAX_MINUTES: 'abc' } })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /WOLFPACK_USAGE_LAST_KNOWN_MAX_MINUTES/)
})

test('consolidation-acceptance AC7 CLI: --boundary --record on a 12-min-old snapshot records a last_known line with real figures + a DEGRADED stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wflk-'))
  try {
    const rec = join(dir, 'usage-gate.jsonl')
    const s = liveSnap({ fh: 40, sd: 60 })
    s.captured_at = new Date(Date.now() - 12 * MIN).toISOString()
    const r = runGate(['--json', '--boundary', '--phase', 'Certify', '--record', rec], { snapshot: s })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.json.source, 'last_known')
    assert.equal(r.json.degraded, true)
    assert.equal(r.json.five_hour_pct, 40)
    assert.equal(r.json.seven_day_pct, 60)
    assert.doesNotMatch(r.json.reason, /DISABLED/)
    assert.match(r.stderr, /DEGRADED — .*min old.*; boundary decided on last-known live figures \(5h 40%, 7d 60%\)/)
    assert.doesNotMatch(r.stderr, /falling back to the transcript estimate/)
    const line = JSON.parse(readFileSyncRO(rec, 'utf8').trim())
    assert.equal(line.phase, 'Certify')
    assert.equal(line.source, 'last_known')
    assert.equal(line.degraded, true)
    assert.equal(line.five_hour_pct, 40)
    assert.equal(line.seven_day_pct, 60)
    assert.doesNotMatch(line.reason, /DISABLED/)
    // the start gate on the same snapshot keeps the old degraded warning
    const st = runGate(['--json'], { snapshot: s })
    assert.equal(st.json.source, 'transcript_estimate')
    assert.match(st.stderr, /falling back to the transcript estimate/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
