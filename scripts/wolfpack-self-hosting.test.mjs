#!/usr/bin/env node
// scripts/wolfpack-self-hosting.test.mjs — the repo wiring that lets wolfpack host its own
// hunts: synced skills ignored (AC9), the tracked .claude/workflows link (A-3), the plans dir,
// a well-formed public pedigree (AC2), and a CHANGELOG whose entries carry hunt attribution.
// Run: node --test scripts/wolfpack-self-hosting.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readlinkSync, lstatSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' })

test('AC9: .agents/skills/synced/ is git-ignored (harness-owned, never tracked)', () => {
  assert.equal(git('check-ignore', '-q', '.agents/skills/synced/x').status, 0)
  assert.equal(git('check-ignore', '-q', '.agents/skills/synced/some-skill/SKILL.md').status, 0)
  // a real pack skill is NOT ignored
  assert.equal(git('check-ignore', '-q', '.agents/skills/tracker/SKILL.md').status, 1)
  assert.equal(git('ls-files', '.agents/skills/synced').stdout.trim(), '', 'nothing tracked under synced/')
})

test('A-3: .claude/workflows is a TRACKED symlink to ../.agents/workflows (mode 120000), like commands/skills', () => {
  for (const [link, target] of [['workflows', '../.agents/workflows'], ['commands', '../.agents/commands'], ['skills', '../.agents/skills']]) {
    const p = join(ROOT, '.claude', link)
    assert.ok(lstatSync(p).isSymbolicLink(), `.claude/${link} is a symlink`)
    assert.equal(readlinkSync(p), target)
    const mode = git('ls-files', '-s', `.claude/${link}`).stdout.split(' ')[0]
    assert.equal(mode, '120000', `.claude/${link} tracked as a symlink`)
  }
  for (const wf of ['hunt-pipeline.js', 'campaign-runner.js']) {
    assert.ok(existsSync(join(ROOT, '.claude', 'workflows', wf)), `${wf} resolves through the link`)
  }
})

// seat-handoff-writes (human-directed): the pedigree index starts header-only, but every
// certified wolfpack-hosted hunt appends a row — so the check is on SHAPE, never on the row count.
// Returns the list of problems ([] = well-formed).
function pedigreeIndexProblems(text) {
  const rows = text.split('\n').filter(l => l.startsWith('|'))
  if (rows.length < 2) return [`expected a header and a separator row, found ${rows.length} table row(s)`]
  const cells = (l) => l.split('|')
  const problems = []
  if (!rows[0].startsWith('| Date | Feature |')) problems.push(`row 0 is not the header: ${rows[0]}`)
  const sep = cells(rows[1]).slice(1, -1)
  if (!sep.length || !sep.every(c => /^-+$/.test(c.trim()))) problems.push(`row 1 is not the separator: ${rows[1]}`)
  const width = cells(rows[0]).length
  for (const [i, l] of rows.entries()) {
    if (!l.trimEnd().endsWith('|')) problems.push(`row ${i} does not end with |: ${l}`)
    if (cells(l.trimEnd()).length !== width) problems.push(`row ${i} has ${cells(l.trimEnd()).length - 2} cells, the header has ${width - 2}: ${l}`)
  }
  return problems
}

test('AC2: plans dir exists (tracked .gitkeep); pedigree index tracked with a header, a separator and only well-formed data rows', () => {
  assert.equal(git('ls-files', '--error-unmatch', '.wolfpack/plans/.gitkeep').status, 0)
  assert.equal(git('ls-files', '--error-unmatch', '.wolfpack/pedigree/index.md').status, 0, 'the pedigree index is tracked')
  const idx = readFileSync(join(ROOT, '.wolfpack', 'pedigree', 'index.md'), 'utf8')
  assert.deepEqual(pedigreeIndexProblems(idx), [])
  assert.equal(git('ls-files', '.wolfpack/campaigns').stdout.trim(), '', 'campaign state is not tracked yet (wave 3)')
})

