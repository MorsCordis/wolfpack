#!/usr/bin/env node
// Byte-identical copy of the pack's scripts/wolfpack-config.mjs — retired by pack-install-model / scripts-unfork.
//
// scripts/wolfpack-config.mjs — the ONE deterministic reader of a consuming project's
// wolfpack-config.md. The router CLI, both workflows (through a one-command probe
// agent that relays this script's --json output) and the tests all read project
// values through it, so a project value is never guessed, paraphrased or hard-coded.
//
// SECTIONS. A section is a line `## <Title>` outside a fenced block. Its key is
// <Title> with any trailing ` (…)` removed, trimmed: `## Hard Rules (agents will be
// fired…)` → `Hard Rules`. The body runs to the next `## ` line; fenced blocks are
// part of the body.
//
// FIELDS. Within a section body, the first line `- <Name>: value` or
// `- **<Name>:** value` (name case-insensitive) supplies the field; value = the rest
// of the line, trimmed.
//   code(v) — the first `…` span of v, else v.
//   list(v) — every `…` span; a bare comma list when there are no backticks.
//   NONE    — v empty, or (backticks stripped) `none` / `n/a`, or `none` followed by
//             a space or punctuation (`none — tooling repo`, `none.`): null for a
//             scalar, [] for a list.
//
// RESOLVED KEYS (`--json`):
//   name             Project Identity → Name                     required (none = missing)
//   testCommand      Project Identity → Test command (code)      required (none = missing)
//   worktreeLinks    Project Identity → Worktree links (list)    optional, [] when absent
//   complianceAreas  Compliance Requirements → Compliance areas  required; none → null
//   compliancePaths  Compliance Requirements → Risk-surface paths (list)  required; none → []
//   devDeployCommand Deployment Notes → Dev deploy command (code) optional; null = no deploy step
//   changelogFile    Deployment Notes → Changelog file (code)    optional
//   tagPattern       Deployment Notes → Tag pattern (code)       optional
//   backlogFile      Deployment Notes → Backlog file (code)      optional
//   models / pool    Model Pool → `- <role> → <token>` lines; judgment + reviewer-a required.
//                    models is keyed by the config spelling (judgment, work-horse,
//                    reviewer-a, reviewer-b, reviewer-c, coder-alt) → full token;
//                    pool by the router's camelCase role → family (token before the
//                    first `:`, lowercased). Other role names land in unknownRoles.
//   sections         every section key, in order
//   missing          required non-pool keys absent (or NONE where none is not allowed)
//   problems         every Model Pool defect, each prefixed `Model Pool:`; on any pool
//                    defect pool and models are null (never a partial object)
//
// CLI: node scripts/wolfpack-config.mjs [--json] [<path>]   (default ./wolfpack-config.md)
//   exit 0 — complete; prints the JSON (--json) or a short summary (bare mode)
//   exit 2 — missing/problems non-empty (output still printed + a ✗ line on stderr),
//            file absent (not-found message), or a usage error.

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Config spelling → router camelCase role.
export const POOL_ROLES = {
  'judgment': 'judgment',
  'work-horse': 'workHorse',
  'reviewer-a': 'reviewerA',
  'reviewer-b': 'reviewerB',
  'reviewer-c': 'reviewerC',
  'coder-alt': 'coderAlt',
}
export const REQUIRED_POOL_ROLES = ['judgment', 'reviewer-a']

const FENCE = /^\s*(```|~~~)/

// [{ key, title, body }] in file order. `## ` lines inside a fenced block do not split.
export function parseSections(text) {
  const out = []
  let cur = null
  let inFence = false
  for (const line of String(text).split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence
    const m = !inFence && /^## (.*)$/.exec(line)
    if (m) {
      const title = m[1].trim()
      const key = title.replace(/\s*\([^)]*\)\s*$/, '').trim()
      cur = { key, title, lines: [] }
      out.push(cur)
      continue
    }
    if (cur) cur.lines.push(line)
  }
  return out.map(({ key, title, lines }) => ({ key, title, body: lines.join('\n') }))
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The value of the first `- <name>:` / `- **<name>:**` line in body, or undefined.
export function field(body, name) {
  const re = new RegExp(`^\\s*-\\s+(?:\\*\\*)?${escapeRe(name)}:(?:\\*\\*)?\\s*(.*)$`, 'i')
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = re.exec(line)
    if (m) return m[1].trim()
  }
  return undefined
}

