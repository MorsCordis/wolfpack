#!/usr/bin/env node
// scripts/wolfpack-release.test.mjs — unit tests for the [04] release helper.
// Run: node --test scripts/wolfpack-release.test.mjs
//
// Mirrors the prior-layer methodology (drive the real pure fns through
// scenarios). Covers: bump aggregation precedence + tooling-only, version math
// across major/minor/patch + prefix preservation + parse failure, release-queue
// classification (AC4 compliance exclusion), and acceptance-criteria parsing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  aggregateBump,
  nextVersion,
  releaseQueue,
  parseAcceptanceCriteria,
} from './wolfpack-release.mjs'

// ── aggregateBump ────────────────────────────────────────────────
test('aggregateBump: minor beats patch', () => {
  assert.equal(aggregateBump(['patch', 'minor', 'patch']), 'minor')
})

test('aggregateBump: major wins (ranked, surfaces loudly)', () => {
  assert.equal(aggregateBump(['minor', 'major', 'patch']), 'major')
})

test('aggregateBump: tooling-only contributes nothing → null', () => {
  assert.equal(aggregateBump([null, '', undefined]), null)
  assert.equal(aggregateBump([]), null)
})

test('aggregateBump: tooling-only mixed with patch → patch', () => {
  assert.equal(aggregateBump([null, 'patch', '']), 'patch')
})

test('aggregateBump: case-insensitive', () => {
  assert.equal(aggregateBump(['PATCH', 'Minor']), 'minor')
})

// ── nextVersion ──────────────────────────────────────────────────
test('nextVersion: patch bump', () => {
  assert.equal(nextVersion('v0.24.5', 'patch'), 'v0.24.6')
})

test('nextVersion: minor bump zeroes patch', () => {
  assert.equal(nextVersion('v0.24.5', 'minor'), 'v0.25.0')
})

test('nextVersion: major bump zeroes minor + patch', () => {
  assert.equal(nextVersion('v0.24.5', 'major'), 'v1.0.0')
})

test('nextVersion: preserves missing v prefix', () => {
  assert.equal(nextVersion('0.24.5', 'patch'), '0.24.6')
})

test('nextVersion: tolerates trailing describe suffix', () => {
  assert.equal(nextVersion('v0.24.5-3-gabc123', 'patch'), 'v0.24.6')
})

test('nextVersion: null bump → null (tooling-only wave)', () => {
  assert.equal(nextVersion('v0.24.5', null), null)
})

test('nextVersion: unparseable tag throws', () => {
  assert.throws(() => nextVersion('garbage', 'patch'), /cannot parse/)
})

// ── releaseQueue ─────────────────────────────────────────────────
test('releaseQueue: certified hunts are ready', () => {
  const q = releaseQueue([
    { slug: 'a', verdict: 'CERTIFIED_AWAITING_DEPLOY' },
    { slug: 'b', status: 'certified' },
  ])
  assert.deepEqual(q.ready, ['a', 'b'])
  assert.deepEqual(q.awaitingCompliance, [])
})

test('releaseQueue: AC4 — compliance_review park is excluded from ready', () => {
  const q = releaseQueue([
    { slug: 'a', verdict: 'CERTIFIED_AWAITING_DEPLOY' },
    { slug: 'cs-fix', verdict: 'PARKED', status: 'parked:compliance_review' },
  ])
  assert.deepEqual(q.ready, ['a'])
  assert.deepEqual(q.awaitingCompliance, ['cs-fix'])
})

test('releaseQueue: compliance flagged via reason field too', () => {
  const q = releaseQueue([
    { slug: 'cs-fix', verdict: 'PARKED', reason: 'compliance_review' },
  ])
  assert.deepEqual(q.awaitingCompliance, ['cs-fix'])
})

test('releaseQueue: failed/other hunts excluded, not released', () => {
  const q = releaseQueue([
    { slug: 'a', verdict: 'CERTIFIED_AWAITING_DEPLOY' },
    { slug: 'broke', verdict: 'WAVE_FAILED' },
    { slug: 'park', verdict: 'PARKED', status: 'parked:open_critical' },
  ])
  assert.deepEqual(q.ready, ['a'])
  assert.deepEqual(q.excluded.sort(), ['broke', 'park'])
})

// ── parseAcceptanceCriteria ──────────────────────────────────────
const SAMPLE = `# Acceptance — invoice-bundle

## Acceptance criteria (the contract)
- AC1 [auto] When a bundle is selected, the default line items apply.
- AC2 [auto] Tax rounds to cents on the invoice total.
- AC3 [manual] The invoice PDF layout looks right.
- AC4 [compliance] The CS record retains the disposition field per DEA 2yr.

## Out of scope
- Do not touch the scheduler.
`

test('parseAcceptanceCriteria: extracts id, tag, text, ref', () => {
  const c = parseAcceptanceCriteria(SAMPLE, 'invoice-bundle')
  assert.equal(c.length, 4)
  assert.deepEqual(c[0], {
    slug: 'invoice-bundle',
    id: 'AC1',
    tag: 'auto',
    text: 'When a bundle is selected, the default line items apply.',
    ref: 'invoice-bundle/1',
  })
  assert.equal(c[3].tag, 'compliance')
  assert.equal(c[3].ref, 'invoice-bundle/4')
})

test('parseAcceptanceCriteria: ignores out-of-scope bullets and prose', () => {
  const c = parseAcceptanceCriteria(SAMPLE, 'invoice-bundle')
  assert.ok(c.every((x) => x.id.startsWith('AC')))
  assert.ok(!c.some((x) => /scheduler/.test(x.text)))
})

test('parseAcceptanceCriteria: empty/garbage input → []', () => {
  assert.deepEqual(parseAcceptanceCriteria('', 'x'), [])
  assert.deepEqual(parseAcceptanceCriteria(null, 'x'), [])
})

test('parseAcceptanceCriteria: tolerates leading indentation', () => {
  const c = parseAcceptanceCriteria('   - AC1 [auto] Indented criterion holds.', 'x')
  assert.equal(c.length, 1)
  assert.equal(c[0].id, 'AC1')
})

// ── CLI ──────────────────────────────────────────────────────────
const SCRIPT = new URL('./wolfpack-release.mjs', import.meta.url).pathname

test('CLI version: aggregates + computes next', () => {
  const out = execFileSync('node', [SCRIPT, 'version', 'v0.24.5', 'patch', 'minor'], {
    encoding: 'utf8',
  })
  assert.match(out, /BUMP=minor/)
  assert.match(out, /VERSION=v0\.25\.0/)
})

test('CLI version: tooling-only wave → none/empty', () => {
  const out = execFileSync('node', [SCRIPT, 'version', 'v0.24.5'], { encoding: 'utf8' })
  assert.match(out, /BUMP=none/)
  assert.match(out, /VERSION=\s*$/m)
})

test('CLI criteria: reads file and prints JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-rel-'))
  try {
    const p = join(dir, 'acceptance.md')
    writeFileSync(p, SAMPLE)
    const out = execFileSync('node', [SCRIPT, 'criteria', p, 'invoice-bundle'], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(out)
    assert.equal(parsed.length, 4)
    assert.equal(parsed[0].ref, 'invoice-bundle/1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
