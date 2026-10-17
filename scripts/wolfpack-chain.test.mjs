#!/usr/bin/env node
// scripts/wolfpack-chain.test.mjs — tests for the campaign CHAIN MODE git core
// (scripts/wolfpack-chain.mjs). Run: node --test scripts/wolfpack-chain.test.mjs
//
// Two layers:
//   1. Pure helpers (chainClass, chainConflicts, mergeLineSets, revertTargets, …) — table tests.
//   2. The git subcommands (init, sync-main, overlap, merge-hunt) — driven against REAL git in a
//      throwaway repo under the OS temp dir (git init -b main, isolated config, no network).
// Plus the core-drift guard: the marked pure-core block must be byte-identical (minus `export `)
// in this module and in whichever runtime copy of campaign-runner.js sits next to it.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  CHAIN_STATUS, chainClass, isDependencyMet, isBlockedStatus, dependencyClosure, chainConflicts,
  isBookkeepingPath, isLineMergeablePath, mergeLineSets, needsComplianceHold, renderParkRecord, parkBlock,
  revertTargets, parseFlags, TEXT_FLAGS, campaignHunts, dirtyPaths, findWorktree, readCampaignMeta,
  cmdInit, cmdSyncMain, cmdOverlap, cmdMergeHunt, ChainError,
} from './wolfpack-chain.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, 'wolfpack-chain.mjs')

// ─── Isolated git environment (no user/system config, fixed identity) ─────────
const CFG_DIR = mkdtempSync(join(tmpdir(), 'wpchain-cfg-'))
writeFileSync(join(CFG_DIR, 'gitconfig'), '')
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(CFG_DIR, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Chain Test', GIT_AUTHOR_EMAIL: 'chain-test@example.invalid',
  GIT_COMMITTER_NAME: 'Chain Test', GIT_COMMITTER_EMAIL: 'chain-test@example.invalid',
})
const ROOTS = [CFG_DIR]
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }) })

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gOk = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).status === 0
const sha = (cwd, ref) => g(cwd, 'rev-parse', ref)
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text) }
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'))
// Write files and commit them, staged BY NAME.
function commitFiles(dir, files, msg) {
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text)
  g(dir, 'add', '--', ...Object.keys(files))
  g(dir, 'commit', '-q', '-m', msg)
  return sha(dir, 'HEAD')
}

const APP = 'l1\nl2\nl3\nl4\nl5\n'
const CL_HEAD = '# Changelog\n\n## [Unreleased]\n\n### Tooling\n- base entry\n'
const CL_TAIL = '\n## [v0.1.0] — 2026-01-01\n- old\n'
const CHANGELOG = CL_HEAD + CL_TAIL
const clWith = (...lines) => CL_HEAD + lines.map(l => `${l}\n`).join('') + CL_TAIL   // insert after "- base entry"
const TODO = '# TODO\n- [ ] t1\n- [ ] t2\n- [ ] t3\n- [ ] t4\n'
const AT = '2026-10-17T00:00:00.000Z'

