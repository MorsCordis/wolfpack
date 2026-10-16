#!/usr/bin/env node
// scripts/wolfpack-usage.mjs — usage-limit-gate AC7/AC8/AC9: the usage meter.
//
// Reads the same live snapshot the window gate decides on (no duplicate parsing — every
// reader/validator is imported from ./wolfpack-window-gate.mjs) and:
//
//   wolfpack-usage                 one line for humans:
//                                  Claude 5h 42% (resets 14:05) · week 61% (pace +8) · live
//                                  percentages use claude-hud's rounding, so they match the
//                                  status line (AC12); degraded ⇒ "… · DEGRADED (<why>)".
//   wolfpack-usage --json          {five_hour_pct, seven_day_pct, weekly_pace, source,
//                                   captured_at, degraded, five_hour_resets_at, seven_day_resets_at}
//   wolfpack-usage stamp --heartbeat <file> [--plan-dir <dir>]
//                                  (A-4) write `usage` into the phase heartbeat (AC8); with
//                                  --plan-dir also maintain metadata.usage_delta (AC7: start
//                                  once, end on every stamp) and fold <plan-dir>/rate-limits.jsonl
//                                  into metadata.mistral_rate_limits (AC9).
//   wolfpack-usage record-offload --plan-dir <dir> --reason <text>
//                                  set metadata.usage_offload = {reason, at} once (first sticks).
//
// Disclosure, not failure: a missing/stale snapshot never makes `stamp` exit non-zero — it
// records `source` + `degraded`. A metadata.json that exists but cannot be parsed is NEVER
// overwritten (exit 1): we do not clobber a file we cannot read.
// Env: WOLFPACK_USAGE_SNAPSHOT (+ every gate threshold env), TZ for the one-liner clock.

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  readSnapshot, computeUsageDecision, thresholdsFromEnv, snapshotPathFromEnv,
  estimateFromEnv, estimateConfigFromEnv,
} from './wolfpack-window-gate.mjs'

// claude-hud's rounding (dist/stdin.js) — the one-liner must agree with the status line.
export const hudPct = (v) => Math.min(100, Math.max(0, Math.round(v)))
const signed = (v) => (v > 0 ? `+${v}` : `${v}`)

// Current usage reading (a gate decision, figures only — tier is irrelevant here).
export function currentUsage({ env = process.env, nowMs = Date.now(), fsImpl, thresholds } = {}) {
  const th = thresholds || thresholdsFromEnv(env)
  // Hard-error on malformed degraded-fallback knobs on EVERY reading, not only when the
  // estimate is actually consulted (same rule as the gate CLI).
  estimateConfigFromEnv(env)
  const snap = readSnapshot(snapshotPathFromEnv(env), fsImpl)
  return computeUsageDecision({
    snapshot: snap.ok ? snap.snapshot : null, snapshotError: snap.error,
    nowMs, tier: 'Red', thresholds: th,
    estimate: () => estimateFromEnv(env, nowMs),
  })
}

function fmtClock(epochSec, nowMs, tz) {
  const d = new Date(epochSec * 1000)
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false }
  if (tz) opts.timeZone = tz
  const hm = new Intl.DateTimeFormat('en-GB', opts).format(d)
  if (d.getTime() - nowMs > 24 * 60 * 60 * 1000) {
    const wopts = { weekday: 'short' }
    if (tz) wopts.timeZone = tz
    return `${new Intl.DateTimeFormat('en-US', wopts).format(d)} ${hm}`
  }
  return hm
}

// Pure: decision → the one-liner.
export function formatOneLiner(d, nowMs, tz) {
  if (d.degraded) {
    let five
    if (!d.gateEnabled) five = '5h ? (no estimate configured)'
    else if (typeof d.used === 'number' && typeof d.limit === 'number' && d.limit > 0) {
      five = `5h ~${hudPct((d.used / d.limit) * 100)}% est.`
    } else five = '5h ? (estimate unreadable)'
    return `Claude ${five} · week n/a · DEGRADED (${d.degraded_reason})`
  }
  const fh = d.five_hour
  const five = fh.reset_since_capture
    ? '5h 0% (reset since capture)'
    : `5h ${hudPct(fh.used_pct)}% (resets ${fmtClock(fh.resets_at, nowMs, tz)})`
  let week = 'week n/a'
  const sd = d.seven_day
  if (sd) {
    week = sd.reset_since_capture
      ? '7d 0% (reset since capture)'
      : `week ${hudPct(sd.used_pct)}% (pace ${signed(sd.pace)}, resets ${fmtClock(sd.resets_at, nowMs, tz)})`
  }
  return `Claude ${five} · ${week} · live`
}

