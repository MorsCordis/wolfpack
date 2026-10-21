#!/usr/bin/env node
// scripts/wolfpack-merge-state.mjs — the deterministic core of the merge commands' bookkeeping.
//
// /merge, /merge-wave and /release-campaign used to leave inconsistent state: `merged` was only
// stamped for worktree hunts, a plan-dir copy-back into an existing target nested or archived it,
// and untagged [Unreleased] items were only warned about. This script is the one place that does
// those jobs, so the commands call it instead of re-deriving shell each run.
//
// CLI (JSON on stdout unless noted; exit 0 ok / 2 refused with {status:'error', reason}):
//   copy-back --slug S --from <worktree plan dir> [--repo R]
//       copy the worktree plan dir's CONTENTS into <main>/.wolfpack/plans/S (created if missing;
//       source files win; never a nested S/S; files only the target has are left alone)
//   stamp-merged --slug S --merge-commit SHA [--released-version V | --released-version ""] [--at ISO] [--repo R]
//       stamp status merged / phase done / merge_commit / merged_at on every metadata copy;
//       refuses a SHA that is not on main
//   backfill-merged [--apply] [--repo R]
//       TEXT output. Survey every `certified` plan dir in the main checkout, prove which ones git
//       shows merged into main (a first-parent merge whose subject is `Merge branch '<b>'` or the
//       older `Merge <b> (…)` / `Merge <b>: …` form, <b> = feat/<slug> or the metadata `branch`), and with
//       --apply stamp exactly those. Dry run by default; idempotent
//   attribute-changelog [--file F] [--apply] [--repo R]
//       tag untagged [Unreleased] items with the hunt whose merge carried them and place them with
//       that hunt's other items; never deletes an item; unattributable ones stay (and are printed
//       on stderr). --apply writes the file (no commit)
//
// The repo is the MAIN checkout of the git repo containing the cwd (a call from inside a hunt
// worktree still lands on it); --repo overrides (tests).
//
// Run tests: node --test scripts/wolfpack-merge-state.test.mjs

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync,
  lstatSync, readlinkSync, symlinkSync, unlinkSync, realpathSync, statSync,
} from 'node:fs'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import {
  git, readHuntMeta, writeHuntMeta, findWorktree, parseFlags, ChainError,
} from './wolfpack-chain.mjs'
import { mainWorktree } from './wolfpack-config.mjs'

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
const needSlug = (v) => {
  if (!v || !SLUG_RE.test(String(v))) throw new ChainError(`--slug must match ^[a-z0-9][a-z0-9-]*$ (got ${JSON.stringify(v)})`)
  return String(v)
}
const writeMeta = (path, meta) => writeFileSync(path, JSON.stringify(meta, null, 2) + '\n')

// ─── 1. copy-back ─────────────────────────────────────────────────

const sameBytes = (a, b) => {
  try {
    const x = readFileSync(a)
    const y = readFileSync(b)
    return x.length === y.length && x.equals(y)
  } catch { return false }
}

// Copy the CONTENTS of `src` into `dest`, file by file. Never creates <dest>/<basename(src)>.
export function copyBack({ src, dest }) {
  if (!src || !existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`copy-back: source plan dir ${src} does not exist`)
  }
  const created = !existsSync(dest)
  if (!created && realpathSync(src) === realpathSync(dest)) return { created: false, copied: [], overwritten: [] }
  mkdirSync(dest, { recursive: true })
  const copied = []
  const overwritten = []
  const walk = (rel) => {
    const from = join(src, rel)
    for (const ent of readdirSync(from, { withFileTypes: true })) {
      const r = join(rel, ent.name)
      const s = join(src, r)
      const d = join(dest, r)
      if (ent.isSymbolicLink()) {
        mkdirSync(dirname(d), { recursive: true })
        if (existsSync(d) || lstatSafe(d)) unlinkSync(d)
        symlinkSync(readlinkSync(s), d)
        copied.push(r)
      } else if (ent.isDirectory()) {
        mkdirSync(d, { recursive: true })
        walk(r)
      } else if (ent.isFile()) {
        mkdirSync(dirname(d), { recursive: true })
        if (existsSync(d) && !sameBytes(s, d)) overwritten.push(r)
        copyFileSync(s, d)
        copied.push(r)
      }
    }
  }
  walk('')
  return { created, copied, overwritten }
}
const lstatSafe = (p) => { try { return lstatSync(p) } catch { return null } }

