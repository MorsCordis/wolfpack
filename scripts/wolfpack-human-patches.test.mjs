#!/usr/bin/env node
// scripts/wolfpack-human-patches.test.mjs — tests for the human-patch gate's target-repo core
// (scripts/lib/human-patch.mjs) and its deterministic probe (scripts/wolfpack-human-patches.mjs),
// consolidation-acceptance AC1–AC3. Driven against REAL git in throwaway repos under the OS temp
// dir (git init -b main, isolated config, no network) — the wolfpack-merge-state.test.mjs pattern.
// Run: node --test scripts/wolfpack-human-patches.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { HUMAN_PATCH_TARGETS, humanPatchTarget, humanPatchRepo, humanPatchApplySteps } from './lib/human-patch.mjs'
import { checkHumanPatches, patchPaths } from './wolfpack-human-patches.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, 'wolfpack-human-patches.mjs')

// ─── Isolated git environment ─────────────────────────────────────
const CFG_DIR = mkdtempSync(join(tmpdir(), 'wphp-cfg-'))
writeFileSync(join(CFG_DIR, 'gitconfig'), '')
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(CFG_DIR, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Human Patch Test', GIT_AUTHOR_EMAIL: 'hp-test@example.invalid',
  GIT_COMMITTER_NAME: 'Human Patch Test', GIT_COMMITTER_EMAIL: 'hp-test@example.invalid',
})
const ROOTS = [CFG_DIR]
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }) })

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (prefix) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); ROOTS.push(d); return d }
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text) }

