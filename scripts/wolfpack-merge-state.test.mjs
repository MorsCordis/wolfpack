#!/usr/bin/env node
// scripts/wolfpack-merge-state.test.mjs — tests for scripts/wolfpack-merge-state.mjs
// (copy-back, stamp-merged, backfill-merged, attribute-changelog), merge-and-state-hygiene
// AC2–AC5, AC11. Driven against REAL git in throwaway repos under the OS temp dir
// (git init -b main, isolated config, no network) — the wolfpack-chain.test.mjs pattern.
// Run: node --test scripts/wolfpack-merge-state.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyBack, stampMerged, surveyMerged, backfillMerged, attributeUnreleased } from './wolfpack-merge-state.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, 'wolfpack-merge-state.mjs')

// ─── Isolated git environment ─────────────────────────────────────
const CFG_DIR = mkdtempSync(join(tmpdir(), 'wpms-cfg-'))
writeFileSync(join(CFG_DIR, 'gitconfig'), '')
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(CFG_DIR, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Merge State Test', GIT_AUTHOR_EMAIL: 'ms-test@example.invalid',
  GIT_COMMITTER_NAME: 'Merge State Test', GIT_COMMITTER_EMAIL: 'ms-test@example.invalid',
})
const ROOTS = [CFG_DIR]
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }) })

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sha = (cwd, ref) => g(cwd, 'rev-parse', ref)
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text) }
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'))
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
function commitFiles(dir, files, msg) {
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text)
  g(dir, 'add', '--', ...Object.keys(files))
  g(dir, 'commit', '-q', '-m', msg)
  return sha(dir, 'HEAD')
}
const tmp = (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); ROOTS.push(d); return d }
// A repo on main. `ignorePlans` keeps .wolfpack/plans/ gitignored (the pack's layout); a tracked
// pedigree.json needs a negation, so the AC2 (c) repo passes false.
function repo({ ignorePlans = true, files = {} } = {}) {
  const root = tmp('wpms-repo-')
  g(root, 'init', '-q', '-b', 'main')
  commitFiles(root, { '.gitignore': `${ignorePlans ? '.wolfpack/plans/\n' : ''}.wt/\n`, 'app.txt': 'a\n', ...files }, 'initial')
  return root
}
// Branch feat/<slug> from main with one commit, merged back --no-ff ("Merge branch 'feat/<slug>'").
function mergeFeat(root, slug, files = { [`${slug}.txt`]: `${slug}\n` }, branch = `feat/${slug}`) {
  g(root, 'checkout', '-q', '-b', branch, 'main')
  commitFiles(root, files, `feat(${slug})`)
  g(root, 'checkout', '-q', 'main')
  g(root, 'merge', '-q', '--no-ff', branch, '-m', `Merge branch '${branch}'`)
  return sha(root, 'HEAD')
}
const writeMeta = (dir, meta) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n') }
const cli = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* text output */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

// ════════════════════════════════════════════════════════════════════════════
// AC2 — copy-back: contents into <main>/.wolfpack/plans/<slug>, never nested, never archived
// ════════════════════════════════════════════════════════════════════════════

function srcPlan() {
  const src = join(tmp('wpms-src-'), 'h')
  put(src, 'metadata.json', '{"status":"certified"}\n')
  put(src, 'plan-final.md', '# plan\n')
  put(src, 'seat-notes/pointer-r1.md', 'note\n')
  put(src, 'pedigree.json', '{"score":5}\n')
  return src
}
const SRC_FILES = ['metadata.json', 'pedigree.json', 'plan-final.md', 'seat-notes/pointer-r1.md']