export function isNone(v) {
  if (v === undefined || v === null) return true
  const s = String(v).replace(/`/g, '').trim()
  if (s === '') return true
  return /^(none|n\/a)(?=$|[\s.,;:—–-])/i.test(s)
}

export function code(v) {
  if (v === undefined || v === null) return v
  const m = /`([^`]*)`/.exec(String(v))
  return m ? m[1] : String(v).trim()
}

export function list(v) {
  if (isNone(v)) return []
  const spans = [...String(v).matchAll(/`([^`]*)`/g)].map((m) => m[1].trim()).filter(Boolean)
  if (spans.length) return spans
  return String(v).split(',').map((s) => s.trim()).filter(Boolean)
}

// Parse the Model Pool section body. body === undefined → section absent.
export function modelPool(body) {
  const problems = []
  if (body === undefined) {
    return { pool: null, models: null, unknownRoles: [], problems: ['Model Pool: section absent'] }
  }
  const models = {}
  const unknownRoles = []
  const emptyToken = []
  const duplicate = []
  const lineRe = /^\s*-\s+([a-z][a-z0-9-]*)\s+(?:→|->)\s*(.*)$/i
  for (const line of String(body).split(/\r?\n/)) {
    const m = lineRe.exec(line)
    if (!m) continue
    const role = m[1].toLowerCase()
    const token = (m[2].split(/\s+/)[0] || '').replace(/^#.*$/, '')
    if (!(role in POOL_ROLES)) {
      if (!unknownRoles.includes(role)) unknownRoles.push(role)
      continue
    }
    if (!token) { emptyToken.push(role); continue }
    if (role in models) { if (!duplicate.includes(role)) duplicate.push(role); continue }
    models[role] = token
  }
  const absent = REQUIRED_POOL_ROLES.filter((r) => !(r in models) && !emptyToken.includes(r))
  if (absent.length) problems.push(`Model Pool: missing required role(s) ${absent.join(', ')}`)
  if (emptyToken.length) problems.push(`Model Pool: empty model token for role(s) ${emptyToken.join(', ')}`)
  if (duplicate.length) problems.push(`Model Pool: duplicate line(s) for role(s) ${duplicate.join(', ')}`)
  if (problems.length) return { pool: null, models: null, unknownRoles, problems }
  const pool = {}
  for (const [role, token] of Object.entries(models)) {
    pool[POOL_ROLES[role]] = token.split(':')[0].toLowerCase()
  }
  return { pool, models, unknownRoles, problems }
}

export function readConfig(text) {
  const secs = parseSections(text)
  const byKey = {}
  for (const s of secs) if (!(s.key in byKey)) byKey[s.key] = s.body
  const sec = (k) => byKey[k]
  const missing = []

  const scalarRequired = (key, section, name, transform) => {
    const v = field(sec(section), name)
    if (isNone(v)) { missing.push(key); return null }
    return transform(v)
  }
  const optionalCode = (section, name) => {
    const v = field(sec(section), name)
    return isNone(v) ? null : code(v)
  }

  const name = scalarRequired('name', 'Project Identity', 'Name', (v) => v)
  const testCommand = scalarRequired('testCommand', 'Project Identity', 'Test command', code)
  const worktreeLinks = list(field(sec('Project Identity'), 'Worktree links'))

  const areasRaw = field(sec('Compliance Requirements'), 'Compliance areas')
  if (areasRaw === undefined) missing.push('complianceAreas')
  const complianceAreas = isNone(areasRaw) ? null : areasRaw
  const pathsRaw = field(sec('Compliance Requirements'), 'Risk-surface paths')
  if (pathsRaw === undefined) missing.push('compliancePaths')
  const compliancePaths = list(pathsRaw)

  const { pool, models, unknownRoles, problems } = modelPool(sec('Model Pool'))

  return {
    name,
    testCommand,
    worktreeLinks,
    complianceAreas,
    compliancePaths,
    devDeployCommand: optionalCode('Deployment Notes', 'Dev deploy command'),
    changelogFile: optionalCode('Deployment Notes', 'Changelog file'),
    tagPattern: optionalCode('Deployment Notes', 'Tag pattern'),
    backlogFile: optionalCode('Deployment Notes', 'Backlog file'),
    pool,
    models,
    unknownRoles,
    sections: secs.map((s) => s.key),
    missing,
    problems,
  }
}

export function loadConfig(path = 'wolfpack-config.md') {
  const abs = resolve(path)
  if (!existsSync(abs)) {
    throw new Error(`wolfpack-config.md not found at ${abs} — copy wolfpack-config.example.md to it and fill it in`)
  }
  return { ...readConfig(readFileSync(abs, 'utf8')), path: abs }
}

export function problemLine(cfg) {
  const parts = []
  if (cfg.missing.length) parts.push(`missing ${cfg.missing.join(', ')}`)
  if (cfg.problems.length) parts.push(cfg.problems.join('; '))
  return parts.length ? `✗ wolfpack-config: ${parts.join('; ')}` : ''
}

function summary(cfg) {
  const lines = [
    `name: ${cfg.name ?? '(missing)'}`,
    `testCommand: ${cfg.testCommand ?? '(missing)'}`,
    `devDeployCommand: ${cfg.devDeployCommand ?? 'none'}`,
  ]
  if (cfg.models) for (const [role, token] of Object.entries(cfg.models)) lines.push(`pool ${role} → ${token}`)
  if (cfg.missing.length) lines.push(`missing: ${cfg.missing.join(', ')}`)
  if (cfg.problems.length) lines.push(`problems: ${cfg.problems.join('; ')}`)
  return lines.join('\n')
}

const USAGE = 'usage: node scripts/wolfpack-config.mjs [--json] [<path to wolfpack-config.md>]'

function main(argv) {
  let json = false
  const paths = []
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a.startsWith('-')) { process.stderr.write(`${USAGE}\n`); return 2 }
    else paths.push(a)
  }
  if (paths.length > 1) { process.stderr.write(`${USAGE}\n`); return 2 }
  let cfg
  try {
    cfg = loadConfig(paths[0] ?? 'wolfpack-config.md')
  } catch (e) {
    process.stderr.write(`✗ ${e.message}\n`)
    return 2
  }
  process.stdout.write(`${json ? JSON.stringify(cfg, null, 2) : summary(cfg)}\n`)
  const bad = problemLine(cfg)
  if (bad) { process.stderr.write(`${bad}\n`); return 2 }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
