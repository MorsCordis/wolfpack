#!/usr/bin/env node
// scripts/wolfpack-self-hosting.test.mjs — the repo wiring that lets wolfpack host its own
// hunts: synced skills ignored (AC9), the tracked .claude/workflows link (A-3), the plans dir,
// an empty public pedigree (AC2), and a CHANGELOG whose entries carry hunt attribution.
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

test('AC2: plans dir exists (tracked .gitkeep); pedigree index tracked with header rows only', () => {
  assert.equal(git('ls-files', '--error-unmatch', '.wolfpack/plans/.gitkeep').status, 0)
  const idx = readFileSync(join(ROOT, '.wolfpack', 'pedigree', 'index.md'), 'utf8')
  assert.equal(idx.split('\n').filter(l => l.startsWith('|')).length, 2, 'header + separator only — a fresh public pedigree')
  assert.equal(git('ls-files', '.wolfpack/campaigns').stdout.trim(), '', 'campaign state is not tracked yet (wave 3)')
})

test('AC2: CHANGELOG has an [Unreleased] section and every entry carries a hunt attribution', () => {
  const cl = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  assert.match(cl, /^## \[Unreleased\]$/m)
  const entries = cl.split('\n').filter(l => /^- /.test(l))
  assert.ok(entries.length >= 1)
  for (const e of entries) assert.match(e, /<!-- hunt:[a-z0-9-]+ -->\s*$/, e)
  const unreleased = cl.split(/^## /m).find(s => s.startsWith('[Unreleased]'))
  assert.match(unreleased, /<!-- hunt:wolfpack-self-hosting -->/)
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
