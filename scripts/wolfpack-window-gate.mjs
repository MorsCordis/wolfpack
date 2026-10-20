#!/usr/bin/env node
// scripts/wolfpack-window-gate.mjs — [05] limits layer, Part A (A2/A3) + usage-limit-gate.
//
// PRIMARY SOURCE — the LIVE usage snapshot (usage-limit-gate, AC2/AC4). Claude Code pipes
// the real account figures to the status line on every render (`rate_limits.five_hour` /
// `rate_limits.seven_day`: `used_percentage` + `resets_at` epoch seconds). The status-line
// wrapper (scripts/wolfpack-statusline.mjs) snapshots ONLY those to
// ~/.cache/wolfpack/claude-usage.json (WOLFPACK_USAGE_SNAPSHOT). When that snapshot is
// fresh (< WOLFPACK_USAGE_STALE_MINUTES, default 10) the gate decides on it:
//   * weekly 7d ≥ WOLFPACK_WEEKLY_DEFER_PCT (90)        → defer ALL new hunts
//   * 5h ≥ WOLFPACK_5H_START_MAX_PCT (80; Red/unknown tier: WOLFPACK_5H_START_MAX_PCT_RED 70)
//                                                       → defer (do not START the hunt)
//   * otherwise proceed; weekly pace (7d used − elapsed share of the week) above
//     WOLFPACK_WEEKLY_PACE_POINTS (15) ⇒ `offload:true` (the runner moves the Shepherd to GLM).
// DEGRADED FALLBACK — the transcript ESTIMATE below (the original [05] gate) runs only when
// the snapshot is missing / unparseable / stale / lacks a valid five_hour window. Its
// output is labelled `source:"transcript_estimate", degraded:true` and a stderr warning is
// written in EVERY mode (--json included) — a degraded reading is never silent (AC3).
// A-7: a window is valid only with a finite used_percentage AND a finite resets_at > 0.
// A-6: a fresh snapshot whose window resets_at is already past ⇒ that window is treated as
//      0% and labelled `reset_since_capture:true` (each window independently).
//
// Output contract (--json, both paths): always-present top-level keys
//   decision, exit, reason, reset_at, source, degraded, gateEnabled, offload,
//   five_hour_pct, seven_day_pct, weekly_pace   (flat mirrors; null when unavailable)
// `offload_reason` only when offload. Nested objects never reuse the names decision /
// reason / reset_at (wolfpack-overnight.sh scrapes those with sed).
//
// ─── Degraded fallback: the transcript estimate (original [05] gate) ───
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
//   node scripts/wolfpack-window-gate.mjs [--json] [--tier <T>] [--snapshot <path>] [--transcripts <dir>]
//   --tier is case-insensitive; missing/unknown ⇒ Red (the conservative 70% ceiling).
// Env (live snapshot — identical names in every fork; a non-numeric / out-of-range value
// is a HARD error, exit 1 — never a silent default):
//   WOLFPACK_USAGE_SNAPSHOT        snapshot path (default ~/.cache/wolfpack/claude-usage.json)
//   WOLFPACK_USAGE_STALE_MINUTES   snapshot older than this ⇒ degraded fallback (default 10)
//   WOLFPACK_5H_START_MAX_PCT      5h start ceiling, non-Red tiers (default 80)
//   WOLFPACK_5H_START_MAX_PCT_RED  5h start ceiling, Red / unknown tier (default 70)
//   WOLFPACK_WEEKLY_PACE_POINTS    weekly pace above this ⇒ offload (default 15)
//   WOLFPACK_WEEKLY_DEFER_PCT      7d at/above this ⇒ defer all new hunts (default 90)
// Env (degraded fallback only):
//   WOLFPACK_AGENT_WINDOW_LIMIT    total tokens in the 5h window for your plan (ENABLES
//                                  the estimate; unset ⇒ estimate disabled / proceed-with-warning)
//   WOLFPACK_CLAUDE_WINDOW_LIMIT   DEPRECATED legacy name of the same limit — still honoured
//                                  (stderr deprecation warning whenever it is set); both names
//                                  set to DIFFERENT values is a hard error (exit 1).
//   WOLFPACK_WINDOW_HEADROOM_PCT   % of the limit to keep in reserve (default 15)
//   WOLFPACK_WINDOW_HOURS          window length in hours (default 5)
//   WOLFPACK_TRANSCRIPT_DIR        transcript root. Default: the first existing of the two
//                                  harness layouts ~/.agents/projects, ~/.claude/projects
//                                  (else ~/.agents/projects).
// Exit codes: 0 = proceed, 10 = defer, 1 = internal error.
//
// Gate protocol 1 = the usage-limit-gate output contract above (source / degraded / offload /
// flat usage mirrors, --tier). campaign-runner.js greps this marker in its preflight: a gate
// script WITHOUT it is the pre-usage-limit-gate transcript-only gate, which the runner drives
// in a loud, labelled legacy-degraded mode instead of aborting every hunt claim.
// WOLFPACK_GATE_PROTOCOL=1

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

