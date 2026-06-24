#!/usr/bin/env node
// scripts/wolfpack-timing.test.mjs — unit tests for the [05] timing aggregator.
// Run: node --test scripts/wolfpack-timing.test.mjs
//
// Mirrors the prior-layer methodology (extract the real pure fns, drive
// scenarios). Covers: round summing, completeness/incompleteness detection,
// clock-skew rejection, malformed-line tolerance, total provenance, by_model
// re-bucketing, and an end-to-end pedigree.json merge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  parseTimingLines, pairPhaseDurations, computeTotal,
  deriveByModel, fmtDuration, buildTimingBlock,
} from './wolfpack-timing.mjs'

const line = (o) => JSON.stringify(o)

test('parseTimingLines skips malformed and non-conforming lines', () => {
  const text = [
    line({ phase: 'Plan', event: 'start', ts: '2026-06-07T10:00:00-06:00' }),
    'not json at all',
    line({ phase: 'Plan', event: 'finish', ts: 'x' }), // bad event value
    line({ nope: true }),                               // missing phase/event
    line({ phase: 'Plan', event: 'end', ts: '2026-06-07T10:05:00-06:00' }),
    '',                                                 // blank ignored, not counted
  ].join('\n')
  const { events, badLines } = parseTimingLines(text)
  assert.equal(events.length, 2)
  assert.equal(badLines, 3)
})

test('pairPhaseDurations sums multiple rounds within a phase', () => {
  const events = [
    { phase: 'Review', event: 'start', ts: '2026-06-07T10:00:00Z' },
    { phase: 'Review', event: 'end',   ts: '2026-06-07T10:02:00Z' }, // 120s
    { phase: 'Review', event: 'start', ts: '2026-06-07T10:10:00Z' },
    { phase: 'Review', event: 'end',   ts: '2026-06-07T10:13:00Z' }, // 180s
  ]
  const { byPhase, incompletePhases } = pairPhaseDurations(events)
  assert.equal(byPhase.Review, 300)
  assert.deepEqual(incompletePhases, [])
})

test('pairPhaseDurations flags a phase with a start but no end', () => {
  const events = [
    { phase: 'Implement', event: 'start', ts: '2026-06-07T10:00:00Z' },
    // crashed — no end
    { phase: 'Test', event: 'start', ts: '2026-06-07T11:00:00Z' },
    { phase: 'Test', event: 'end',   ts: '2026-06-07T11:01:00Z' },
  ]
  const { byPhase, incompletePhases } = pairPhaseDurations(events)
  assert.equal(byPhase.Test, 60)
  assert.ok(!('Implement' in byPhase))      // no bogus duration stored
  assert.deepEqual(incompletePhases, ['Implement'])
})

test('pairPhaseDurations rejects clock skew (end before start)', () => {
  const events = [
    { phase: 'Plan', event: 'start', ts: '2026-06-07T10:05:00Z' },
    { phase: 'Plan', event: 'end',   ts: '2026-06-07T10:00:00Z' }, // earlier than start
  ]
  const { byPhase, incompletePhases } = pairPhaseDurations(events)
  assert.ok(!('Plan' in byPhase))
  assert.deepEqual(incompletePhases, ['Plan'])
})

test('pairPhaseDurations: crash-then-resume keeps resumed duration, flags the orphan start', () => {
  const events = [
    { phase: 'Implement', event: 'start', ts: '2026-06-07T10:00:00Z' }, // orphan (crash)
    { phase: 'Implement', event: 'start', ts: '2026-06-07T12:00:00Z' }, // resume
    { phase: 'Implement', event: 'end',   ts: '2026-06-07T12:05:00Z' }, // 300s
  ]
  const { byPhase, incompletePhases } = pairPhaseDurations(events)
  assert.equal(byPhase.Implement, 300)
  assert.deepEqual(incompletePhases, ['Implement'])
})

test('computeTotal prefers the metadata wall-clock window', () => {
  const r = computeTotal({
    metadata: { created: '2026-06-07T10:00:00Z', completed_at: '2026-06-07T10:30:00Z' },
    byPhase: { Plan: 120 },
    events: [],
  })
  assert.deepEqual(r, { total_s: 1800, method: 'metadata' })
})

test('computeTotal falls back to phase sum, then span, then none', () => {
  assert.equal(computeTotal({ metadata: {}, byPhase: { Plan: 120, Test: 60 }, events: [] }).method, 'phase_sum')
  assert.equal(computeTotal({ metadata: {}, byPhase: { Plan: 120, Test: 60 }, events: [] }).total_s, 180)

  const spanEvents = [
    { phase: 'Plan', event: 'start', ts: '2026-06-07T10:00:00Z' },
    { phase: 'Plan', event: 'end',   ts: '2026-06-07T10:10:00Z' },
  ]
  // byPhase empty forces the span branch
  const span = computeTotal({ metadata: {}, byPhase: {}, events: spanEvents })
  assert.equal(span.method, 'span')
  assert.equal(span.total_s, 600)

  assert.deepEqual(computeTotal({ metadata: {}, byPhase: {}, events: [] }), { total_s: null, method: 'none' })
})

