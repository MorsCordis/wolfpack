#!/usr/bin/env node
// scripts/wolfpack-version.test.mjs — tests for scripts/wolfpack-version.mjs (merge-and-state-hygiene
// AC7): the one write path for metadata.proposed_version, with set_by provenance; a human-set
// version is immutable to seats and a seat's disagreement becomes a SEAT NOTE in human-notes.md.
// Run: node --test scripts/wolfpack-version.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ROLES, normBump, normTag, TAG_RE, applyProposedVersion, seatNoteBlock } from './wolfpack-version.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, 'wolfpack-version.mjs')
const DIRS = []
after(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }) })

const planDir = (meta, notes) => {
  const d = mkdtempSync(join(tmpdir(), 'wpver-'))
  DIRS.push(d)
  writeFileSync(join(d, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n')
  if (notes !== undefined) writeFileSync(join(d, 'human-notes.md'), notes)
  return d
}
const run = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* error path */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}
const metaBytes = (d) => readFileSync(join(d, 'metadata.json'), 'utf8')
const notes = (d) => existsSync(join(d, 'human-notes.md')) ? readFileSync(join(d, 'human-notes.md'), 'utf8') : null
const HUMAN = { feature: 'h', status: 'planned', usage_delta: { x: 1 }, proposed_version: { bump: 'PATCH', tag: 'v1.2.4', set_by: 'human' } }

test('normBump: case-insensitive; none/null/"" → null; anything else throws', () => {
  assert.equal(normBump('minor'), 'MINOR')
  assert.equal(normBump('Patch'), 'PATCH')
  assert.equal(normBump('MAJOR'), 'MAJOR')
  for (const v of ['none', 'NONE', 'null', '', null, undefined]) assert.equal(normBump(v), null, String(v))
  assert.throws(() => normBump('huge'), /invalid bump/)
  assert.deepEqual(ROLES, ['human', 'alpha', 'debrief', 'shepherd', 'pointer', 'tracker', 'watchdog'])
})

test('AC7: a seat over a human-set version → metadata byte-identical; ONE SEAT NOTE whose stands line is the HUMAN value', () => {
  const d = planDir(HUMAN)
  const before = metaBytes(d)
  const r = run('set', '--plan-dir', d, '--bump', 'MINOR', '--tag', 'v1.3.0', '--by', 'alpha', '--reason', 'new scripts are features', '--at', '2026-10-21T05:00:00Z')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.applied, false)
  assert.deepEqual(r.json.disagreement.current, { bump: 'PATCH', tag: 'v1.2.4' }, 'current = the human\'s standing value, not the seat\'s args')
  assert.deepEqual(r.json.disagreement.proposed, { bump: 'MINOR', tag: 'v1.3.0' })
  assert.equal(r.json.disagreement.role, 'alpha')
  assert.deepEqual(r.json.proposed_version, HUMAN.proposed_version)
  assert.equal(metaBytes(d), before, 'metadata.json byte-identical')
  const n = notes(d)
  assert.equal((n.match(/SEAT NOTE \(not human direction\)/g) || []).length, 1)
  assert.match(n, /^## 2026-10-21 — SEAT NOTE \(not human direction\): alpha disagrees with the human-set version\n/)
  assert.match(n, /\n- Human-set \(stands\): PATCH v1\.2\.4\n/)
  assert.match(n, /\n- alpha proposes: MINOR v1\.3\.0\n/)
  assert.match(n, /\n- Why: new scripts are features\n/)
})

test('AC7: the note is APPENDED after existing human blocks (never rewriting them), separated by a blank line', () => {
  const prior = '# Human notes\n\n## 2026-10-20 — Cecil\n- keep this\n'
  const d = planDir(HUMAN, prior)
  run('set', '--plan-dir', d, '--bump', 'major', '--tag', 'v2.0.0', '--by', 'watchdog', '--reason', 'breaking', '--at', '2026-10-21T00:00:00Z')
  const n = notes(d)
  assert.ok(n.startsWith(prior), 'prior content kept verbatim')
  assert.match(n.slice(prior.length), /^\n## 2026-10-21 — SEAT NOTE \(not human direction\): watchdog disagrees/)
  run('set', '--plan-dir', d, '--bump', 'minor', '--tag', 'v1.3.0', '--by', 'debrief', '--reason', 'r2', '--at', '2026-10-22T00:00:00Z')
  assert.equal((notes(d).match(/SEAT NOTE/g) || []).length, 2)
})

test('a SEAT NOTE never moves human-notes.md mtime (test-record ensure reads it as the last HUMAN write); a file it creates is back-dated', () => {
  const d = planDir(HUMAN, '## 2026-10-20 — human\nre-armed\n')
  const np = join(d, 'human-notes.md')
  const t = new Date('2026-10-20T12:00:00Z')
  utimesSync(np, t, t)
  assert.equal(run('set', '--plan-dir', d, '--bump', 'minor', '--tag', 'v1.3.0', '--by', 'watchdog', '--reason', 'r').code, 0)
  assert.match(notes(d), /SEAT NOTE/)
  assert.equal(statSync(np).mtimeMs, t.getTime())
  const fresh = planDir(HUMAN)
  assert.equal(run('set', '--plan-dir', fresh, '--bump', 'minor', '--tag', 'v1.3.0', '--by', 'alpha', '--reason', 'r').code, 0)
  assert.match(notes(fresh), /SEAT NOTE/)
  assert.equal(statSync(join(fresh, 'human-notes.md')).mtimeMs, 0)
})

test('AC7: a seat proposing the SAME version as the human → no note, metadata unchanged', () => {
  const d = planDir(HUMAN)
  const before = metaBytes(d)
  const r = run('set', '--plan-dir', d, '--bump', 'patch', '--tag', 'v1.2.4', '--by', 'alpha')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.applied, false)
  assert.equal(r.json.disagreement, null)
  assert.equal(metaBytes(d), before)
  assert.equal(notes(d), null, 'no human-notes.md created')
})

test('AC7: an alpha-set (or null) version is revised by a seat — bump/tag changed, set_by = the seat, other fields kept', () => {
  for (const pv of [{ bump: 'PATCH', tag: 'v1.2.4', set_by: 'alpha', note: 'kept' }, { bump: null, tag: null, set_by: null, note: 'kept' }]) {
    const d = planDir({ ...HUMAN, proposed_version: pv })
    const r = run('set', '--plan-dir', d, '--bump', 'MINOR', '--tag', 'v1.3.0', '--by', 'debrief', '--reason', 'r')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.json.applied, true)
    const m = JSON.parse(metaBytes(d))
    assert.deepEqual(m.proposed_version, { bump: 'MINOR', tag: 'v1.3.0', set_by: 'debrief', note: 'kept' })
    assert.deepEqual(m.usage_delta, { x: 1 }, 'unrelated metadata preserved')
    assert.ok(metaBytes(d).endsWith('}\n'))
    assert.equal(notes(d), null)
  }
})