// ─── Live usage snapshot (primary source; usage-limit-gate) ───────────────
const HOUR_MS = 60 * 60 * 1000
export const WEEK_MS = 7 * 24 * HOUR_MS
export const DEFAULT_SNAPSHOT_PATH = join(homedir(), '.cache', 'wolfpack', 'claude-usage.json')
export const WEEKLY_UNAVAILABLE_NOTE =
  'weekly figures unavailable — weekly cap and pacing NOT enforced this check'

const KNOWN_TIERS = ['Green', 'Blue', 'Yellow', 'Orange', 'Red']
// Case-insensitive; missing / unknown ⇒ Red (the most conservative ceiling) — A-11,
// matching campaign-runner.js normTier's "empty ⇒ Red".
export function normTier(t) {
  const s = String(t ?? '').trim().toLowerCase()
  return KNOWN_TIERS.find(k => k.toLowerCase() === s) || 'Red'
}

export function snapshotPathFromEnv(env = process.env) {
  return env.WOLFPACK_USAGE_SNAPSHOT || DEFAULT_SNAPSHOT_PATH
}

// A-7: valid ⇔ finite numeric used_percentage AND finite numeric resets_at > 0.
export function isValidWindow(w) {
  return !!w && typeof w === 'object' &&
    typeof w.used_percentage === 'number' && Number.isFinite(w.used_percentage) &&
    typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) && w.resets_at > 0
}

// Env thresholds. Unset or empty ⇒ default. Anything else that is not a finite number in
// range is a HARD error (throws) — fail loud, never a silent fallback to the default.
// Read one numeric env var: unset/blank ⇒ default; anything else must parse and be in range
// or it hard-errors (a typo must never silently disable a gate rule).
function readNumEnv(env, name, def, { pct = true } = {}) {
  const raw = env[name]
  if (raw == null || String(raw).trim() === '') return def
  const n = Number(raw)
  const ok = Number.isFinite(n) && (pct ? (n >= 0 && n <= 100) : n > 0)
  if (!ok) {
    throw new Error(`${name}=${JSON.stringify(raw)} is invalid — expected ${pct ? 'a number in [0,100]' : 'a number > 0'}`)
  }
  return n
}

export function thresholdsFromEnv(env = process.env) {
  const read = (name, def, opts) => readNumEnv(env, name, def, opts)
  return {
    staleMinutes: read('WOLFPACK_USAGE_STALE_MINUTES', 10, { pct: false }),
    fiveHourMaxPct: read('WOLFPACK_5H_START_MAX_PCT', 80),
    fiveHourMaxPctRed: read('WOLFPACK_5H_START_MAX_PCT_RED', 70),
    weeklyPacePoints: read('WOLFPACK_WEEKLY_PACE_POINTS', 15),
    weeklyDeferPct: read('WOLFPACK_WEEKLY_DEFER_PCT', 90),
  }
}
export const DEFAULT_THRESHOLDS = thresholdsFromEnv({})

// Read + parse the snapshot. Never throws. {ok:true, snapshot} | {ok:false, error}.
// Window validity / staleness are judged by computeUsageDecision, not here.
export function readSnapshot(path, fsImpl = { readFileSync, existsSync }) {
  try {
    if (!fsImpl.existsSync(path)) return { ok: false, error: `snapshot missing (${path})` }
    let snapshot
    try { snapshot = JSON.parse(fsImpl.readFileSync(path, 'utf8')) } catch (e) {
      return { ok: false, error: `snapshot unparseable (${path}: ${e.message})` }
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { ok: false, error: `snapshot is not a JSON object (${path})` }
    }
    return { ok: true, snapshot }
  } catch (e) {
    return { ok: false, error: `snapshot unreadable (${path}: ${e.message})` }
  }
}