// A throwaway repo on main with a tracked .wolfpack/pedigree file (plans/campaigns are ignored,
// as in a real consumer repo) and campaign/c created by cmdInit.
function mkRepo({ graph = {}, init = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wpchain-repo-')))
  ROOTS.push(root)
  g(root, 'init', '-q', '-b', 'main')
  commitFiles(root, {
    '.gitignore': '.wolfpack/plans/\n.wolfpack/campaigns/\n.wt/\n',
    'app.txt': APP, 'CHANGELOG.md': CHANGELOG, 'TODO.md': TODO,
    '.wolfpack/pedigree/index.md': '# pedigree\n',
  }, 'initial')
  if (init) cmdInit(root, { campaign: 'c', graph, at: AT })
  return root
}
const wtPlan = (root, slug) => join(root, '.wt', slug, '.wolfpack', 'plans', slug)
const mainPlan = (root, slug) => join(root, '.wolfpack', 'plans', slug)
function writeMeta(root, slug, meta, { main = false } = {}) {
  const dirs = [wtPlan(root, slug), ...(main ? [mainPlan(root, slug)] : [])]
  for (const d of dirs) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n') }
}
// A hunt worktree at <root>/.wt/<slug> on feat/<slug> forked from `base`, with one commit of
// `edits` (if any) and a worktree metadata.json.
function addHunt(root, slug, { base = 'campaign/c', edits = {}, status = 'certified', meta = {} } = {}) {
  const wt = join(root, '.wt', slug)
  g(root, 'worktree', 'add', '-q', wt, '-b', `feat/${slug}`, base)
  if (Object.keys(edits).length) commitFiles(wt, edits, `feat(${slug}): change`)
  writeMeta(root, slug, { feature: slug, status, tier: 'Yellow', ...meta })
  return wt
}
// Commit directly onto campaign/c (a scratch worktree, removed afterwards).
function commitOnCampaign(root, files, msg = 'campaign change') {
  const d = join(root, '.wt', '__camp')
  g(root, 'worktree', 'add', '-q', d, 'campaign/c')
  const s = commitFiles(d, files, msg)
  g(root, 'worktree', 'remove', '--force', d)
  return s
}
const metaWt = (root, slug) => readJ(join(wtPlan(root, slug), 'metadata.json'))
const metaBoth = (root, slug) => ({ wt: readJ(join(wtPlan(root, slug), 'metadata.json')), main: readJ(join(mainPlan(root, slug), 'metadata.json')) })
const parents = (root, ref) => g(root, 'rev-list', '--parents', '-n', '1', ref).split(' ').slice(1)
const showFile = (root, ref, path) => { const r = spawnSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' }); return r.status === 0 ? r.stdout : null }
const noTempWorktrees = (root) => !g(root, 'worktree', 'list', '--porcelain').includes('wolfpack-chain-')
const runCli = (root, ...a) => {
  const r = spawnSync(process.execPath, [CLI, ...a], { cwd: root, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* not JSON */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}

// ════════════════════════════════════════════════════════════════════════════
// 21. Core drift guard
// ════════════════════════════════════════════════════════════════════════════
const CORE_RE = /\/\/ ── BEGIN wolfpack-chain core[^\n]*\n[\s\S]*?\/\/ ── END wolfpack-chain core ──/
test('core drift: the pure-core block is byte-identical (minus export) in wolfpack-chain.mjs and campaign-runner.js', () => {
  const runner = ['../.agents/workflows/campaign-runner.js', '../.claude/workflows/campaign-runner.js']
    .map(p => join(here, p)).find(existsSync)
  assert.ok(runner, 'no campaign-runner.js found next to scripts/ (.agents/workflows or .claude/workflows)')
  const modBlock = readFileSync(join(here, 'wolfpack-chain.mjs'), 'utf8').match(CORE_RE)
  const runBlock = readFileSync(runner, 'utf8').match(CORE_RE)
  assert.ok(modBlock, 'core block markers missing in wolfpack-chain.mjs')
  assert.ok(runBlock, `core block markers missing in ${runner}`)
  assert.match(modBlock[0], /^export function chainClass/m, 'the module copy exports the core')
  assert.equal(runBlock[0], modBlock[0].replace(/^export /gm, ''))
  // The sync script rewrites .agents/ → .claude/; the block must not contain such a path.
  assert.doesNotMatch(modBlock[0], /\.agents\//)
})

// ════════════════════════════════════════════════════════════════════════════
// 23. chainClass / isDependencyMet / isBlockedStatus
// ════════════════════════════════════════════════════════════════════════════
test('chainClass: every chain status, the barrier statuses, and junk', () => {
  const table = {
    merged: 'released',
    [CHAIN_STATUS.MERGED]: 'campaign_merged',
    [CHAIN_STATUS.MERGED_PENDING_COMPLIANCE]: 'campaign_merged',
    certified: 'awaiting_merge',
    certified_not_merged: 'awaiting_merge',
    [CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE]: 'awaiting_merge',
    [CHAIN_STATUS.HELD_OVERLAP]: 'awaiting_merge',
    [CHAIN_STATUS.REVERTED_WITH_DEP]: 'reverted_dep',
    'parked:model_quota': 'quota',
    [CHAIN_STATUS.MERGE_CONFLICT]: 'blocked',
    [CHAIN_STATUS.REVERTED]: 'blocked',
    'parked:open_critical': 'blocked',
    'parked:compliance_review': 'blocked',
    needs_spec: 'blocked',
    ready_for_alpha: 'pending',
    implementing: 'pending',
    failed: 'pending',
    '': 'pending',
  }
  for (const [s, want] of Object.entries(table)) assert.equal(chainClass(s), want, s)
  assert.equal(chainClass(undefined), 'pending')
  assert.equal(chainClass(null), 'pending')
  // the new statuses are distinct from merged/certified and only the two park statuses carry parked:
  assert.equal(new Set(Object.values(CHAIN_STATUS)).size, 7)
  for (const s of [CHAIN_STATUS.MERGED, CHAIN_STATUS.MERGED_PENDING_COMPLIANCE, CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE, CHAIN_STATUS.HELD_OVERLAP, CHAIN_STATUS.REVERTED_WITH_DEP]) {
    assert.ok(!s.startsWith('parked:') && s !== 'merged' && s !== 'certified', s)
  }
})

test('isDependencyMet: released or campaign-merged only; isBlockedStatus: blocked or reverted dependent', () => {
  assert.equal(isDependencyMet('merged'), true)
  assert.equal(isDependencyMet(CHAIN_STATUS.MERGED), true)
  assert.equal(isDependencyMet(CHAIN_STATUS.MERGED_PENDING_COMPLIANCE), true, 'A1: Red dependents may build on an unsigned Red hunt')
  for (const s of ['certified', CHAIN_STATUS.HELD_OVERLAP, CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE, 'parked:open_critical', 'ready_for_alpha', CHAIN_STATUS.REVERTED_WITH_DEP]) {
    assert.equal(isDependencyMet(s), false, s)
  }
  for (const s of ['parked:open_critical', 'needs_spec', CHAIN_STATUS.MERGE_CONFLICT, CHAIN_STATUS.REVERTED, CHAIN_STATUS.REVERTED_WITH_DEP]) {
    assert.equal(isBlockedStatus(s), true, s)
  }
  for (const s of ['parked:model_quota', 'certified', CHAIN_STATUS.HELD_OVERLAP, CHAIN_STATUS.MERGED, 'merged', 'ready_for_alpha']) {
    assert.equal(isBlockedStatus(s), false, s)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// 22. AC9 conflict test (chainConflicts / dependencyClosure)
// ════════════════════════════════════════════════════════════════════════════
const G = {
  x: { dependsOn: ['y'], migrationApps: [] },
  y: { dependsOn: ['b'], migrationApps: [] },
  b: { dependsOn: [], migrationApps: ['Billing', 'records'] },
  d: { dependsOn: ['b'], migrationApps: [] },
  m: { dependsOn: [], migrationApps: ['billing'] },
  free: { dependsOn: [], migrationApps: ['scheduler'] },
  multi: { dependsOn: ['b'], migrationApps: ['RECORDS'] },
}
test('AC9 rule a: a direct dependency on a blocked hunt', () => {
  assert.deepEqual(chainConflicts('d', ['b'], G), [{ rule: 'a', with: 'b', via: ['d', 'b'] }])
})
test('AC9 rule a: a TRANSITIVE dependency carries the path in via', () => {
  assert.deepEqual(chainConflicts('x', ['b'], G), [{ rule: 'a', with: 'b', via: ['x', 'y', 'b'] }])
  // the intermediate hunt blocked instead → a direct hit on y
  assert.deepEqual(chainConflicts('x', ['y'], G), [{ rule: 'a', with: 'y', via: ['x', 'y'] }])
})
test('AC9 rule b: a shared migration app, case-insensitive (returned lowercased)', () => {
  assert.deepEqual(chainConflicts('m', ['b'], G), [{ rule: 'b', with: 'b', apps: ['billing'] }])
})
test('AC9 rule c: precomputed overlap files', () => {
  assert.deepEqual(chainConflicts('free', ['b'], G, { b: ['app/views.py'] }), [{ rule: 'c', with: 'b', files: ['app/views.py'] }])
  // an empty overlap list is no conflict
  assert.deepEqual(chainConflicts('free', ['b'], G, { b: [] }), [])
})
test('AC9: several rules at once give one entry per (blocker, rule) in a/b/c order', () => {
  const out = chainConflicts('multi', ['b', 'free'], G, { b: ['x.py'], free: ['y.py'] })
  assert.deepEqual(out, [
    { rule: 'a', with: 'b', via: ['multi', 'b'] },
    { rule: 'b', with: 'b', apps: ['records'] },
    { rule: 'c', with: 'b', files: ['x.py'] },
    { rule: 'c', with: 'free', files: ['y.py'] },
  ])
})
test('AC9: a hunt that conflicts with nothing → []; an empty blocker set → []; itself is never a blocker', () => {
  assert.deepEqual(chainConflicts('free', ['b'], G), [])
  assert.deepEqual(chainConflicts('d', [], G), [])
  assert.deepEqual(chainConflicts('d', undefined, G), [])
  assert.deepEqual(chainConflicts('b', ['b'], G), [])
  // unknown slugs / missing graph do not throw
  assert.deepEqual(chainConflicts('nope', ['b'], G), [])
  assert.deepEqual(chainConflicts('x', ['b'], undefined), [])
})
test('dependencyClosure: cycle-safe, shortest paths, self excluded', () => {
  const cyc = { p: { dependsOn: ['q'] }, q: { dependsOn: ['r'] }, r: { dependsOn: ['p', 'q'] } }
  const c = dependencyClosure('p', cyc)
  assert.deepEqual([...c.keys()].sort(), ['q', 'r'])
  assert.deepEqual(c.get('r'), ['p', 'q', 'r'])
  assert.equal(c.has('p'), false)
  assert.deepEqual(chainConflicts('p', ['r'], cyc), [{ rule: 'a', with: 'r', via: ['p', 'q', 'r'] }])
  // diamond: the shortest path wins
  const dia = { t: { dependsOn: ['u', 'z'] }, u: { dependsOn: ['v'] }, v: { dependsOn: ['z'] }, z: { dependsOn: [] } }
  assert.deepEqual(dependencyClosure('t', dia).get('z'), ['t', 'z'])
})

// ════════════════════════════════════════════════════════════════════════════
// 24. mergeLineSets (A-9 bookkeeping auto-resolution)
// ════════════════════════════════════════════════════════════════════════════
const L = (...xs) => xs.join('\n')
test('mergeLineSets: CHANGELOG pure insertions on both sides → both kept, in order', () => {
  assert.equal(mergeLineSets(L('a', 'b', 'c'), L('a', 'X', 'b', 'c'), L('a', 'b', 'Y', 'c')), L('a', 'X', 'b', 'Y', 'c'))
  // same gap → both, ours first
  assert.equal(mergeLineSets(L('h', '- base', ''), L('h', '- base', '- ours', ''), L('h', '- base', '- theirs', '')),
    L('h', '- base', '- ours', '- theirs', ''))
  // insertion at the very end and the very start
  assert.equal(mergeLineSets(L('a', 'b'), L('S', 'a', 'b'), L('a', 'b', 'E')), L('S', 'a', 'b', 'E'))
})
test('mergeLineSets: TODO adjacent pure deletions → both removed', () => {
  assert.equal(mergeLineSets(L('t1', 't2', 't3', 't4'), L('t1', 't3', 't4'), L('t1', 't2', 't4')), L('t1', 't4'))
  // both delete the SAME line → gone once
  assert.equal(mergeLineSets(L('t1', 't2', 't3'), L('t1', 't3'), L('t1', 't3')), L('t1', 't3'))
})
test('mergeLineSets: one side deletes, the other inserts → both applied', () => {
  assert.equal(mergeLineSets(L('a', 'b', 'c'), L('a', 'c'), L('a', 'b', 'N', 'c')), L('a', 'N', 'c'))
})
test('mergeLineSets: a MODIFIED line (either side) → null', () => {
  assert.equal(mergeLineSets(L('a', 'b'), L('a', 'B'), L('a', 'b', 'c')), null)
  assert.equal(mergeLineSets(L('a', 'b'), L('a', 'b', 'c'), L('a', 'B')), null)
  // longer but not a superset (modify + insert)
  assert.equal(mergeLineSets(L('a', 'b'), L('a', 'B', 'c'), L('a', 'b')), null)
  // shorter but not a subsequence (modify + delete)
  assert.equal(mergeLineSets(L('a', 'b', 'c'), L('A', 'c'), L('a', 'b', 'c')), null)
  // a missing stage (add/add, modify/delete) is never auto-resolved
  assert.equal(mergeLineSets(null, 'a', 'b'), null)
  assert.equal(mergeLineSets('a', undefined, 'a'), null)
})
test('mergeLineSets: duplicate (blank) lines and identical sides', () => {
  const base = L('## [Unreleased]', '', '- a', '', '## [v1]')
  assert.equal(mergeLineSets(base, L('## [Unreleased]', '', '- a', '- o', '', '## [v1]'), L('## [Unreleased]', '', '- t', '- a', '', '## [v1]')),
    L('## [Unreleased]', '', '- t', '- a', '- o', '', '## [v1]'))
  // an inserted blank line next to existing blanks survives
  const out = mergeLineSets(L('x', '', 'y'), L('x', '', '', 'y'), L('x', '', 'y'))
  assert.equal(out, L('x', '', '', 'y'))
  assert.equal(mergeLineSets(base, base, base), base)
  // trailing newline preserved
  assert.equal(mergeLineSets('a\n', 'a\nb\n', 'a\n'), 'a\nb\n')
})
test('isBookkeepingPath / isLineMergeablePath', () => {
  for (const p of ['.wolfpack/pedigree/index.md', './.wolfpack/x', 'CHANGELOG.md', 'TODO.md', './TODO.md']) assert.equal(isBookkeepingPath(p), true, p)
  for (const p of ['app/CHANGELOG.md', 'docs/TODO.md', 'wolfpack/x', 'app.txt', '']) assert.equal(isBookkeepingPath(p), false, p)
  assert.equal(isLineMergeablePath('CHANGELOG.md'), true)
  assert.equal(isLineMergeablePath('TODO.md'), true)
  assert.equal(isLineMergeablePath('.wolfpack/pedigree/index.md'), false, '.wolfpack/ is NOT auto-resolved by A-9')
  assert.equal(isLineMergeablePath('app.txt'), false)
})

// ════════════════════════════════════════════════════════════════════════════
// 25. revertTargets
// ════════════════════════════════════════════════════════════════════════════
test('revertTargets: H + transitive campaign-merged dependents, newest first; unmerged dependents excluded', () => {
  const graph = { h: { dependsOn: [] }, d: { dependsOn: ['h'] }, e: { dependsOn: ['d'] }, u: { dependsOn: ['h'] }, z: { dependsOn: [] } }
  const statuses = { h: CHAIN_STATUS.MERGED, d: CHAIN_STATUS.MERGED_PENDING_COMPLIANCE, e: CHAIN_STATUS.MERGED, u: 'certified', z: CHAIN_STATUS.MERGED }
  assert.deepEqual(revertTargets('h', statuses, graph, ['e', 'z', 'd', 'h']), ['e', 'd', 'h'])
  // a merge order that is not dependency-shaped is still honoured exactly
  assert.deepEqual(revertTargets('h', statuses, graph, ['d', 'e', 'h']), ['d', 'e', 'h'])
  // a slug missing from the merge order sorts last
  assert.deepEqual(revertTargets('h', statuses, graph, ['e', 'h']), ['e', 'h', 'd'])
  // a released (main-merged) dependent is NOT reverted from the campaign branch
  assert.deepEqual(revertTargets('h', { ...statuses, d: 'merged', e: 'merged' }, graph, ['e', 'd', 'h']), ['h'])
  // no dependents
  assert.deepEqual(revertTargets('z', statuses, graph, ['z']), ['z'])
})

// ════════════════════════════════════════════════════════════════════════════
// 31 (pure). needsComplianceHold + park helpers
// ════════════════════════════════════════════════════════════════════════════
test('needsComplianceHold: every marker while unsigned; nothing once signed', () => {
  assert.equal(needsComplianceHold({ status: CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE }), true)
  assert.equal(needsComplianceHold({ status: CHAIN_STATUS.MERGED_PENDING_COMPLIANCE }), true)
  assert.equal(needsComplianceHold({ status: CHAIN_STATUS.HELD_OVERLAP, compliance_hold: { reason: 'billing' } }), true)
  assert.equal(needsComplianceHold({ status: CHAIN_STATUS.MERGED, spec: { compliance_review_required: true } }), true)
  // falsy (the helper may return undefined rather than false for "no marker")
  assert.ok(!needsComplianceHold({ status: CHAIN_STATUS.MERGED, compliance_hold: {} }), 'an empty hold block is not a marker')
  assert.ok(!needsComplianceHold({ status: CHAIN_STATUS.MERGED, compliance_hold: [] }))
  assert.ok(!needsComplianceHold({ status: CHAIN_STATUS.MERGED, spec: { compliance_review_required: false } }))
  assert.ok(!needsComplianceHold({ status: 'certified' }))
  assert.ok(!needsComplianceHold(null))
  const signed = { park: { compliance_signed_off: true } }
  assert.equal(needsComplianceHold({ ...signed, status: CHAIN_STATUS.MERGED_PENDING_COMPLIANCE, compliance_hold: { r: 1 }, spec: { compliance_review_required: true } }), false)
  assert.equal(needsComplianceHold({ status: CHAIN_STATUS.MERGED_PENDING_COMPLIANCE, park: { compliance_signed_off: 'yes' } }), true, 'only literal true signs off')
})
test('renderParkRecord / parkBlock: the /parked shape; a re-park keeps redirect_count', () => {
  const md = renderParkRecord({ slug: 'h', reason: 'campaign_merge_conflict', parkedAt: AT, resumePhase: 'Code Review', resolutionType: 'clarify', tier: 'Orange', need: 'N', context: 'C', options: 'O' })
  for (const s of ['# PARKED — h', '- reason: campaign_merge_conflict', `- parked_at: ${AT}`, '- resume_phase: Code Review',
    '- resolution_type_expected: clarify', '- tier: Orange', '## What I need from you', '## Context (enough to decide without opening the worktree)', '## Options (feeds AskUserQuestion)']) {
    assert.ok(md.includes(s), s)
  }
  assert.match(renderParkRecord({ slug: 'h', reason: 'r', parkedAt: AT, resumePhase: 'X', resolutionType: 'clarify' }), /- tier: Red/, 'tier defaults to Red (fail closed)')
  const pb = parkBlock({ reason: 'r', parkedAt: AT, resumePhase: 'Code Review', resolutionType: 'clarify', tier: 'Yellow', prior: { redirect_count: 2, compliance_signed_off: true } })
  assert.deepEqual(pb, { reason: 'r', parked_at: AT, resume_phase: 'Code Review', resolution_type: 'clarify', tier: 'Yellow', human_notes_seen: false, redirect_count: 2, compliance_signed_off: false })
  assert.equal(parkBlock({ reason: 'r', parkedAt: AT, resumePhase: 'X', resolutionType: 'clarify' }).redirect_count, 0)
})

// ════════════════════════════════════════════════════════════════════════════
// Pointer r1 F5 — parseFlags TEXT_FLAGS
// ════════════════════════════════════════════════════════════════════════════
test('parseFlags: a free-text flag keeps a value that starts with --; other flags stay boolean before a flag', () => {
  assert.deepEqual([...TEXT_FLAGS].sort(), ['by', 'deploy-cmd', 'graph', 'migrate-cmd', 'reason'])
  const f = parseFlags(['pos', '--reason', '--force was wrong', '--version', '--apply', '--campaign', 'c', '--at=2026-01-01', '--by', '--x'])
  assert.equal(f.reason, '--force was wrong')
  assert.equal(f.version, true)
  assert.equal(f.apply, true)
  assert.equal(f.campaign, 'c')
  assert.equal(f.at, '2026-01-01')
  assert.equal(f.by, '--x')
  assert.deepEqual(f._, ['pos'])
  assert.equal(parseFlags(['--checkpoint']).checkpoint, true, 'a trailing flag is boolean')
  assert.equal(parseFlags(['--deploy-cmd', '--help']).deployCmd, undefined)
  assert.equal(parseFlags(['--deploy-cmd', '--help'])['deploy-cmd'], '--help')
})

// ════════════════════════════════════════════════════════════════════════════
// campaignHunts (Pointer r2 F2: graph keys must not SHADOW metadata.hunts)
// ════════════════════════════════════════════════════════════════════════════
test('campaignHunts: graph keys, else metadata.hunts, else []', () => {
  assert.deepEqual(campaignHunts({ chain: { graph: { a: {}, b: {} } } }), ['a', 'b'])
  assert.deepEqual(campaignHunts({ hunts: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(campaignHunts({ chain: {}, hunts: ['a'] }), ['a'])
  assert.deepEqual(campaignHunts({}), [])
  assert.deepEqual(campaignHunts(null), [])
})
test('campaignHunts (Pointer r2 F2): a hunt listed in metadata.hunts but absent from the parsed graph (a BLOCKED-wave hunt) is still a campaign hunt', () => {
  // The runner builds chain.graph from the parsed waves, and the parse EXCLUDES BLOCKED hunts.
  // The release gate's `unfinished` refusal reads campaignHunts, so a shadowing graph lets a
  // final release pass while a listed hunt never shipped (fail-open human gate).
  const hunts = campaignHunts({ chain: { graph: { a: {}, b: {} } }, hunts: ['a', 'b', 'blocked-one'] })
  assert.deepEqual([...hunts].sort(), ['a', 'b', 'blocked-one'])
})

// ════════════════════════════════════════════════════════════════════════════
// 26. init (temp repo)
// ════════════════════════════════════════════════════════════════════════════
test('init: creates campaign/<c> from main and writes metadata.chain; a second call adopts (same sha)', () => {
  const root = mkRepo({ init: false })
  const mainSha = sha(root, 'main')
  const graph = { a: { dependsOn: [], migrationApps: ['billing'] } }
  const r1 = cmdInit(root, { campaign: 'c', graph, at: AT })
  assert.deepEqual(r1, { status: 'created', branch: 'campaign/c', sha: mainSha })
  assert.equal(sha(root, 'campaign/c'), mainSha)
  const m1 = readCampaignMeta(root, 'c')
  assert.equal(m1.chain.mode, 'chain')
  assert.equal(m1.chain.branch, 'campaign/c')
  assert.equal(m1.chain.created_at, AT)
  assert.equal(m1.chain.created_from, `main@${mainSha}`)
  assert.deepEqual(m1.chain.graph, graph)
  // main advances; the campaign branch is adopted as-is (never reset to main)
  commitFiles(root, { 'later.txt': 'x\n' }, 'main moves')
  const r2 = cmdInit(root, { campaign: 'c', graph, at: '2026-10-18T00:00:00.000Z' })
  assert.deepEqual(r2, { status: 'adopted', branch: 'campaign/c', sha: mainSha })
  const m2 = readCampaignMeta(root, 'c')
  assert.equal(m2.chain.created_at, AT, 'created_at is preserved')
  assert.equal(m2.chain.adopted_at, '2026-10-18T00:00:00.000Z')
  assert.equal(g(root, 'branch', '--show-current'), 'main', 'the main checkout never moves')
})
test('init (Pointer r1 F8): a graph-less init writes no empty graph and a graph-less re-init keeps the prior graph', () => {
  const root = mkRepo({ init: false })
  writeFileSync(join(root, 'x'), '')   // untracked noise is irrelevant
  mkdirSync(join(root, '.wolfpack', 'campaigns', 'c'), { recursive: true })
  writeFileSync(join(root, '.wolfpack', 'campaigns', 'c', 'metadata.json'), JSON.stringify({ campaign: 'c', hunts: ['a', 'b'], other: 1 }))
  cmdInit(root, { campaign: 'c', at: AT })
  const m = readCampaignMeta(root, 'c')
  assert.equal('graph' in m.chain, false)
  assert.equal(m.other, 1, 'campaign metadata is read-modify-write')
  assert.deepEqual(campaignHunts(m), ['a', 'b'], 'metadata.hunts is the fallback')
  cmdInit(root, { campaign: 'c', graph: { a: { dependsOn: [] } }, at: AT })
  cmdInit(root, { campaign: 'c', at: AT })
  assert.deepEqual(readCampaignMeta(root, 'c').chain.graph, { a: { dependsOn: [] } })
})
test('init: rejects a non-slug campaign; CLI exit codes (0 decided, 2 error JSON)', () => {
  const root = mkRepo({ init: false })
  assert.throws(() => cmdInit(root, { campaign: '../x' }), ChainError)
  assert.throws(() => cmdInit(root, { campaign: '' }), ChainError)
  const ok = runCli(root, 'init', '--campaign', 'c', '--graph', '{"a":{"dependsOn":[]}}', '--at', AT)
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  assert.equal(ok.json.status, 'created')
  const bad = runCli(root, 'init', '--campaign', 'c', '--graph', '{not json')
  assert.equal(bad.code, 2)
  assert.equal(bad.json.status, 'error')
  assert.match(bad.json.reason, /--graph is not valid JSON/)
  const usage = runCli(root, 'frobnicate')
  assert.equal(usage.code, 2)
  assert.match(usage.json.reason, /usage:/)
  const missing = runCli(root, 'merge-hunt', '--campaign', 'c', '--hunt', 'nope')
  assert.equal(missing.code, 2)
  assert.match(missing.json.reason, /no worktree has feat\/nope/)
})

// ════════════════════════════════════════════════════════════════════════════
// 27. AC4 — the documented Shepherd rebase onto the advanced campaign branch
// ════════════════════════════════════════════════════════════════════════════
test('AC4: `git rebase campaign/c` (local ref, no origin/) moves a stale feature branch onto the advanced campaign tip', () => {
  const root = mkRepo()
  const wt = addHunt(root, 'h', { edits: { 'h.txt': 'h\n' } })
  const newTip = commitOnCampaign(root, { 'other.txt': 'o\n' })
  assert.equal(gOk(root, 'merge-base', '--is-ancestor', newTip, 'feat/h'), false, 'precondition: feat/h is stale')
  g(wt, 'rebase', 'campaign/c')            // exactly the command the chain-mode Shepherd prompts carry
  assert.equal(gOk(root, 'merge-base', '--is-ancestor', newTip, 'feat/h'), true)
  assert.equal(g(wt, 'branch', '--show-current'), 'feat/h')
  assert.ok(existsSync(join(wt, 'other.txt')) && existsSync(join(wt, 'h.txt')))
})

// ════════════════════════════════════════════════════════════════════════════
// 28. AC5 / AC6 — merge-hunt (temp repo)
// ════════════════════════════════════════════════════════════════════════════
test('AC5/AC6: merge-hunt merges --no-ff, holds a real conflict without moving the branch, auto-resolves a CHANGELOG insertion collision', () => {
  const root = mkRepo()
  const mainSha = sha(root, 'main')
  // All three fork from the SAME campaign tip.
  addHunt(root, 'h1', { edits: { 'app.txt': APP.replace('l2', 'h1'), 'CHANGELOG.md': clWith('- h1 thing <!-- hunt:h1 -->') } })
  const wt2 = addHunt(root, 'h2', { edits: { 'app.txt': APP.replace('l2', 'h2') }, meta: { tier: 'Orange', park: { redirect_count: 1 } } })
  addHunt(root, 'h3', { edits: { 'h3.txt': 'three\n', 'CHANGELOG.md': clWith('- h3 thing <!-- hunt:h3 -->') } })

  // h1: a clean --no-ff merge.
  const r1 = cmdMergeHunt(root, { campaign: 'c', hunt: 'h1', at: AT })
  assert.equal(r1.status, 'merged')
  assert.equal(r1.stamped, CHAIN_STATUS.MERGED)
  assert.equal(sha(root, 'campaign/c'), r1.commit)
  assert.equal(parents(root, r1.commit).length, 2, 'a --no-ff merge commit')
  assert.equal(g(root, 'log', '-1', '--format=%s', r1.commit), "Merge branch 'feat/h1' into campaign/c")
  assert.equal(sha(root, 'main'), mainSha, 'main untouched')
  assert.equal(g(root, 'tag', '-l'), '', 'no tag')
  for (const m of Object.values(metaBoth(root, 'h1'))) {
    assert.equal(m.status, CHAIN_STATUS.MERGED)
    assert.equal(m.campaign_merge_commit, r1.commit)
    assert.equal(m.campaign_branch, 'campaign/c')
    assert.equal(m.campaign_merged_at, AT)
    assert.equal(m.phase, 'campaign_merged')
    assert.deepEqual(m.campaign_merge_history, [])
  }
  assert.ok(noTempWorktrees(root))

  // h2: same line of app.txt → conflict at the rebase; nothing moves.
  const before = sha(root, 'campaign/c')
  const tip2 = sha(root, 'feat/h2')
  const r2 = cmdMergeHunt(root, { campaign: 'c', hunt: 'h2', at: AT })
  assert.deepEqual(r2, { status: 'conflict', stage: 'rebase', files: ['app.txt'] })
  assert.equal(sha(root, 'campaign/c'), before, 'campaign branch unchanged')
  assert.equal(sha(root, 'feat/h2'), tip2, 'feat/h2 unchanged (rebase aborted)')
  assert.equal(g(wt2, 'branch', '--show-current'), 'feat/h2')
  assert.equal(g(wt2, 'status', '--porcelain', '--untracked-files=no'), '', 'worktree clean')
  assert.equal(existsSync(join(root, '.git', 'worktrees', 'h2', 'rebase-merge')), false, 'no rebase in progress')
  for (const [where, m] of Object.entries(metaBoth(root, 'h2'))) {
    assert.equal(m.status, CHAIN_STATUS.MERGE_CONFLICT, where)
    assert.equal(m.park.reason, 'campaign_merge_conflict')
    assert.equal(m.park.resume_phase, 'Code Review')
    assert.equal(m.park.resolution_type, 'clarify')
    assert.equal(m.park.tier, 'Orange')
    assert.equal(m.park.redirect_count, 1, 'the redirect-loop counter survives a re-park')
    assert.equal(m.park.compliance_signed_off, false)
  }
  for (const d of [wtPlan(root, 'h2'), mainPlan(root, 'h2')]) {
    const md = readFileSync(join(d, 'parked.md'), 'utf8')
    assert.match(md, /^# PARKED — h2$/m)
    assert.match(md, /- reason: campaign_merge_conflict/)
    assert.match(md, /Conflicted files: app\.txt/)
    assert.match(md, /- tier: Orange/)
  }

  // h3: a pure-insertion CHANGELOG collision with h1 auto-resolves (A-9) and merges.
  const r3 = cmdMergeHunt(root, { campaign: 'c', hunt: 'h3', at: AT })
  assert.equal(r3.status, 'merged', JSON.stringify(r3))
  const cl = showFile(root, 'campaign/c', 'CHANGELOG.md')
  assert.ok(cl.includes('- h1 thing <!-- hunt:h1 -->\n') && cl.includes('- h3 thing <!-- hunt:h3 -->\n'), cl)
  assert.doesNotMatch(cl, /^(<<<<<<<|=======|>>>>>>>)/m)
  assert.ok(cl.endsWith(CL_TAIL), 'the rest of the file is intact')
  assert.equal(showFile(root, 'campaign/c', 'h3.txt'), 'three\n')
  assert.equal(showFile(root, 'campaign/c', 'app.txt'), APP.replace('l2', 'h1'))
  assert.ok(noTempWorktrees(root))
})

test('AC6: a CHANGELOG MODIFICATION collision is a conflict (held), not auto-resolved', () => {
  const root = mkRepo()
  addHunt(root, 'm1', { edits: { 'CHANGELOG.md': CHANGELOG.replace('- base entry', '- base entry (m1)') } })
  addHunt(root, 'm2', { edits: { 'CHANGELOG.md': CHANGELOG.replace('- base entry', '- base entry (m2)') } })
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 'm1', at: AT }).status, 'merged')
  const before = sha(root, 'campaign/c')
  const r = cmdMergeHunt(root, { campaign: 'c', hunt: 'm2', at: AT })
  assert.equal(r.status, 'conflict')
  assert.deepEqual(r.files, ['CHANGELOG.md'])
  assert.equal(sha(root, 'campaign/c'), before)
  assert.equal(metaBoth(root, 'm2').main.status, CHAIN_STATUS.MERGE_CONFLICT)
})

test('AC6: a CHANGELOG collision where the OTHER side also modified a line is a conflict (whole-file proof, fail closed)', () => {
  const root = mkRepo()
  addHunt(root, 'p1', { edits: { 'CHANGELOG.md': clWith('- p1 <!-- hunt:p1 -->').replace('- base entry', '- base entry (p1)') } })
  addHunt(root, 'p2', { edits: { 'CHANGELOG.md': clWith('- p2 <!-- hunt:p2 -->') } })
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 'p1', at: AT }).status, 'merged')
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 'p2', at: AT }).status, 'conflict')
})

test('AC6: TODO adjacent pure-deletion collisions auto-resolve; a conflict in a NON-bookkeeping file next to it still holds', () => {
  const root = mkRepo()
  addHunt(root, 't1', { edits: { 'TODO.md': TODO.replace('- [ ] t2\n', '') } })
  addHunt(root, 't2', { edits: { 'TODO.md': TODO.replace('- [ ] t3\n', '') } })
  addHunt(root, 't3', { edits: { 'TODO.md': TODO.replace('- [ ] t1\n', ''), 'app.txt': APP.replace('l1', 'x') } })
  addHunt(root, 't4', { edits: { 'TODO.md': TODO.replace('- [ ] t4\n', ''), 'app.txt': APP.replace('l1', 'y') } })
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 't1', at: AT }).status, 'merged')
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 't2', at: AT }).status, 'merged')
  assert.equal(showFile(root, 'campaign/c', 'TODO.md'), '# TODO\n- [ ] t1\n- [ ] t4\n')
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 't3', at: AT }).status, 'merged')
  const before = sha(root, 'campaign/c')
  const r = cmdMergeHunt(root, { campaign: 'c', hunt: 't4', at: AT })
  assert.equal(r.status, 'conflict')
  assert.ok(r.files.includes('app.txt'))
  assert.equal(sha(root, 'campaign/c'), before)
})