export function jsonView(d) {
  return {
    five_hour_pct: d.five_hour_pct, seven_day_pct: d.seven_day_pct, weekly_pace: d.weekly_pace,
    source: d.source, captured_at: d.captured_at ?? null, degraded: d.degraded,
    five_hour_resets_at: d.five_hour ? d.five_hour.resets_at : null,
    seven_day_resets_at: d.seven_day ? d.seven_day.resets_at : null,
  }
}

// ─── atomic JSON I/O ────────────────────────────────────────────
function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw e
  }
}
// {ok:true, obj} (missing ⇒ obj = {} when allowMissing) | {ok:false, error}
function readJson(path, { allowMissing }) {
  if (!existsSync(path)) {
    return allowMissing ? { ok: true, obj: {}, missing: true } : { ok: false, error: `${path} does not exist` }
  }
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'))
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: `${path} is not a JSON object` }
    return { ok: true, obj }
  } catch (e) {
    return { ok: false, error: `${path} is unparseable (${e.message})` }
  }
}

// Pure: one usage reading for metadata.usage_delta.
export function reading(d, atIso) {
  const v = jsonView(d)
  return {
    at: atIso, five_hour_pct: v.five_hour_pct, seven_day_pct: v.seven_day_pct,
    five_hour_resets_at: v.five_hour_resets_at, seven_day_resets_at: v.seven_day_resets_at,
    source: v.source, degraded: v.degraded,
  }
}

// Pure: (previous usage_delta | undefined, new reading) → new usage_delta. `start` is set
// only once; `end` always. A window whose start-time resets_at has been reached by `end.at`
// was CROSSED: its delta is null (never a negative number).
export function updateUsageDelta(prev, r) {
  const ud = { ...(prev && typeof prev === 'object' ? prev : {}) }
  if (!ud.start) ud.start = r
  ud.end = r
  const endSec = Date.parse(ud.end.at) / 1000
  const windows_reset = []
  for (const w of ['five_hour', 'seven_day']) {
    const s = ud.start[`${w}_pct`], e = ud.end[`${w}_pct`]
    const startReset = ud.start[`${w}_resets_at`]
    const crossed = typeof startReset === 'number' && Number.isFinite(endSec) && endSec >= startReset
    if (crossed) windows_reset.push(w)
    ud[`${w}_delta`] = (!crossed && typeof s === 'number' && typeof e === 'number')
      ? Math.round((e - s) * 10) / 10 : null
  }
  ud.windows_reset = windows_reset
  ud.window_reset_during_hunt = windows_reset.length > 0
  return ud
}

// Pure: rate-limits.jsonl text → mistral_rate_limits (AC9). GLM and Mistral Large share
// one API key, so shared_key_429_total sums both families' 429s.
export function aggregateRateLimits(text) {
  const out = { shared_key_429_total: 0, last_at: null, unparsed_lines: 0 }
  const KINDS = ['429', 'transient', 'breaker_open']
  let last = null
  for (const line of String(text || '').split('\n')) {
    const s = line.trim()
    if (!s) continue
    let ev
    try { ev = JSON.parse(s) } catch { out.unparsed_lines++; continue }
    if (!ev || typeof ev.family !== 'string' || !ev.family || !KINDS.includes(String(ev.kind))) {
      out.unparsed_lines++
      continue
    }
    const fam = ev.family
    if (!out[fam]) out[fam] = { '429': 0, transient: 0, breaker_open: 0 }
    out[fam][String(ev.kind)]++
    if (String(ev.kind) === '429') out.shared_key_429_total++
    if (typeof ev.ts === 'number' && Number.isFinite(ev.ts) && (last == null || ev.ts > last)) last = ev.ts
  }
  for (const fam of ['glm', 'mistral']) if (!out[fam]) out[fam] = { '429': 0, transient: 0, breaker_open: 0 }
  out.last_at = last == null ? null : new Date(last * 1000).toISOString()
  return out
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : null
}

