#!/usr/bin/env node
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
//   testVerdictCommand  Project Identity → Test verdict command (code)  optional, null when absent/none:
//                    decides the pipeline test record's pass/fail from the run log ({log}, {exit},
//                    {main} placeholders) instead of the raw exit code (scripts/wolfpack-test-record.mjs).
//   worktreeLinks    Project Identity → Worktree links (list)    optional, [] when absent
//   complianceAreas  Compliance Requirements → Compliance areas  required; none → null
//   compliancePaths  Compliance Requirements → Risk-surface paths (list)  required; none → []
//   devDeployCommand Deployment Notes → Dev deploy command (code) optional; null = no deploy step
//   changelogFile    Deployment Notes → Changelog file (code)    optional
//   tagPattern       Deployment Notes → Tag pattern (code)       optional
//   releaseTags      false when Deployment Notes → Tag pattern is PRESENT and `none` (the project
//                    does not tag releases: /merge, /merge-wave and /release-campaign lay no tag
//                    and record released_version null); true otherwise — an ABSENT key keeps the
//                    default `v[0-9]*` tagging, so an unset key never silently turns tagging off.
//   backlogFile      Deployment Notes → Backlog file (code)      optional
//   wolfpackHome     Project Identity → Wolfpack home (code)     optional; a leading `~` expands to
//                    the home dir; a present, non-NONE, non-absolute value is a problem.
//                    The WOLFPACK_HOME env var overrides it (the workflows + pack-home resolve
//                    env → this key → fail loud; never the consuming repo).
//   worktreeRoot     Project Identity → Worktree root (code)     optional; null when absent; the
//                    workflows require it. Repo-relative (e.g. `.agents/worktrees`), trailing `/`
//                    stripped; a malformed value is a problem (see validWorktreeRoot).
//   projectCommands  Project Identity → Project commands (list)  optional, [] for none/absent: the
//                    project-only slash commands a consuming repo may track (the no-copies
//                    guard's allow-list). Each name must match ^[a-z0-9][a-z0-9-]*$ (else a problem, []).
//   smokeLoginHook   Deployment Notes → Smoke login hook          optional; null for none/absent. The
//                    first backticked span is the command template; it must contain {host} and may
//                    contain {account}. Notes after the first ` — ` are dropped before parsing.
//   smokeLoginAccounts  the backticked names after the word `accounts` (and before the first ` — `)
//                    in the same value; the first is the default; [] when there is no `accounts` word.
//                    Problems: no backticked template, no {host}, {account} with no account listed,
//                    an account outside [A-Za-z0-9_.@-]+, a TAB or newline in the template (both
//                    values null/[] on a problem).
//   POST-MERGE STAGE KEYS (chain mode, docs/post-merge-stage.md; all optional unless
//   postMergeStage is true, when wolfpack-smoke-stage.mjs check-config requires every STAGE_KEYS
//   entry marked required — the reader itself never adds them to `missing`):
//   postMergeStage   Deployment Notes → Post-merge smoke stage    `on` → true; absent/`off` → false;
//                    any other value is a problem (false).
//   migrateCommand   Deployment Notes → Migration command (code)   optional
//   migrationFilePattern  Deployment Notes → Migration file pattern (code)  optional (a regex source)
//   neverSmokeHosts  Deployment Notes → Never-smoke hosts (list)    optional, []
//   prodHostSuffix   Deployment Notes → Prod URL                    the URL's host with a leading `*.`
//                    stripped (`https://*.example.vet` → `example.vet`); null when absent
//   smokeTenants     Deployment Notes → Smoke tenants (list of `name=host`)  {name: host}, {} when absent;
//                    names ^[a-z][a-z0-9-]*$, hosts ^[a-z0-9.-]+$ (a malformed pair is a problem, {}).
//   smokeManifests   Deployment Notes → Smoke tenant manifests (list of `tenant=path`)  {tenant: path}
//   smokeTenantEnsureCommand / waveReportDirCommand / waveReportBuildCommand / campaignReportCommand /
//   reportUrlCommand Deployment Notes → Smoke tenant ensure command / Wave report dir command /
//                    Wave report build command / Campaign report command / Report URL command (code)  optional
//   appMarkerFile    Project Identity → App marker file (code)       optional
//   integrationTestArgs  Project Identity → Integration test args (code)  optional; may hold {campaign}
//   integrationFullSuitePaths  Project Identity → Integration full-suite paths (list)  optional, []
//   triageBlockPaths Compliance Requirements → Triage block paths (list)  optional, []
//   exec             ## Execution Layer (see execLayer below) — the execution-layer keys the
//                    seat shim / sandbox launcher need. NOT part of the top-level `missing`
//                    (a project with no Vibe seats needs none of them): exec.missing lists the
//                    absent shim-required keys by their written names. exec.problems join the
//                    top-level problems only when the section exists.
//   models / pool    Model Pool → `- <role> → <token>` lines; judgment + reviewer-a required.
//                    models is keyed by the config spelling (judgment, work-horse,
//                    reviewer-a, reviewer-b, reviewer-c, coder-alt) → full token;
//                    pool by the router's camelCase role → family (token before the
//                    first `:`, lowercased). Other role names land in unknownRoles.
//   gates            Model Pool → an optional `gate=<ENV>` word after the token (before any `#`):
//                    { <family>: <ENV> }, {} when none. ENV must match WOLFPACK_[A-Z0-9_]+; only
//                    reviewer-a/b/c and coder-alt may be gated (implementer families are always on);
//                    one gate per line; two roles of one family must not name different gates.
//                    The router turns it into the enabled set (unset/""/1/true → on, else off).
//                    null on any pool defect (like pool/models).
//   sections         every section key, in order
//   missing          required non-pool keys absent (or NONE where none is not allowed)
//   problems         every Model Pool defect, each prefixed `Model Pool:`; on any pool
//                    defect pool and models are null (never a partial object)
//
// CLI: node scripts/wolfpack-config.mjs [--json | --exec] [<path>]   (default ./wolfpack-config.md)
//   exit 0 — complete; prints the JSON (--json) or a short summary (bare mode)
//   exit 2 — missing/problems non-empty (output still printed + a ✗ line on stderr),
//            file absent (not-found message), or a usage error.
//   --exec — for the shell side (scripts/lib/wolfpack-sandbox.sh): one `<field>\t<value>` line
//            per value: config, sandbox_image, glm_image, project_layer (empty when none),
//            seat_mount (`host\tcontainer`, repeated), sandbox_mount (same), secrets_path
//            (repeated), vibe_agent_dir, seat_env (`NAME=value`, repeated). Exit 0. When
//            exec.missing or any problem is non-empty it prints NOTHING on stdout, one ✗ line
//            on stderr naming the keys as written (`Execution Layer: missing Sandbox image`)
//            or the problem, and exits 2.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

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