test('AC7: --by human over a human value applies; --tag none / --bump none record nulls', () => {
  const d = planDir(HUMAN)
  const r = run('set', '--plan-dir', d, '--bump', 'none', '--tag', 'none', '--by', 'human', '--reason', 'tooling only')
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.applied, true)
  assert.deepEqual(JSON.parse(metaBytes(d)).proposed_version, { bump: null, tag: null, set_by: 'human' })
})

test('AC7: a hunt with no proposed_version gets one with provenance', () => {
  const d = planDir({ feature: 'h' })
  const r = run('set', '--plan-dir', d, '--bump', 'PATCH', '--tag', 'v0.0.2', '--by', 'alpha')
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(metaBytes(d)).proposed_version, { bump: 'PATCH', tag: 'v0.0.2', set_by: 'alpha' })
})

test('AC7: bad arguments exit 2 and leave every file untouched', () => {
  const d = planDir(HUMAN)
  const before = metaBytes(d)
  const cases = [
    ['set', '--plan-dir', d, '--bump', 'huge', '--tag', 'v1', '--by', 'alpha'],          // bad bump
    ['set', '--plan-dir', d, '--bump', 'MINOR', '--tag', 'v1', '--by', 'intern'],        // unknown role
    ['set', '--plan-dir', d, '--tag', 'v1', '--by', 'alpha'],                            // no bump
    ['set', '--plan-dir', d, '--bump', 'MINOR', '--by', 'alpha'],                        // no tag
    ['set', '--bump', 'MINOR', '--tag', 'v1', '--by', 'alpha'],                          // no plan dir
    ['set', '--plan-dir', join(d, 'missing'), '--bump', 'MINOR', '--tag', 'v1', '--by', 'alpha'],
    ['frobnicate'],
  ]
  for (const args of cases) {
    const r = run(...args)
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /^wolfpack-version: /)
  }
  assert.equal(metaBytes(d), before)
  assert.equal(notes(d), null)
})

