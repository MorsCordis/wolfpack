#!/usr/bin/env node
// scripts/pack-docs.test.mjs — the pack's own design docs (docs/autonomy/ + docs/user-guide.md):
// the eight autonomy files exist (AC1), no frontmatter project tag and 01/02 defer compliance to
// wolfpack-config.md (AC3), the retired doc-set path is gone from tracked files (AC4), every
// docs/autonomy/ citation resolves — directly or by numeric prefix (AC5), any retired consumer-guide
// citation names a real file (AC6), and README/SETUP link the docs.
// The name sits OUTSIDE scripts/wolfpack-* on purpose (AC7's pathspec). Old/fake paths are
// assembled at runtime so the real-repo scans never match this file's own text.
// Run: node --test scripts/pack-docs.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const AUTO = 'docs/' + 'autonomy'
const RETIRED_GUIDE = 'docs/wolf' + 'pack.md'
const OLD = 'wolfpack-' + 'autonomy'
const AUTO_FILES = [
  'README.md',
  '01-spec-driven-hunts.md',
  '02-park-resolve-resume.md',
  '03-convergence-and-verdict.md',
  '04-batch-merge-smoke.md',
  '05-limits-and-timing.md',
  '06-model-tiers-and-routing.md',
  '07-cross-model-execution.md',
]