test('merge-hunt (Pointer r1 F2): allow-list — only a certified (awaiting-merge) hunt or a reverted dependent', () => {
  const root = mkRepo()
  addHunt(root, 'h', { edits: { 'h.txt': 'h\n' } })
  const before = sha(root, 'campaign/c')
  for (const st of ['implementing', 'ready_for_alpha', 'parked:model_quota', 'parked:open_critical', 'needs_spec',
    CHAIN_STATUS.MERGE_CONFLICT, CHAIN_STATUS.REVERTED, 'merged', CHAIN_STATUS.MERGED, CHAIN_STATUS.MERGED_PENDING_COMPLIANCE, '']) {
    writeMeta(root, 'h', { feature: 'h', status: st })
    assert.throws(() => cmdMergeHunt(root, { campaign: 'c', hunt: 'h', at: AT }), /merge-hunt only merges a certified hunt or reapplies a reverted dependent/, st || '(empty)')
  }
  assert.equal(sha(root, 'campaign/c'), before)
  // every awaiting-merge status is accepted
  for (const st of ['certified_not_merged', CHAIN_STATUS.HELD_OVERLAP]) assert.equal(chainClass(st), 'awaiting_merge')
  writeMeta(root, 'h', { feature: 'h', status: 'certified_not_merged' })
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 'h', at: AT }).status, 'merged')
})