// ─── 2. stamp-merged ──────────────────────────────────────────────

const isOnMain = (root, sha) =>
  git(['merge-base', '--is-ancestor', sha, 'refs/heads/main'], { cwd: root, allowFail: true }).code === 0

// Stamp a hunt `merged` on every metadata copy (worktree + main). Fails loud when the commit is
// not on main: a merged marker without a merge is exactly the inconsistency this script removes.
export function stampMerged(root, slug, { mergeCommit, releasedVersion, at, extra = {} } = {}) {
  needSlug(slug)
  if (!mergeCommit) throw new ChainError('stamp-merged: --merge-commit is required')
  const v = git(['rev-parse', '--verify', '--quiet', `${mergeCommit}^{commit}`], { cwd: root, allowFail: true })
  if (v.code !== 0 || !v.stdout) throw new ChainError(`fail loud: ${mergeCommit} does not resolve to a commit`)
  const sha = v.stdout
  if (!isOnMain(root, sha)) throw new ChainError(`fail loud: ${mergeCommit} is not on main`)
  const now = at || new Date().toISOString()
  const meta = writeHuntMeta(root, slug, (m) => {
    const keep = m.status === 'merged' && m.merge_commit === sha && m.merged_at
    m.status = 'merged'
    m.phase = 'done'
    m.merge_commit = sha
    m.merged_at = keep ? m.merged_at : now
    if (releasedVersion !== undefined) m.released_version = releasedVersion || null
    Object.assign(m, extra)
  })
  return {
    status: 'stamped', slug, merge_commit: meta.merge_commit, merged_at: meta.merged_at,
    released_version: meta.released_version === undefined ? null : meta.released_version,
  }
}

// ─── 3. survey + backfill ─────────────────────────────────────────