// A repo on main with one committed protected file.
function repo(prefix, rel = '.claude/hooks/guard.sh', text = 'echo old\n') {
  const root = tmp(prefix)
  g(root, 'init', '-q', '-b', 'main')
  put(root, rel, text)
  g(root, 'add', '--', rel)
  g(root, 'commit', '-q', '-m', 'initial')
  return root
}
// A unified diff (worktree-relative a/ b/ paths) turning `from` into `to` at `rel` — made by git
// itself in the repo, then the working tree is restored, so the patch is NOT applied.
function makePatch(root, rel, to) {
  writeFileSync(join(root, rel), to)
  const diff = g(root, 'diff', '--', rel) + '\n'
  g(root, 'checkout', '-q', '--', rel)
  return diff
}
// A hunt worktree (W) with a plan dir (D) inside, plus an optional consumer worktree (C).
function scenario({ consumer = true, consumerMeta } = {}) {
  const W = repo('wphp-hunt-')
  const D = join(W, '.wolfpack', 'plans', 'h')
  mkdirSync(join(D, 'human-patches'), { recursive: true })
  const C = consumer ? repo('wphp-consumer-', '.claude/hooks/smoke.sh', 'echo c-old\n') : null
  const meta = { feature: 'h', status: 'implementing' }
  if (consumerMeta !== undefined) { if (consumerMeta !== null) meta.consumer_worktree = consumerMeta }
  else if (C) meta.consumer_worktree = { path: C, branch: 'feat/h-consumer' }
  writeFileSync(join(D, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n')
  return { W, D, C }
}
const cli = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* asserted by callers */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

// ════════════════════════════════════════════════════════════════════════════
// AC1 — the pure core: target from location, repo per target
// ════════════════════════════════════════════════════════════════════════════

test('AC1: humanPatchTarget — a top-level patch targets the hunt; consumer/<name>.patch targets the consumer; anything else throws', () => {
  assert.deepEqual(HUMAN_PATCH_TARGETS, ['hunt', 'consumer'])
  assert.equal(humanPatchTarget('01-guard.patch'), 'hunt')
  assert.equal(humanPatchTarget('consumer/01-smoke.patch'), 'consumer')
  for (const bad of ['a/b/c.patch', 'other/x.patch', 'consumer/sub/x.patch', 'consumer/', 'x.diff', 'consumer/x.diff',
    '', null, undefined, '/abs/x.patch']) {
    assert.throws(() => humanPatchTarget(bad), /not <name>\.patch or consumer\/<name>\.patch/, String(bad))
  }
})

test('AC1: humanPatchRepo — no target (hunt) → worktreePath; consumer → the recorded consumer path; no record → throws', () => {
  const ctx = { worktreePath: '/w/hunt', consumer: { path: '/c/consumer', branch: 'feat/x' } }
  assert.equal(humanPatchRepo('hunt', ctx), '/w/hunt')
  assert.equal(humanPatchRepo('hunt', { worktreePath: '/w/hunt', consumer: null }), '/w/hunt', 'a hunt patch never needs a consumer')
  assert.equal(humanPatchRepo('consumer', ctx), '/c/consumer')
  for (const consumer of [null, undefined, {}, { path: '' }, { path: 'relative/dir' }, { path: 42 }, { branch: 'feat/x' }]) {
    assert.throws(() => humanPatchRepo('consumer', { worktreePath: '/w/hunt', consumer }),
      /needs metadata\.consumer_worktree\.path \(absolute\)/, JSON.stringify(consumer))
  }
  for (const t of ['wolfpack', '', undefined, 'Consumer']) {
    assert.throws(() => humanPatchRepo(t, ctx), /unknown human-patch target/, String(t))
  }
})

// ════════════════════════════════════════════════════════════════════════════
// AC3 — the park's apply / add / commit lines name each patch's own repo + branch
// ════════════════════════════════════════════════════════════════════════════

test('AC3: humanPatchApplySteps — a consumer patch gets git -C <consumer> apply/add/commit, never git -C <hunt>; branches name the consumer branch', () => {
  const W = '/w/hunt'
  const C = '/c/consumer'
  const pending = [
    { patch: '/d/human-patches/consumer/01-smoke.patch', paths: ['.claude/hooks/smoke.sh'], applies: true, target: 'consumer' },
  ]
  const { steps, branches } = humanPatchApplySteps(pending, { worktreePath: W, consumer: { path: C, branch: 'feat/h-consumer' }, slug: 'h' })
  const lines = steps.split('\n')
  assert.deepEqual(lines, [
    `  git -C ${C} apply /d/human-patches/consumer/01-smoke.patch`,
    `  git -C ${C} add .claude/hooks/smoke.sh`,
    `  git -C ${C} commit -m "fix(hooks): apply the Shepherd's staged patch"`,
  ])
  assert.ok(!steps.includes(`git -C ${W}`), 'never the hunt worktree for a consumer patch')
  assert.deepEqual(branches, [`feat/h-consumer (consumer worktree ${C})`])
})

test('AC3: humanPatchApplySteps — mixed patches: hunt group first, then consumer; each repo gets its own add (deduped paths) + commit', () => {
  const W = '/w/hunt'
  const C = '/c/consumer'
  const pending = [
    { patch: '/d/hp/consumer/01-c.patch', paths: ['.claude/hooks/smoke.sh'], applies: false, target: 'consumer' },
    { patch: '/d/hp/01-a.patch', paths: ['.claude/hooks/a.sh', '.claude/settings.json'], applies: true, target: 'hunt' },
    { patch: '/d/hp/02-b.patch', paths: ['.claude/hooks/a.sh'], applies: true, target: 'hunt' },
  ]
  const { steps, branches } = humanPatchApplySteps(pending, { worktreePath: W, consumer: { path: C, branch: null }, slug: 'h' })
  assert.deepEqual(steps.split('\n'), [
    `  git -C ${W} apply /d/hp/01-a.patch`,
    `  git -C ${W} apply /d/hp/02-b.patch`,
    `  git -C ${W} add .claude/hooks/a.sh .claude/settings.json`,
    `  git -C ${W} commit -m "fix(hooks): apply the Shepherd's staged patch"`,
    `  git -C ${C} apply /d/hp/consumer/01-c.patch   # does NOT apply cleanly: inspect it first`,
    `  git -C ${C} add .claude/hooks/smoke.sh`,
    `  git -C ${C} commit -m "fix(hooks): apply the Shepherd's staged patch"`,
  ])
  // no consumer branch recorded → feat/<slug>, still labelled as the consumer worktree
  assert.deepEqual(branches, ['feat/h (hunt worktree)', `feat/h (consumer worktree ${C})`])
})

test('AC1/AC3: humanPatchApplySteps — hunt-only patches keep today\'s single-repo commands; a consumer patch without a record throws', () => {
  const { steps, branches } = humanPatchApplySteps(
    [{ patch: '/d/hp/01-a.patch', paths: ['.claude/hooks/a.sh'], applies: true, target: 'hunt' }],
    { worktreePath: '/w/hunt', consumer: null, slug: 'h' })
  assert.match(steps, /^ {2}git -C \/w\/hunt apply \/d\/hp\/01-a\.patch$/m)
  assert.deepEqual(branches, ['feat/h (hunt worktree)'])
  assert.deepEqual(humanPatchApplySteps([], { worktreePath: '/w', consumer: null, slug: 'h' }), { steps: '', branches: [] })
  assert.throws(() => humanPatchApplySteps(
    [{ patch: '/d/hp/consumer/01.patch', paths: ['x'], applies: true, target: 'consumer' }],
    { worktreePath: '/w', consumer: null, slug: 'h' }), /consumer_worktree/)
})

test('patchPaths: the b/ paths a patch touches, deduped, trailing tab+timestamp stripped; /dev/null (deletion) is not a b/ path', () => {
  const text = [
    'diff --git a/x.sh b/x.sh', '--- a/x.sh', '+++ b/x.sh', '@@ -1 +1 @@', '-a', '+b',
    '--- a/y.sh\t2026-10-21 00:00:00', '+++ b/y.sh\t2026-10-21 00:00:01', '@@ -1 +1 @@', '-a', '+b',
    '+++ b/x.sh', '--- a/gone.sh', '+++ /dev/null', '',
  ].join('\n')
  assert.deepEqual(patchPaths(text), ['x.sh', 'y.sh'])
  assert.deepEqual(patchPaths(''), [])
})

// ════════════════════════════════════════════════════════════════════════════
// AC2 — the deterministic probe checks each patch IN ITS OWN REPO
// ════════════════════════════════════════════════════════════════════════════

test('AC2: no human-patches dir / an empty one → {pending: [], consumer: null}, exit 0', () => {
  const { W, D } = scenario({ consumer: false })
  assert.deepEqual(checkHumanPatches({ planDir: D, worktree: W }), { pending: [], consumer: null })
  rmSync(join(D, 'human-patches'), { recursive: true })
  assert.deepEqual(checkHumanPatches({ planDir: D, worktree: W }), { pending: [], consumer: null })
  const r = cli('check', '--plan-dir', D, '--worktree', W)
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.deepEqual(r.json, { pending: [], consumer: null })
  // a non-.patch file is not a patch
  put(D, 'human-patches/README.md', 'notes\n')
  assert.deepEqual(cli('check', '--plan-dir', D, '--worktree', W).json, { pending: [], consumer: null })
})

test('AC2: a consumer patch the human ALREADY APPLIED in the consumer worktree is not pending (the -R probe runs there, not in the hunt worktree)', () => {
  const { W, D, C } = scenario()
  const patch = makePatch(C, '.claude/hooks/smoke.sh', 'echo c-new\n')
  put(D, 'human-patches/consumer/01-smoke.patch', patch)
  // unapplied → one pending, targeted at the consumer
  let r = cli('check', '--plan-dir', D, '--worktree', W)
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.json.pending.length, 1)
  const p = r.json.pending[0]
  assert.equal(p.target, 'consumer')
  assert.equal(p.repo, C)
  assert.equal(p.rel, 'consumer/01-smoke.patch')
  assert.equal(p.patch, join(D, 'human-patches', 'consumer', '01-smoke.patch'))
  assert.deepEqual(p.paths, ['.claude/hooks/smoke.sh'])
  assert.equal(p.applies, true)
  assert.deepEqual(r.json.consumer, { path: C, branch: 'feat/h-consumer' })
  // the human applies it in the consumer → nothing pending (no re-park)
  g(C, 'apply', join(D, 'human-patches', 'consumer', '01-smoke.patch'))
  r = cli('check', '--plan-dir', D, '--worktree', W)
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.deepEqual(r.json.pending, [])
  assert.equal(readFileSync(join(W, '.claude/hooks/guard.sh'), 'utf8'), 'echo old\n', 'the hunt worktree was never touched')
  // committed there too → still not pending
  g(C, 'commit', '-q', '-am', 'fix(hooks): apply')
  assert.deepEqual(checkHumanPatches({ planDir: D, worktree: W }).pending, [])
})

test('AC2: a hunt patch is still checked in the hunt worktree; mixed hunt + consumer → both pending, hunt first, each with its own repo', () => {
  const { W, D, C } = scenario()
  put(D, 'human-patches/consumer/01-smoke.patch', makePatch(C, '.claude/hooks/smoke.sh', 'echo c-new\n'))
  put(D, 'human-patches/02-guard.patch', makePatch(W, '.claude/hooks/guard.sh', 'echo new\n'))
  const r = checkHumanPatches({ planDir: D, worktree: W })
  assert.deepEqual(r.pending.map(x => [x.rel, x.target, x.repo, x.applies]), [
    ['02-guard.patch', 'hunt', W, true],
    ['consumer/01-smoke.patch', 'consumer', C, true],
  ])
  // apply the hunt one in the hunt worktree → only the consumer one stays
  g(W, 'apply', join(D, 'human-patches', '02-guard.patch'))
  assert.deepEqual(checkHumanPatches({ planDir: D, worktree: W }).pending.map(x => x.rel), ['consumer/01-smoke.patch'])
  // applying the consumer patch in the WRONG repo (the hunt worktree) is impossible (no such file) and
  // does not make it read as applied
  assert.throws(() => g(W, 'apply', '--check', join(D, 'human-patches', 'consumer', '01-smoke.patch')))
})

test('AC2: a hunt-only plan dir never reads metadata.consumer_worktree (absent is fine); a patch that does not apply is pending with applies:false', () => {
  const { W, D } = scenario({ consumer: false })
  const patch = makePatch(W, '.claude/hooks/guard.sh', 'echo new\n')
  // the target file moved on since the patch was written → neither forward nor reverse applies
  writeFileSync(join(W, '.claude/hooks/guard.sh'), 'echo something else entirely\n')
  g(W, 'commit', '-q', '-am', 'drift')
  put(D, 'human-patches/01-guard.patch', patch)
  rmSync(join(D, 'metadata.json'))
  const r = cli('check', '--plan-dir', D, '--worktree', W)
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.json.consumer, null)
  assert.equal(r.json.pending.length, 1)
  assert.equal(r.json.pending[0].target, 'hunt')
  assert.equal(r.json.pending[0].repo, W)
  assert.equal(r.json.pending[0].applies, false)
})