test('AC2 (a): no target — created, every source file byte-equal, no nested <slug>/<slug>', () => {
  const src = srcPlan()
  const dest = join(tmp('wpms-dst-'), '.wolfpack', 'plans', 'h')
  const r = copyBack({ src, dest })
  assert.equal(r.created, true)
  assert.deepEqual([...r.copied].sort(), SRC_FILES)
  assert.deepEqual(r.overwritten, [])
  for (const f of SRC_FILES) assert.equal(hash(join(dest, f)), hash(join(src, f)), f)
  assert.equal(existsSync(join(dest, 'h')), false, 'never nests')
})

test('AC2 (b): existing target — source wins, a differing file is reported overwritten, an extra target file is kept, still no nesting', () => {
  const src = srcPlan()
  const dest = join(tmp('wpms-dst-'), 'h')
  put(dest, 'plan-final.md', '# OLD plan\n')        // differs → overwritten
  put(dest, 'metadata.json', '{"status":"certified"}\n')   // identical → copied, not "overwritten"
  put(dest, 'only-in-main.md', 'keep me\n')
  const r = copyBack({ src, dest })
  assert.equal(r.created, false)
  assert.deepEqual(r.overwritten, ['plan-final.md'])
  for (const f of SRC_FILES) assert.equal(readFileSync(join(dest, f), 'utf8'), readFileSync(join(src, f), 'utf8'), f)
  assert.equal(readFileSync(join(dest, 'only-in-main.md'), 'utf8'), 'keep me\n')
  assert.equal(existsSync(join(dest, 'h')), false)
  // a second copy-back (the target now exists AND holds a dir named like nothing new) still never nests
  const r2 = copyBack({ src, dest })
  assert.deepEqual(r2.overwritten, [])
  assert.equal(existsSync(join(dest, 'h')), false)
})

test('AC2 (c): a target whose pedigree.json is TRACKED → overwritten in place (git shows modified, never deleted), no .prior-* archive', () => {
  const root = repo({ ignorePlans: false })
  const mainPlan = join(root, '.wolfpack', 'plans', 'h')
  commitFiles(root, { '.wolfpack/plans/h/pedigree.json': '{"score":1}\n' }, 'pedigree')
  const src = srcPlan()
  const r = cli(root, 'copy-back', '--slug', 'h', '--from', src, '--repo', root)
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.json.status, 'copied')
  assert.equal(r.json.dest, mainPlan)
  assert.ok(r.json.overwritten.includes('pedigree.json'))
  assert.equal(hash(join(mainPlan, 'pedigree.json')), hash(join(src, 'pedigree.json')))
  const st = g(root, 'status', '--porcelain', '--', '.wolfpack/plans/h/pedigree.json')
  assert.match(st, /^ ?M /, `pedigree.json is modified, not deleted: ${JSON.stringify(st)}`)
  assert.doesNotMatch(g(root, 'status', '--porcelain'), /^ ?D /m, 'no tracked deletion anywhere')
  assert.equal(existsSync(join(mainPlan, 'h')), false)
  assert.deepEqual(execFileSync('ls', ['-a', join(root, '.wolfpack', 'plans')], { encoding: 'utf8' }).split('\n').filter(n => n.includes('prior')), [])
})

test('AC2: same path is a no-op; a missing source throws; symlinks are recreated as links', () => {
  const src = srcPlan()
  assert.deepEqual(copyBack({ src, dest: src }), { created: false, copied: [], overwritten: [] })
  assert.throws(() => copyBack({ src: join(src, 'nope'), dest: join(tmp('wpms-dst-'), 'x') }), /copy-back: source plan dir .* does not exist/)
  symlinkSync('plan-final.md', join(src, 'latest.md'))
  const dest = join(tmp('wpms-dst-'), 'h')
  put(dest, 'latest.md', 'a regular file the link replaces\n')
  copyBack({ src, dest })
  assert.ok(lstatSync(join(dest, 'latest.md')).isSymbolicLink())
  assert.equal(readlinkSync(join(dest, 'latest.md')), 'plan-final.md')
})

