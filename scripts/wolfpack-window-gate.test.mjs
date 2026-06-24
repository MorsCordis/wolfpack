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
