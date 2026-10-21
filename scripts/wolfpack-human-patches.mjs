#!/usr/bin/env node
// scripts/wolfpack-human-patches.mjs — the human-patch gate's deterministic probe.
//
// A patch in <plan-dir>/human-patches/ is a protected-path change a human must apply. Its target
// repo is encoded by LOCATION (scripts/lib/human-patch.mjs): `<NN>-<name>.patch` → the hunt
// worktree, `consumer/<NN>-<name>.patch` → the consumer worktree recorded in
// metadata.consumer_worktree {path, branch}. Any other location is an error (exit 2), never
// skipped: a patch the gate cannot place must not read as "nothing pending".
//
// CLI:
//   node scripts/wolfpack-human-patches.mjs check --plan-dir D --worktree W
//     prints {"pending":[{patch,rel,target,repo,paths,applies}…],"consumer":{path,branch}|null}
//     and exits 0 (pending is [] when every patch is already applied, or none exist);
//     on any problem prints {"status":"error","reason":…} and exits 2.
//
// Run tests: node --test scripts/wolfpack-human-patches.test.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { git, parseFlags } from './wolfpack-chain.mjs'
import { humanPatchTarget, humanPatchRepo } from './lib/human-patch.mjs'

// Every *.patch under dir, as POSIX paths relative to dir. Top level first, then subdirs; sorted.
function listPatches(dir) {
  const out = []
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const a = join(abs, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(a).isDirectory()) walk(a, r)
      else if (name.endsWith('.patch')) out.push(r)
    }
  }
  walk(dir, '')
  return out.sort((a, b) => {
    const da = a.includes('/'), db = b.includes('/')
    return da === db ? (a < b ? -1 : a > b ? 1 : 0) : (da ? 1 : -1)
  })
}

// The b/ paths a patch touches (trailing tab+timestamp stripped).
export function patchPaths(text) {
  const paths = []
  for (const line of String(text).split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line)
    if (m) {
      const p = m[1].replace(/\t.*$/, '')
      if (!paths.includes(p)) paths.push(p)
    }
  }
  return paths
}

export function checkHumanPatches({ planDir, worktree }) {
  const dir = join(planDir, 'human-patches')
  if (!existsSync(dir)) return { pending: [], consumer: null }
  const rels = listPatches(dir)
  if (rels.length === 0) return { pending: [], consumer: null }
  // Route EVERY path first, so an unplaceable patch fails before anything is checked.
  const routed = rels.map(rel => ({ rel, target: humanPatchTarget(rel) }))
  let consumer = null
  if (routed.some(x => x.target === 'consumer')) {
    const mp = join(planDir, 'metadata.json')
    if (!existsSync(mp)) throw new Error(`a consumer patch exists but ${mp} is missing`)
    const meta = JSON.parse(readFileSync(mp, 'utf8'))
    const cw = meta && meta.consumer_worktree
    consumer = cw && typeof cw === 'object' ? { path: cw.path, branch: cw.branch || null } : null
  }
  const pending = []
  for (const { rel, target } of routed) {
    const repo = humanPatchRepo(target, { worktreePath: worktree, consumer })
    const inside = git(['-C', repo, 'rev-parse', '--is-inside-work-tree'], { allowFail: true })
    if (inside.code !== 0 || inside.stdout !== 'true') throw new Error(`${repo} (the ${target} repo for ${rel}) is not a git work tree`)
    const patch = resolve(dir, rel)
    const applied = git(['-C', repo, 'apply', '--check', '-R', patch], { allowFail: true })
    if (applied.code === 0) continue
    const fwd = git(['-C', repo, 'apply', '--check', patch], { allowFail: true })
    pending.push({ patch, rel, target, repo, paths: patchPaths(readFileSync(patch, 'utf8')), applies: fwd.code === 0 })
  }
  return { pending, consumer }
}

function main(argv) {
  const [cmd, ...rest] = argv
  const f = parseFlags(rest, { text: ['plan-dir', 'worktree'] })
  try {
    if (cmd !== 'check') throw new Error('usage: wolfpack-human-patches.mjs check --plan-dir D --worktree W')
    if (typeof f['plan-dir'] !== 'string') throw new Error('--plan-dir is required')
    if (typeof f.worktree !== 'string') throw new Error('--worktree is required')
    console.log(JSON.stringify(checkHumanPatches({ planDir: resolve(f['plan-dir']), worktree: resolve(f.worktree) })))
    return 0
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', reason: e.message }))
    return 2
  }
}

if (process.argv[1] && process.argv[1].endsWith('wolfpack-human-patches.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