test('deriveByModel re-buckets phases by their assigned role-model', () => {
  const byModel = deriveByModel(
    { Plan: 100, Review: 200, Debrief: 50, Implement: 300, Certify: 80, Spec: 999 },
    { model_assignments: { alpha: 'judgment', bloodhound: 'reviewer-model', shepherd: 'work-horse', watchdog: 'reviewer-model' } },
  )
  assert.equal(byModel['judgment'], 150) // Plan + Debrief
  assert.equal(byModel['reviewer-model'], 280)       // Review + Certify
  assert.equal(byModel['work-horse'], 300)
  assert.ok(!('Spec' in byModel))            // Spec has no role-model — not guessed
})

test('fmtDuration formats h/m/s and unknown', () => {
  assert.equal(fmtDuration(0), '0s')
  assert.equal(fmtDuration(75), '1m 15s')
  assert.equal(fmtDuration(3661), '1h 1m 1s')
  assert.equal(fmtDuration(null), 'unknown')
})

test('buildTimingBlock marks complete only when clean AND metadata-derived', () => {
  const timingText = [
    line({ phase: 'Plan', event: 'start', ts: '2026-06-07T10:00:00Z' }),
    line({ phase: 'Plan', event: 'end',   ts: '2026-06-07T10:05:00Z' }),
  ].join('\n')
  const good = buildTimingBlock({
    timingText,
    metadata: { created: '2026-06-07T10:00:00Z', completed_at: '2026-06-07T10:30:00Z' },
  })
  assert.equal(good.complete, true)
  assert.equal(good.total_method, 'metadata')
  assert.equal(good.duration, '30m 0s')

  // No completed_at → total falls back, so NOT complete even with clean phases.
  const noEnd = buildTimingBlock({ timingText, metadata: { created: '2026-06-07T10:00:00Z' } })
  assert.equal(noEnd.complete, false)
  assert.equal(noEnd.total_method, 'phase_sum')
})

test('buildTimingBlock never reads complete with no phase markers (C4 false-positive guard)', () => {
  // Empty timing.jsonl BUT a full metadata window — must NOT pass as complete.
  const block = buildTimingBlock({
    timingText: '',
    metadata: { created: '2026-06-07T10:00:00Z', completed_at: '2026-06-07T10:30:00Z' },
  })
  assert.equal(block.complete, false)
  assert.equal(block.no_markers, true)
  assert.deepEqual(block.by_phase, {})
  assert.equal(block.total_method, 'metadata') // window still computes the total
  assert.equal(block.total_s, 1800)
})

test('buildTimingBlock: only-orphan markers (all pairs rejected) is not complete', () => {
  const block = buildTimingBlock({
    timingText: JSON.stringify({ phase: 'Plan', event: 'start', ts: '2026-06-07T10:00:00Z' }),
    metadata: { created: '2026-06-07T10:00:00Z', completed_at: '2026-06-07T10:30:00Z' },
  })
  assert.equal(block.complete, false)
  assert.equal(block.no_markers, true)               // no usable pair → no markers
  assert.deepEqual(block.incomplete_phases, ['Plan']) // orphan start still flagged
})

test('integration: CLI merges a timing block into pedigree.json and prints DURATION', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wolfpack-timing-'))
  try {
    writeFileSync(join(dir, 'timing.jsonl'), [
      line({ phase: 'Plan', event: 'start', ts: '2026-06-07T10:00:00Z' }),
      line({ phase: 'Plan', event: 'end',   ts: '2026-06-07T10:06:00Z' }),
      line({ phase: 'Implement', event: 'start', ts: '2026-06-07T10:10:00Z' }), // orphan
    ].join('\n') + '\n')
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({
      created: '2026-06-07T10:00:00Z',
      completed_at: '2026-06-07T10:20:00Z',
      model_assignments: { alpha: 'judgment' },
    }))
    writeFileSync(join(dir, 'pedigree.json'), JSON.stringify({ feature: 'x', certifier_verdict: 'pass' }))

    const out = execFileSync('node', [join(import.meta.dirname, 'wolfpack-timing.mjs'), dir], { encoding: 'utf8' })
    assert.match(out, /DURATION=20m 0s/)

    const pedigree = JSON.parse(readFileSync(join(dir, 'pedigree.json'), 'utf8'))
    assert.equal(pedigree.feature, 'x')               // existing fields preserved
    assert.equal(pedigree.timing.total_s, 1200)
    assert.equal(pedigree.timing.by_phase.Plan, 360)
    assert.equal(pedigree.timing.complete, false)
    assert.deepEqual(pedigree.timing.incomplete_phases, ['Implement'])
    assert.equal(pedigree.timing.by_model['judgment'], 360)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
