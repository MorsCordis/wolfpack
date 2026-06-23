#!/usr/bin/env node
// scripts/wolfpack-timing.mjs — [05] timing aggregator (host-side, run at Certify).
//
// Reads a hunt's append-only timing.jsonl (start/end markers each phase agent
// brackets itself with — see hunt-pipeline.js heartbeat()) plus metadata.json,
// computes total + per-phase + per-model durations, and folds a "timing" block
// into pedigree.json. Prints `DURATION=<…>` on stdout for the Watchdog to drop
// into the pedigree index row.
//
// WHY THIS IS HOST-SIDE: the workflow JS cannot read the clock (Date.now()/new
// Date() throw — they'd break resume), so timestamps are agent-authored (bash
// `date -Iseconds`) and the math happens HERE, in a plain node script, where
// Date is allowed. This is the "closing step — host-side script, NOT the
// workflow JS" the design (05 § Part C) calls for.
//
// FAIL-LOUD, NOT FAIL-SILENT (wolfpack-config.md + 05 § C4): an incomplete record (a
// phase with a start but no end) is FLAGGED, never silently stored as partial —
// a missing end means an agent died mid-phase, which is itself a signal, and it
// would otherwise corrupt the per-phase averages the limit gate depends on.
// But the script never BLOCKS certification: timing is telemetry, not a gate
// (mirrors wolfpack-lessons.sh) — it always exits 0.
//
// Usage: node scripts/wolfpack-timing.mjs <planDir>
//   <planDir> holds timing.jsonl, metadata.json, and pedigree.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Phase → role, so per-phase durations can be re-bucketed by the model that ran
// them (the x/y the [06] routing meter needs). Phases with no model assignment
// (Scaffold/Spec/Verify run as the orchestrating agent) are left out of
// by_model rather than guessed — fail-loud over a fabricated bucket.
const PHASE_ROLE = {
  Plan: 'alpha',
  Review: 'bloodhound',
  Debrief: 'alpha',
  Implement: 'shepherd',
  'Code Review': 'pointer',
  Test: 'tracker',
  Certify: 'watchdog',
}

// ─── Pure helpers (unit-tested directly) ───────────────────────

// Parse timing.jsonl into events, counting malformed lines rather than throwing
// on them — one corrupt append must not lose the whole record.
export function parseTimingLines(text) {
  const events = []
  let badLines = 0
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj
    try { obj = JSON.parse(line) } catch { badLines++; continue }
    if (!obj || typeof obj.phase !== 'string' || (obj.event !== 'start' && obj.event !== 'end')) {
      badLines++; continue
    }
    events.push(obj)
  }
  return { events, badLines }
}

const tsMs = (ts) => {
  const n = Date.parse(ts)
  return Number.isNaN(n) ? null : n
}

// Pair start→end per phase, IN FILE ORDER, summing every matched pair (so a
// phase that ran across multiple rounds — Review, Code Review — accumulates its
// real total, and a resumed hunt's fresh pair adds real time). Dangling starts
// or ends (crash mid-phase, clock skew, unparseable ts) flag the phase
// incomplete; they never silently vanish.
export function pairPhaseDurations(events) {
  const byPhase = {}
  const incomplete = new Set()
  const byPhaseEvents = {}
  for (const ev of events) {
    (byPhaseEvents[ev.phase] ||= []).push(ev)
  }
  for (const [phase, evs] of Object.entries(byPhaseEvents)) {
    let pendingStart = null
    let total = 0
    let sawPair = false
    for (const ev of evs) {
      if (ev.event === 'start') {
        if (pendingStart !== null) incomplete.add(phase) // start with no matching end before this one
        pendingStart = tsMs(ev.ts)
        if (pendingStart === null) incomplete.add(phase) // unparseable start ts
      } else { // end
        if (pendingStart === null) { incomplete.add(phase); continue } // end with no open start
        const endMs = tsMs(ev.ts)
        if (endMs === null || endMs < pendingStart) {
          incomplete.add(phase) // unparseable end or clock skew — don't store a bogus duration
        } else {
          total += (endMs - pendingStart) / 1000
          sawPair = true
        }
        pendingStart = null
      }
    }
    if (pendingStart !== null) incomplete.add(phase) // open start, never ended
    if (sawPair) byPhase[phase] = Math.round(total)
  }
  return { byPhase, incompletePhases: [...incomplete].sort() }
}