test('AC2 CLI: bad slug / missing --from refuse with exit 2 and a JSON reason', () => {
  const root = repo()
  for (const args of [['--slug', 'Bad_Slug', '--from', '/x'], ['--slug', 'h']]) {
    const r = cli(root, 'copy-back', ...args, '--repo', root)
    assert.equal(r.code, 2)
    assert.equal(r.json.status, 'error')
  }
  const u = cli(root, 'bogus', '--repo', root)
  assert.equal(u.code, 2)
  assert.match(u.json.reason, /^usage:/)
})

// ════════════════════════════════════════════════════════════════════════════
// AC3 — stamp-merged: always (worktree or not), fail loud off main, merged_at kept on re-stamp
// ════════════════════════════════════════════════════════════════════════════

test('AC3: a worktree hunt — BOTH metadata copies stamped merged / done / merge_commit / merged_at', () => {
  const root = repo()
  const wt = join(root, '.wt', 'h')
  g(root, 'worktree', 'add', '-q', wt, '-b', 'feat/h', 'main')
  const meta = { feature: 'h', status: 'certified', phase: 'certify', tier: 'Yellow', usage_delta: { keep: 1 } }
  writeMeta(join(wt, '.wolfpack', 'plans', 'h'), meta)
  writeMeta(join(root, '.wolfpack', 'plans', 'h'), meta)
  commitFiles(wt, { 'h.txt': 'h\n' }, 'feat(h)')
  g(root, 'merge', '-q', '--no-ff', 'feat/h', '-m', "Merge branch 'feat/h'")
  const M = sha(root, 'main')
  const r = stampMerged(root, 'h', { mergeCommit: M, at: '2026-10-21T00:00:00.000Z' })
  assert.deepEqual(r, { status: 'stamped', slug: 'h', merge_commit: M, merged_at: '2026-10-21T00:00:00.000Z', released_version: null })
  for (const d of [join(wt, '.wolfpack', 'plans', 'h'), join(root, '.wolfpack', 'plans', 'h')]) {
    const m = readJ(join(d, 'metadata.json'))
    assert.equal(m.status, 'merged', d)
    assert.equal(m.phase, 'done', d)
    assert.equal(m.merge_commit, M, d)
    assert.equal(m.merged_at, '2026-10-21T00:00:00.000Z', d)
    assert.deepEqual(m.usage_delta, { keep: 1 }, 'other fields preserved')
    assert.equal('released_version' in m, false, 'released_version untouched without the flag')
  }
})

test('AC3: a --no-worktree hunt (main copy only) is stamped too; an abbreviated SHA is resolved to the full one', () => {
  const root = repo()
  writeMeta(join(root, '.wolfpack', 'plans', 'n'), { feature: 'n', status: 'certified' })
  const M = mergeFeat(root, 'n')
  const r = cli(root, 'stamp-merged', '--slug', 'n', '--merge-commit', M.slice(0, 10), '--at', '2026-10-21T01:00:00.000Z', '--repo', root)
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.json.merge_commit, M)
  const m = readJ(join(root, '.wolfpack', 'plans', 'n', 'metadata.json'))
  assert.equal(m.status, 'merged')
  assert.equal(m.phase, 'done')
  assert.equal(m.merge_commit, M)
  assert.equal(m.merged_at, '2026-10-21T01:00:00.000Z')
})

test('AC3: a SHA that is not on main / does not resolve / is absent fails loud and writes nothing', () => {
  const root = repo()
  writeMeta(join(root, '.wolfpack', 'plans', 'x'), { feature: 'x', status: 'certified' })
  g(root, 'checkout', '-q', '-b', 'feat/x')
  const off = commitFiles(root, { 'x.txt': 'x\n' }, 'feat(x)')
  g(root, 'checkout', '-q', 'main')
  const before = hash(join(root, '.wolfpack', 'plans', 'x', 'metadata.json'))
  assert.throws(() => stampMerged(root, 'x', { mergeCommit: off }), /fail loud: .* is not on main/)
  assert.throws(() => stampMerged(root, 'x', { mergeCommit: 'f'.repeat(40) }), /fail loud: .* does not resolve to a commit/)
  assert.throws(() => stampMerged(root, 'x', {}), /--merge-commit is required/)
  assert.throws(() => stampMerged(root, 'X!', { mergeCommit: off }), /--slug must match/)
  const r = cli(root, 'stamp-merged', '--slug', 'x', '--merge-commit', off, '--repo', root)
  assert.equal(r.code, 2)
  assert.match(r.json.reason, /is not on main/)
  assert.equal(hash(join(root, '.wolfpack', 'plans', 'x', 'metadata.json')), before)
})