test('merge-hunt preconditions: missing campaign branch, missing worktree, missing metadata, dirty app file, a reverted dependent without its revert commit', () => {
  const root = mkRepo()
  assert.throws(() => cmdMergeHunt(root, { campaign: 'zz', hunt: 'h' }), /campaign\/zz does not exist/)
  assert.throws(() => cmdMergeHunt(root, { campaign: 'c', hunt: 'ghost' }), /no worktree has feat\/ghost checked out/)
  const wt = addHunt(root, 'h', { edits: { 'h.txt': 'h\n' } })
  rmSync(join(wtPlan(root, 'h'), 'metadata.json'))
  assert.throws(() => cmdMergeHunt(root, { campaign: 'c', hunt: 'h' }), /no metadata\.json for hunt h/)
  writeMeta(root, 'h', { feature: 'h', status: 'certified' })
  writeFileSync(join(wt, 'app.txt'), 'dirty\n')
  assert.throws(() => cmdMergeHunt(root, { campaign: 'c', hunt: 'h' }), /uncommitted changes outside \.wolfpack\/: app\.txt$/)
  g(wt, 'checkout', '--', 'app.txt')
  writeMeta(root, 'h', { feature: 'h', status: CHAIN_STATUS.REVERTED_WITH_DEP })
  assert.throws(() => cmdMergeHunt(root, { campaign: 'c', hunt: 'h' }), /has no campaign_revert_commit/)
})