// Roles a `gate=<ENV>` word may sit on (the examiner families + the optional alt coder).
export const GATEABLE_ROLES = ['reviewer-a', 'reviewer-b', 'reviewer-c', 'coder-alt']
const GATE_NAME = /^WOLFPACK_[A-Z0-9_]+$/

// Parse the Model Pool section body. body === undefined → section absent.
export function modelPool(body) {
  const problems = []
  if (body === undefined) {
    return { pool: null, models: null, gates: null, unknownRoles: [], problems: ['Model Pool: section absent'] }
  }
  const models = {}
  const roleGates = {}
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
    // gate=<ENV> words: the rest of the line after the token, before the first `#` (comment
    // text is never parsed — `(WOLFPACK_ENABLE_GLM=0 disables)` in a comment is prose).
    const words = m[2].split('#')[0].trim().split(/\s+/).slice(1)
    const gateWords = words.filter((w) => w.startsWith('gate='))
    if (gateWords.length > 1) { problems.push(`Model Pool: ${role} has more than one gate= word`); continue }
    if (gateWords.length === 1) {
      const name = gateWords[0].slice('gate='.length)
      if (!GATEABLE_ROLES.includes(role)) problems.push(`Model Pool: ${role} cannot be gated (implementer families are always on)`)
      else if (!GATE_NAME.test(name)) problems.push(`Model Pool: ${role} gate '${name}' must match WOLFPACK_[A-Z0-9_]+`)
      else roleGates[role] = name
    }
  }
  const absent = REQUIRED_POOL_ROLES.filter((r) => !(r in models) && !emptyToken.includes(r))
  if (absent.length) problems.push(`Model Pool: missing required role(s) ${absent.join(', ')}`)
  if (emptyToken.length) problems.push(`Model Pool: empty model token for role(s) ${emptyToken.join(', ')}`)
  if (duplicate.length) problems.push(`Model Pool: duplicate line(s) for role(s) ${duplicate.join(', ')}`)
  const family = (token) => token.split(':')[0].toLowerCase()
  const gates = {}
  for (const [role, name] of Object.entries(roleGates)) {
    const fam = family(models[role])
    if (fam in gates && gates[fam] !== name) {
      problems.push(`Model Pool: family ${fam} has conflicting gates ${gates[fam]}, ${name}`)
      continue
    }
    gates[fam] = name
  }
  if (problems.length) return { pool: null, models: null, gates: null, unknownRoles, problems }
  const pool = {}
  for (const [role, token] of Object.entries(models)) {
    pool[POOL_ROLES[role]] = family(token)
  }
  return { pool, models, gates, unknownRoles, problems }
}