test('AC3: re-stamping with --released-version keeps merged_at; --released-version "" records null', () => {
  const root = repo()
  writeMeta(join(root, '.wolfpack', 'plans', 'r'), { feature: 'r', status: 'certified' })
  const M = mergeFeat(root, 'r')
  stampMerged(root, 'r', { mergeCommit: M, at: '2026-10-21T02:00:00.000Z' })
  const a = cli(root, 'stamp-merged', '--slug', 'r', '--merge-commit', M, '--released-version', 'v0.5.0', '--at', '2026-10-22T00:00:00.000Z', '--repo', root)
  assert.equal(a.code, 0, a.stdout + a.stderr)
  assert.equal(a.json.merged_at, '2026-10-21T02:00:00.000Z', 'merged_at kept')
  assert.equal(a.json.released_version, 'v0.5.0')
  const b = cli(root, 'stamp-merged', '--slug', 'r', '--merge-commit', M, '--released-version', '', '--repo', root)
  assert.equal(b.code, 0, b.stdout + b.stderr)
  const m = readJ(join(root, '.wolfpack', 'plans', 'r', 'metadata.json'))
  assert.equal(m.released_version, null)
  assert.equal(m.merged_at, '2026-10-21T02:00:00.000Z')
})

// ════════════════════════════════════════════════════════════════════════════
// AC4 / AC5 — backfill-merged: git-proven survey first, dry run by default, idempotent --apply
// ════════════════════════════════════════════════════════════════════════════

function backfillRepo() {
  const root = repo()
  const plans = join(root, '.wolfpack', 'plans')
  for (const s of ['a', 'b', 'c']) writeMeta(join(plans, s), { feature: s, status: 'certified', usage_delta: { s } })
  writeMeta(join(plans, 'd'), { feature: 'd', status: 'certified', branch: 'fix/d-custom' })   // provable via meta.branch
  writeMeta(join(plans, 'm'), { feature: 'm', status: 'merged', merge_commit: 'x' })           // not certified: ignored
  writeMeta(join(plans, 'a.prior-20260101-000000'), { feature: 'a', status: 'certified' })    // archive dir: skipped
  const A = mergeFeat(root, 'a')
  const B = mergeFeat(root, 'b')
  const D = mergeFeat(root, 'd', { 'd.txt': 'd\n' }, 'fix/d-custom')
  // c: a feat/c branch exists but was never merged
  g(root, 'branch', 'feat/c', 'main')
  const metas = ['a', 'b', 'c', 'd', 'm', 'a.prior-20260101-000000'].map(s => join(plans, s, 'metadata.json'))
  return { root, plans, A, B, D, metas }
}
const hashes = (paths) => paths.map(hash)

