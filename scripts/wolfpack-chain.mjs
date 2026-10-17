#!/usr/bin/env node
// scripts/wolfpack-chain.mjs — campaign CHAIN MODE (`--chain`) git core.
//
// Chain mode moves a campaign's integration target from `main` to a LOCAL branch
// `campaign/<slug>`: hunts fork from and rebase onto it, certified hunts auto-merge into it
// (`--no-ff`, never tagged, never pushed), `main` is merged into it at each wave start, and a
// blocked hunt only holds the hunts that conflict with it. The Workflow runner cannot run git
// itself, so EVERY git step of chain mode runs through this one deterministic CLI (called from
// a sonnet agent Bash step that returns its JSON verbatim). The git logic is therefore real,
// tested code — never LLM-improvised.
//
// NAMESPACE-AGNOSTIC BY DESIGN: this file never names a worktree directory. A hunt's worktree
// is found with `git worktree list --porcelain` by its branch (`refs/heads/feat/<slug>`), and
// merges into `campaign/<slug>` run in a temporary worktree under the OS temp dir (removed in
// `finally`), so the main checkout never leaves `main` mid-run. That keeps this file
// byte-identical in every repo that consumes the Wolfpack.
//
// CLI (JSON on stdout; exit 0 = decided — "conflict" included —, exit 2 = error {status:'error',reason}):
//   node scripts/wolfpack-chain.mjs init      --campaign C [--graph JSON] [--at ISO]
//   node scripts/wolfpack-chain.mjs sync-main --campaign C
//   node scripts/wolfpack-chain.mjs overlap   --campaign C --hunt H --blockers b1,b2
//   node scripts/wolfpack-chain.mjs merge-hunt --campaign C --hunt H [--at ISO]
//
// The PURE CORE block below appears byte-identically (minus `export `) in the runner
// (`campaign-runner.js`); a drift test fails if the two copies differ.
//
// Run tests: node --test scripts/wolfpack-chain.test.mjs

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// ── BEGIN wolfpack-chain core (keep byte-identical: scripts/wolfpack-chain.mjs ⇄ campaign-runner.js) ──
export const CHAIN_STATUS = Object.freeze({
  MERGED: 'merged_to_campaign',
  MERGED_PENDING_COMPLIANCE: 'merged_to_campaign_pending_compliance',
  CERTIFIED_PENDING_COMPLIANCE: 'certified_pending_compliance',
  HELD_OVERLAP: 'certified_held_overlap',
  MERGE_CONFLICT: 'parked:campaign_merge_conflict',
  REVERTED: 'parked:reverted_from_campaign',
  REVERTED_WITH_DEP: 'reverted_with_dependency',
})
// 'released' | 'campaign_merged' | 'awaiting_merge' | 'reverted_dep' | 'quota' | 'blocked' | 'pending'
export function chainClass(status) {
  const s = String(status || '')
  if (s === 'merged') return 'released'
  if (s === CHAIN_STATUS.MERGED || s === CHAIN_STATUS.MERGED_PENDING_COMPLIANCE) return 'campaign_merged'
  if (['certified', 'certified_not_merged', CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE, CHAIN_STATUS.HELD_OVERLAP].includes(s)) return 'awaiting_merge'
  if (s === CHAIN_STATUS.REVERTED_WITH_DEP) return 'reverted_dep'
  if (s === 'parked:model_quota') return 'quota'
  if (s === 'needs_spec' || s.startsWith('parked:')) return 'blocked'
  return 'pending'
}
export const isDependencyMet = (status) => ['released', 'campaign_merged'].includes(chainClass(status))
export const isBlockedStatus = (status) => ['blocked', 'reverted_dep'].includes(chainClass(status))
// graph: { [slug]: { dependsOn: string[], migrationApps: string[] } }
// Returns Map dep → path, where path is the slug chain from `slug` to that dep inclusive
// (x→y→b gives b → ['x','y','b']). Breadth-first, so each path is a shortest one; a
// visited set makes it cycle-safe.
export function dependencyClosure(slug, graph) {
  const out = new Map()
  const g = graph || {}
  const queue = [[slug, [slug]]]
  const seen = new Set([slug])
  while (queue.length) {
    const [cur, path] = queue.shift()
    const deps = (g[cur] && Array.isArray(g[cur].dependsOn)) ? g[cur].dependsOn : []
    for (const d of deps) {
      if (seen.has(d)) continue
      seen.add(d)
      const p = [...path, d]
      out.set(d, p)
      queue.push([d, p])
    }
  }
  return out
}
// overlaps: { [blockedSlug]: string[] } (rule c, precomputed by the CLI). Returns [] when no conflict.
// One entry per (blocker, rule): a = depends on it (directly or transitively), b = shares a
// migration app with it (case-insensitive), c = its diff overlaps the blocker's diff.
export function chainConflicts(slug, blockedSlugs, graph, overlaps = {}) {
  const g = graph || {}
  const out = []
  const closure = dependencyClosure(slug, g)
  const appsOf = (s) => ((g[s] && Array.isArray(g[s].migrationApps)) ? g[s].migrationApps : [])
    .map(a => String(a).trim().toLowerCase()).filter(Boolean)
  const mine = new Set(appsOf(slug))
  for (const b of blockedSlugs || []) {
    if (b === slug) continue
    if (closure.has(b)) out.push({ rule: 'a', with: b, via: closure.get(b) })
    const shared = [...new Set(appsOf(b))].filter(a => mine.has(a))
    if (shared.length) out.push({ rule: 'b', with: b, apps: shared })
    const files = (overlaps && Array.isArray(overlaps[b])) ? overlaps[b] : []
    if (files.length) out.push({ rule: 'c', with: b, files: [...files] })
  }
  return out
}
// ── END wolfpack-chain core ──