test('merge-hunt (Pointer r1 F3): tracked .wolfpack/ dirt is refused BEFORE the rebase, naming the full path', () => {
  const root = mkRepo()
  const wt = addHunt(root, 'h', { edits: { 'h.txt': 'h\n' } })
  commitOnCampaign(root, { 'adv.txt': 'a\n' })      // so a rebase would really run
  writeFileSync(join(wt, '.wolfpack', 'pedigree', 'index.md'), '# pedigree\nedited\n')
  const tip = sha(root, 'feat/h')
  assert.throws(() => cmdMergeHunt(root, { campaign: 'c', hunt: 'h', at: AT }),
    /uncommitted tracked \.wolfpack\/ changes the rebase would refuse: \.wolfpack\/pedigree\/index\.md — commit or discard/)
  assert.equal(sha(root, 'feat/h'), tip)
  assert.equal(metaWt(root, 'h').status, 'certified', 'nothing stamped')
})

test('dirtyPaths (Pointer r1 F3): the FIRST porcelain line keeps its first character; renames keep the new path; .wolfpack/ exempt by default', () => {
  const root = mkRepo({ init: false })
  writeFileSync(join(root, 'app.txt'), 'changed\n')
  assert.deepEqual(dirtyPaths(root), ['app.txt'])
  writeFileSync(join(root, '.wolfpack', 'pedigree', 'index.md'), 'x\n')
  assert.deepEqual(dirtyPaths(root), ['app.txt'])
  assert.deepEqual(dirtyPaths(root, { includeWolfpack: true }).sort(), ['.wolfpack/pedigree/index.md', 'app.txt'])
  g(root, 'checkout', '--', 'app.txt')
  assert.deepEqual(dirtyPaths(root, { includeWolfpack: true }), ['.wolfpack/pedigree/index.md'], 'first line is .wolfpack/… (not wolfpack/…)')
  assert.deepEqual(dirtyPaths(root), [])
  g(root, 'checkout', '--', '.wolfpack/pedigree/index.md')
  g(root, 'mv', 'TODO.md', 'TODO2.md')
  assert.deepEqual(dirtyPaths(root), ['TODO2.md'])
  // untracked files never count
  g(root, 'mv', 'TODO2.md', 'TODO.md')
  writeFileSync(join(root, 'untracked.txt'), 'u')
  assert.deepEqual(dirtyPaths(root), [])
})