test('AC2 (shape check): header-only passes, an appended well-formed row passes, a wrong cell count or a broken header/separator fails', () => {
  const header = '| Date | Feature | Tier | Verdict |'
  const sep = '|------|---------|------|---------|'
  const base = `# Wolfpack Pedigree Index\n\n${header}\n${sep}\n`
  assert.deepEqual(pedigreeIndexProblems(base), [], 'header-only (a fresh public pedigree)')
  assert.deepEqual(pedigreeIndexProblems(`${base}| 2026-10-20 | seat-handoff-writes | Orange | PASS |\n`), [], 'one certified row')
  assert.deepEqual(pedigreeIndexProblems(`${base}| a | b | c | d |\n| e | f | g | h |\n`), [], 'several rows')
  assert.equal(pedigreeIndexProblems(`${base}| 2026-10-20 | x | Orange |\n`).length, 1, 'a short row fails')
  assert.equal(pedigreeIndexProblems(`${base}| 2026-10-20 | x | Orange | PASS | extra |\n`).length, 1, 'a long row fails')
  assert.ok(pedigreeIndexProblems(`${base}| 2026-10-20 | x | Orange | PASS\n`).length >= 1, 'a row without the closing | fails')
  assert.ok(pedigreeIndexProblems(`${header}\n`).length >= 1, 'no separator fails')
  assert.ok(pedigreeIndexProblems(`| Foo | Bar | Tier | Verdict |\n${sep}\n`).some(p => /not the header/.test(p)))
  assert.ok(pedigreeIndexProblems(`${header}\n| a | b | c | d |\n`).some(p => /not the separator/.test(p)))
  // the REAL index with a well-formed row appended (as this hunt's own certification will do) passes
  const real = readFileSync(join(ROOT, '.wolfpack', 'pedigree', 'index.md'), 'utf8')
  const width = real.split('\n').find(l => l.startsWith('| Date |')).split('|').length - 2
  const row = `| ${Array.from({ length: width }, (_, i) => (i === 0 ? '2026-10-20' : 'x')).join(' | ')} |`
  assert.deepEqual(pedigreeIndexProblems(`${real.trimEnd()}\n${row}\n`), [])
  assert.equal(pedigreeIndexProblems(`${real.trimEnd()}\n| 2026-10-20 | x |\n`).length, 1)
})

test('AC2: CHANGELOG has an [Unreleased] section and every entry carries a hunt attribution', () => {
  const cl = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  assert.match(cl, /^## \[Unreleased\]$/m)
  const entries = cl.split('\n').filter(l => /^- /.test(l))
  assert.ok(entries.length >= 1)
  for (const e of entries) assert.match(e, /<!-- hunt:[a-z0-9-]+ -->\s*$/, e)
  // The hunt's entries live under [Unreleased] until a wave stamps them, then under a version
  // heading — assert they exist under one of the two, not which (that changes at every release).
  const sections = cl.split(/^## /m).filter(s => /^\[(Unreleased|v[0-9][^\]]*)\]/.test(s))
  assert.ok(sections.some(s => s.includes('<!-- hunt:wolfpack-self-hosting -->')))
})

test('CLAUDE.md points at wolfpack-config.md and the one test command; README/SETUP referenced exist', () => {
  const md = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')
  assert.ok(md.split('\n').length <= 20, 'short')
  assert.match(md, /wolfpack-config\.md/)
  assert.match(md, /bash scripts\/test-all\.sh/)
  for (const f of ['README.md', 'SETUP.md', 'TODO.md', 'wolfpack-config.md']) assert.ok(existsSync(join(ROOT, f)), f)
})

test('the config\'s Test command is exactly what CI runs (one entry point)', () => {
  const out = execFileSync(process.execPath, [join(here, 'wolfpack-config.mjs'), '--json', join(ROOT, 'wolfpack-config.md')], { encoding: 'utf8' })
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.ok(ci.includes(`run: ${JSON.parse(out).testCommand}`))
})
