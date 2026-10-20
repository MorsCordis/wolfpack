#!/usr/bin/env node
// scripts/wolfpack-no-copies.mjs — the no-copies guard. The pack's commands, skills and workflows
// exist exactly once, in the pack; install.sh links them user-level and generates a consuming
// project's stamped workflow copies (gitignored). A tracked copy anywhere else is shadowed and
// drifts (it never runs, so work "shipped" in it never ships), so this guard fails CI on one.
//
// MODES (picked from the repo, never a flag):
//   pack mode     — the repo IS the pack (realpath of both git toplevels equal). Each of
//                   .claude/commands, .claude/skills, .claude/workflows must be ONE tracked entry,
//                   mode 120000, whose link text is ../.agents/<class>.
//   consumer mode — any other repo. It needs <repo>/wolfpack-config.md; the allow-list is its
//                   Project Identity → Project commands (read with the pack's config reader).
//
// CLASSES (exported; each check(ctx) returns [{ path, fix }]):
//   commands  — consumer: every tracked path under .claude/commands/ or .agents/commands/ except
//               <dir>/<name>.md with <name> on the allow-list; an alias link at either dir; a stale
//               allow-list entry (no tracked <name>.md in either dir).
//   skills    — consumer: every tracked path .claude/skills/<n>/… or .agents/skills/<n>/… where <n>
//               is a pack skill, plus alias links at those dirs. Project skills (other names) pass.
//   workflows — consumer: every tracked path under .claude/workflows/ other than
//               .claude/workflows/README.md, and everything under .agents/workflows/.
// scripts-unfork (4B) adds the script class by appending to CLASSES.
//
// CLI: node <pack>/scripts/wolfpack-no-copies.mjs [--pack <dir>] [<repo>]
//   <repo> defaults to the cwd's git toplevel; --pack defaults to this script's own repo root.
//   exit 0 — clean: `✓ no-copies: clean (<mode>: commands, skills, workflows)`
//   exit 1 — offending paths: one `✗ <path> — <fix>` line each (sorted by path), then
//            `✗ no-copies: <N> offending path(s) (<mode>)`
//   exit 2 — usage or setup error: not a git repo, a consumer without wolfpack-config.md, a config
//            reader problem, or a Project commands name that is a pack command.

import { existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './wolfpack-config.mjs'

export class SetupError extends Error {}

function git(dir, args) {
  const p = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (p.status !== 0) throw new SetupError(`git ${args.join(' ')} failed in ${dir}: ${(p.stderr || '').trim() || `exit ${p.status}`}`)
  return p.stdout
}

export function toplevel(dir) {
  if (!existsSync(dir)) throw new SetupError(`${dir} does not exist`)
  const p = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (p.status !== 0) throw new SetupError(`${dir} is not a git repository`)
  return p.stdout.trim()
}

// `git ls-files -s -z` → [{ mode, sha, path }].
export function trackedEntries(repo) {
  return git(repo, ['ls-files', '-s', '-z']).split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t')
    const [mode, sha] = rec.slice(0, tab).split(' ')
    return { mode, sha, path: rec.slice(tab + 1) }
  })
}

// The pack's tracked command names (.agents/commands/<name>.md) and skill names (.agents/skills/<name>/…).
export function packInventory(pack) {
  const commands = new Set()
  const skills = new Set()
  for (const p of git(pack, ['ls-files', '-z', '.agents/commands', '.agents/skills']).split('\0').filter(Boolean)) {
    const seg = p.split('/')
    if (seg[1] === 'commands' && seg.length === 3 && seg[2].endsWith('.md')) commands.add(seg[2].slice(0, -3))
    else if (seg[1] === 'skills' && seg.length >= 4) skills.add(seg[2])
  }
  return { commands, skills }
}

const LINK = '120000'
const under = (path, dir) => path === dir || path.startsWith(`${dir}/`)

// Pack mode: .claude/<x> must be exactly one tracked link to ../.agents/<x>.
function packLinkCheck(x) {
  return ({ repo, tracked }) => {
    const dir = `.claude/${x}`
    const fix = `track \`${dir}\` as the link \`../.agents/${x}\` (\`git rm -r --cached ${dir} && ln -s ../.agents/${x} ${dir} && git add ${dir}\`)`
    const hits = tracked.filter((e) => under(e.path, dir))
    if (hits.length === 0) return [{ path: dir, fix: `missing — ${fix}` }]
    const ok = hits.length === 1 && hits[0].path === dir && hits[0].mode === LINK &&
      git(repo, ['cat-file', 'blob', hits[0].sha]) === `../.agents/${x}`
    return ok ? [] : hits.map((e) => ({ path: e.path, fix }))
  }
}