test('findWorktree: by branch refs/heads/feat/<slug>, not by directory name', () => {
  const root = mkRepo()
  const wt = join(root, '.wt', 'some-other-dir-name')
  g(root, 'worktree', 'add', '-q', wt, '-b', 'feat/zz', 'campaign/c')
  assert.equal(findWorktree(root, 'zz'), wt)
  assert.equal(findWorktree(root, 'some-other-dir-name'), null)
  assert.equal(findWorktree(root, 'z'), null, 'no prefix match')
})

// ════════════════════════════════════════════════════════════════════════════
// 29. AC7 — sync-main (temp repo)
// ════════════════════════════════════════════════════════════════════════════
test('AC7 sync-main: main already an ancestor → up_to_date (no commit)', () => {
  const root = mkRepo()
  const before = sha(root, 'campaign/c')
  assert.deepEqual(cmdSyncMain(root, { campaign: 'c' }), { status: 'up_to_date', sha: before, files: [], warning: null })
  assert.equal(sha(root, 'campaign/c'), before)
})
test('AC7 sync-main: main advanced cleanly → one --no-ff merge commit on the campaign branch', () => {
  const root = mkRepo()
  commitOnCampaign(root, { 'camp.txt': 'c\n' })
  const campBefore = sha(root, 'campaign/c')
  const mainSha = commitFiles(root, { 'mainonly.txt': 'm\n' }, 'main advances')
  const r = cmdSyncMain(root, { campaign: 'c' })
  assert.equal(r.status, 'merged')
  assert.equal(r.sha, sha(root, 'campaign/c'))
  assert.deepEqual(parents(root, 'campaign/c'), [campBefore, mainSha])
  assert.equal(g(root, 'log', '-1', '--format=%s', 'campaign/c'), "Merge branch 'main' into campaign/c")
  assert.equal(sha(root, 'main'), mainSha, 'main itself unchanged')
  assert.equal(g(root, 'branch', '--show-current'), 'main')
  // a second sync is a no-op
  assert.equal(cmdSyncMain(root, { campaign: 'c' }).status, 'up_to_date')
  assert.ok(noTempWorktrees(root))
})
test('AC7 sync-main: a conflicting main change → conflict + files; branch unchanged; no merge left in progress', () => {
  const root = mkRepo()
  commitOnCampaign(root, { 'app.txt': APP.replace('l3', 'camp') })
  const before = sha(root, 'campaign/c')
  commitFiles(root, { 'app.txt': APP.replace('l3', 'main') }, 'main conflicts')
  const r = cmdSyncMain(root, { campaign: 'c' })
  assert.equal(r.status, 'conflict')
  assert.deepEqual(r.files, ['app.txt'])
  assert.equal(r.sha, before)
  assert.equal(sha(root, 'campaign/c'), before)
  assert.equal(existsSync(join(root, '.git', 'MERGE_HEAD')), false)
  assert.equal(g(root, 'status', '--porcelain', '--untracked-files=no'), '')
  assert.ok(noTempWorktrees(root), 'the temp worktree was removed')
})
test('AC7 sync-main: a CHANGELOG pure-insertion collision with main auto-resolves (A-9)', () => {
  const root = mkRepo()
  commitOnCampaign(root, { 'CHANGELOG.md': clWith('- camp <!-- hunt:x -->') })
  commitFiles(root, { 'CHANGELOG.md': clWith('- from main <!-- hunt:y -->') }, 'main changelog')
  const r = cmdSyncMain(root, { campaign: 'c' })
  assert.equal(r.status, 'merged', JSON.stringify(r))
  const cl = showFile(root, 'campaign/c', 'CHANGELOG.md')
  assert.ok(cl.includes('- camp <!-- hunt:x -->') && cl.includes('- from main <!-- hunt:y -->'))
  assert.equal(parents(root, 'campaign/c').length, 2)
  assert.equal(gOk(root, 'merge-base', '--is-ancestor', 'main', 'campaign/c'), true)
})
test('AC7 sync-main (spec A4): warns when origin/main exists but is not an ancestor of local main', () => {
  const root = mkRepo()
  const tree = g(root, 'rev-parse', 'HEAD^{tree}')
  const stray = g(root, 'commit-tree', tree, '-m', 'pushed from elsewhere')
  g(root, 'update-ref', 'refs/remotes/origin/main', stray)
  const r = cmdSyncMain(root, { campaign: 'c' })
  assert.equal(r.status, 'up_to_date')
  assert.match(r.warning, /origin\/main is not an ancestor of local main/)
  g(root, 'update-ref', 'refs/remotes/origin/main', sha(root, 'main'))
  assert.equal(cmdSyncMain(root, { campaign: 'c' }).warning, null)
})
test('sync-main: refuses a missing campaign branch, naming the init command', () => {
  const root = mkRepo({ init: false })
  assert.throws(() => cmdSyncMain(root, { campaign: 'c' }), /campaign\/c does not exist — run: node scripts\/wolfpack-chain\.mjs init --campaign c/)
})