// ─── Pure helpers ─────────────────────────────────────────────────

// Bookkeeping paths every certified hunt touches (the Watchdog commits pedigree/index.md,
// every hunt adds a CHANGELOG line and removes its TODO line). Rule (c) ignores them, or
// every hunt would "overlap" every blocked hunt.
export function isBookkeepingPath(p) {
  const s = String(p || '').replace(/^\.\//, '')
  return s.startsWith('.wolfpack/') || s === 'CHANGELOG.md' || s === 'TODO.md'
}
// The only files whose conflicts merge-hunt / sync-main may auto-resolve (A-9).
export const isLineMergeablePath = (p) => {
  const s = String(p || '').replace(/^\.\//, '')
  return s === 'CHANGELOG.md' || s === 'TODO.md'
}

// Align `side` against `base` when one is a subsequence of the other.
//   insertion: base ⊆ side → { kind:'insert', gaps: Map<gapIndex, string[]> } (gap i = before base[i]; gap n = end)
//   deletion:  side ⊆ base → { kind:'delete', deleted: Set<baseIndex> }
//   identical → { kind:'same' }; neither → null (the side MODIFIED a line).
function alignSide(base, side) {
  if (base.length === side.length && base.every((l, i) => l === side[i])) return { kind: 'same' }
  if (side.length > base.length) {
    const gaps = new Map()
    let i = 0
    for (const line of side) {
      if (i < base.length && line === base[i]) { i++; continue }
      if (!gaps.has(i)) gaps.set(i, [])
      gaps.get(i).push(line)
    }
    return i === base.length ? { kind: 'insert', gaps } : null
  }
  if (side.length < base.length) {
    const deleted = new Set()
    let j = 0
    for (let i = 0; i < base.length; i++) {
      if (j < side.length && base[i] === side[j]) { j++; continue }
      deleted.add(i)
    }
    return j === side.length ? { kind: 'delete', deleted } : null
  }
  return null // same length, different content ⇒ a modification
}

// A-9: merge two versions of a bookkeeping file against their merge base, ONLY when each
// side is a pure line-insertion or a pure line-deletion of the base (a proved subsequence
// relation). Returns the merged text, or null for anything else (a real conflict).
// Insertions at the same spot keep both, ours first; a line deleted by either side is gone.
export function mergeLineSets(base, ours, theirs) {
  if (base == null || ours == null || theirs == null) return null
  const B = String(base).split('\n')
  const O = alignSide(B, String(ours).split('\n'))
  const T = alignSide(B, String(theirs).split('\n'))
  if (!O || !T) return null
  const out = []
  const gapLines = (side, i) => (side.kind === 'insert' && side.gaps.has(i)) ? side.gaps.get(i) : []
  const isDeleted = (side, i) => side.kind === 'delete' && side.deleted.has(i)
  for (let i = 0; i <= B.length; i++) {
    out.push(...gapLines(O, i), ...gapLines(T, i))
    if (i < B.length && !isDeleted(O, i) && !isDeleted(T, i)) out.push(B[i])
  }
  return out.join('\n')
}

const nonEmptyObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0

// The pending-compliance rule shared by merge-hunt and wolfpack-release.mjs `check`/`sign-off`.
// True when the hunt touched a compliance surface (any marker below) and no human signed it
// off. `compliance_hold` is the gate-written marker: it survives every later status change
// (overlap holds, merges, reverts never clear it), so a drifted status cannot launder a hunt.
export function needsComplianceHold(meta) {
  const m = meta || {}
  if (m.park && m.park.compliance_signed_off === true) return false
  return m.status === CHAIN_STATUS.CERTIFIED_PENDING_COMPLIANCE ||
    m.status === CHAIN_STATUS.MERGED_PENDING_COMPLIANCE ||
    nonEmptyObject(m.compliance_hold) ||
    (m.spec && m.spec.compliance_review_required === true)
}

// parked.md in the exact structure /parked and /resolve parse (mirrors hunt-pipeline parkHunt).
export function renderParkRecord({ slug, reason, parkedAt, resumePhase, resolutionType, tier, need, context, options }) {
  return [
    `# PARKED — ${slug}`,
    '',
    `- reason: ${reason}`,
    `- parked_at: ${parkedAt}`,
    `- resume_phase: ${resumePhase}`,
    `- resolution_type_expected: ${resolutionType}`,
    `- tier: ${tier || 'Red'}`,
    '',
    '## What I need from you',
    need || '',
    '',
    '## Context (enough to decide without opening the worktree)',
    context || '',
    ...(options ? ['', '## Options (feeds AskUserQuestion)', options] : []),
    '',
  ].join('\n')
}

// The park block hunt-pipeline's parkHunt writes, so /resolve and the compliance gate never
// read undefined. A re-park keeps the redirect-loop counter.
export function parkBlock({ reason, parkedAt, resumePhase, resolutionType, tier, prior }) {
  return {
    reason, parked_at: parkedAt, resume_phase: resumePhase, resolution_type: resolutionType,
    tier: tier || 'Red', human_notes_seen: false,
    redirect_count: (prior && Number.isInteger(prior.redirect_count)) ? prior.redirect_count : 0,
    compliance_signed_off: false,
  }
}

// AC10: the hunts a revert of `slug` must take out of the campaign branch — `slug` itself plus
// every campaign-merged hunt that depends on it transitively, NEWEST FIRST.
//   statuses:   { [slug]: status }
//   mergeOrder: slugs ordered newest-merged first (first-parent order of their
//               campaign_merge_commit on campaign/<c>); unknown slugs sort last.
export function revertTargets(slug, statuses, graph, mergeOrder) {
  const st = statuses || {}
  const order = Array.isArray(mergeOrder) ? mergeOrder : []
  const rank = (s) => { const i = order.indexOf(s); return i === -1 ? Number.MAX_SAFE_INTEGER : i }
  const dependents = Object.keys(graph || {}).filter(s =>
    s !== slug && chainClass(st[s]) === 'campaign_merged' && dependencyClosure(s, graph).has(slug))
  return [slug, ...dependents].sort((a, b) => rank(a) - rank(b))
}

// ─── Git helpers (exported for wolfpack-release.mjs) ──────────────

export function git(args, { cwd, allowFail = false, input } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  const res = { code: r.status == null ? -1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
  if (!allowFail && res.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.code})${res.stderr ? `: ${res.stderr.split('\n')[0]}` : ''}`)
  }
  return res
}

// The MAIN repo root, even when invoked from inside a linked worktree (git-common-dir is
// <root>/.git in both cases).
export function repoRoot(cwd = process.cwd()) {
  const common = git(['rev-parse', '--git-common-dir'], { cwd }).stdout
  const abs = isAbsolute(common) ? common : resolve(cwd, common)
  return dirname(abs)
}

export const branchExists = (root, ref) =>
  git(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { cwd: root, allowFail: true }).code === 0
export const revParse = (root, ref) => git(['rev-parse', ref], { cwd: root }).stdout
export const isAncestor = (root, a, b) =>
  git(['merge-base', '--is-ancestor', a, b], { cwd: root, allowFail: true }).code === 0

// The worktree that has refs/heads/feat/<slug> checked out, or null.
export function findWorktree(root, slug) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd: root }).stdout
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const wt = lines.find(l => l.startsWith('worktree '))
    const br = lines.find(l => l.startsWith('branch '))
    if (wt && br && br.slice('branch '.length).trim() === `refs/heads/feat/${slug}`) {
      return wt.slice('worktree '.length).trim()
    }
  }
  return null
}

// Tracked changes outside .wolfpack/ (untracked convenience symlinks never count).
// Tracked uncommitted changes. `.wolfpack/` bookkeeping is exempt unless includeWolfpack is
// set: a `git rebase` refuses ANY tracked dirt (pedigree index.md / pedigree.json included).
export function dirtyPaths(dir, { includeWolfpack = false } = {}) {
  return git(['status', '--porcelain', '--untracked-files=no'], { cwd: dir }).stdout
    // git() trims stdout, so the FIRST line may have lost its leading status space: strip the
    // XY code by shape, not by a fixed slice(3) (which ate the first path's first character).
    .split('\n').filter(Boolean).map(l => l.replace(/^\s*\S{1,2}\s+/, '').replace(/^.* -> /, '').trim())
    .filter(p => includeWolfpack || !p.startsWith('.wolfpack/'))
}

// Run fn(dir) in a temporary worktree checked out at `ref` (a branch name checks the branch
// out there, so commits made in it move the branch). Always removed in `finally`.
export function withTempWorktree(root, ref, fn) {
  const parent = mkdtempSync(join(tmpdir(), 'wolfpack-chain-'))
  const dir = join(parent, 'wt')
  let added = false
  try {
    git(['worktree', 'add', '--quiet', dir, ref], { cwd: root })
    added = true
    return fn(dir)
  } finally {
    if (added) git(['worktree', 'remove', '--force', dir], { cwd: root, allowFail: true })
    rmSync(parent, { recursive: true, force: true })
    git(['worktree', 'prune'], { cwd: root, allowFail: true })
  }
}

export const unmergedFiles = (dir) =>
  git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir }).stdout.split('\n').filter(Boolean)

// A-9: try to resolve every conflicted file in `dir` with mergeLineSets. Returns
// { resolved:true } when every conflict was a bookkeeping insert/delete collision (each
// resolved file is written and staged), else { resolved:false, files }.
export function resolveBookkeepingConflicts(dir) {
  const files = unmergedFiles(dir)
  if (!files.length) return { resolved: false, files }
  if (!files.every(isLineMergeablePath)) return { resolved: false, files }
  // Untrimmed blob text (git() trims, which would change the trailing newline); a missing
  // stage (add/add or modify/delete) yields null ⇒ not a pure insert/delete ⇒ real conflict.
  const stage = (n, f) => {
    const r = spawnSync('git', ['show', `:${n}:${f}`], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return r.status === 0 ? r.stdout : null
  }
  const merged = []
  for (const f of files) {
    const text = mergeLineSets(stage(1, f), stage(2, f), stage(3, f))
    if (text == null) return { resolved: false, files }
    merged.push([f, text])
  }
  for (const [f, text] of merged) {
    writeFileSync(join(dir, f), text)
    git(['add', '--', f], { cwd: dir })
  }
  return { resolved: true, files }
}

const gitPathExists = (dir, name) => existsSync(resolve(dir, git(['rev-parse', '--git-path', name], { cwd: dir }).stdout))
export const rebaseInProgress = (dir) => gitPathExists(dir, 'rebase-merge') || gitPathExists(dir, 'rebase-apply')
export const revertInProgress = (dir) => gitPathExists(dir, 'REVERT_HEAD')
export const mergeInProgress = (dir) => gitPathExists(dir, 'MERGE_HEAD')

// ─── Metadata (worktree-first read, dual write) ───────────────────

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, obj) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n') }

export function huntPlanDirs(root, slug) {
  const wt = findWorktree(root, slug)
  return {
    worktree: wt,
    worktreePlanDir: wt ? join(wt, '.wolfpack', 'plans', slug) : null,
    mainPlanDir: join(root, '.wolfpack', 'plans', slug),
  }
}

// Worktree copy first (it is the live one during a hunt), else the main-repo copy; null when neither exists.
export function readHuntMeta(root, slug) {
  const d = huntPlanDirs(root, slug)
  for (const dir of [d.worktreePlanDir, d.mainPlanDir]) {
    if (dir && existsSync(join(dir, 'metadata.json'))) return { meta: readJson(join(dir, 'metadata.json')), dirs: d, from: dir }
  }
  return { meta: null, dirs: d, from: null }
}

// Read-modify-write: mutate(meta) edits the authoritative copy in place; the result is written
// to BOTH copies (the main-repo plan dir is created if missing) so they never diverge.
// `files` ({name: text}) are written next to metadata.json in both plan dirs.
export function writeHuntMeta(root, slug, mutate, files = {}) {
  const { meta, dirs } = readHuntMeta(root, slug)
  if (!meta) throw new Error(`no metadata.json for hunt ${slug}`)
  mutate(meta)
  for (const dir of [dirs.worktreePlanDir, dirs.mainPlanDir].filter(Boolean)) {
    writeJson(join(dir, 'metadata.json'), meta)
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  }
  return meta
}

export const campaignMetaPath = (root, c) => join(root, '.wolfpack', 'campaigns', c, 'metadata.json')
export function readCampaignMeta(root, c) {
  const p = campaignMetaPath(root, c)
  return existsSync(p) ? readJson(p) : null
}
export function writeCampaignMeta(root, c, meta) { writeJson(campaignMetaPath(root, c), meta) }

// The campaign's hunts: the chain graph's keys (written by the runner's init), else
// metadata.hunts (written by /expedition).
export function campaignHunts(campaignMeta) {
  const m = campaignMeta || {}
  const g = (m.chain && m.chain.graph) || {}
  const keys = Object.keys(g)
  return keys.length ? keys : (Array.isArray(m.hunts) ? m.hunts : [])
}

// ─── Subcommands ──────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
export class ChainError extends Error {}
const need = (v, name) => {
  if (!v || !SLUG_RE.test(String(v))) throw new ChainError(`--${name} must match ^[a-z0-9][a-z0-9-]*$ (got ${JSON.stringify(v)})`)
  return v
}

export function cmdInit(root, { campaign, graph, at }) {
  const c = need(campaign, 'campaign')
  const branch = `campaign/${c}`
  const now = at || new Date().toISOString()
  let status
  if (branchExists(root, branch)) status = 'adopted'
  else {
    if (!branchExists(root, 'main')) throw new ChainError('local branch main does not exist')
    git(['branch', branch, 'main'], { cwd: root })
    status = 'created'
  }
  const sha = revParse(root, `refs/heads/${branch}`)
  const meta = readCampaignMeta(root, c) || { campaign: c }
  const prior = meta.chain || {}
  meta.chain = {
    ...prior,
    mode: 'chain',
    branch,
    created_at: prior.created_at || now,
    created_from: prior.created_from || (status === 'created' ? `main@${revParse(root, 'refs/heads/main')}` : `adopted@${sha}`),
    ...(status === 'adopted' ? { adopted_at: now } : {}),
  }
  // A graph-less init (the /run-campaign-local preflight) never writes an empty graph: the
  // runner's own init supplies it, and until then campaignHunts reads metadata.hunts.
  const g = graph || prior.graph
  if (g && Object.keys(g).length) meta.chain.graph = g
  else delete meta.chain.graph
  writeCampaignMeta(root, c, meta)
  return { status, branch, sha }
}

export function cmdSyncMain(root, { campaign }) {
  const c = need(campaign, 'campaign')
  const branch = `campaign/${c}`
  if (!branchExists(root, branch)) throw new ChainError(`${branch} does not exist — run: node scripts/wolfpack-chain.mjs init --campaign ${c}`)
  // Spec A4: the wave-start merge uses LOCAL main; warn when origin/main has commits main lacks.
  let warning = null
  const om = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: root, allowFail: true })
  if (om.code === 0 && !isAncestor(root, 'refs/remotes/origin/main', 'refs/heads/main')) {
    warning = 'origin/main is not an ancestor of local main (pushed from elsewhere?) — merged LOCAL main only'
  }
  if (isAncestor(root, 'refs/heads/main', `refs/heads/${branch}`)) {
    return { status: 'up_to_date', sha: revParse(root, `refs/heads/${branch}`), files: [], warning }
  }
  return withTempWorktree(root, branch, (dir) => {
    const m = git(['merge', '--no-ff', 'main', '-m', `Merge branch 'main' into ${branch}`], { cwd: dir, allowFail: true })
    if (m.code !== 0) {
      const r = mergeInProgress(dir) ? resolveBookkeepingConflicts(dir) : { resolved: false, files: [] }
      if (r.resolved) {
        git(['-c', 'core.editor=true', 'commit', '--no-edit'], { cwd: dir })
      } else {
        const files = r.files.length ? r.files : unmergedFiles(dir)
        if (mergeInProgress(dir)) git(['merge', '--abort'], { cwd: dir, allowFail: true })
        if (!files.length) throw new ChainError(`merge of main into ${branch} failed: ${m.stderr.split('\n')[0]}`)
        return { status: 'conflict', sha: revParse(root, `refs/heads/${branch}`), files, warning }
      }
    }
    return { status: 'merged', sha: revParse(dir, 'HEAD'), files: [], warning }
  })
}

const diffNames = (root, branch, slug) => {
  if (!branchExists(root, `feat/${slug}`)) return []
  return git(['diff', '--name-only', `refs/heads/${branch}...refs/heads/feat/${slug}`], { cwd: root }).stdout
    .split('\n').filter(Boolean).filter(p => !isBookkeepingPath(p))
}

const HOLDABLE = ['certified', 'certified_not_merged', CHAIN_STATUS.HELD_OVERLAP]

export function cmdOverlap(root, { campaign, hunt, blockers }) {
  const c = need(campaign, 'campaign')
  const h = need(hunt, 'hunt')
  const branch = `campaign/${c}`
  if (!branchExists(root, branch)) throw new ChainError(`${branch} does not exist`)
  const list = String(blockers || '').split(',').map(s => s.trim()).filter(Boolean)
  list.forEach(b => need(b, 'blockers'))
  const mine = new Set(diffNames(root, branch, h))
  const overlaps = {}
  const noDiff = []
  for (const b of list) {
    const theirs = diffNames(root, branch, b)
    if (!theirs.length) { noDiff.push(b); continue }
    const shared = theirs.filter(p => mine.has(p))
    if (shared.length) overlaps[b] = shared
  }
  const held = Object.keys(overlaps).length > 0
  if (held) {
    writeHuntMeta(root, h, (meta) => {
      meta.held_on = Object.entries(overlaps).map(([slug, files]) => ({ slug, files }))
      // A certified_pending_compliance hunt KEEPS that status: the hold never erases the
      // compliance flag (chainClass already reads it as awaiting merge).
      if (HOLDABLE.includes(meta.status)) meta.status = CHAIN_STATUS.HELD_OVERLAP
    })
  }
  return { overlaps, noDiff, held }
}

// Stamp a merge-conflict park in both plan dirs (and parked.md).
function stampMergeConflict(root, c, h, stage, files, at) {
  writeHuntMeta(root, h, (meta) => {
    const tier = (meta.tier) || 'Red'
    meta.status = CHAIN_STATUS.MERGE_CONFLICT
    meta.park = parkBlock({ reason: 'campaign_merge_conflict', parkedAt: at, resumePhase: 'Code Review', resolutionType: 'clarify', tier, prior: meta.park })
  }, {
    'parked.md': renderParkRecord({
      slug: h, reason: 'campaign_merge_conflict', parkedAt: at, resumePhase: 'Code Review', resolutionType: 'clarify',
      tier: (readHuntMeta(root, h).meta || {}).tier,
      need: `The chain auto-merge of feat/${h} into campaign/${c} conflicted (${stage}). campaign/${c} is unchanged. Rebase feat/${h} onto campaign/${c} in its worktree (resolve the conflict, commit), then answer clarify — the hunt re-runs Code Review and merges on the next runner pass.`,
      context: `Conflicted files: ${files.join(', ') || '(none reported)'}\nStage: ${stage}\nIn the hunt's worktree: git rebase campaign/${c}`,
      options: `- A (clarify): I rebased it — resume at Code Review.\n- B (redirect): the hunt needs re-planning against the campaign branch.`,
    }),
  })
}