const gitIn = (root, ...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' })

// AC5 resolver: same rule as the acceptance one-liner
// (git grep -ohE 'docs/autonomy/[A-Za-z0-9._-]*[A-Za-z0-9]' → ls -d $p $p-*).
function danglingCitations(root) {
  const re = AUTO + '/[A-Za-z0-9._-]*[A-Za-z0-9]'
  const r = gitIn(root, 'grep', '-ohE', re)
  assert.ok(r.status === 0 || r.status === 1, `git grep failed: ${r.stderr}`)
  const all = r.stdout.split('\n').filter(Boolean)
  const cites = [...new Set(all)]
  const dir = join(root, AUTO)
  const entries = existsSync(dir) ? readdirSync(dir) : []
  const dangling = cites.filter((p) => {
    if (existsSync(join(root, p))) return false
    const b = basename(p)
    return !entries.some((e) => e.startsWith(b + '-'))
  })
  return { cites, dangling, occurrences: all.length }
}

test('AC1: the eight docs/autonomy/ files exist and are non-empty', () => {
  for (const f of AUTO_FILES) {
    const p = join(ROOT, AUTO, f)
    assert.ok(existsSync(p), `missing ${AUTO}/${f}`)
    assert.ok(statSync(p).size > 0, `empty ${AUTO}/${f}`)
    assert.equal(gitIn(ROOT, 'ls-files', '--error-unmatch', `${AUTO}/${f}`).status, 0, `${AUTO}/${f} is tracked`)
  }
  assert.ok(existsSync(join(ROOT, 'docs', 'user-guide.md')), 'docs/user-guide.md exists')
})

test('AC4: the retired doc-set path appears in no tracked file', () => {
  const r = gitIn(ROOT, 'grep', '-n', OLD)
  assert.equal(r.status, 1, `unexpected hits:\n${r.stdout}`)
})

test('AC5: every docs/autonomy/ citation in tracked files resolves (direct or numeric prefix)', () => {
  const { cites, dangling, occurrences } = danglingCitations(ROOT)
  // 19 repointed lines + the moved docs' own cross-refs
  assert.ok(occurrences >= 19, `expected the repointed citations to be found, got ${occurrences}`)
  assert.deepEqual(dangling, [])
  // the short-form citations skills/scripts use must be among those resolved by prefix
  for (const short of ['01', '02', '03', '06']) {
    assert.ok(cites.includes(`${AUTO}/${short}`) || cites.some((c) => c.startsWith(`${AUTO}/${short}-`)),
      `some citation of ${AUTO}/${short} exists`)
  }
})

test('AC5 negative: the resolver flags a dangling numeric citation and a bare README', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pack-docs-'))
  try {
    assert.equal(gitIn(tmp, 'init', '-q').status, 0)
    mkdirSync(join(tmp, AUTO), { recursive: true })
    writeFileSync(join(tmp, AUTO, '06-model-tiers.md'), 'x\n')
    writeFileSync(join(tmp, AUTO, 'README.md'), 'x\n')
    const bad09 = `${AUTO}/0` + '9'
    const bareReadme = `${AUTO}/READ` + 'ME'
    writeFileSync(join(tmp, 'cite.md'),
      `ok ${AUTO}/06 §\nok ${AUTO}/README.md\nbad ${bad09} §\nbad ${bareReadme} § Build\n`)
    assert.equal(gitIn(tmp, 'add', 'cite.md', AUTO).status, 0)
    const { dangling } = danglingCitations(tmp)
    assert.deepEqual(dangling.sort(), [bad09, bareReadme].sort())
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('AC6: any retired consumer-guide citation in tracked files names an existing file', () => {
  const r = gitIn(ROOT, 'grep', '-ohE', RETIRED_GUIDE.replace('.', '\\.'))
  assert.ok(r.status === 0 || r.status === 1)
  for (const p of new Set(r.stdout.split('\n').filter(Boolean))) {
    assert.ok(existsSync(join(ROOT, p)), `dangling ${p}`)
  }
  // the hunt-pipeline tier-table comment now cites the pack guide, which carries "trust-Shepherd"
  const wf = readFileSync(join(ROOT, '.agents/workflows/hunt-pipeline.js'), 'utf8')
  assert.match(wf, /docs\/user-guide\.md tier table: "trust-Shepherd"/)
  assert.match(readFileSync(join(ROOT, 'docs/user-guide.md'), 'utf8'), /trust-Shepherd/)
})

test('AC3: no project frontmatter tag under docs/; 01 and 02 defer to wolfpack-config.md', () => {
  const files = [...AUTO_FILES.map((f) => join(ROOT, AUTO, f)), join(ROOT, 'docs', 'user-guide.md')]
  for (const p of files) {
    const txt = readFileSync(p, 'utf8')
    for (const line of txt.split('\n')) {
      assert.doesNotMatch(line, /^(tags|project):.*project\//, `${p}: ${line}`)
      assert.doesNotMatch(line, /^\s*- project\//, `${p}: ${line}`)
    }
  }
  for (const f of AUTO_FILES) {
    const txt = readFileSync(join(ROOT, AUTO, f), 'utf8')
    const fm = txt.match(/^---\n([\s\S]*?)\n---\n/)
    assert.ok(fm, `${f} keeps its frontmatter`)
    assert.match(fm[1], /^status:/m, `${f} keeps status:`)
    assert.match(fm[1], /- docs\/wolfpack\n/, `${f} tag docs/wolfpack`)
    assert.match(fm[1], /- docs\/autonomy\n?/, `${f} tag docs/autonomy`)
  }
  for (const f of ['01-spec-driven-hunts.md', '02-park-resolve-resume.md']) {
    assert.match(readFileSync(join(ROOT, AUTO, f), 'utf8'), /wolfpack-config\.md/, `${f} names wolfpack-config.md`)
  }
})

test('cited section headings survive the move verbatim', () => {
  const read = (f) => readFileSync(join(ROOT, AUTO, f), 'utf8')
  const six = read('06-model-tiers-and-routing.md')
  for (const h of ['The two tiers (a DEFAULT, not a cage)', "Give models their tools — don't box them",
    'Flexible allocation + learning (explore / exploit)', 'Guard against']) {
    assert.ok(six.includes(h), `06 keeps "${h}"`)
  }
  assert.match(six, /cross-tier, metered-with-fallback/)
  const three = read('03-convergence-and-verdict.md')
  for (const h of ['Part B — Convergence detection', 'Capped parallel review fan-out', 'The ledger as the model-grading substrate']) {
    assert.ok(three.includes(h), `03 keeps "${h}"`)
  }
  assert.ok(read('01-spec-driven-hunts.md').includes('The interview interface'))
  assert.ok(read('README.md').includes('Build process'))
})

test('README.md and SETUP.md link the pack docs', () => {
  for (const f of ['README.md', 'SETUP.md']) {
    const txt = readFileSync(join(ROOT, f), 'utf8')
    assert.ok(txt.includes('docs/user-guide.md'), `${f} mentions docs/user-guide.md`)
    assert.ok(txt.includes(AUTO + '/'), `${f} mentions ${AUTO}/`)
  }
  assert.ok(readFileSync(join(ROOT, 'README.md'), 'utf8').includes(`${AUTO}/README.md`), 'README links the design-set index')
})
