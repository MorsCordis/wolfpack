#!/usr/bin/env node
// scripts/wolfpack-window-gate.mjs — [05] limits layer, Part A (A2/A3).
//
// HOST-SIDE agent rate-limit gate. The precise account rate-limit (the rolling
// 5-hour window / weekly Max caps) is NOT reachable inside a Workflow agent — but the
// host DRIVER can estimate it the way ccusage / claude-hud do: token accounting from
// the local transcript JSONL against a known plan limit. So the gate lives here and is
// checked BETWEEN hunts (never mid-pipeline — halting mid-Shepherd leaves a half-built
// worktree; the wave structure gives clean boundaries).
//
// It answers ONE question and emits a decision the loop wrapper (wolfpack-overnight.sh)
// acts on:
//   proceed → launch the next hunt.
//   defer   → too little window left; do NOT launch. The decision carries `reset_at`
//             (when the oldest in-window usage ages out and capacity returns) so the
//             wrapper can sleep until then / ScheduleWakeup past it (A3 self-resume).
//
// WHY HOST-SIDE (AC5): the workflow .js cannot read the clock (Date.now()/new Date()
// throw — they'd break resume). This is a plain node script where Date is allowed —
// the "host driver owns A2/A3" home the design (05 § Threading) calls for.
//
// FAIL-LOUD / CONSERVATIVE (wolfpack-config.md + 05 § A4): transcript accounting LAGS and is
// approximate (shared-pool effects). So the gate leaves headroom and pauses EARLY — a
// false "pause too soon" costs a few idle minutes; a false "plenty left" strands a
// half-built compliance hunt at the wall. Two distinct uncertainty cases, handled
// differently and ON PURPOSE:
//   * NOT CONFIGURED (no WOLFPACK_AGENT_WINDOW_LIMIT) → the gate has no basis to judge,
//     so it PROCEEDS but says so LOUDLY (visible degraded mode, not a buried log). The
//     operator opts in by setting the limit; an unconfigured gate must not silently
//     block every overnight run.
//   * CONFIGURED BUT UNREADABLE (limit set, transcripts missing/unparseable) → now we
//     are in the "uncertain reading" case the fail-closed rule targets → DEFER.
//
// Usage:
//   node scripts/wolfpack-window-gate.mjs [--transcripts <dir>] [--json]
// Env:
//   WOLFPACK_AGENT_WINDOW_LIMIT    total tokens in the 5h window for your plan (ENABLES
//                                  the gate; unset ⇒ gate disabled / proceed-with-warning)
//   WOLFPACK_WINDOW_HEADROOM_PCT   % of the limit to keep in reserve (default 15)
//   WOLFPACK_WINDOW_HOURS          window length in hours (default 5)
//   WOLFPACK_TRANSCRIPT_DIR        transcript root. Default is the agent harness's local
//                                  transcript dir; TODO(de-fracture): the default path
//                                  (~/.agents/projects) is harness-specific — set this env
//                                  var to your harness's transcript location (see wolfpack-config.md).
// Exit codes: 0 = proceed, 10 = defer, 1 = internal error.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const PROCEED = 0
export const DEFER = 10
export const ERROR = 1

// Sum every token bucket the rate-limit counts — input + output + both cache buckets.
// Counting the MOST is the conservative choice (over-count → pause earlier).
export function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0
  return (usage.input_tokens || 0) +
         (usage.output_tokens || 0) +
         (usage.cache_creation_input_tokens || 0) +
         (usage.cache_read_input_tokens || 0)
}

// Parse one transcript JSONL file body → [{ ts: epoch_ms, tokens }]. Tolerant: skips
// blank / unparseable lines and lines without usage (the file mixes user turns, tool
// results, etc.). A malformed line is NOT fatal — telemetry, parsed best-effort.
export function parseTranscript(text) {
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let obj
    try { obj = JSON.parse(s) } catch { continue }
    const usage = obj?.message?.usage
    if (!usage) continue
    const tokens = usageTokens(usage)
    if (tokens <= 0) continue
    const tsRaw = obj.timestamp || obj.ts || obj?.message?.timestamp
    const ts = tsRaw ? Date.parse(tsRaw) : NaN
    if (Number.isNaN(ts)) continue
    out.push({ ts, tokens })
  }
  return out
}