test('AC4: the survey counts certified vs git-provable; the dry run prints them and writes nothing', () => {
  const { root, A, B, D, metas } = backfillRepo()
  const s = surveyMerged(root)
  assert.deepEqual(s.certified, ['a', 'b', 'c', 'd'])
  assert.deepEqual(s.provable.map(p => p.slug), ['a', 'b', 'd'])
  assert.deepEqual(s.unprovable, ['c'])
  assert.equal(s.provable.find(p => p.slug === 'a').commit, A)
  assert.equal(s.provable.find(p => p.slug === 'b').commit, B)
  assert.equal(s.provable.find(p => p.slug === 'd').commit, D)
  const before = hashes(metas)
  const r = cli(root, 'backfill-merged', '--repo', root)
  assert.equal(r.code, 0, r.stderr)
  const lines = r.stdout.split('\n')
  assert.equal(lines[0], 'certified=4 provable=3')
  assert.equal(lines[1], 'provable: a b d')
  assert.equal(lines[2], 'unprovable: c')
  assert.doesNotMatch(r.stdout, /stamped:/)
  assert.deepEqual(hashes(metas), before, 'dry run: every metadata byte-identical')
  assert.deepEqual(backfillMerged(root).stamped, [])
})

test('AC5: --apply stamps exactly the provable hunts (from the merge commit); a second --apply is a no-op', () => {
  const { root, plans, A, metas } = backfillRepo()
  const cBefore = hash(join(plans, 'c', 'metadata.json'))
  const r = cli(root, 'backfill-merged', '--apply', '--repo', root)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /^certified=4 provable=3\n/)
  assert.match(r.stdout, /\nstamped: a b d\n/)
  const a = readJ(join(plans, 'a', 'metadata.json'))
  assert.equal(a.status, 'merged')
  assert.equal(a.phase, 'done')
  assert.equal(a.backfilled, true)
  assert.equal(a.merge_commit, A)
  assert.equal(a.merged_at, g(root, 'log', '-1', '--format=%cI', A))
  assert.deepEqual(a.usage_delta, { s: 'a' }, 'other fields preserved')
  assert.equal(readJ(join(plans, 'd', 'metadata.json')).status, 'merged')
  assert.equal(hash(join(plans, 'c', 'metadata.json')), cBefore, 'unprovable c untouched')
  assert.equal(readJ(join(plans, 'a.prior-20260101-000000', 'metadata.json')).status, 'certified', 'archive dir untouched')
  // idempotent
  const after1 = hashes(metas)
  const r2 = cli(root, 'backfill-merged', '--apply', '--repo', root)
  assert.equal(r2.code, 0, r2.stderr)
  assert.match(r2.stdout, /^certified=1 provable=0\n/)
  assert.deepEqual(hashes(metas), after1, 'second --apply writes nothing')
})

test('AC5: --apply stamps the worktree copy INDEPENDENTLY (its own fields kept, never copied over the main one)', () => {
  const root = repo()
  const wt = join(root, '.wt', 'w')
  g(root, 'worktree', 'add', '-q', wt, '-b', 'feat/w', 'main')
  writeMeta(join(root, '.wolfpack', 'plans', 'w'), { feature: 'w', status: 'certified', only_main: 1 })
  writeMeta(join(wt, '.wolfpack', 'plans', 'w'), { feature: 'w', status: 'certified', only_wt: 2 })
  commitFiles(wt, { 'w.txt': 'w\n' }, 'feat(w)')
  g(root, 'merge', '-q', '--no-ff', 'feat/w', '-m', "Merge branch 'feat/w'")
  const r = backfillMerged(root, { apply: true })
  assert.deepEqual(r.stamped, ['w'])
  const m = readJ(join(root, '.wolfpack', 'plans', 'w', 'metadata.json'))
  const w = readJ(join(wt, '.wolfpack', 'plans', 'w', 'metadata.json'))
  assert.equal(m.status, 'merged'); assert.equal(w.status, 'merged')
  assert.equal(m.only_main, 1); assert.equal('only_wt' in m, false)
  assert.equal(w.only_wt, 2); assert.equal('only_main' in w, false)
})

test('AC4: a repo with no plans dir surveys empty', () => {
  const root = repo()
  assert.deepEqual(surveyMerged(root), { certified: [], provable: [], unprovable: [] })
  const r = cli(root, 'backfill-merged', '--repo', root)
  assert.equal(r.stdout.split('\n')[0], 'certified=0 provable=0')
})