const round1 = (v) => Math.round(v * 10) / 10
const clamp01 = (v) => Math.min(1, Math.max(0, v))
const isoFromEpochSec = (s) => new Date(s * 1000).toISOString()
const signed = (v) => (v > 0 ? `+${v}` : `${v}`)

// Why the snapshot cannot drive a live decision (null ⇒ usable).
export function snapshotUnusableReason(snapshot, nowMs, thresholds, snapshotError) {
  if (!snapshot) return snapshotError || 'snapshot missing'
  const capMs = Date.parse(snapshot.captured_at)
  if (typeof snapshot.captured_at !== 'string' || !Number.isFinite(capMs)) {
    return 'snapshot captured_at missing/invalid'
  }
  if (capMs > nowMs + 60 * 1000) return 'snapshot captured_at is in the future'
  const ageMin = (nowMs - capMs) / 60000
  if (ageMin > thresholds.staleMinutes) {
    return `snapshot ${Math.round(ageMin)} min old (stale > ${thresholds.staleMinutes} min)`
  }
  if (!isValidWindow(snapshot.rate_limits?.five_hour)) return 'snapshot five_hour window missing/invalid'
  return null
}

// The ONE place the flat mirrors are derived from the nested objects (output contract).
export function flatten(d) {
  const out = { ...d }
  out.five_hour_pct = d.five_hour ? d.five_hour.used_pct : null
  out.seven_day_pct = d.seven_day ? d.seven_day.used_pct : null
  out.weekly_pace = d.seven_day ? d.seven_day.pace : null
  out.offload = d.offload === true
  if (!out.offload) delete out.offload_reason
  for (const k of ['decision', 'exit', 'reason', 'reset_at', 'source', 'degraded', 'gateEnabled']) {
    if (!(k in out)) out[k] = null
  }
  return out
}

// THE PURE LIVE DECISION CORE (unit-tested). No fs / env / Date.now — all arguments.
//   snapshot      : parsed snapshot object or null
//   snapshotError : why it could not be read (for degraded_reason)
//   estimate      : () => computeDecision(...) result — the degraded fallback (lazy, so the
//                   transcript tree is only walked when actually degraded). Omitted ⇒ the
//                   disabled-estimate decision (proceed, gateEnabled:false).
export function computeUsageDecision({ snapshot, snapshotError, nowMs, tier, thresholds = DEFAULT_THRESHOLDS, estimate }) {
  const t = normTier(tier)
  const unusable = snapshotUnusableReason(snapshot, nowMs, thresholds, snapshotError)
  if (unusable) {
    const est = typeof estimate === 'function' ? estimate()
      : computeDecision({ events: [], nowMs, limit: null, headroomPct: 15, windowMs: 5 * HOUR_MS, readOk: false })
    return flatten({
      ...est, tier: t, source: 'transcript_estimate', degraded: true, degraded_reason: unusable,
      captured_at: snapshot && typeof snapshot.captured_at === 'string' ? snapshot.captured_at : null,
      five_hour: null, seven_day: null, offload: false,
    })
  }

  const fhRaw = snapshot.rate_limits.five_hour
  const fhReset = fhRaw.resets_at * 1000 <= nowMs
  const five_hour = {
    used_pct: fhReset ? 0 : fhRaw.used_percentage,
    resets_at: fhRaw.resets_at,
    reset_since_capture: fhReset,
  }
  if (fhReset) five_hour.captured_used_pct = fhRaw.used_percentage

  const sdRaw = snapshot.rate_limits.seven_day
  let seven_day = null
  if (isValidWindow(sdRaw)) {
    const sdReset = sdRaw.resets_at * 1000 <= nowMs
    const used = sdReset ? 0 : sdRaw.used_percentage
    const elapsed = sdReset ? 0 : clamp01((nowMs - (sdRaw.resets_at * 1000 - WEEK_MS)) / WEEK_MS)
    seven_day = {
      used_pct: used, resets_at: sdRaw.resets_at,
      elapsed_share: Math.round(elapsed * 1000) / 1000,
      pace: sdReset ? 0 : round1(used - elapsed * 100),
      reset_since_capture: sdReset,
    }
    if (sdReset) seven_day.captured_used_pct = sdRaw.used_percentage
  }

  const base = {
    source: 'live', degraded: false, gateEnabled: true,
    captured_at: snapshot.captured_at, tier: t, five_hour, seven_day, offload: false,
  }
  if (!seven_day) base.weekly_note = WEEKLY_UNAVAILABLE_NOTE

  // Rule 2: weekly cap.
  if (seven_day && seven_day.used_pct >= thresholds.weeklyDeferPct) {
    return flatten({
      ...base, decision: 'defer', exit: DEFER,
      reason: `weekly cap: 7d ${seven_day.used_pct}% ≥ ${thresholds.weeklyDeferPct}% — defer all new hunts`,
      reset_at: isoFromEpochSec(seven_day.resets_at),
    })
  }
  // Rule 3: 5h start ceiling (tier-dependent).
  const ceiling = t === 'Red' ? thresholds.fiveHourMaxPctRed : thresholds.fiveHourMaxPct
  if (five_hour.used_pct >= ceiling) {
    return flatten({
      ...base, decision: 'defer', exit: DEFER,
      reason: `5h window: ${five_hour.used_pct}% ≥ ${ceiling}% start ceiling (${t}) — defer until the 5h window resets`,
      reset_at: isoFromEpochSec(five_hour.resets_at),
    })
  }
  // Rule 4: proceed (+ weekly pacing offload).
  const weekTxt = seven_day ? `; week ${seven_day.used_pct}% (pace ${signed(seven_day.pace)})` : '; week n/a'
  const out = {
    ...base, decision: 'proceed', exit: PROCEED,
    reason: `5h ${five_hour.used_pct}% < ${ceiling}% start ceiling (${t})${weekTxt}`,
    reset_at: five_hour.reset_since_capture ? null : isoFromEpochSec(five_hour.resets_at),
  }
  if (seven_day && seven_day.pace > thresholds.weeklyPacePoints) {
    out.offload = true
    out.offload_reason = `weekly pace ${signed(seven_day.pace)} points ahead of the week's elapsed share (> ${thresholds.weeklyPacePoints}) — offload the Shepherd to GLM`
  }
  return flatten(out)
}