export function cmdMergeHunt(root, { campaign, hunt, at }) {
  const c = need(campaign, 'campaign')
  const h = need(hunt, 'hunt')
  const branch = `campaign/${c}`
  const now = at || new Date().toISOString()
  // 1. Preconditions.
  if (!branchExists(root, branch)) throw new ChainError(`${branch} does not exist`)
  const wt = findWorktree(root, h)
  if (!wt) throw new ChainError(`no worktree has feat/${h} checked out`)
  const dirty = dirtyPaths(wt)
  if (dirty.length) throw new ChainError(`${h}'s worktree has uncommitted changes outside .wolfpack/: ${dirty.join(', ')}`)
  const { meta: before } = readHuntMeta(root, h)
  if (!before) throw new ChainError(`no metadata.json for hunt ${h}`)
  // Allow-list: only a certified (awaiting-merge) hunt or a reverted dependent. A mid-pipeline,
  // quota-parked, blocked, merged or released hunt is refused — never merged uncertified.
  const cls = chainClass(before.status)
  if (!['awaiting_merge', 'reverted_dep'].includes(cls)) {
    throw new ChainError(`${h} is ${before.status || '(no status)'} — merge-hunt only merges a certified hunt or reapplies a reverted dependent`)
  }
  const reapply = before.status === CHAIN_STATUS.REVERTED_WITH_DEP
  if (!reapply) {
    // Normal mode rebases IN this worktree, and git rebase refuses tracked .wolfpack/ dirt too.
    const wolfDirt = dirtyPaths(wt, { includeWolfpack: true }).filter(p => p.startsWith('.wolfpack/'))
    if (wolfDirt.length) throw new ChainError(`${h}'s worktree has uncommitted tracked .wolfpack/ changes the rebase would refuse: ${wolfDirt.join(', ')} — commit or discard them, then re-run`)
  }

  let commit
  if (reapply) {
    // 2. Reapply mode: re-apply the dependent's reverted change on a temp branch, merge --no-ff.
    const revertCommit = before.campaign_revert_commit
    if (!revertCommit) throw new ChainError(`${h} is ${before.status} but has no campaign_revert_commit`)
    const tmpBranch = `wolfpack/reapply-${h}`
    const r = withTempWorktree(root, branch, (dir) => {
      git(['checkout', '--quiet', '-b', tmpBranch, branch], { cwd: dir })
      try {
        const rv = git(['revert', '--no-edit', revertCommit], { cwd: dir, allowFail: true })
        if (rv.code !== 0) {
          const res = revertInProgress(dir) ? resolveBookkeepingConflicts(dir) : { resolved: false, files: [] }
          if (res.resolved) git(['-c', 'core.editor=true', 'revert', '--continue'], { cwd: dir })
          else {
            const files = res.files.length ? res.files : unmergedFiles(dir)
            if (revertInProgress(dir)) git(['revert', '--abort'], { cwd: dir, allowFail: true })
            git(['checkout', '--quiet', branch], { cwd: dir, allowFail: true })
            return { conflict: true, stage: 'reapply', files }
          }
        }
        git(['checkout', '--quiet', branch], { cwd: dir })
        const m = git(['merge', '--no-ff', tmpBranch, '-m', `Merge branch 'feat/${h}' (reapplied) into ${branch}`], { cwd: dir, allowFail: true })
        if (m.code !== 0) {
          const files = unmergedFiles(dir)
          if (mergeInProgress(dir)) git(['merge', '--abort'], { cwd: dir, allowFail: true })
          return { conflict: true, stage: 'reapply', files }
        }
        return { conflict: false, commit: revParse(dir, 'HEAD') }
      } finally {
        git(['branch', '-D', tmpBranch], { cwd: dir, allowFail: true })
      }
    })
    if (r.conflict) {
      stampMergeConflict(root, c, h, r.stage, r.files, now)
      return { status: 'conflict', stage: r.stage, files: r.files }
    }
    commit = r.commit
  } else {
    // 3. Normal mode: rebase in H's worktree (bookkeeping collisions auto-resolve), then merge.
    let rb = git(['rebase', branch], { cwd: wt, allowFail: true })
    for (let guard = 0; rb.code !== 0; guard++) {
      // A rebase that never started (bad ref, locked index, …) is an error, not a conflict.
      if (!rebaseInProgress(wt)) throw new ChainError(`git rebase ${branch} failed in ${h}'s worktree: ${rb.stderr.split('\n')[0]}`)
      const res = guard < 500 ? resolveBookkeepingConflicts(wt) : { resolved: false, files: unmergedFiles(wt) }
      if (!res.resolved) {
        const files = res.files.length ? res.files : unmergedFiles(wt)
        git(['rebase', '--abort'], { cwd: wt, allowFail: true })
        stampMergeConflict(root, c, h, 'rebase', files, now)
        return { status: 'conflict', stage: 'rebase', files }
      }
      // A resolution that leaves the commit empty cannot be continued — skip it.
      const empty = git(['diff', '--cached', '--quiet'], { cwd: wt, allowFail: true }).code === 0
      rb = empty
        ? git(['-c', 'core.editor=true', 'rebase', '--skip'], { cwd: wt, allowFail: true })
        : git(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: wt, allowFail: true })
    }
    const m = withTempWorktree(root, branch, (dir) => {
      const r = git(['merge', '--no-ff', `feat/${h}`, '-m', `Merge branch 'feat/${h}' into ${branch}`], { cwd: dir, allowFail: true })
      if (r.code !== 0) {
        const files = unmergedFiles(dir)
        if (mergeInProgress(dir)) git(['merge', '--abort'], { cwd: dir, allowFail: true })
        return { conflict: true, files }
      }
      return { conflict: false, commit: revParse(dir, 'HEAD') }
    })
    if (m.conflict) {
      stampMergeConflict(root, c, h, 'merge', m.files, now)
      return { status: 'conflict', stage: 'merge', files: m.files }
    }
    commit = m.commit
  }

  // 5. Success: copy the plan dir back (worktree → main), then stamp both copies.
  const dirs = huntPlanDirs(root, h)
  if (dirs.worktreePlanDir && existsSync(dirs.worktreePlanDir)) {
    mkdirSync(dirs.mainPlanDir, { recursive: true })
    cpSync(dirs.worktreePlanDir, dirs.mainPlanDir, { recursive: true, force: true })
  }
  let stamped
  writeHuntMeta(root, h, (meta) => {
    // needsComplianceHold covers: prior status certified_pending_compliance, a non-empty
    // compliance_hold, or spec.compliance_review_required — each only while unsigned.
    stamped = needsComplianceHold(meta) ? CHAIN_STATUS.MERGED_PENDING_COMPLIANCE : CHAIN_STATUS.MERGED
    const history = Array.isArray(meta.campaign_merge_history) ? meta.campaign_merge_history : []
    if (meta.campaign_merge_commit || meta.campaign_revert_commit) {
      history.push({
        campaign_merge_commit: meta.campaign_merge_commit || null,
        campaign_merged_at: meta.campaign_merged_at || null,
        campaign_revert_commit: meta.campaign_revert_commit || null,
      })
    }
    meta.campaign_merge_history = history
    delete meta.campaign_revert_commit
    delete meta.held_on
    delete meta.reverted_because
    meta.status = stamped
    meta.phase = 'campaign_merged'
    meta.campaign_branch = branch
    meta.campaign_merge_commit = commit
    meta.campaign_merged_at = now
  })
  return { status: 'merged', commit, stamped }
}