// THE PURE DECISION CORE (unit-tested). Given the usage events, the clock, and the
// config, decide proceed vs defer. No fs, no env, no Date — everything is an argument,
// so it is deterministic and testable.
//   events     : [{ ts: epoch_ms, tokens }]
//   nowMs      : current time (epoch ms)
//   limit      : window token limit (null/0/NaN ⇒ gate disabled)
//   headroomPct: reserve %, 0..100
//   windowMs   : rolling window length in ms
//   readOk     : did we actually read transcript state? false ⇒ fail-closed defer
export function computeDecision({ events, nowMs, limit, headroomPct, windowMs, readOk }) {
  // Gate disabled: no configured limit → proceed, but LOUDLY (visible degraded mode).
  if (!limit || !Number.isFinite(limit) || limit <= 0) {
    return {
      decision: 'proceed', exit: PROCEED, gateEnabled: false,
      reason: 'window gate DISABLED — set WOLFPACK_AGENT_WINDOW_LIMIT to enable rate-limit gating',
      used: null, remaining: null, reset_at: null,
    }
  }
  // Configured but we could not read usage state → fail closed (defer). An unreadable
  // transcript with the gate ON is exactly the "uncertain → treat conservatively" case.
  if (!readOk) {
    return {
      decision: 'defer', exit: DEFER, gateEnabled: true,
      reason: 'window gate ENABLED but transcript usage could not be read — failing closed (defer)',
      used: null, remaining: null,
      reset_at: new Date(nowMs + windowMs).toISOString(),
    }
  }

  const headroom = Math.max(0, Math.round(limit * (headroomPct / 100)))
  const windowStart = nowMs - windowMs
  const inWindow = events.filter(e => e.ts >= windowStart)
  const used = inWindow.reduce((s, e) => s + e.tokens, 0)
  const remaining = limit - used

  // reset_at: when the OLDEST in-window usage ages out, that capacity returns. A
  // conservative, honest resume point for a rolling window (if still over after that,
  // the next gate call simply defers again — idempotent). With nothing in-window,
  // capacity is already full → reset is now.
  const resetMs = inWindow.length
    ? Math.min(...inWindow.map(e => e.ts)) + windowMs
    : nowMs   // nothing in-window ⇒ capacity already full ⇒ no wait
  const reset_at = new Date(resetMs).toISOString()

  if (remaining < headroom) {
    return {
      decision: 'defer', exit: DEFER, gateEnabled: true,
      reason: `est. remaining ${remaining} < headroom ${headroom} (used ${used}/${limit} in window) — defer until window frees`,
      used, remaining, headroom, limit, reset_at,
    }
  }
  return {
    decision: 'proceed', exit: PROCEED, gateEnabled: true,
    reason: `est. remaining ${remaining} ≥ headroom ${headroom} (used ${used}/${limit} in window)`,
    used, remaining, headroom, limit, reset_at,
  }
}

// ─── Host I/O (not unit-tested; thin) ──────────────────────────
export function collectEvents(rootDir, windowStartMs) {
  // Returns { events, readOk }. readOk=false (⇒ fail-closed defer when the gate is
  // enabled) when the root is missing, no JSONL files exist, OR files exist but NOT ONE
  // could be read/parsed (a permissions/locking failure that would otherwise fail OPEN
  // by reporting 0 tokens used). An empty in-window result when files DID read is a
  // legitimate "fresh window" (readOk=true).
  if (!existsSync(rootDir)) return { events: [], readOk: false }
  const files = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(rootDir)
  if (files.length === 0) return { events: [], readOk: false }
  const events = []
  let readCount = 0
  for (const f of files) {
    // Perf: a file not modified since the window started can hold no in-window event
    // (mtime = last append). Skip its read entirely — without this the gate parses the
    // operator's entire transcript history between every hunt. A skip is NOT a read
    // failure; it counts toward readCount so an all-skipped/all-old tree still reads OK.
    try {
      if (windowStartMs && statSync(f).mtimeMs < windowStartMs) { readCount++; continue }
    } catch { /* statSync failed — fall through and try to read it */ }
    try {
      events.push(...parseTranscript(readFileSync(f, 'utf8')))
      readCount++
    } catch { /* unreadable/unparseable — does NOT count as a successful read */ }
  }
  // Files existed but none were readable (all threw) → fail closed.
  if (readCount === 0) return { events: [], readOk: false }
  return { events, readOk: true }
}

function main() {
  const argv = process.argv.slice(2)
  const jsonOnly = argv.includes('--json')
  const tIdx = argv.indexOf('--transcripts')
  const rootDir = tIdx >= 0 && argv[tIdx + 1]
    ? argv[tIdx + 1]
    // TODO(de-fracture): the default transcript dir (~/.agents/projects) is harness-specific —
    // override with WOLFPACK_TRANSCRIPT_DIR or parameterize via wolfpack-config.md.
    : (process.env.WOLFPACK_TRANSCRIPT_DIR || join(homedir(), '.agents', 'projects'))

  const limit = Number(process.env.WOLFPACK_AGENT_WINDOW_LIMIT)
  const headroomPct = process.env.WOLFPACK_WINDOW_HEADROOM_PCT != null
    ? Number(process.env.WOLFPACK_WINDOW_HEADROOM_PCT) : 15
  const windowHours = process.env.WOLFPACK_WINDOW_HOURS != null
    ? Number(process.env.WOLFPACK_WINDOW_HOURS) : 5
  const windowMs = windowHours * 60 * 60 * 1000

  // Only read transcripts when the gate is enabled (limit set) — no point walking the
  // tree to print a "disabled" notice.
  const nowMs = Date.now()
  let events = [], readOk = false
  if (limit && Number.isFinite(limit) && limit > 0) {
    ({ events, readOk } = collectEvents(rootDir, nowMs - windowMs))
  }

  const decision = computeDecision({
    events, nowMs, limit, headroomPct, windowMs, readOk,
  })

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(decision) + '\n')
  } else {
    process.stdout.write(JSON.stringify(decision, null, 2) + '\n')
    process.stderr.write(`wolfpack-window-gate: ${decision.decision.toUpperCase()} — ${decision.reason}\n`)
    if (decision.decision === 'defer' && decision.reset_at) {
      process.stderr.write(`wolfpack-window-gate: resume after ${decision.reset_at}\n`)
    }
  }
  process.exit(decision.exit)
}

// Run main() only when executed directly (not when imported by the test).
const invokedDirectly = process.argv[1] && (
  process.argv[1].endsWith('wolfpack-window-gate.mjs') ||
  process.argv[1].endsWith('wolfpack-window-gate')
)
if (invokedDirectly) main()