function commandsCheck(ctx) {
  if (ctx.mode === 'pack') return packLinkCheck('commands')(ctx)
  const { tracked, inventory, allow } = ctx
  const out = []
  for (const dir of ['.claude/commands', '.agents/commands']) {
    for (const e of tracked.filter((t) => under(t.path, dir))) {
      if (e.path === dir) { out.push({ path: e.path, fix: 'remove the alias link (install.sh links the pack user-level)' }); continue }
      const rel = e.path.slice(dir.length + 1)
      const name = rel.endsWith('.md') ? rel.slice(0, -3) : rel
      if (!rel.includes('/') && rel.endsWith('.md') && allow.includes(name)) continue
      out.push({
        path: e.path,
        fix: inventory.commands.has(name)
          ? `delete it — the pack's \`/${name}\` is installed user-level (\`install.sh\`)`
          : `delete it, or add \`${name}\` to wolfpack-config.md → Project Identity → Project commands`,
      })
    }
  }
  const paths = new Set(tracked.map((t) => t.path))
  for (const n of allow) {
    if (!paths.has(`.claude/commands/${n}.md`) && !paths.has(`.agents/commands/${n}.md`)) {
      out.push({ path: 'wolfpack-config.md', fix: `stale Project commands entry \`${n}\` — no tracked .claude/commands/${n}.md or .agents/commands/${n}.md; remove it from the list` })
    }
  }
  return out
}

function skillsCheck(ctx) {
  if (ctx.mode === 'pack') return packLinkCheck('skills')(ctx)
  const out = []
  for (const dir of ['.claude/skills', '.agents/skills']) {
    for (const e of ctx.tracked.filter((t) => under(t.path, dir))) {
      if (e.path === dir) { out.push({ path: e.path, fix: 'remove the alias link (install.sh links the pack user-level)' }); continue }
      const n = e.path.slice(dir.length + 1).split('/')[0]
      if (ctx.inventory.skills.has(n)) {
        out.push({ path: e.path, fix: `delete the copy — the pack skill \`${n}\` is installed user-level; rename it if it is a project skill` })
      }
    }
  }
  return out
}

function workflowsCheck(ctx) {
  if (ctx.mode === 'pack') return packLinkCheck('workflows')(ctx)
  const fix = 'untrack it — workflow copies are generated by `install.sh --consumer` and gitignored'
  return ctx.tracked
    .filter((t) => (under(t.path, '.claude/workflows') && t.path !== '.claude/workflows/README.md') || under(t.path, '.agents/workflows'))
    .map((t) => ({ path: t.path, fix }))
}

export const CLASSES = [
  { name: 'commands', check: commandsCheck },
  { name: 'skills', check: skillsCheck },
  { name: 'workflows', check: workflowsCheck },
]

const real = (p) => realpathSync(p)

// → { mode, offending: [{ path, fix }] }. Throws SetupError for exit-2 conditions.
export function runGuard({ repo, pack }) {
  const repoTop = toplevel(repo)
  const packTop = toplevel(pack)
  const mode = real(repoTop) === real(packTop) ? 'pack' : 'consumer'
  const inventory = packInventory(packTop)
  let allow = []
  if (mode === 'consumer') {
    const cfgPath = join(repoTop, 'wolfpack-config.md')
    if (!existsSync(cfgPath)) throw new SetupError(`${repoTop} has no wolfpack-config.md — a consuming project needs one (copy the pack's wolfpack-config.example.md)`)
    let cfg
    try { cfg = loadConfig(cfgPath) } catch (e) { throw new SetupError(e.message) }
    if (cfg.problems.length) throw new SetupError(`wolfpack-config.md: ${cfg.problems.join('; ')}`)
    allow = cfg.projectCommands
    const clash = allow.filter((n) => inventory.commands.has(n))
    if (clash.length) throw new SetupError(clash.map((n) => `Project commands names pack command \`${n}\``).join('; ') + ' — remove it (the pack command is installed user-level)')
  }
  const tracked = trackedEntries(repoTop)
  const ctx = { repo: repoTop, pack: packTop, mode, tracked, inventory, allow }
  const offending = CLASSES.flatMap((c) => c.check(ctx))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { mode, offending }
}

const USAGE = 'usage: node <pack>/scripts/wolfpack-no-copies.mjs [--pack <dir>] [<repo>]'

export function main(argv, { cwd = process.cwd(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  let pack = null
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pack') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('-')) { err(`${USAGE}\n`); return 2 }
      pack = v; i++
    } else if (a.startsWith('--pack=')) pack = a.slice(7)
    else if (a.startsWith('-')) { err(`${USAGE}\n`); return 2 }
    else pos.push(a)
  }
  if (pos.length > 1 || pack === '') { err(`${USAGE}\n`); return 2 }
  try {
    const repo = pos.length ? resolve(cwd, pos[0]) : toplevel(cwd)
    const packDir = pack ? resolve(cwd, pack) : toplevel(dirname(fileURLToPath(import.meta.url)))
    const { mode, offending } = runGuard({ repo, pack: packDir })
    if (!offending.length) {
      out(`✓ no-copies: clean (${mode}: ${CLASSES.map((c) => c.name).join(', ')})\n`)
      return 0
    }
    for (const o of offending) out(`✗ ${o.path} — ${o.fix}\n`)
    out(`✗ no-copies: ${offending.length} offending path(s) (${mode})\n`)
    return 1
  } catch (e) {
    if (e instanceof SetupError) { err(`✗ no-copies: ${e.message}\n`); return 2 }
    throw e
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