export function stamp({ heartbeat, planDir, env = process.env, nowMs = Date.now() }) {
  const d = currentUsage({ env, nowMs })
  const atIso = new Date(nowMs).toISOString()
  // (1) heartbeat.usage (AC8) — preserve every other field.
  const hb = readJson(heartbeat, { allowMissing: true })
  if (!hb.ok) throw new Error(`heartbeat ${hb.error} — not overwriting it`)
  hb.obj.usage = {
    five_hour_pct: d.five_hour_pct, seven_day_pct: d.seven_day_pct, weekly_pace: d.weekly_pace,
    source: d.source, captured_at: d.captured_at ?? null,
  }
  writeJsonAtomic(heartbeat, hb.obj)
  if (!planDir) return { heartbeat: hb.obj }
  // (2) metadata.usage_delta (AC7) + (3) mistral_rate_limits (AC9).
  const metaPath = join(planDir, 'metadata.json')
  const meta = readJson(metaPath, { allowMissing: false })
  if (!meta.ok) throw new Error(`metadata ${meta.error} — not overwriting it`)
  meta.obj.usage_delta = updateUsageDelta(meta.obj.usage_delta, reading(d, atIso))
  const rlPath = join(planDir, 'rate-limits.jsonl')
  if (existsSync(rlPath)) meta.obj.mistral_rate_limits = aggregateRateLimits(readFileSync(rlPath, 'utf8'))
  writeJsonAtomic(metaPath, meta.obj)
  return { heartbeat: hb.obj, metadata: meta.obj }
}

export function recordOffload({ planDir, reason, nowMs = Date.now() }) {
  const metaPath = join(planDir, 'metadata.json')
  const meta = readJson(metaPath, { allowMissing: false })
  if (!meta.ok) throw new Error(`metadata ${meta.error} — not overwriting it`)
  if (!meta.obj.usage_offload) {
    meta.obj.usage_offload = { reason: String(reason || ''), at: new Date(nowMs).toISOString() }
    writeJsonAtomic(metaPath, meta.obj)
  }
  return meta.obj.usage_offload
}

function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : null
  try {
    if (cmd === 'stamp') {
      const heartbeat = argValue(argv, '--heartbeat')
      if (!heartbeat) throw new Error('stamp needs --heartbeat <file>')
      const r = stamp({ heartbeat, planDir: argValue(argv, '--plan-dir') })
      const u = r.heartbeat.usage
      process.stdout.write(`usage stamped: 5h ${u.five_hour_pct ?? '?'}% · 7d ${u.seven_day_pct ?? '?'}% · ${u.source}\n`)
      return 0
    }
    if (cmd === 'record-offload') {
      const planDir = argValue(argv, '--plan-dir')
      if (!planDir) throw new Error('record-offload needs --plan-dir <dir>')
      process.stdout.write(JSON.stringify(recordOffload({ planDir, reason: argValue(argv, '--reason') })) + '\n')
      return 0
    }
    if (cmd) throw new Error(`unknown command "${cmd}" (expected stamp | record-offload)`)
    const nowMs = Date.now()
    const d = currentUsage({ nowMs })
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(jsonView(d)) + '\n')
    else process.stdout.write(formatOneLiner(d, nowMs, process.env.TZ || undefined) + '\n')
    return 0
  } catch (e) {
    process.stderr.write(`wolfpack-usage: ERROR — ${e.message}\n`)
    return 1
  }
}

const invokedDirectly = process.argv[1] && (
  process.argv[1].endsWith('wolfpack-usage.mjs') ||
  process.argv[1].endsWith('wolfpack-usage')
)
if (invokedDirectly) process.exit(main())