// The MAIN working tree of the git repository that contains `dir` (a hunt worktree resolves to
// its main checkout), or null when `dir` is not inside a git repo. Pack scripts take their
// cross-worktree DATA root from here — the invoking repo — never from their own location.
export function mainWorktree(dir = process.cwd()) {
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return common ? dirname(common) : null
  } catch {
    return null
  }
}

// `~` or `~/…` → the home directory; anything else unchanged.
export function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return homedir() + p.slice(1)
  return p
}

// ## Execution Layer keys: [written name, field, shim-required, none allowed].
export const EXEC_KEYS = [
  ['Sandbox image', 'sandboxImage', true, false],
  ['GLM image', 'glmImage', true, false],
  ['Sandbox project layer', 'projectLayer', true, true],
  ['Seat extra mounts', 'seatExtraMounts', true, true],
  ['Sandbox extra mounts', 'sandboxExtraMounts', false, true],
  ['Secrets paths', 'secretsPaths', true, true],
  ['Vibe agent dir', 'vibeAgentDir', true, false],
  ['Seat test env', 'seatTestEnv', false, true],
]

const RESERVED_ENV = /^(HOME|PATH|WOLFPACK_.*|GIT_.*)$/

// An image reference must carry a `:tag` (a `:` after the last `/`; `host:5000/x` has none).
export function imageHasTag(ref) {
  const i = ref.lastIndexOf(':')
  return i > 0 && i < ref.length - 1 && !ref.slice(i + 1).includes('/')
}

// Parse the ## Execution Layer body. body === undefined → section absent: every
// shim-required key is in `missing`, no problems. configDir resolves a relative layer path.
export function execLayer(body, configDir = process.cwd()) {
  const missing = []
  const problems = []
  const out = {
    sandboxImage: null, glmImage: null, projectLayer: null, seatExtraMounts: [],
    sandboxExtraMounts: [], secretsPaths: [], vibeAgentDir: null, seatTestEnv: [],
  }
  const P = (msg) => problems.push(`Execution Layer: ${msg}`)
  const mounts = (key, entries) => {
    const res = []
    for (const e of entries) {
      const parts = e.split(':')
      if (parts.length > 2) { P(`${key} entry '${e}' has a third ':' field — mounts are always read-only; options are not allowed`); continue }
      const host = expandHome(parts[0].trim())
      const container = expandHome((parts[1] ?? parts[0]).trim())
      if (!host || !isAbsolute(host)) { P(`${key} entry '${e}' must have an absolute (or ~/…) host path`); continue }
      if (!container || !isAbsolute(container)) { P(`${key} entry '${e}' must have an absolute (or ~/…) container path`); continue }
      if (/\n/.test(host + container)) { P(`${key} entry '${e}' contains a newline`); continue }
      res.push({ host, container })
    }
    return res
  }
  for (const [key, prop, required, noneOk] of EXEC_KEYS) {
    const v = body === undefined ? undefined : field(body, key)
    if (v === undefined) { if (required) missing.push(key); continue }
    if (/\t/.test(v)) { P(`${key} contains a TAB`); continue }
    if (isNone(v)) {
      if (!noneOk && required) missing.push(key)
      continue
    }
    switch (prop) {
      case 'sandboxImage':
      case 'glmImage': {
        const ref = code(v).trim()
        if (/\s/.test(ref) || !ref) P(`${key} '${ref}' must not contain whitespace`)
        else if (!imageHasTag(ref)) P(`${key} '${ref}' must carry an explicit :tag (e.g. name:latest)`)
        else out[prop] = ref
        break
      }
      case 'projectLayer': {
        const p = expandHome(code(v).trim())
        out.projectLayer = isAbsolute(p) ? p : resolve(configDir, p)
        break
      }
      case 'vibeAgentDir': {
        const p = expandHome(code(v).trim())
        if (!isAbsolute(p)) P(`${key} '${p}' must be an absolute path or ~/…`)
        else out.vibeAgentDir = p
        break
      }
      case 'seatExtraMounts':
      case 'sandboxExtraMounts':
        out[prop] = mounts(key, list(v))
        break
      case 'secretsPaths':
        for (const e of list(v)) {
          const p = expandHome(e)
          if (!isAbsolute(p)) P(`${key} entry '${e}' must be an absolute path or ~/…`)
          else out.secretsPaths.push(p)
        }
        break
      case 'seatTestEnv':
        for (const e of list(v)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(e)
          if (!m) P(`${key} entry '${e}' must be NAME=value`)
          else if (RESERVED_ENV.test(m[1])) P(`${key} entry '${e}' uses a reserved name (HOME, PATH, WOLFPACK_*, GIT_*)`)
          else out.seatTestEnv.push(e)
        }
        break
    }
  }
  return { ...out, missing, problems }
}