// ════════════════════════════════════════════════════════════════════════════
// 30. overlap (rule c) — temp repo
// ════════════════════════════════════════════════════════════════════════════
test('overlap: a shared code file holds the hunt (held_on in both copies, status certified_held_overlap)', () => {
  const root = mkRepo()
  addHunt(root, 'b', { edits: { 'app.txt': APP.replace('l4', 'b'), 'b.txt': 'b\n' }, status: 'parked:open_critical' })
  addHunt(root, 'g', { edits: { 'app.txt': APP.replace('l1', 'g') } })
  writeMeta(root, 'g', { feature: 'g', status: 'certified' }, { main: true })
  const r = cmdOverlap(root, { campaign: 'c', hunt: 'g', blockers: 'b' })
  assert.deepEqual(r, { overlaps: { b: ['app.txt'] }, noDiff: [], held: true })
  for (const m of Object.values(metaBoth(root, 'g'))) {
    assert.equal(m.status, CHAIN_STATUS.HELD_OVERLAP)
    assert.deepEqual(m.held_on, [{ slug: 'b', files: ['app.txt'] }])
  }
})
test('overlap: only bookkeeping paths shared (CHANGELOG.md, TODO.md, .wolfpack/) → not held, nothing written', () => {
  const root = mkRepo()
  addHunt(root, 'b', { edits: { 'CHANGELOG.md': clWith('- b'), 'TODO.md': TODO.replace('- [ ] t1\n', ''), '.wolfpack/pedigree/index.md': 'b\n', 'b.txt': 'b\n' }, status: 'parked:open_critical' })
  addHunt(root, 'g', { edits: { 'CHANGELOG.md': clWith('- g'), 'TODO.md': TODO.replace('- [ ] t2\n', ''), '.wolfpack/pedigree/index.md': 'g\n', 'g.txt': 'g\n' } })
  const r = cmdOverlap(root, { campaign: 'c', hunt: 'g', blockers: 'b' })
  assert.deepEqual(r, { overlaps: {}, noDiff: [], held: false })
  assert.equal(metaWt(root, 'g').status, 'certified')
  assert.equal('held_on' in metaWt(root, 'g'), false)
})
test('overlap: a blocker with no diff yet (no branch, no commits, or bookkeeping-only) → noDiff', () => {
  const root = mkRepo()
  addHunt(root, 'empty', { status: 'parked:open_critical' })                         // branch, no commits
  addHunt(root, 'bk', { edits: { 'CHANGELOG.md': clWith('- bk') }, status: 'needs_spec' })   // bookkeeping only
  addHunt(root, 'g', { edits: { 'app.txt': APP.replace('l1', 'g') } })
  const r = cmdOverlap(root, { campaign: 'c', hunt: 'g', blockers: 'empty,nobranch,bk' })
  assert.deepEqual(r, { overlaps: {}, noDiff: ['empty', 'nobranch', 'bk'], held: false })
})
test('overlap: a certified_pending_compliance hunt that overlaps is held but KEEPS its status (the hold never erases the compliance flag)', () => {
  const root = mkRepo()
  addHunt(root, 'b', { edits: { 'app.txt': APP.replace('l4', 'b') }, status: 'parked:open_critical' })
  addHunt(root, 'red', { edits: { 'app.txt': APP.replace('l1', 'r') }, status: CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE })
  const r = cmdOverlap(root, { campaign: 'c', hunt: 'red', blockers: 'b' })
  assert.equal(r.held, true)
  const m = metaWt(root, 'red')
  assert.equal(m.status, CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE)
  assert.deepEqual(m.held_on, [{ slug: 'b', files: ['app.txt'] }])
})
test('overlap: validates slugs and the campaign branch', () => {
  const root = mkRepo()
  assert.throws(() => cmdOverlap(root, { campaign: 'c', hunt: 'g', blockers: 'ok,../bad' }), ChainError)
  assert.throws(() => cmdOverlap(root, { campaign: 'nope', hunt: 'g', blockers: 'b' }), /campaign\/nope does not exist/)
})