// ════════════════════════════════════════════════════════════════════════════
// AC11 / AC12 — attribute-changelog: tag + place untagged [Unreleased] items; never delete
// ════════════════════════════════════════════════════════════════════════════

const CL0 = [
  '# Changelog', '', '## [Unreleased]', '',
  '### Added', '- a first <!-- hunt:a -->', '- z item <!-- hunt:z -->', '',
  '### Fixed', '- fixed thing <!-- hunt:z -->', '',
  '## [v0.1.0] — 2026-01-01', '- old untagged item', '',
].join('\n')
const withLine = (text, after, line) => text.replace(`${after}\n`, `${after}\n${line}\n`)

function changelogRepo() {
  const root = repo({ files: { 'CHANGELOG.md': CL0 } })
  // item 1: introduced on feat/a (appended at the end of ### Added), merged --no-ff
  g(root, 'checkout', '-q', '-b', 'feat/a', 'main')
  commitFiles(root, { 'CHANGELOG.md': withLine(CL0, '- z item <!-- hunt:z -->', '- a second (untagged)') }, 'feat(a): add item')
  g(root, 'checkout', '-q', 'main')
  g(root, 'merge', '-q', '--no-ff', 'feat/a', '-m', "Merge branch 'feat/a'")
  // item 2: committed straight to main
  let cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  commitFiles(root, { 'CHANGELOG.md': withLine(cl, '- fixed thing <!-- hunt:z -->', '- direct to main') }, 'docs: direct')
  // item 3: carried by a non-feat merge (fix/changelog-x) → unattributable
  cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  g(root, 'checkout', '-q', '-b', 'fix/changelog-x', 'main')
  commitFiles(root, { 'CHANGELOG.md': withLine(cl, '- direct to main', '- via fix branch') }, 'fix: changelog')
  g(root, 'checkout', '-q', 'main')
  g(root, 'merge', '-q', '--no-ff', 'fix/changelog-x', '-m', "Merge branch 'fix/changelog-x'")
  // item 4: in the working tree only (never committed) → no introducing commit
  cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  writeFileSync(join(root, 'CHANGELOG.md'), withLine(cl, '- via fix branch', '- uncommitted'))
  return root
}
const dashLines = (t) => t.split('\n').filter(l => /^\s*-\s/.test(l))
const strip = (l) => l.replace(/\s*<!--\s*hunt:[a-z0-9-]+\s*-->\s*$/, '')

test('AC11: a feat-merged item is tagged and moved after that hunt\'s item; direct / fix-branch / uncommitted items stay, loudly; nothing deleted', () => {
  const root = changelogRepo()
  const before = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const r = attributeUnreleased(root)
  assert.deepEqual(r.attributed, [{ line: '- a second (untagged)', slug: 'a' }])
  assert.deepEqual(r.unattributed, ['- direct to main', '- via fix branch', '- uncommitted'])
  const lines = r.text.split('\n')
  const iA1 = lines.indexOf('- a first <!-- hunt:a -->')
  assert.equal(lines[iA1 + 1], '- a second (untagged) <!-- hunt:a -->', 'placed right after the existing hunt:a item')
  assert.equal(lines[iA1 + 2], '- z item <!-- hunt:z -->')
  const unrel = r.text.split('## [v0.1.0]')[0]
  for (const l of r.unattributed) assert.ok(unrel.includes(`${l}\n`), `${l} still under [Unreleased]`)
  assert.equal(dashLines(r.text).length, dashLines(before).length, '- line count unchanged')
  assert.deepEqual(dashLines(r.text).map(strip).sort(), dashLines(before).map(strip).sort())
  assert.ok(r.text.includes('## [v0.1.0] — 2026-01-01\n- old untagged item\n'), 'an older version heading is untouched')
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), before, 'the function never writes')
})