// A repo-relative directory for hunt worktrees: non-empty, not absolute, no leading `~`, every
// `/`-segment an optional leading dot + [A-Za-z0-9_] + [A-Za-z0-9_.-]* (so `.agents`, `.claude`,
// `.wt` pass; `.`, `..`, `..x`, empty, whitespace, quotes, `$`, `*`, backticks fail), and a first
// segment other than `.git`. The workflows' requireWorktreeRoot inlines this identical rule.
export function validWorktreeRoot(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.startsWith('~')) return false
  const segs = p.split('/')
  if (segs[0] === '.git') return false
  return segs.every((seg) => /^\.?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(seg))
}

// Deployment Notes → Smoke login hook: `<template>` accounts `<default>` `<other>`… — notes.
// Returns { hook, accounts }; pushes each defect onto problems (and then returns null/[]).
export function smokeLoginHookValue(v, problems = []) {
  if (isNone(v)) return { hook: null, accounts: [] }
  const P = (msg) => { problems.push(`Deployment Notes → Smoke login hook ${msg}`); return { hook: null, accounts: [] } }
  const raw = String(v)
  const cut = raw.indexOf(' — ')
  const head = cut === -1 ? raw : raw.slice(0, cut)
  const m = /`([^`]*)`/.exec(head)
  if (!m) return P('must start with a backticked command template, e.g. `./scripts/smoke-login --host {host}`')
  const hook = m[1].trim()
  if (/[\t\n\r]/.test(m[1])) return P('template contains a TAB or newline')
  if (!hook.includes('{host}')) return P(`template '${hook}' must contain {host}`)
  const rest = head.slice(m.index + m[0].length)
  const w = /\baccounts\b/.exec(rest)
  const accounts = w ? list(rest.slice(w.index + w[0].length)) : []
  const bad = accounts.filter((a) => !/^[A-Za-z0-9_.@-]+$/.test(a))
  if (bad.length) return P(`account name(s) ${bad.map((a) => `'${a}'`).join(', ')} must match [A-Za-z0-9_.@-]+`)
  if (hook.includes('{account}') && accounts.length === 0) return P(`template '${hook}' uses {account} but lists no accounts (add: accounts \`<default>\`)`)
  return { hook, accounts }
}

// The post-merge stage keys: [field, written name, required when postMergeStage is on].
// wolfpack-smoke-stage.mjs check-config reports a missing one by its written name.
export const STAGE_KEYS = [
  ['devDeployCommand', 'Deployment Notes → Dev deploy command', true],
  ['migrateCommand', 'Deployment Notes → Migration command', true],
  ['migrationFilePattern', 'Deployment Notes → Migration file pattern', true],
  ['neverSmokeHosts', 'Deployment Notes → Never-smoke hosts', true],
  ['prodHostSuffix', 'Deployment Notes → Prod URL', true],
  ['smokeTenants', 'Deployment Notes → Smoke tenants', true],
  ['smokeManifests', 'Deployment Notes → Smoke tenant manifests', true],
  ['smokeTenantEnsureCommand', 'Deployment Notes → Smoke tenant ensure command', true],
  ['waveReportDirCommand', 'Deployment Notes → Wave report dir command', true],
  ['waveReportBuildCommand', 'Deployment Notes → Wave report build command', true],
  ['campaignReportCommand', 'Deployment Notes → Campaign report command', true],
  ['reportUrlCommand', 'Deployment Notes → Report URL command', true],
  ['smokeLoginHook', 'Deployment Notes → Smoke login hook', true],
  ['appMarkerFile', 'Project Identity → App marker file', true],
  ['integrationTestArgs', 'Project Identity → Integration test args', true],
  ['testCommand', 'Project Identity → Test command', true],
  ['testVerdictCommand', 'Project Identity → Test verdict command', true],
  ['integrationFullSuitePaths', 'Project Identity → Integration full-suite paths', false],
  ['triageBlockPaths', 'Compliance Requirements → Triage block paths', true],
]