// ════════════════════════════════════════════════════════════════════════════
// 31. pending-compliance stamp (temp repo)
// ════════════════════════════════════════════════════════════════════════════
test('AC11/AC12 merge-hunt stamp: every compliance marker → merged_to_campaign_pending_compliance; signed → merged_to_campaign', () => {
  const root = mkRepo()
  const cases = {
    prior: { status: CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE, want: CHAIN_STATUS.MERGED_PENDING_COMPLIANCE },
    spec: { status: 'certified', spec: { compliance_review_required: true }, want: CHAIN_STATUS.MERGED_PENDING_COMPLIANCE },
    hold: { status: CHAIN_STATUS.HELD_OVERLAP, spec: { compliance_review_required: false }, compliance_hold: { reason: 'billing', touched_paths: ['billing/x.py'] }, want: CHAIN_STATUS.MERGED_PENDING_COMPLIANCE },
    signed: { status: 'certified', spec: { compliance_review_required: true }, park: { compliance_signed_off: true }, want: CHAIN_STATUS.MERGED },
    plain: { status: 'certified', want: CHAIN_STATUS.MERGED },
  }
  for (const [slug, { want, ...meta }] of Object.entries(cases)) {
    addHunt(root, slug, { edits: { [`${slug}.txt`]: `${slug}\n` }, status: meta.status, meta })
    const r = cmdMergeHunt(root, { campaign: 'c', hunt: slug, at: AT })
    assert.equal(r.status, 'merged', slug)
    assert.equal(r.stamped, want, slug)
    const m = metaBoth(root, slug)
    assert.equal(m.main.status, want, slug)
    assert.equal(m.wt.status, want, slug)
    if (meta.compliance_hold) assert.deepEqual(m.main.compliance_hold, meta.compliance_hold, 'compliance_hold is never cleared')
  }
})
test('AC11: held-then-merged — a certified_pending_compliance hunt held by overlap, then merged, stays pending compliance with compliance_hold kept', () => {
  const root = mkRepo()
  addHunt(root, 'b', { edits: { 'app.txt': APP.replace('l4', 'b') }, status: 'parked:open_critical' })
  const hold = { reason: 'touches billing', touched_paths: ['app.txt'], summary: 'x', held_at: AT }
  addHunt(root, 'red', { edits: { 'app.txt': APP.replace('l1', 'r') }, status: CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE, meta: { compliance_hold: hold } })
  assert.equal(cmdOverlap(root, { campaign: 'c', hunt: 'red', blockers: 'b' }).held, true)
  // the blocker is resolved and merges first (its own status flips to certified)
  writeMeta(root, 'b', { feature: 'b', status: 'certified' })
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 'b', at: AT }).status, 'merged')
  const r = cmdMergeHunt(root, { campaign: 'c', hunt: 'red', at: AT })
  assert.equal(r.status, 'merged')
  assert.equal(r.stamped, CHAIN_STATUS.MERGED_PENDING_COMPLIANCE)
  const m = metaBoth(root, 'red').main
  assert.deepEqual(m.compliance_hold, hold)
  assert.equal('held_on' in m, false, 'held_on is cleared on merge')
  assert.equal(showFile(root, 'campaign/c', 'app.txt'), APP.replace('l1', 'r').replace('l4', 'b'))
})
test('merge-hunt: the worktree plan dir is copied back to the main repo on success', () => {
  const root = mkRepo()
  addHunt(root, 'h', { edits: { 'h.txt': 'h\n' } })
  writeFileSync(join(wtPlan(root, 'h'), 'certification.md'), '# cert\n')
  assert.equal(cmdMergeHunt(root, { campaign: 'c', hunt: 'h', at: AT }).status, 'merged')
  assert.equal(readFileSync(join(mainPlan(root, 'h'), 'certification.md'), 'utf8'), '# cert\n')
})
