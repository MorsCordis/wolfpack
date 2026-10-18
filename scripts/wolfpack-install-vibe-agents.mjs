#!/usr/bin/env node
// scripts/wolfpack-install-vibe-agents.mjs — install the tracked Wolfpack Vibe seat
// profiles (vibe-agents/wolfpack-*.toml) into the headless agents dir.
//
// WHY: the seat profiles used to live only in ~/.vibe/agents-headless/, hand-edited and
// untracked. One hand edit (bash = "never" on every review seat) silently turned every
// review and certification into a file-reading audit. The templates are now the single
// tracked source; this installer is the only supported way to put them in place, and
// `--check` reports drift without touching anything. scripts/wolfpack-toolcheck.mjs then
// checks the INSTALLED copies against the shim (what actually runs).
//
// Usage:
//   node scripts/wolfpack-install-vibe-agents.mjs [--check] [--dest DIR]
//     dest: --dest > $WOLFPACK_VIBE_AGENTS_DIR > $HOME/.vibe/agents-headless
//
// install (default): mkdir -p dest; for each template
//     absent      → write                                   "installed  <name>"
//     byte-equal  → leave                                   "unchanged  <name>"
//     differs     → back up to <name>.bak-<YYYYMMDDTHHMMSS> "replaced   <name>  (backup: <bak>)"
//                   (-2, -3, … if that backup name is taken), then write
//   Writes are atomic (temp file in dest + rename), mode 0644.
// --check: writes nothing; each template is "in sync" / "missing" / "drift"; exit 1 if
//   any is missing or drifted, else 0.
// Both modes report any wolfpack-*.toml in dest with no template as
//   "unmanaged  <name> (left as is)" and never read, write or delete any other file
//   (non-pack profiles, *.bak-* backups).
// Exit codes: 0 ok · 1 drift (--check) · 2 usage error, missing/empty templates dir, or
// any filesystem error (the message names the path).
//
// The clock is used only for backup names (the no-clock rule applies to workflow JS).

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE_RE = /^wolfpack-[a-z0-9-]+\.toml$/

export function templatesDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'vibe-agents')
}

export function defaultDest(env = process.env) {
  if (env.WOLFPACK_VIBE_AGENTS_DIR) return env.WOLFPACK_VIBE_AGENTS_DIR
  return join(env.HOME || '', '.vibe', 'agents-headless')
}

export function listTemplates(dir) {
  let names
  try {
    if (!statSync(dir).isDirectory()) return null
    names = readdirSync(dir)
  } catch { return null }
  return names.filter(n => TEMPLATE_RE.test(n)).sort()
}

const pad = (n) => String(n).padStart(2, '0')
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function backupName(dest, name) {
  const base = `${name}.bak-${stamp()}`
  if (!existsSync(join(dest, base))) return base
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`
    if (!existsSync(join(dest, cand))) return cand
  }
}

function atomicWrite(dest, name, bytes) {
  const tmp = join(dest, `.${name}.tmp-${process.pid}`)
  try {
    writeFileSync(tmp, bytes, { mode: 0o644 })
    chmodSync(tmp, 0o644)
    renameSync(tmp, join(dest, name))
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw e
  }
}

class FsError extends Error {
  constructor(path, cause) { super(`${path}: ${cause && cause.message ? cause.message : cause}`); this.path = path }
}
const fsTry = (path, fn) => { try { return fn() } catch (e) { throw new FsError(path, e) } }

// Returns { lines: string[], exitCode }. Pure of process.exit so a test can call it.
export function run({ check = false, dest, srcDir = templatesDir() } = {}) {
  const lines = []
  const templates = listTemplates(srcDir)
  if (!templates || !templates.length) {
    return { lines: [`✗ no seat templates found in ${srcDir} (expected vibe-agents/wolfpack-*.toml)`], exitCode: 2, error: true }
  }
  const counts = { installed: 0, unchanged: 0, replaced: 0, inSync: 0, missing: 0, drift: 0 }
  try {
    if (!check) fsTry(dest, () => mkdirSync(dest, { recursive: true }))
    const destExists = existsSync(dest)
    for (const name of templates) {
      const srcPath = join(srcDir, name)
      const want = fsTry(srcPath, () => readFileSync(srcPath))
      const target = join(dest, name)
      const have = destExists && existsSync(target) ? fsTry(target, () => readFileSync(target)) : null
      if (check) {
        if (have == null) { counts.missing++; lines.push(`missing    ${name}`) }
        else if (Buffer.compare(have, want) === 0) { counts.inSync++; lines.push(`in sync    ${name}`) }
        else { counts.drift++; lines.push(`drift      ${name}`) }
        continue
      }
      if (have == null) {
        fsTry(target, () => atomicWrite(dest, name, want))
        counts.installed++; lines.push(`installed  ${name}`)
      } else if (Buffer.compare(have, want) === 0) {
        counts.unchanged++; lines.push(`unchanged  ${name}`)
      } else {
        const bak = backupName(dest, name)
        fsTry(join(dest, bak), () => copyFileSync(target, join(dest, bak)))
        fsTry(target, () => atomicWrite(dest, name, want))
        counts.replaced++; lines.push(`replaced   ${name}  (backup: ${bak})`)
      }
    }
    if (destExists || !check) {
      const present = fsTry(dest, () => readdirSync(dest)).filter(n => TEMPLATE_RE.test(n)).sort()
      for (const n of present) if (!templates.includes(n)) lines.push(`unmanaged  ${n} (left as is)`)
    }
  } catch (e) {
    lines.push(`✗ ${e instanceof FsError ? e.message : String(e && e.message || e)}`)
    return { lines, exitCode: 2, error: true }
  }
  if (check) {
    lines.push(`${counts.inSync} in sync, ${counts.missing} missing, ${counts.drift} drift  (${dest})`)
    return { lines, exitCode: counts.missing || counts.drift ? 1 : 0 }
  }
  lines.push(`${counts.installed} installed, ${counts.unchanged} unchanged, ${counts.replaced} replaced  (${dest})`)
  return { lines, exitCode: 0 }
}

function main(argv) {
  let check = false
  let dest = null
  const rest = argv.slice(2)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--check') check = true
    else if (a === '--dest') {
      const v = rest[i + 1]
      if (!v || v.startsWith('--')) { console.error('✗ --dest needs a directory'); process.exit(2) }
      dest = v; i++
    } else {
      console.error(`✗ unknown argument ${a}\nusage: node wolfpack-install-vibe-agents.mjs [--check] [--dest DIR]`)
      process.exit(2)
    }
  }
  const res = run({ check, dest: dest || defaultDest(process.env) })
  for (const l of res.lines) (res.exitCode === 2 || l.startsWith('✗') ? console.error : console.log)(l)
  process.exit(res.exitCode)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
}