const TENANT_NAME = /^[a-z][a-z0-9-]*$/
const HOSTNAME = /^[a-z0-9.-]+$/
// A smoke tenant host: dot-separated labels, no leading/trailing/double dot (a trailing-dot FQDN
// is the same site and would slip past an exact never-smoke / prod-suffix comparison).
const SMOKE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/

// `name=value` spans → {name: value}. Pushes a problem (and returns {}) on a malformed pair.
export function pairList(v, written, problems, { valueRe = null } = {}) {
  const out = {}
  for (const span of list(v)) {
    const m = /^([^=\s]+)=(\S+)$/.exec(span)
    if (!m || !TENANT_NAME.test(m[1])) {
      problems.push(`${written}: malformed pair '${span}' (expected \`name=value\`, name ^[a-z][a-z0-9-]*$)`)
      return {}
    }
    if (valueRe && !valueRe.test(m[2])) {
      problems.push(`${written}: '${m[2]}' (for ${m[1]}) must match ${valueRe.source}`)
      return {}
    }
    if (m[1] in out) {
      problems.push(`${written}: duplicate name '${m[1]}'`)
      return {}
    }
    out[m[1]] = m[2]
  }
  return out
}

// Deployment Notes → Prod URL → the prod host suffix (`https://*.x.vet …` → `x.vet`), or null.
export function prodHostSuffixOf(v) {
  if (isNone(v)) return null
  const first = code(v).trim().split(/\s+/)[0] || ''
  const host = first.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].replace(/:\d+$/, '').toLowerCase()
  const bare = host.replace(/^\*\./, '')
  return bare && SMOKE_HOST.test(bare) ? bare : null
}