// The degraded-fallback ESTIMATE, configured from env exactly as the original gate was.
// Exported so wolfpack-usage.mjs reuses it verbatim (the env NAMES live only here).
// rootDir defaults to WOLFPACK_TRANSCRIPT_DIR, else the first existing harness layout
// (~/.agents/projects, ~/.claude/projects), else ~/.agents/projects.
export function defaultTranscriptDir(env = process.env, exists = existsSync) {
  if (env.WOLFPACK_TRANSCRIPT_DIR) return env.WOLFPACK_TRANSCRIPT_DIR
  const candidates = [join(homedir(), '.agents', 'projects'), join(homedir(), '.claude', 'projects')]
  return candidates.find((d) => exists(d)) || candidates[0]
}

const stderrWarn = (msg) => process.stderr.write(`⚠ wolfpack-window-gate: ${msg}\n`)

// The configured window limit (raw string, undefined when neither name is set).
// WOLFPACK_AGENT_WINDOW_LIMIT wins; the legacy WOLFPACK_CLAUDE_WINDOW_LIMIT is honoured with a
// deprecation warning (fired whenever it is set); both set to different values → throw.
export function windowLimitFromEnv(env = process.env, warn = stderrWarn) {
  const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== ''
  const cur = env.WOLFPACK_AGENT_WINDOW_LIMIT
  const legacy = env.WOLFPACK_CLAUDE_WINDOW_LIMIT
  if (isSet(legacy)) {
    warn('WOLFPACK_CLAUDE_WINDOW_LIMIT is deprecated — rename it WOLFPACK_AGENT_WINDOW_LIMIT')
    if (isSet(cur) && String(cur).trim() !== String(legacy).trim()) {
      throw new Error(`conflicting window limits: WOLFPACK_AGENT_WINDOW_LIMIT=${cur} vs WOLFPACK_CLAUDE_WINDOW_LIMIT=${legacy} — keep only WOLFPACK_AGENT_WINDOW_LIMIT`)
    }
    if (!isSet(cur)) return legacy
  }
  return isSet(cur) ? cur : undefined
}
// The estimate's tuning knobs, validated with the SAME hard-error rule as thresholdsFromEnv:
// a malformed WOLFPACK_WINDOW_HEADROOM_PCT / WOLFPACK_WINDOW_HOURS used to yield NaN / 0 and
// silently make the backstop always proceed (A-8). Unset/blank ⇒ default; invalid ⇒ throw.
// (WOLFPACK_AGENT_WINDOW_LIMIT is NOT validated here: unset/0 is the documented
// "estimate disabled" opt-out, reported loudly by computeDecision.)
export function estimateConfigFromEnv(env = process.env) {
  return {
    headroomPct: readNumEnv(env, 'WOLFPACK_WINDOW_HEADROOM_PCT', 15),
    windowHours: readNumEnv(env, 'WOLFPACK_WINDOW_HOURS', 5, { pct: false }),
  }
}
export function estimateFromEnv(env, nowMs, rootDir = defaultTranscriptDir(env), { warn = stderrWarn } = {}) {
  const limit = Number(windowLimitFromEnv(env, warn))
  const { headroomPct, windowHours } = estimateConfigFromEnv(env)
  const windowMs = windowHours * 60 * 60 * 1000
  // Only read transcripts when the estimate is enabled (limit set) — no point walking the
  // tree to print a "disabled" notice.
  let events = [], readOk = false
  if (limit && Number.isFinite(limit) && limit > 0) {
    ({ events, readOk } = collectEvents(rootDir, nowMs - windowMs))
  }
  return computeDecision({ events, nowMs, limit, headroomPct, windowMs, readOk })
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}