test('applyProposedVersion is pure (never mutates its input); seatNoteBlock renders "none" for null parts', () => {
  const input = JSON.parse(JSON.stringify(HUMAN))
  const snap = JSON.stringify(input)
  applyProposedVersion(input, { bump: 'MAJOR', tag: 'v2.0.0', by: 'alpha', reason: 'x' })
  const alphaIn = { proposed_version: { bump: 'PATCH', tag: 'v1', set_by: 'alpha' } }
  const r = applyProposedVersion(alphaIn, { bump: 'MAJOR', tag: 'v2.0.0', by: 'tracker' })
  assert.equal(JSON.stringify(input), snap)
  assert.deepEqual(alphaIn.proposed_version, { bump: 'PATCH', tag: 'v1', set_by: 'alpha' })
  assert.equal(r.meta.proposed_version.set_by, 'tracker')
  const b = seatNoteBlock({ date: '2026-10-21', role: 'pointer', current: { bump: 'PATCH', tag: null }, proposed: { bump: null, tag: null } })
  assert.match(b, /- Human-set \(stands\): PATCH none\n- pointer proposes: none none\n- Why: \(no reason given\)\n/)
  assert.match(b, /Only a human changes it/)
})

// ─── consolidation-acceptance AC12: --tag is validated (vMAJOR.MINOR.PATCH[-prerelease] | none) ───

test('consolidation-acceptance AC12: normTag accepts vX.Y.Z[-pre] and none/null/""; refuses every other shape', () => {
  for (const t of ['v1.2.3', 'v0.0.0', 'v1.0.0', 'v10.20.30', 'v1.0.0-rc.1', 'v1.0.0-alpha', 'v1.0.0-x-y.2']) {
    assert.equal(normTag(t), t, t)
    assert.ok(TAG_RE.test(t), t)
  }
  assert.equal(normTag('  v1.2.3  '), 'v1.2.3', 'trimmed')
  for (const v of ['none', 'NONE', 'None', 'null', '', '   ', null, undefined]) assert.equal(normTag(v), null, String(v))
  for (const bad of ['not-a-tag', '1.2.3', 'v1.2', 'v1', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3+b', 'v1.2.3+build.1',
    'V1.2.3', 'v1.2.3-', 'v1.2.3-rc..1', 'v1.2.3 extra', 'vX.Y.Z', 'v-1.2.3']) {
    assert.throws(() => normTag(bad), /invalid --tag .*vMAJOR\.MINOR\.PATCH\[-prerelease\] or none/, bad)
  }
})

test('consolidation-acceptance AC12: set --tag not-a-tag exits 2 with a --tag message; metadata and human-notes untouched', () => {
  for (const meta of [{ feature: 'h' }, HUMAN, { feature: 'h', proposed_version: { bump: 'PATCH', tag: 'v0.1.0', set_by: 'alpha' } }]) {
    const d = planDir(meta)
    const before = metaBytes(d)
    for (const bad of ['not-a-tag', '1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3+b']) {
      const r = run('set', '--plan-dir', d, '--bump', 'PATCH', '--tag', bad, '--by', 'alpha')
      assert.equal(r.code, 2, `${bad}: ${r.stdout}${r.stderr}`)
      assert.match(r.stderr, /^wolfpack-version: .*--tag/, bad)
      assert.equal(r.stdout, '', 'nothing printed on stdout for a refused call')
    }
    assert.equal(metaBytes(d), before, 'metadata.json byte-identical')
    assert.equal(notes(d), null, 'no seat note for a refused call')
  }
})

test('consolidation-acceptance AC12: set --tag v1.2.3 / v1.0.0-rc.1 / none are accepted and recorded', () => {
  for (const [tag, want] of [['v1.2.3', 'v1.2.3'], ['v1.0.0-rc.1', 'v1.0.0-rc.1'], ['none', null], ['NONE', null]]) {
    const d = planDir({ feature: 'h', usage_delta: { keep: true } })
    const r = run('set', '--plan-dir', d, '--bump', 'PATCH', '--tag', tag, '--by', 'alpha')
    assert.equal(r.code, 0, `${tag}: ${r.stderr}`)
    assert.equal(r.json.applied, true)
    const m = JSON.parse(metaBytes(d))
    assert.deepEqual(m.proposed_version, { bump: 'PATCH', tag: want, set_by: 'alpha' })
    assert.deepEqual(m.usage_delta, { keep: true }, 'other fields preserved')
  }
})

test('consolidation-acceptance AC12: a legacy stored tag is never re-validated (only the new --tag is)', () => {
  // an older hunt recorded a non-canonical tag; a seat re-proposing a valid one still applies over it
  const d = planDir({ feature: 'h', proposed_version: { bump: 'PATCH', tag: 'v1', set_by: 'alpha' } })
  const r = run('set', '--plan-dir', d, '--bump', 'MINOR', '--tag', 'v1.1.0', '--by', 'debrief')
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(metaBytes(d)).proposed_version, { bump: 'MINOR', tag: 'v1.1.0', set_by: 'debrief' })
})