export function readConfig(text, { configDir = process.cwd() } = {}) {
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
  const testVerdictCommand = optionalCode('Project Identity', 'Test verdict command')
  const worktreeLinks = list(field(sec('Project Identity'), 'Worktree links'))

  const areasRaw = field(sec('Compliance Requirements'), 'Compliance areas')
  if (areasRaw === undefined) missing.push('complianceAreas')
  const complianceAreas = isNone(areasRaw) ? null : areasRaw
  const pathsRaw = field(sec('Compliance Requirements'), 'Risk-surface paths')
  if (pathsRaw === undefined) missing.push('compliancePaths')
  const compliancePaths = list(pathsRaw)

  const { pool, models, gates, unknownRoles, problems } = modelPool(sec('Model Pool'))

  let wolfpackHome = optionalCode('Project Identity', 'Wolfpack home')
  if (wolfpackHome !== null) {
    wolfpackHome = expandHome(wolfpackHome.trim())
    if (!isAbsolute(wolfpackHome)) {
      problems.push('Project Identity → Wolfpack home must be an absolute path or ~/…')
      wolfpackHome = null
    } else if (wolfpackHome.includes("'")) {
      // The workflows' run-start probe single-quotes this path (PACK='<home>'): refuse a quote
      // here so it is a clean config problem, never a garbled probe.
      problems.push('Project Identity → Wolfpack home must not contain a single quote')
      wolfpackHome = null
    }
  }
  // pack-install-model: where hunt worktrees live, repo-relative (e.g. `.agents/worktrees`).
  // Absent/none → null (the workflows fail loud); malformed → a problem.
  let worktreeRoot = optionalCode('Project Identity', 'Worktree root')
  if (worktreeRoot !== null) {
    worktreeRoot = worktreeRoot.trim().replace(/\/+$/, '')
    if (!validWorktreeRoot(worktreeRoot)) {
      problems.push('Project Identity → Worktree root must be a repo-relative path like `.agents/worktrees` (no leading / or ~, no . or .. segments, no spaces or shell characters)')
      worktreeRoot = null
    }
  }
  // pack-commands-canonical: the project-only slash commands (no-copies guard allow-list).
  let projectCommands = list(field(sec('Project Identity'), 'Project commands'))
  const badCommands = projectCommands.filter((n) => !/^[a-z0-9][a-z0-9-]*$/.test(n))
  if (badCommands.length) {
    problems.push(`Project Identity → Project commands: invalid name(s) ${badCommands.map((n) => `'${n}'`).join(', ')} (lowercase letters, digits and -, e.g. \`doc-reviewer\`)`)
    projectCommands = []
  }
  const tagPatternRaw = field(sec('Deployment Notes'), 'Tag pattern')
  const { hook: smokeLoginHook, accounts: smokeLoginAccounts } = smokeLoginHookValue(
    field(sec('Deployment Notes'), 'Smoke login hook'), problems)
  const exec = execLayer(sec('Execution Layer'), configDir)
  if (sec('Execution Layer') !== undefined) problems.push(...exec.problems)

  // Post-merge stage keys (chain mode).
  const stageRaw = field(sec('Deployment Notes'), 'Post-merge smoke stage')
  let postMergeStage = false
  if (stageRaw !== undefined && !isNone(stageRaw)) {
    const v = code(stageRaw).trim().toLowerCase().split(/\s+/)[0]
    if (v === 'on') postMergeStage = true
    else if (v !== 'off') problems.push(`Deployment Notes → Post-merge smoke stage must be \`on\` or \`off\` (got '${v}')`)
  }
  const smokeTenants = pairList(field(sec('Deployment Notes'), 'Smoke tenants'),
    'Deployment Notes → Smoke tenants', problems, { valueRe: SMOKE_HOST })
  const smokeManifests = pairList(field(sec('Deployment Notes'), 'Smoke tenant manifests'),
    'Deployment Notes → Smoke tenant manifests', problems)
  const integrationTestArgs = optionalCode('Project Identity', 'Integration test args')
  if (integrationTestArgs && !integrationTestArgs.includes('{campaign}')) {
    problems.push('Project Identity → Integration test args must contain the {campaign} placeholder (without it every campaign-tip run shares one test DB)')
  }
  const prodUrlRaw = field(sec('Deployment Notes'), 'Prod URL')
  const prodHostSuffix = prodHostSuffixOf(prodUrlRaw)
  // Only a value that IS a URL (first word has a scheme or a `*.` wildcard) is checked; prose
  // placeholders like the example's `(e.g., https://…)` stay as before (no suffix).
  const prodUrlFirst = (prodUrlRaw !== undefined && !isNone(prodUrlRaw)) ? (code(prodUrlRaw).trim().split(/\s+/)[0] || '') : ''
  if (prodHostSuffix === null && /^([a-z][a-z0-9+.-]*:\/\/|\*\.)/i.test(prodUrlFirst)) {
    problems.push(`Deployment Notes → Prod URL has a malformed host (got '${prodUrlFirst}') — the prod-suffix guard would never match`)
  }

  return {
    name,
    testCommand,
    testVerdictCommand,
    worktreeLinks,
    complianceAreas,
    compliancePaths,
    devDeployCommand: optionalCode('Deployment Notes', 'Dev deploy command'),
    changelogFile: optionalCode('Deployment Notes', 'Changelog file'),
    tagPattern: optionalCode('Deployment Notes', 'Tag pattern'),
    releaseTags: !(typeof tagPatternRaw === 'string' && tagPatternRaw.trim() !== '' && isNone(tagPatternRaw)),
    backlogFile: optionalCode('Deployment Notes', 'Backlog file'),
    wolfpackHome,
    worktreeRoot,
    projectCommands,
    smokeLoginHook,
    smokeLoginAccounts,
    postMergeStage,
    migrateCommand: optionalCode('Deployment Notes', 'Migration command'),
    migrationFilePattern: optionalCode('Deployment Notes', 'Migration file pattern'),
    neverSmokeHosts: list(field(sec('Deployment Notes'), 'Never-smoke hosts')).map((h) => h.toLowerCase()),
    prodHostSuffix,
    smokeTenants,
    smokeManifests,
    smokeTenantEnsureCommand: optionalCode('Deployment Notes', 'Smoke tenant ensure command'),
    waveReportDirCommand: optionalCode('Deployment Notes', 'Wave report dir command'),
    waveReportBuildCommand: optionalCode('Deployment Notes', 'Wave report build command'),
    campaignReportCommand: optionalCode('Deployment Notes', 'Campaign report command'),
    reportUrlCommand: optionalCode('Deployment Notes', 'Report URL command'),
    appMarkerFile: optionalCode('Project Identity', 'App marker file'),
    integrationTestArgs,
    integrationFullSuitePaths: list(field(sec('Project Identity'), 'Integration full-suite paths')),
    triageBlockPaths: list(field(sec('Compliance Requirements'), 'Triage block paths')),
    exec,
    pool,
    models,
    gates,
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
  return { ...readConfig(readFileSync(abs, 'utf8'), { configDir: dirname(abs) }), path: abs }
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
    `testVerdictCommand: ${cfg.testVerdictCommand ?? 'none'}`,
    `devDeployCommand: ${cfg.devDeployCommand ?? 'none'}`,
    `wolfpackHome: ${cfg.wolfpackHome ?? 'none'}`,
    `worktreeRoot: ${cfg.worktreeRoot ?? 'none'}`,
    `releaseTags: ${cfg.releaseTags}`,
    `smokeLoginHook: ${cfg.smokeLoginHook ?? 'none'}`,
    `postMergeStage: ${cfg.postMergeStage ? 'on' : 'off'}`,
    cfg.exec && cfg.exec.missing.length
      ? `exec: missing ${cfg.exec.missing.join(', ')}`
      : `exec: sandbox ${cfg.exec?.sandboxImage} · glm ${cfg.exec?.glmImage} · layer ${cfg.exec?.projectLayer ?? 'none'}`,
  ]
  if (cfg.models) for (const [role, token] of Object.entries(cfg.models)) lines.push(`pool ${role} → ${token}`)
  if (cfg.gates) for (const [fam, name] of Object.entries(cfg.gates)) lines.push(`gate ${fam} ← ${name}`)
  if (cfg.missing.length) lines.push(`missing: ${cfg.missing.join(', ')}`)
  if (cfg.problems.length) lines.push(`problems: ${cfg.problems.join('; ')}`)
  return lines.join('\n')
}