// `Merge branch '<b>'[ into …]`  |  older forms: `Merge <b> (…)`, `Merge <b>: …`, `Merge <b> — …`, `Merge <b>`
// where <b> contains a '/' (feat/x, fix/x, chore/x). Returns the branch or null.
export const MERGE_SUBJECT_RE = /^Merge (?:branch '([^']+)'|([^\s':]+\/[^\s':]+))(?=$|[\s:])/
export function mergeSubjectBranch(subject) {
  const m = MERGE_SUBJECT_RE.exec(String(subject || ''))
  return m ? (m[1] || m[2]) : null
}

// Merges on main's first-parent line (see mergeSubjectBranch) → branch → newest {commit, date}.
function mergedBranches(root) {
  const out = git(['log', 'refs/heads/main', '--first-parent', '--merges', '--format=%H%x09%cI%x09%s'], { cwd: root, allowFail: true })
  const map = new Map()
  if (out.code !== 0) return map
  for (const row of out.stdout.split('\n').filter(Boolean)) {
    const [commit, date, ...rest] = row.split('\t')
    const b = mergeSubjectBranch(rest.join('\t'))
    if (b && !map.has(b)) map.set(b, { commit, date })
  }
  return map
}

function certifiedHunts(root) {
  const dir = join(root, '.wolfpack', 'plans')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (!SLUG_RE.test(name)) continue          // e.g. <slug>.prior-* archives
    const p = join(dir, name, 'metadata.json')
    if (!existsSync(p)) continue
    let meta
    try { meta = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
    if (meta && meta.status === 'certified') out.push({ slug: name, meta })
  }
  return out
}

export function surveyMerged(root) {
  const certified = certifiedHunts(root)
  const merges = mergedBranches(root)
  const provable = []
  const unprovable = []
  for (const { slug, meta } of certified) {
    const hit = merges.get(`feat/${slug}`) || (meta.branch ? merges.get(String(meta.branch)) : undefined)
    if (hit) provable.push({ slug, commit: hit.commit, date: hit.date })
    else unprovable.push(slug)
  }
  return { certified: certified.map(c => c.slug), provable, unprovable }
}

export function backfillMerged(root, { apply = false } = {}) {
  const survey = surveyMerged(root)
  const stamped = []
  if (apply) {
    for (const p of survey.provable) {
      const paths = [join(root, '.wolfpack', 'plans', p.slug, 'metadata.json')]
      const wt = findWorktree(root, p.slug)
      if (wt) paths.push(join(wt, '.wolfpack', 'plans', p.slug, 'metadata.json'))
      for (const path of paths) {
        if (!existsSync(path)) continue
        const m = JSON.parse(readFileSync(path, 'utf8'))   // each copy independently; never copy one over the other
        m.status = 'merged'
        m.phase = 'done'
        m.merge_commit = p.commit
        m.merged_at = p.date
        m.backfilled = true
        writeMeta(path, m)
      }
      stamped.push(p.slug)
    }
  }
  return { ...survey, stamped }
}

// ─── 4. attribute-changelog ───────────────────────────────────────

const TAG_RE = /<!--\s*hunt:([a-z0-9][a-z0-9-]*)\s*-->\s*$/
const stripTag = (l) => l.replace(/\s*<!--\s*hunt:[a-z0-9][a-z0-9-]*\s*-->\s*$/, '')

export function attributeUnreleased(root, { file = 'CHANGELOG.md', text, ref = 'refs/heads/main' } = {}) {
  const relFile = isAbsolute(file) ? relative(root, file) : file
  const src = text !== undefined ? String(text) : readFileSync(resolve(root, relFile), 'utf8')
  const lines = src.split('\n')
  const start = lines.findIndex(l => /^## \[Unreleased\]/.test(l))
  if (start === -1) return { text: src, attributed: [], unattributed: [] }
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end === -1) end = lines.length

  // An error is not "no match": a failing git call must stop attribution, never read as "unattributable".
  const gitOrThrow = (args) => {
    const r = git(args, { cwd: root, allowFail: true })
    if (r.code !== 0) throw new ChainError(`attribute-changelog: git ${args.slice(0, 3).join(' ')} failed (exit ${r.code}): ${r.stderr.trim()}`)
    return r
  }
  const fpr = git(['rev-list', '--first-parent', ref], { cwd: root, allowFail: true })
  if (fpr.code !== 0) throw new ChainError(`attribute-changelog: git rev-list --first-parent ${ref} failed (exit ${fpr.code}): ${fpr.stderr.trim()}`)
  const firstParent = new Set(fpr.stdout.split('\n').filter(Boolean))
  const attributedOf = (line) => {
    const log = gitOrThrow(['log', ref, '--reverse', '--format=%H', `-S${line}`, '--', relFile])
    const commit = log.stdout.split('\n').filter(Boolean)[0]
    if (!commit) return null
    if (firstParent.has(commit)) return null                      // committed straight to the branch
    const carry = gitOrThrow(['rev-list', '--first-parent', '--merges', '--reverse', '--ancestry-path', `${commit}..${ref}`])
    const merge = carry.stdout.split('\n').filter(Boolean)[0]
    if (!merge) return null
    const subject = git(['log', '-1', '--format=%s', merge], { cwd: root }).stdout
    const m = /^Merge branch 'feat\/([a-z0-9][a-z0-9-]*)'/.exec(subject)
    return m ? m[1] : null
  }

  // Block model: each line of the section is an entry; `group` = index of its `### ` heading.
  let group = -1
  const entries = []
  for (let i = start + 1; i < end; i++) {
    const text0 = lines[i]
    if (/^### /.test(text0)) group = i
    entries.push({ text: text0, group, orig: text0, tagged: TAG_RE.test(text0) })
  }
  const attributed = []
  const unattributed = []
  const decisions = new Map()
  for (const e of entries) {
    if (!/^\s*-\s/.test(e.text) || e.tagged || /<!--\s*hunt:/.test(e.text)) continue
    const slug = attributedOf(e.text)
    if (slug) { decisions.set(e, slug); attributed.push({ line: e.orig, slug }) } else unattributed.push(e.orig)
  }
  // Apply: tag, then move after the last line of the same group already carrying that hunt's tag.
  let work = entries.slice()
  for (const [e, slug] of decisions) {
    e.text = `${e.text} <!-- hunt:${slug} -->`
    e.tagged = true
    const without = work.filter(x => x !== e)
    let anchor = -1
    without.forEach((x, idx) => {
      if (x.group === e.group) { const m = TAG_RE.exec(x.text); if (m && m[1] === slug && x.tagged) anchor = idx }
    })
    if (anchor === -1) continue                                    // nothing of that hunt in the group: stays in place
    without.splice(anchor + 1, 0, e)
    work = without
  }
  const outLines = [...lines.slice(0, start + 1), ...work.map(x => x.text), ...lines.slice(end)]
  const outText = outLines.join('\n')
  const items = (t) => t.split('\n').filter(l => /^\s*-\s/.test(l)).map(stripTag).sort()
  const a = items(src)
  const b = items(outText)
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) throw new Error('attribute-changelog: item count changed')
  return { text: outText, attributed, unattributed }
}

// ─── CLI ──────────────────────────────────────────────────────────

function main(argv) {
  const [cmd, ...rest] = argv
  const f = parseFlags(rest)
  const emit = (obj, code = 0) => { console.log(JSON.stringify(obj, null, 2)); return code }
  try {
    const root = typeof f.repo === 'string' ? resolve(f.repo) : mainWorktree(process.cwd())
    if (!root) throw new ChainError('not inside a git repository')
    if (cmd === 'copy-back') {
      const slug = needSlug(f.slug)
      if (typeof f.from !== 'string') throw new ChainError('--from <worktree plan dir> is required')
      const dest = join(root, '.wolfpack', 'plans', slug)
      return emit({ status: 'copied', slug, dest, ...copyBack({ src: resolve(f.from), dest }) })
    }
    if (cmd === 'stamp-merged') {
      const rv = f['released-version']
      return emit(stampMerged(root, f.slug, {
        mergeCommit: f['merge-commit'],
        releasedVersion: rv === undefined ? undefined : (rv === true ? '' : String(rv)),
        at: typeof f.at === 'string' ? f.at : undefined,
      }))
    }
    if (cmd === 'backfill-merged') {
      const r = backfillMerged(root, { apply: f.apply === true })
      // Counts are the survey BEFORE any stamp; a re-run after --apply reports certified=<N-M> provable=0.
      console.log(`certified=${r.certified.length} provable=${r.provable.length}`)
      console.log(`provable: ${r.provable.map(p => p.slug).join(' ')}`)
      console.log(`unprovable: ${r.unprovable.join(' ')}`)
      if (f.apply === true) console.log(`stamped: ${r.stamped.join(' ')}`)
      return 0
    }
    if (cmd === 'attribute-changelog') {
      const file = typeof f.file === 'string' ? f.file : 'CHANGELOG.md'
      const r = attributeUnreleased(root, { file })
      if (f.apply === true && r.attributed.length) {
        writeFileSync(isAbsolute(file) ? file : resolve(root, file), r.text)
      }
      for (const l of r.unattributed) console.error(`⚠ unattributed [Unreleased] item (left in place): ${l}`)
      return emit({ attributed: r.attributed, unattributed: r.unattributed })
    }
    return emit({ status: 'error', reason: 'usage: wolfpack-merge-state.mjs <copy-back|stamp-merged|backfill-merged|attribute-changelog> [...]' }, 2)
  } catch (e) {
    return emit({ status: 'error', reason: e.message }, 2)
  }
}

if (process.argv[1] && process.argv[1].endsWith('wolfpack-merge-state.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