function main() {
  const argv = process.argv.slice(2)
  const jsonOnly = argv.includes('--json')
  const rootDir = argValue(argv, '--transcripts') || defaultTranscriptDir(process.env)
  const tier = normTier(argValue(argv, '--tier'))
  const snapPath = argValue(argv, '--snapshot') || snapshotPathFromEnv()

  let thresholds
  try {
    thresholds = thresholdsFromEnv(process.env)
    // Validate the degraded-fallback knobs up front too, so a bad value hard-errors on
    // every run — not only on the run that happens to fall back to the estimate.
    estimateConfigFromEnv(process.env)
    windowLimitFromEnv(process.env)   // conflicting legacy/current limits → exit 1; warns on the legacy name
  } catch (e) {
    process.stderr.write(`wolfpack-window-gate: ERROR — ${e.message}\n`)
    process.exit(ERROR)
  }

  const nowMs = Date.now()
  // Degraded fallback (lazy): the original transcript estimate, unchanged.
  const estimate = () => estimateFromEnv(process.env, nowMs, rootDir, { warn: () => {} })   // warned above

  const snap = readSnapshot(snapPath)
  const decision = computeUsageDecision({
    snapshot: snap.ok ? snap.snapshot : null, snapshotError: snap.error,
    nowMs, tier, thresholds, estimate,
  })

  // Warnings go to stderr in EVERY mode (--json included): a degraded reading, an
  // unenforced weekly cap, or an offload is never silent (AC3, A-7).
  if (decision.degraded) {
    process.stderr.write(`⚠ wolfpack-window-gate: DEGRADED — ${decision.degraded_reason}; ` +
      `falling back to the transcript estimate (${decision.gateEnabled ? 'enabled' : 'NOT configured — proceeding ungated; set WOLFPACK_AGENT_WINDOW_LIMIT as the backstop'}). ` +
      `Live 5h/weekly gating and offload are INACTIVE.\n`)
  }
  if (decision.weekly_note) process.stderr.write(`⚠ wolfpack-window-gate: ${decision.weekly_note}\n`)
  if (decision.offload) process.stderr.write(`⚖ wolfpack-window-gate: OFFLOAD — ${decision.offload_reason}\n`)

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(decision) + '\n')
  } else {
    process.stdout.write(JSON.stringify(decision, null, 2) + '\n')
    process.stderr.write(`wolfpack-window-gate: ${decision.decision.toUpperCase()} [${decision.source}] — ${decision.reason}\n`)
    if (decision.seven_day) {
      process.stderr.write(`wolfpack-window-gate: week ${decision.seven_day.used_pct}% · elapsed ${Math.round(decision.seven_day.elapsed_share * 100)}% · pace ${decision.seven_day.pace > 0 ? '+' : ''}${decision.seven_day.pace}\n`)
    }
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