const USAGE = 'usage: node scripts/wolfpack-config.mjs [--json | --exec] [<path to wolfpack-config.md>]'

// The --exec TAB lines (see the header). Values never contain a TAB (the reader refuses one).
export function execLines(cfg) {
  const e = cfg.exec
  const lines = [
    ['config', cfg.path],
    ['sandbox_image', e.sandboxImage],
    ['glm_image', e.glmImage],
    ['project_layer', e.projectLayer ?? ''],
  ]
  for (const m of e.seatExtraMounts) lines.push(['seat_mount', `${m.host}\t${m.container}`])
  for (const m of e.sandboxExtraMounts) lines.push(['sandbox_mount', `${m.host}\t${m.container}`])
  for (const s of e.secretsPaths) lines.push(['secrets_path', s])
  lines.push(['vibe_agent_dir', e.vibeAgentDir])
  for (const kv of e.seatTestEnv) lines.push(['seat_env', kv])
  return lines.map(([k, v]) => `${k}\t${v}`).join('\n')
}

function main(argv) {
  let json = false
  let exec = false
  const paths = []
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a === '--exec') exec = true
    else if (a.startsWith('-')) { process.stderr.write(`${USAGE}\n`); return 2 }
    else paths.push(a)
  }
  if (paths.length > 1 || (json && exec)) { process.stderr.write(`${USAGE}\n`); return 2 }
  let cfg
  try {
    cfg = loadConfig(paths[0] ?? 'wolfpack-config.md')
  } catch (e) {
    process.stderr.write(`✗ ${e.message}\n`)
    return 2
  }
  if (exec) {
    const parts = []
    if (cfg.exec.missing.length) parts.push(`Execution Layer: missing ${cfg.exec.missing.join(', ')}`)
    if (cfg.problems.length) parts.push(cfg.problems.join('; '))
    if (parts.length) { process.stderr.write(`✗ wolfpack-config: ${parts.join('; ')}\n`); return 2 }
    process.stdout.write(`${execLines(cfg)}\n`)
    return 0
  }
  process.stdout.write(`${json ? JSON.stringify(cfg, null, 2) : summary(cfg)}\n`)
  const bad = problemLine(cfg)
  if (bad) { process.stderr.write(`${bad}\n`); return 2 }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
