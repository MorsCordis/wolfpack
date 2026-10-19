#!/usr/bin/env node
// scripts/wolfpack-toolcheck.mjs — [06] AC1 preflight regression guard + seat-profile parity.
//
// Asserts the cross-model REVIEWER still holds its full CAPABLE toolset and has
// NOT silently re-boxed back to the 2-tool cage (read,grep) that blinded the
// cross-model reviewer in the run-#5 shakedown. Per docs/wolfpack-autonomy/06 § "Guard against
// regression": the `--enabled-tools read,grep` comma bug was a SILENT re-boxing —
// it filtered every tool out and nobody noticed until the reviewer hallucinated a
// whole review. So a preflight MUST assert the capable set before a run and FAIL
// LOUD (exit non-zero), not warn, if a model comes back re-boxed.
//
// SEAT-PROFILE PARITY (seat-profiles-into-pack). A seat's real toolset is the
// INTERSECTION of two layers: the shim's --enabled-tools list AND the Vibe agent
// profile's `[tools.<name>] permission`. The shim enabled bash for review seats while
// the hand-edited, untracked profiles set bash = "never" — every review and
// certification ran without a shell and nothing failed. So this guard also reads every
// pipeline seat profile (installed from the tracked `vibe-agents/` templates by
// scripts/wolfpack-install-vibe-agents.mjs) and cross-checks it against the tools the
// shim actually enables for that seat (both families, both modes, operator env
// overrides honoured), under a per-role policy (ROLE_POLICY):
//   review    — must have read_file, grep, bash; edit/write_file are denied BY ROLE
//               (a `never` there is intended); task is forbidden.
//   implement — must have read_file, grep, write_file, edit; bash and task forbidden.
// Any other disagreement fails loud: a profile that denies a tool the shim enables,
// enables one the shim omits, leaves a shim tool on "ask" (headless vibe -p denies or
// hangs on it), or a pipeline seat with no installed profile. hunt-pipeline.js runs
// this CLI as a preflight before the first shim seat.
//
// TODO(de-fracture): the shim filename (podman-vibe.sh) and the shell variable names
// (VIBE_TOOLS_DEFAULT, GLM_*_TOOLS_DEFAULT, GLM_*_DROP) are specific to one cross-model
// agent harness. Parameterize them via wolfpack-config.md so this guard targets
// whichever harness shim a project actually ships.
//
// What it checks in the shim:
//   1. VIBE_TOOLS_DEFAULT lists the capable producer + git-read set
//      (read, grep, edit, write_file, bash) — not a 2-tool subset.
//   2. The tools are SPACE-separated (a comma re-introduces the single-bogus-token
//      bug: the for-loop would emit `--enabled-tools read,grep` = one tool named
//      "read,grep" that matches nothing → blind reviewer).
//   3. No legacy `--enabled-tools read,grep`-style comma-joined flag survives.
//   4. The flag array is built by REPEATING --enabled-tools per tool (argparse
//      action="append"), not collapsed to one flag.
//   5. `task` is NOT in the default set — cross-model self-orchestration stays off.
//   6. (analyzeGlmShim) the GLM review/implement lists and their drop lists exist,
//      are quoted, space-separated and comma-free; review includes bash; task is
//      dropped in both modes; bash is dropped in implement mode.
// Then, per pipeline seat, the profile × shim parity rules in checkSeatParity.
//
// WHY NODE / NO CLOCK: pure string analysis, host-side; no Date/random. Exit 0 =
// capable + every seat in parity; exit 1 = re-boxed or a seat mismatch (loud); exit 2
// = the shim or the profiles dir couldn't be read (also loud — a missing guard target
// is itself a failure).
//
// Usage:
//   node scripts/wolfpack-toolcheck.mjs [<shim> | --shim <path>] [--profiles <dir>]
//     shim default:     $WOLFPACK_HOME/scripts/podman-vibe.sh (the pack's shim) when
//                       WOLFPACK_HOME is set, else <this dir>/podman-vibe.sh
//     profiles default: $WOLFPACK_VIBE_AGENTS_DIR, else $HOME/.vibe/agents when
//                       WOLFPACK_SANDBOX is set (the unified-sandbox mount), else
//                       $HOME/.vibe/agents-headless
//   There is deliberately no flag to skip the profile check: a bypass would recreate
//   the silent gap this guard closes.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The capable reviewer toolset (docs/wolfpack-autonomy/06 § "give models their
// tools"). read+grep+edit+write_file+bash maps the spec's enumerated
// read/grep/git-read/write/search_replace onto Vibe's live tool names. `task` is
// the one deliberate exclusion (self-orchestration disabled).
export const CAPABLE_TOOLS = ['read', 'grep', 'edit', 'write_file', 'bash']
export const FORBIDDEN_DEFAULT_TOOLS = ['task']