// total_s, with provenance. Prefer the authoritative wall-clock window
// (metadata created → completed_at) since it spans the whole hunt incl. phases
// without timing markers; fall back to summing phases, then to the marker span.
export function computeTotal({ metadata, byPhase, events }) {
  const created = tsMs(metadata?.created || metadata?.created_at)
  const completed = tsMs(metadata?.completed_at)
  if (created !== null && completed !== null && completed >= created) {
    return { total_s: Math.round((completed - created) / 1000), method: 'metadata' }
  }
  const phaseSum = Object.values(byPhase).reduce((a, b) => a + b, 0)
  if (phaseSum > 0) return { total_s: phaseSum, method: 'phase_sum' }
  const tss = events.map(e => tsMs(e.ts)).filter(n => n !== null)
  if (tss.length >= 2) {
    return { total_s: Math.round((Math.max(...tss) - Math.min(...tss)) / 1000), method: 'span' }
  }
  return { total_s: null, method: 'none' }
}

// Best-effort re-bucket of per-phase durations by the model that ran each phase.
export function deriveByModel(byPhase, metadata) {
  const assigns = metadata?.model_assignments || {}
  const byModel = {}
  for (const [phase, secs] of Object.entries(byPhase)) {
    const role = PHASE_ROLE[phase]
    const model = role && assigns[role]
    if (!model) continue
    byModel[model] = (byModel[model] || 0) + secs
  }
  return byModel
}

export function fmtDuration(s) {
  if (s == null) return 'unknown'
  s = Math.round(s)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const parts = []
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  parts.push(`${sec}s`)
  return parts.join(' ')
}

// Assemble the full timing block written into pedigree.json.
export function buildTimingBlock({ timingText, metadata }) {
  const { events, badLines } = parseTimingLines(timingText)
  const { byPhase, incompletePhases } = pairPhaseDurations(events)
  const { total_s, method } = computeTotal({ metadata, byPhase, events })
  const by_model = deriveByModel(byPhase, metadata)
  // No phase produced a usable start/end pair — an empty or missing timing.jsonl,
  // or every pair was rejected. This must NEVER read as `complete` just because a
  // metadata created/completed_at window exists (C4: a record with no phase data
  // is the strongest incompleteness signal — agents didn't append at all).
  const noMarkers = Object.keys(byPhase).length === 0
  const complete = !noMarkers && incompletePhases.length === 0 && badLines === 0 && method === 'metadata'
  const block = {
    total_s,
    duration: fmtDuration(total_s),
    total_method: method,
    by_phase: byPhase,
    by_model,
    complete,
  }
  if (incompletePhases.length) block.incomplete_phases = incompletePhases
  if (badLines) block.malformed_lines = badLines
  if (noMarkers) block.no_markers = true
  return block
}

// ─── CLI ───────────────────────────────────────────────────────

function main(planDir) {
  if (!planDir) {
    console.error('wolfpack-timing: usage: node scripts/wolfpack-timing.mjs <planDir>')
    console.log('DURATION=unknown')
    return 0
  }
  const timingPath = join(planDir, 'timing.jsonl')
  const metaPath = join(planDir, 'metadata.json')
  const pedigreePath = join(planDir, 'pedigree.json')

  const timingText = existsSync(timingPath) ? readFileSync(timingPath, 'utf8') : ''
  if (!timingText.trim()) {
    console.error(`wolfpack-timing: no timing markers at ${timingPath} — phase agents did not append (telemetry gap, not a cert blocker)`)
  }
  let metadata = {}
  try { metadata = JSON.parse(readFileSync(metaPath, 'utf8')) } catch {
    console.error(`wolfpack-timing: could not read ${metaPath} — total may fall back to marker span`)
  }

  const block = buildTimingBlock({ timingText, metadata })

  if (existsSync(pedigreePath)) {
    try {
      const pedigree = JSON.parse(readFileSync(pedigreePath, 'utf8'))
      pedigree.timing = block
      writeFileSync(pedigreePath, JSON.stringify(pedigree, null, 2) + '\n')
    } catch (e) {
      console.error(`wolfpack-timing: could not update ${pedigreePath}: ${e.message}`)
    }
  } else {
    console.error(`wolfpack-timing: ${pedigreePath} not found — Watchdog writes it before this runs; skipping merge`)
  }

  // Fail-loud surfacing (05 § C4): an incomplete record is a signal, not a footnote.
  if (!block.complete) {
    const reasons = []
    if (block.no_markers) reasons.push('no phase markers recorded (empty/missing timing.jsonl)')
    if (block.incomplete_phases) reasons.push(`incomplete phases: ${block.incomplete_phases.join(', ')}`)
    if (block.malformed_lines) reasons.push(`${block.malformed_lines} malformed line(s)`)
    if (block.total_method !== 'metadata') reasons.push(`total derived via ${block.total_method} (no metadata created/completed_at window)`)
    console.error(`wolfpack-timing: INCOMPLETE record — ${reasons.join('; ')}`)
  }
  console.log(`DURATION=${block.duration}`)
  return 0
}

// Only run when invoked directly, not when imported by the test module.
if (process.argv[1] && process.argv[1].endsWith('wolfpack-timing.mjs')) {
  process.exit(main(process.argv[2]))
}