// ─── CLI ──────────────────────────────────────────────────────────

// Free-text flags always take the next argument, even one that starts with "--" (a
// `--reason "--force was wrong"` must not lose its value). Other flags stay boolean when
// followed by another flag (`--version --apply`).
export const TEXT_FLAGS = Object.freeze(['reason', 'by', 'deploy-cmd', 'migrate-cmd', 'graph'])
export function parseFlags(argv, { text = TEXT_FLAGS } = {}) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined || (v.startsWith('--') && !text.includes(k))) out[k] = true
      else { out[k] = v; i++ }
    } else out._.push(a)
  }
  return out
}

function main(argv) {
  const [cmd, ...rest] = argv
  const f = parseFlags(rest)
  const emit = (obj, code = 0) => { console.log(JSON.stringify(obj, null, 2)); return code }
  try {
    const root = repoRoot()
    if (cmd === 'init') {
      let graph
      if (typeof f.graph === 'string') {
        try { graph = JSON.parse(f.graph) } catch (e) { throw new ChainError(`--graph is not valid JSON: ${e.message}`) }
      }
      return emit(cmdInit(root, { campaign: f.campaign, graph, at: f.at }))
    }
    if (cmd === 'sync-main') return emit(cmdSyncMain(root, { campaign: f.campaign }))
    if (cmd === 'overlap') return emit(cmdOverlap(root, { campaign: f.campaign, hunt: f.hunt, blockers: f.blockers }))
    if (cmd === 'merge-hunt') return emit(cmdMergeHunt(root, { campaign: f.campaign, hunt: f.hunt, at: f.at }))
    return emit({ status: 'error', reason: 'usage: wolfpack-chain.mjs <init|sync-main|overlap|merge-hunt> --campaign C [...]' }, 2)
  } catch (e) {
    return emit({ status: 'error', reason: e.message }, 2)
  }
}

// Only run when invoked directly, not when imported by a test or by wolfpack-release.mjs.
if (process.argv[1] && process.argv[1].endsWith('wolfpack-chain.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