test('AC2 fail closed: a consumer patch with no consumer_worktree recorded → exit 2 {status:error}, never pending: []', () => {
  for (const consumerMeta of [null, { branch: 'feat/x' }, { path: 'relative/consumer' }]) {
    const { W, D } = scenario({ consumer: false, consumerMeta })
    put(D, 'human-patches/consumer/01-smoke.patch', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
    const r = cli('check', '--plan-dir', D, '--worktree', W)
    assert.equal(r.code, 2, `${JSON.stringify(consumerMeta)}: ${r.stdout}`)
    assert.equal(r.json.status, 'error')
    assert.match(r.json.reason, /consumer_worktree\.path/)
    assert.equal('pending' in r.json, false)
  }
  // metadata.json missing entirely with a consumer patch → error too
  const { W, D } = scenario({ consumer: false })
  rmSync(join(D, 'metadata.json'))
  put(D, 'human-patches/consumer/01-smoke.patch', '--- a/x\n+++ b/x\n')
  const r = cli('check', '--plan-dir', D, '--worktree', W)
  assert.equal(r.code, 2)
  assert.match(r.json.reason, /metadata\.json is missing/)
})

test('AC2 fail closed: the consumer path is not a git work tree → exit 2 naming it (never falls back to the hunt worktree)', () => {
  const notGit = tmp('wphp-notgit-')
  const { W, D } = scenario({ consumer: false, consumerMeta: { path: notGit, branch: 'feat/x' } })
  put(D, 'human-patches/consumer/01-smoke.patch', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
  const r = cli('check', '--plan-dir', D, '--worktree', W)
  assert.equal(r.code, 2, r.stdout)
  assert.equal(r.json.status, 'error')
  assert.ok(r.json.reason.includes(`${notGit} (the consumer repo for consumer/01-smoke.patch) is not a git work tree`), r.json.reason)
  const gone = join(notGit, 'does-not-exist')
  const s2 = scenario({ consumer: false, consumerMeta: { path: gone, branch: 'feat/x' } })
  put(s2.D, 'human-patches/consumer/01-smoke.patch', '--- a/x\n+++ b/x\n')
  assert.equal(cli('check', '--plan-dir', s2.D, '--worktree', s2.W).code, 2)
})

test('AC2 fail closed: a patch in an unexpected subdir (human-patches/other/x.patch) → exit 2, even alongside a valid patch', () => {
  const { W, D } = scenario({ consumer: false })
  put(D, 'human-patches/01-guard.patch', makePatch(W, '.claude/hooks/guard.sh', 'echo new\n'))
  put(D, 'human-patches/other/x.patch', '--- a/x\n+++ b/x\n')
  const r = cli('check', '--plan-dir', D, '--worktree', W)
  assert.equal(r.code, 2, r.stdout)
  assert.equal(r.json.status, 'error')
  assert.match(r.json.reason, /"other\/x\.patch": not <name>\.patch or consumer\/<name>\.patch/)
  // nested under consumer/ is unexpected too
  rmSync(join(D, 'human-patches', 'other'), { recursive: true })
  put(D, 'human-patches/consumer/deep/y.patch', '--- a/y\n+++ b/y\n')
  assert.equal(cli('check', '--plan-dir', D, '--worktree', W).code, 2)
})

test('AC2 fail closed: the hunt worktree itself is not a git work tree → exit 2', () => {
  const notGit = tmp('wphp-notgit-w-')
  const D = join(notGit, 'plan')
  put(D, 'human-patches/01-x.patch', '--- a/x\n+++ b/x\n')
  const r = cli('check', '--plan-dir', D, '--worktree', notGit)
  assert.equal(r.code, 2)
  assert.match(r.json.reason, /\(the hunt repo for 01-x\.patch\) is not a git work tree/)
})

test('CLI usage errors exit 2 with a JSON reason', () => {
  for (const [args, re] of [
    [[], /usage: wolfpack-human-patches\.mjs check/],
    [['frobnicate', '--plan-dir', '/x', '--worktree', '/y'], /usage/],
    [['check', '--worktree', '/y'], /--plan-dir is required/],
    [['check', '--plan-dir', '/x'], /--worktree is required/],
  ]) {
    const r = cli(...args)
    assert.equal(r.code, 2, args.join(' '))
    assert.equal(r.json.status, 'error')
    assert.match(r.json.reason, re)
  }
})

test('AC1–AC3 end to end: the CLI\'s pending list feeds humanPatchApplySteps → the consumer park text targets the consumer repo', () => {
  const { W, D, C } = scenario()
  put(D, 'human-patches/consumer/01-smoke.patch', makePatch(C, '.claude/hooks/smoke.sh', 'echo c-new\n'))
  const r = cli('check', '--plan-dir', D, '--worktree', W)
  assert.equal(r.code, 0, r.stdout)
  const { steps, branches } = humanPatchApplySteps(r.json.pending, { worktreePath: W, consumer: r.json.consumer, slug: 'h' })
  assert.ok(steps.includes(`git -C ${C} apply ${join(D, 'human-patches', 'consumer', '01-smoke.patch')}`))
  assert.ok(steps.includes(`git -C ${C} add .claude/hooks/smoke.sh`))
  assert.ok(steps.includes(`git -C ${C} commit -m`))
  assert.ok(!steps.includes(`git -C ${W} `))
  assert.deepEqual(branches, [`feat/h-consumer (consumer worktree ${C})`])
  // pasting the printed commands really applies + commits it in the consumer, and the check clears
  for (const line of steps.split('\n')) {
    const argv = line.trim().replace(/^git /, '').match(/"[^"]*"|\S+/g).map(a => a.replace(/^"|"$/g, ''))
    execFileSync('git', argv, { stdio: 'ignore' })
  }
  assert.equal(readFileSync(join(C, '.claude/hooks/smoke.sh'), 'utf8'), 'echo c-new\n')
  assert.equal(g(C, 'status', '--porcelain'), '')
  assert.deepEqual(cli('check', '--plan-dir', D, '--worktree', W).json.pending, [])
})