// ─── Pure core (unit-tested directly) ───────────────────────────

// Analyze the podman-vibe.sh text. Returns { ok, tools, problems } — problems is
// a list of human-readable, fail-loud strings (empty ⇒ capable).
export function analyzeVibeShim(text) {
  const src = String(text || '')
  const problems = []

  // (3) Legacy comma-joined flag anywhere — the exact silent-blinding bug.
  //     e.g. --enabled-tools read,grep  /  --enabled-tools "read,grep"  /
  //     --enabled-tools=read,grep (argparse accepts the `=` form too).
  const commaFlag = src.match(/--enabled-tools[=\s]+["']?[\w.*-]+,[\w.*,-]+/)
  if (commaFlag) {
    problems.push(
      `comma-joined --enabled-tools found ("${commaFlag[0].trim()}") — argparse parses it as ONE bogus tool name; repeat the flag per tool instead`)
  }

  // (1) Extract the committed default tool list.
  const defMatch = src.match(/VIBE_TOOLS_DEFAULT=(["'])(.*?)\1/)
  if (!defMatch) {
    problems.push('VIBE_TOOLS_DEFAULT not found — cannot verify the capable toolset (did the shim get rewritten?)')
    return { ok: false, tools: [], problems }
  }
  const rawDefault = defMatch[2]

  // (2) Space-separated, comma-free.
  if (rawDefault.includes(',')) {
    problems.push(`VIBE_TOOLS_DEFAULT="${rawDefault}" contains a comma — tools must be SPACE-separated or the per-tool loop emits a bogus comma-joined flag`)
  }
  const tools = rawDefault.split(/\s+/).filter(Boolean)

  // (4) The loop must repeat --enabled-tools per tool (append), not one flag.
  //     Look for a for-loop over the default that appends a per-tool flag.
  const repeatsPerTool = /for\s+\w+\s+in\s+[^\n]*VIBE_TOOLS_DEFAULT[\s\S]*?VIBE_TOOL_FLAGS\+=\(\s*--enabled-tools\s+["']?\$/.test(src)
  if (!repeatsPerTool) {
    problems.push('VIBE_TOOL_FLAGS is not built by repeating --enabled-tools per tool over VIBE_TOOLS_DEFAULT — argparse needs the flag repeated, not collapsed')
  }

  // (1 cont.) Capable set present.
  for (const need of CAPABLE_TOOLS) {
    if (!tools.includes(need)) {
      problems.push(`capable tool "${need}" missing from VIBE_TOOLS_DEFAULT (have: ${tools.join(', ') || '<none>'}) — reviewer is re-boxed`)
    }
  }

  // (5) Self-orchestration must stay off.
  for (const bad of FORBIDDEN_DEFAULT_TOOLS) {
    if (tools.includes(bad)) {
      problems.push(`"${bad}" is in the default toolset — cross-model self-orchestration must stay disabled (the orchestrator owns fan-out)`)
    }
  }

  return { ok: problems.length === 0, tools, problems }
}

// ─── Seat-profile parity (seat-profiles-into-pack) ──────────────

// Vibe migrates legacy tool names (core/config/_migration.py RENAMED_TOOLS). The Mistral
// shim still passes `read`, so both sides are normalised through the same map.
export const RENAMED_TOOLS = { read: 'read_file', search_replace: 'edit' }
// Vibe's git_bash is a Windows-only shell (is_available → is_windows()). It is bash's
// companion: its permission must equal bash's, and it is exempt from "shim omits it".
export const SHELL_COMPANIONS = { git_bash: 'bash' }
export const ROLE_POLICY = {
  review:    { require: ['read_file', 'grep', 'bash'], roleDeny: ['edit', 'write_file'], forbid: ['task'] },
  implement: { require: ['read_file', 'grep', 'write_file', 'edit'], roleDeny: [], forbid: ['bash', 'task'] },
}
// The agents hunt-pipeline.js dispatches through the shim.
export const PIPELINE_SEATS = {
  'wolfpack-bloodhound':     { family: 'mistral', mode: 'review' },
  'wolfpack-pointer':        { family: 'mistral', mode: 'review' },
  'wolfpack-watchdog':       { family: 'mistral', mode: 'review' },
  'wolfpack-bloodhound-glm': { family: 'glm', mode: 'review' },
  'wolfpack-pointer-glm':    { family: 'glm', mode: 'review' },
  'wolfpack-watchdog-glm':   { family: 'glm', mode: 'review' },
  'wolfpack-shepherd-glm':   { family: 'glm', mode: 'implement' },
}
// Tracked in vibe-agents/ as they are, but never dispatched through the shim by the
// pipeline — listed, not parity-checked.
export const TRACKED_NOT_DISPATCHED = ['wolfpack-alpha', 'wolfpack-shepherd', 'wolfpack-tracker']
// Text a seat transcript shows when its tool calls were denied or unknown, or when the
// shell ran but git could not see the repo (both make a review audit-only). Each branch is
// anchored on the exact message shape the tool emits (Vibe: "Tool '<name>' is permanently
// disabled", "Unknown tool '<name>'", "Tool execution denied by approval policy", "Tool
// '<name>' was denied by hook ..."; git: "fatal: not a git repository"), never on bare prose
// ("tool calls were denied"), so a certifier DISCUSSING denials does not park itself. A seat
// that quotes one of these exact messages still matches; the park shows the evidence.
// POSIX-ERE and JS compatible; match case-insensitively. hunt-pipeline.js embeds the SAME
// string (it cannot import); a harness test asserts the two are byte-equal.
export const TOOL_DENIAL_PATTERN =
  "Tool '[^']+' is permanently disabled|Unknown tool '[^']+'|Tool execution denied by (the )?approval policy|Tool '[^']+' was denied by hook|fatal: not a git repository"

const PERMISSIONS = ['always', 'never', 'ask']

export function normalizeTool(name) {
  const n = String(name || '').trim()
  return RENAMED_TOOLS[n] || n
}

const splitTools = (s) => String(s || '').split(/\s+/).filter(Boolean).map(normalizeTool)
const uniq = (xs) => [...new Set(xs)]

// Read `NAME="a b c"` from the shim. Returns { value } (quoted), { unquoted } when the
// variable is assigned without quotes, or null when it is absent.
function shimVar(text, name) {
  const src = String(text || '')
  const q = src.match(new RegExp(`^[ \\t]*${name}=(["'])(.*?)\\1`, 'm'))
  if (q) return { value: q[2] }
  const u = src.match(new RegExp(`^[ \\t]*${name}=(\\S*)`, 'm'))
  if (u) return { unquoted: u[1] }
  return null
}

// Minimal, dependency-free TOML subset for a Vibe agent profile: `[tools.<name>]`
// section headers and the `permission = "always|never|ask"` value inside each. Comments,
// top-level keys and other keys (allowlist, …) are ignored. Section names are normalised
// (RENAMED_TOOLS). An unknown or unquoted permission value is a PROBLEM (fail loud), as
// is the same tool set twice with different permissions (e.g. [tools.read] + [tools.read_file]).
export function parseSeatProfile(text) {
  const tools = {}
  const problems = []
  let current = null
  const lines = String(text || '').split(/\r?\n/)
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '').trim()
    if (!line) return
    const header = line.match(/^\[([^\]]+)\]$/)
    if (header) {
      const name = header[1].trim()
      current = name.startsWith('tools.') ? normalizeTool(name.slice('tools.'.length)) : null
      return
    }
    if (current == null) return
    const kv = line.match(/^permission\s*=\s*(.*)$/)
    if (!kv) return
    const q = kv[1].match(/^"([^"]*)"$/) || kv[1].match(/^'([^']*)'$/)
    if (!q) {
      problems.push(`line ${i + 1}: [tools.${current}] permission = ${kv[1]} is not a quoted string`)
      return
    }
    const perm = q[1]
    if (!PERMISSIONS.includes(perm)) {
      problems.push(`line ${i + 1}: [tools.${current}] permission = "${perm}" is not one of ${PERMISSIONS.join('|')}`)
      return
    }
    if (tools[current] && tools[current] !== perm) {
      problems.push(`[tools.${current}] is set twice with different permissions ("${tools[current]}" and "${perm}") — a legacy alias section conflicts`)
    }
    tools[current] = perm
  })
  return { tools, problems }
}

// The GLM half of the shim: the review/implement allow-lists and their declared drop lists.
export function analyzeGlmShim(text) {
  const problems = []
  const vals = {}
  for (const name of ['GLM_REVIEW_TOOLS_DEFAULT', 'GLM_IMPLEMENT_TOOLS_DEFAULT', 'GLM_REVIEW_DROP', 'GLM_IMPLEMENT_DROP']) {
    const v = shimVar(text, name)
    if (!v) { problems.push(`${name} not found — cannot verify the GLM seat toolsets (did the shim get rewritten?)`); continue }
    if (v.value == null) { problems.push(`${name}=${v.unquoted} is not quoted — keep the list a single quoted, space-separated string`); continue }
    if (v.value.includes(',')) problems.push(`${name}="${v.value}" contains a comma — tools must be SPACE-separated`)
    vals[name] = splitTools(v.value)
  }
  const review = vals.GLM_REVIEW_TOOLS_DEFAULT
  const rDrop = vals.GLM_REVIEW_DROP
  const iDrop = vals.GLM_IMPLEMENT_DROP
  if (review && !review.includes('bash')) problems.push(`GLM_REVIEW_TOOLS_DEFAULT lacks "bash" — GLM review/certify seats cannot run git diff or the tests`)
  if (rDrop && !rDrop.includes('task')) problems.push(`GLM_REVIEW_DROP lacks "task" — GLM review seats must not self-orchestrate`)
  if (rDrop && rDrop.includes('bash')) problems.push(`GLM_REVIEW_DROP drops "bash" — GLM review/certify seats would run without a shell`)
  if (iDrop && !iDrop.includes('task')) problems.push(`GLM_IMPLEMENT_DROP lacks "task" — the GLM implementer must not self-orchestrate`)
  if (iDrop && !iDrop.includes('bash')) problems.push(`GLM_IMPLEMENT_DROP lacks "bash" — the GLM implementer must stay shell-free (the wrapper commits; Tracker runs tests)`)
  return { ok: problems.length === 0, problems }
}

// The tools the shim really enables for one seat, mirroring the shim's own logic:
//   mistral        — ${WOLFPACK_VIBE_TOOLS:-VIBE_TOOLS_DEFAULT}, minus task for wolfpack-bloodhound
//   glm review     — ${WOLFPACK_GLM_TOOLS:-GLM_REVIEW_TOOLS_DEFAULT} minus GLM_REVIEW_DROP
//   glm implement  — ${WOLFPACK_GLM_IMPLEMENT_TOOLS:-GLM_IMPLEMENT_TOOLS_DEFAULT} minus GLM_IMPLEMENT_DROP
// A required shim variable that is missing is a problem, never a silent default.
export function shimToolsFor(shimText, seat, env = {}) {
  const spec = PIPELINE_SEATS[seat]
  if (!spec) return { tools: [], problems: [`${seat}: not a pipeline seat`] }
  const problems = []
  const read = (name) => {
    const v = shimVar(shimText, name)
    if (!v || v.value == null) { problems.push(`${seat}: shim variable ${name} not found (or unquoted) — cannot derive the seat's enabled tools`); return null }
    return v.value
  }
  const pick = (envName, def) => (env && env[envName]) ? String(env[envName]) : def
  let list = []
  if (spec.family === 'mistral') {
    const def = read('VIBE_TOOLS_DEFAULT')
    if (def == null) return { tools: [], problems }
    list = splitTools(pick('WOLFPACK_VIBE_TOOLS', def))
    if (seat === 'wolfpack-bloodhound') list = list.filter(t => t !== 'task')
  } else {
    const isImpl = spec.mode === 'implement'
    const def = read(isImpl ? 'GLM_IMPLEMENT_TOOLS_DEFAULT' : 'GLM_REVIEW_TOOLS_DEFAULT')
    const drop = read(isImpl ? 'GLM_IMPLEMENT_DROP' : 'GLM_REVIEW_DROP')
    if (def == null || drop == null) return { tools: [], problems }
    const dropSet = new Set(splitTools(drop))
    list = splitTools(pick(isImpl ? 'WOLFPACK_GLM_IMPLEMENT_TOOLS' : 'WOLFPACK_GLM_TOOLS', def)).filter(t => !dropSet.has(t))
  }
  return { tools: uniq(list), problems }
}

// Profile × shim parity for ONE pipeline seat. `profile` is parseSeatProfile's result
// (or its .tools map); `shimTools` the normalised list shimToolsFor returned.
// Every problem names the seat and the tool.
export function checkSeatParity(seat, profile, shimTools) {
  const spec = PIPELINE_SEATS[seat]
  if (!spec) return [`${seat}: not a pipeline seat`]
  const policy = ROLE_POLICY[spec.mode]
  const perms = (profile && profile.tools) ? profile.tools : (profile || {})
  const shim = new Set((shimTools || []).map(normalizeTool))
  const shimList = [...shim].join(' ') || '<none>'
  const perm = (t) => perms[t]
  const problems = []
  // 1. a required tool the shim does not enable
  for (const t of policy.require) {
    if (!shim.has(t)) problems.push(`${seat}: the shim does not enable "${t}", which the ${spec.mode} role requires (shim enables: ${shimList})`)
  }
  for (const t of shim) {
    // 2. profile denies a tool the shim enables (not an intended role denial)
    if (perm(t) === 'never' && !policy.roleDeny.includes(t) && !policy.forbid.includes(t)) {
      problems.push(`${seat}: profile denies "${t}" ([tools.${t}] permission = "never") but the shim enables it`)
    }
    // 3. "ask" on a shim tool — headless vibe -p cannot answer it
    if (perm(t) === 'ask') {
      problems.push(`${seat}: "${t}" is "ask" — a headless vibe -p run denies (or hangs on) every ask`)
    }
  }
  // 4. a required tool the profile does not grant "always"
  for (const t of policy.require) {
    if (perm(t) !== 'always' && perm(t) !== 'never' && perm(t) !== 'ask') {
      problems.push(`${seat}: profile does not set [tools.${t}] — it falls to Vibe's default ("ask" for bash), which a headless run denies; the ${spec.mode} role requires "always"`)
    } else if (perm(t) === 'never') {
      problems.push(`${seat}: profile sets "${t}" to "never", but the ${spec.mode} role requires "always"`)
    } else if (perm(t) === 'ask') {
      problems.push(`${seat}: profile sets "${t}" to "ask", but the ${spec.mode} role requires "always"`)
    }
  }
  // 5. profile enables a tool the shim omits (shell companions excepted)
  for (const [t, p] of Object.entries(perms)) {
    if ((p === 'always' || p === 'ask') && !shim.has(t) && !SHELL_COMPANIONS[t]) {
      problems.push(`${seat}: profile enables "${t}" ([tools.${t}] permission = "${p}") but the shim omits it`)
    }
  }
  // 6. a forbidden tool — never in the shim set, always "never" in the profile
  for (const t of policy.forbid) {
    if (shim.has(t)) problems.push(`${seat}: the shim enables "${t}", which the ${spec.mode} role forbids`)
    if (perm(t) !== 'never') problems.push(`${seat}: profile sets "${t}" to ${perm(t) ? `"${perm(t)}"` : 'nothing (Vibe default)'} — the ${spec.mode} role forbids it; set [tools.${t}] permission = "never"`)
  }
  // 7. a role-denied tool must be "never" in the profile
  for (const t of policy.roleDeny) {
    if (perm(t) !== 'never') problems.push(`${seat}: profile sets "${t}" to ${perm(t) ? `"${perm(t)}"` : 'nothing (Vibe default)'} — the ${spec.mode} role is read-only; set [tools.${t}] permission = "never"`)
  }
  // 8. a shell companion must mirror its base tool
  for (const [c, base] of Object.entries(SHELL_COMPANIONS)) {
    if ((perm(c) !== undefined || perm(base) !== undefined) && perm(c) !== perm(base)) {
      problems.push(`${seat}: "${c}" is ${perm(c) ? `"${perm(c)}"` : 'unset'} but "${base}" is ${perm(base) ? `"${perm(base)}"` : 'unset'} — ${c} is ${base}'s shell companion and must match it`)
    }
  }
  return uniq(problems)
}

export const INSTALLER_HINT = 'node <wolfpack>/scripts/wolfpack-install-vibe-agents.mjs'

// Every pipeline seat profile in `profilesDir` against the shim. Returns
// { ok, problems, seats: [{ name, status, problems }] } — status is "ok", "mismatch",
// "missing" or "tracked, not dispatched — not parity-checked".
export function checkProfiles(shimText, profilesDir, env = {}) {
  const seats = []
  const problems = []
  for (const name of Object.keys(PIPELINE_SEATS)) {
    const file = join(profilesDir, `${name}.toml`)
    if (!existsSync(file)) {
      const p = [`${name}: profile not installed in ${profilesDir} — run ${INSTALLER_HINT}`]
      seats.push({ name, status: 'missing', problems: p })
      problems.push(...p)
      continue
    }
    const profile = parseSeatProfile(readFileSync(file, 'utf8'))
    const shim = shimToolsFor(shimText, name, env)
    const p = uniq([
      ...profile.problems.map(x => `${name}: ${x}`),
      ...shim.problems,
      ...(shim.problems.length ? [] : checkSeatParity(name, profile, shim.tools)),
    ])
    seats.push({ name, status: p.length ? 'mismatch' : 'ok', problems: p, shimTools: shim.tools })
    problems.push(...p)
  }
  for (const name of TRACKED_NOT_DISPATCHED) {
    seats.push({ name, status: 'tracked, not dispatched — not parity-checked', problems: [] })
  }
  return { ok: problems.length === 0, problems, seats }
}

export function defaultProfilesDir(env = {}) {
  if (env.WOLFPACK_VIBE_AGENTS_DIR) return env.WOLFPACK_VIBE_AGENTS_DIR
  const home = env.HOME || ''
  return env.WOLFPACK_SANDBOX ? join(home, '.vibe', 'agents') : join(home, '.vibe', 'agents-headless')
}

// ─── CLI ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { shim: null, profiles: null, errors: [] }
  const rest = argv.slice(2)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--shim' || a === '--profiles') {
      const v = rest[i + 1]
      if (v == null || v.startsWith('--')) { out.errors.push(`${a} needs a path`); continue }
      out[a.slice(2)] = v
      i++
    } else if (a.startsWith('--')) {
      out.errors.push(`unknown flag ${a}`)
    } else if (out.shim == null) {
      out.shim = a   // backward-compatible positional shim path
    } else {
      out.errors.push(`unexpected argument ${a}`)
    }
  }
  return out
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url))
  const args = parseArgs(argv)
  if (args.errors.length) {
    for (const e of args.errors) console.error(`✗ toolcheck: ${e}`)
    console.error('usage: node wolfpack-toolcheck.mjs [<shim> | --shim <path>] [--profiles <dir>]')
    process.exit(2)
  }
  const vibePath = args.shim || (process.env.WOLFPACK_HOME
    ? join(process.env.WOLFPACK_HOME, 'scripts', 'podman-vibe.sh')
    : join(here, 'podman-vibe.sh'))
  const profilesDir = args.profiles || defaultProfilesDir(process.env)

  let failed = false

  if (!existsSync(vibePath)) {
    console.error(`✗ toolcheck: shim not found: ${vibePath} — pass --shim <path> or set WOLFPACK_HOME to the pack checkout`)
    process.exit(2)
  }
  let isDir = false
  try { isDir = statSync(profilesDir).isDirectory() } catch { isDir = false }
  if (!isDir) {
    console.error(`✗ toolcheck: seat profiles dir not found: ${profilesDir} — install the tracked templates with ${INSTALLER_HINT}`)
    process.exit(2)
  }
  const shimText = readFileSync(vibePath, 'utf8')

  const vibe = analyzeVibeShim(shimText)
  if (vibe.ok) {
    console.log(`✓ podman-vibe.sh: capable toolset [${vibe.tools.join(' ')}] — not re-boxed`)
  } else {
    failed = true
    console.error('✗ podman-vibe.sh REVIEWER IS RE-BOXED (fail-loud):')
    for (const p of vibe.problems) console.error(`    • ${p}`)
  }
  const glm = analyzeGlmShim(shimText)
  if (glm.ok) {
    console.log('✓ podman-vibe.sh: GLM review/implement toolsets + drop lists declared')
  } else {
    failed = true
    console.error('✗ podman-vibe.sh GLM SEAT TOOLSETS ARE WRONG (fail-loud):')
    for (const p of glm.problems) console.error(`    • ${p}`)
  }

  const res = checkProfiles(shimText, profilesDir, process.env)
  console.log(`  seat profiles: ${profilesDir}`)
  for (const s of res.seats) {
    if (s.status === 'ok') {
      console.log(`✓ ${s.name}: profile matches the shim [${(s.shimTools || []).join(' ')}]`)
    } else if (!s.problems.length) {
      console.log(`· ${s.name}: ${s.status}`)
    } else {
      failed = true
      console.error(`✗ ${s.name}: ${s.status === 'missing' ? 'PROFILE MISSING' : 'PROFILE ≠ SHIM'} (fail-loud):`)
      for (const p of s.problems) console.error(`    • ${p}`)
    }
  }

  process.exit(failed ? 1 : 0)
}

// Run as CLI only when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
}