test('AC11 CLI: without --apply the file is untouched; --apply writes it; unattributed items go to stderr', () => {
  const root = changelogRepo()
  const before = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const dry = cli(root, 'attribute-changelog', '--repo', root)
  assert.equal(dry.code, 0, dry.stderr)
  assert.deepEqual(dry.json.attributed, [{ line: '- a second (untagged)', slug: 'a' }])
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), before)
  for (const l of ['- direct to main', '- via fix branch', '- uncommitted']) {
    assert.ok(dry.stderr.includes(`⚠ unattributed [Unreleased] item (left in place): ${l}`), dry.stderr)
  }
  const ap = cli(root, 'attribute-changelog', '--apply', '--file', 'CHANGELOG.md', '--repo', root)
  assert.equal(ap.code, 0, ap.stderr)
  const now = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(now, /- a first <!-- hunt:a -->\n- a second \(untagged\) <!-- hunt:a -->\n/)
  assert.equal(dashLines(now).length, dashLines(before).length)
  // re-run: nothing left to attribute, file unchanged
  const again = cli(root, 'attribute-changelog', '--apply', '--repo', root)
  assert.deepEqual(again.json.attributed, [])
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), now)
})

test('AC11: an attributed item whose hunt has no other item in its group stays in place (tagged)', () => {
  const base = ['# Changelog', '', '## [Unreleased]', '', '### Added', '- other <!-- hunt:z -->', ''].join('\n')
  const root = repo({ files: { 'CHANGELOG.md': base } })
  mergeFeat(root, 'q', { 'CHANGELOG.md': withLine(base, '- other <!-- hunt:z -->', '- q item') })
  const r = attributeUnreleased(root)
  assert.deepEqual(r.attributed, [{ line: '- q item', slug: 'q' }])
  assert.match(r.text, /- other <!-- hunt:z -->\n- q item <!-- hunt:q -->\n/)
})

test('AC11: the chain runner\'s "Merge branch \'feat/<h>\' into campaign/<c>" subject attributes against that ref', () => {
  const base = ['# Changelog', '', '## [Unreleased]', '', '### Added', '- base <!-- hunt:z -->', ''].join('\n')
  const root = repo({ files: { 'CHANGELOG.md': base } })
  g(root, 'branch', 'campaign/c', 'main')
  g(root, 'checkout', '-q', '-b', 'feat/k', 'campaign/c')
  commitFiles(root, { 'CHANGELOG.md': withLine(base, '- base <!-- hunt:z -->', '- k item') }, 'feat(k)')
  g(root, 'checkout', '-q', 'campaign/c')
  g(root, 'merge', '-q', '--no-ff', 'feat/k', '-m', "Merge branch 'feat/k' into campaign/c")
  g(root, 'checkout', '-q', 'main')
  const text = g(root, 'show', 'campaign/c:CHANGELOG.md') + '\n'
  const r = attributeUnreleased(root, { text, ref: 'refs/heads/campaign/c' })
  assert.deepEqual(r.attributed, [{ line: '- k item', slug: 'k' }])
})

test('AC11: no [Unreleased] section → unchanged, nothing attributed', () => {
  const root = repo({ files: { 'CHANGELOG.md': '# Changelog\n\n## [v1.0.0]\n- x\n' } })
  const r = attributeUnreleased(root)
  assert.deepEqual(r, { text: '# Changelog\n\n## [v1.0.0]\n- x\n', attributed: [], unattributed: [] })
})

test('AC12: the pack\'s own CHANGELOG [Unreleased] has no untagged item (the hygiene the command now enforces)', () => {
  const cl = readFileSync(join(here, '..', 'CHANGELOG.md'), 'utf8')
  const m = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m.exec(cl)
  // (a release stamp may leave [Unreleased] empty or absent — AC14: never assert pre-release state)
  const untagged = (m ? m[1] : '').split('\n').filter(l => /^- /.test(l) && !/<!-- hunt:/.test(l))
  assert.deepEqual(untagged, [])
})
