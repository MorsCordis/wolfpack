#!/usr/bin/env node
// scripts/wolfpack-statusline.mjs — usage-limit-gate AC1: status-line wrapper.
//
// Claude Code pipes a JSON blob to the status-line command on every render. Since
// 2.x that blob carries the REAL account usage: `rate_limits.five_hour` and
// `rate_limits.seven_day`, each `{used_percentage, resets_at}` (resets_at = epoch
// seconds). The window gate (wolfpack-window-gate.mjs) needs those numbers, but only the
// status line ever sees them. This wrapper sits in front of the real status line:
//
//   1. reads stdin to EOF (as raw bytes),
//   2. spawns the INNER status command with stdout INHERITED and writes it the SAME bytes
//      — so the rendered status line is byte-for-byte what the inner command prints (AC1b),
//   3. then snapshots ONLY `rate_limits` (whitelisted window fields) + `captured_at` to
//      ~/.cache/wolfpack/claude-usage.json (WOLFPACK_USAGE_SNAPSHOT), atomically.
//      Nothing else from stdin (prompt text, cwd, model, transcript path, session id) is
//      ever written.
//
// The snapshot is telemetry: EVERY parse/fs error is swallowed so it can never change the
// status line's stdout or exit code (stderr only with WOLFPACK_STATUSLINE_DEBUG=1 — status-line
// stderr is noise). No `rate_limits` / non-JSON stdin ⇒ no write; the previous snapshot stays.
//
// Settings (user step, Spark only — agents never edit ~/.claude/settings.json):
//   "statusLine": { "type": "command",
//     "command": "node /path/to/wolfpack/scripts/wolfpack-statusline.mjs" }
//
// Inner command resolution (first hit wins):
//   a. argv after `--`                         e.g.  wolfpack-statusline.mjs -- bash -c '<old cmd>'
//   b. WOLFPACK_STATUSLINE_INNER (run via /bin/sh -c)
//   c. auto-discover claude-hud exactly like the stock settings command: the highest-semver
//      ${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/claude-hud/claude-hud/*/  →
//      `<node> <dir>/dist/index.js`
// If the inner command cannot be spawned, ONE visible line is printed
// (`wolfpack-statusline: inner status command unavailable (<why>)`) — a blank bar would
// hide the failure; this is cosmetic, so a visible line is the right level.

import { spawn } from 'node:child_process'
import { readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_SNAPSHOT_PATH = join(homedir(), '.cache', 'wolfpack', 'claude-usage.json')
const STDIN_IDLE_MS = 1000

const debug = (msg) => {
  if (process.env.WOLFPACK_STATUSLINE_DEBUG === '1') process.stderr.write(`wolfpack-statusline: ${msg}\n`)
}

// A-7 window validity: finite numeric used_percentage AND finite numeric resets_at > 0.
function validWindow(w) {
  return !!w && typeof w === 'object' &&
    typeof w.used_percentage === 'number' && Number.isFinite(w.used_percentage) &&
    typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) && w.resets_at > 0
}

// Pure: status JSON object → whitelisted snapshot, or null when there is nothing valid.
export function extractSnapshot(obj, nowIso) {
  const rl = obj && typeof obj === 'object' ? obj.rate_limits : null
  if (!rl || typeof rl !== 'object') return null
  const rate_limits = {}
  for (const k of ['five_hour', 'seven_day']) {
    if (validWindow(rl[k])) {
      rate_limits[k] = { used_percentage: rl[k].used_percentage, resets_at: rl[k].resets_at }
    }
  }
  if (!Object.keys(rate_limits).length) return null
  return { rate_limits, captured_at: nowIso }
}

const semverKey = (name) => name.split('.').map(p => {
  const n = parseInt(p, 10)
  return Number.isFinite(n) ? n : -1
})
const cmpSemver = (a, b) => {
  const x = semverKey(a), y = semverKey(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1)
    if (d) return d
  }
  return 0
}

// Pure-ish (fs via probe): → {cmd, args} | {error}.
export function resolveInner(argv, env, fsProbe = { readdirSync, existsSync }) {
  const dd = argv.indexOf('--')
  if (dd >= 0) {
    const rest = argv.slice(dd + 1)
    if (rest.length) return { cmd: rest[0], args: rest.slice(1) }
    return { error: 'nothing after --' }
  }
  if (env.WOLFPACK_STATUSLINE_INNER) {
    return { cmd: '/bin/sh', args: ['-c', env.WOLFPACK_STATUSLINE_INNER] }
  }
  const cfg = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude')
  const base = join(cfg, 'plugins', 'cache', 'claude-hud', 'claude-hud')
  let versions
  try {
    versions = fsProbe.readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return { error: `claude-hud not found under ${base}` }
  }
  versions.sort(cmpSemver)
  for (let i = versions.length - 1; i >= 0; i--) {
    const entry = join(base, versions[i], 'dist', 'index.js')
    if (fsProbe.existsSync(entry)) return { cmd: process.execPath, args: [entry] }
  }
  return { error: `no claude-hud dist/index.js under ${base}` }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    let timer = null
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    }
    // Safety: a half-open pipe that never sends EOF must not hang the status line.
    const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(finish, STDIN_IDLE_MS) }
    arm()
    process.stdin.on('data', (c) => { chunks.push(c); arm() })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

export function writeSnapshot(buf, path, nowIso) {
  try {
    let obj
    try { obj = JSON.parse(buf.toString('utf8')) } catch { debug('stdin is not JSON — no snapshot'); return false }
    const snap = extractSnapshot(obj, nowIso)
    if (!snap) { debug('no valid rate_limits — no snapshot'); return false }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(snap) + '\n', { mode: 0o600 })
      renameSync(tmp, path)
    } catch (e) {
      try { unlinkSync(tmp) } catch { /* nothing to clean */ }
      throw e
    }
    return true
  } catch (e) {
    debug(`snapshot write failed: ${e.message}`)
    return false
  }
}

async function main() {
  const buf = await readStdin()
  const inner = resolveInner(process.argv.slice(2), process.env)
  let exitCode = 0
  const ran = new Promise((resolve) => {
    if (inner.error) {
      process.stdout.write(`wolfpack-statusline: inner status command unavailable (${inner.error})\n`)
      resolve(0)
      return
    }
    let child
    try {
      child = spawn(inner.cmd, inner.args, { stdio: ['pipe', 'inherit', 'inherit'], env: process.env })
    } catch (e) {
      process.stdout.write(`wolfpack-statusline: inner status command unavailable (${e.message})\n`)
      resolve(0)
      return
    }
    child.on('error', (e) => {
      process.stdout.write(`wolfpack-statusline: inner status command unavailable (${e.message})\n`)
      resolve(0)
    })
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    child.stdin.on('error', () => { /* inner closed stdin early — not our failure */ })
    child.stdin.end(buf)
  })
  // Snapshot AFTER spawning so rendering is never delayed by the write.
  writeSnapshot(buf, process.env.WOLFPACK_USAGE_SNAPSHOT || DEFAULT_SNAPSHOT_PATH, new Date().toISOString())
  exitCode = await ran
  process.exit(exitCode)
}

const invokedDirectly = process.argv[1] && (
  process.argv[1].endsWith('wolfpack-statusline.mjs') ||
  process.argv[1].endsWith('wolfpack-statusline')
)
if (invokedDirectly) main()
