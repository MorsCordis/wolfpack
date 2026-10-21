#!/usr/bin/env node
// scripts/wolfpack-version.mjs — the ONE write path for a hunt's metadata.proposed_version.
//
// A version the human chose (`/hunt` Q5, or `/resolve`) must not be silently rewritten by a seat.
// Every proposed_version carries `set_by`: "human" | <role> | null. A seat that disagrees with a
// human-set version does not edit it: it runs `set`, which keeps the human's value and appends a
// SEAT NOTE (not human direction) block to human-notes.md for the human to act on.
//
// CLI:
//   node scripts/wolfpack-version.mjs set --plan-dir D --bump B --tag T --by ROLE [--reason TEXT] [--at ISO]
//       B = PATCH|MINOR|MAJOR|none (case-insensitive)   T = vX.Y.Z | none
//       ROLE = human|alpha|debrief|shepherd|pointer|tracker|watchdog
//       prints {applied, disagreement, proposed_version}; exit 0, or 2 on bad arguments.
//       applied → D/metadata.json rewritten; not applied → left byte-identical, and a real
//       disagreement is appended to D/human-notes.md (created if missing).
//
// Run tests: node --test scripts/wolfpack-version.test.mjs

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseFlags } from './wolfpack-chain.mjs'

export const ROLES = ['human', 'alpha', 'debrief', 'shepherd', 'pointer', 'tracker', 'watchdog']

// 'PATCH' | 'MINOR' | 'MAJOR' | null (none / null / ''); anything else throws.
export function normBump(b) {
  if (b === undefined || b === null) return null
  const s = String(b).trim().toLowerCase()
  if (s === '' || s === 'none' || s === 'null') return null
  if (s === 'patch' || s === 'minor' || s === 'major') return s.toUpperCase()
  throw new Error(`invalid bump ${JSON.stringify(b)} (want PATCH|MINOR|MAJOR|none)`)
}

const normTag = (t) => {
  if (t === undefined || t === null) return null
  const s = String(t).trim()
  return (s === '' || s.toLowerCase() === 'none' || s === 'null') ? null : s
}

// Pure: never mutates `meta`.
export function applyProposedVersion(meta, { bump, tag, by, reason } = {}) {
  const cur = (meta && meta.proposed_version) || {}
  const nb = normBump(bump)
  const nt = normTag(tag)
  if (cur.set_by === 'human' && by !== 'human') {
    const same = nb === (cur.bump === undefined ? null : normBump(cur.bump)) && nt === (cur.tag || null)
    const disagreement = same ? null : {
      role: by,
      current: { bump: cur.bump === undefined ? null : normBump(cur.bump), tag: cur.tag || null },   // the HUMAN's standing value
      proposed: { bump: nb, tag: nt },
      reason,
    }
    return { meta, applied: false, disagreement }
  }
  return {
    meta: { ...meta, proposed_version: { ...cur, bump: nb, tag: nt, set_by: by } },
    applied: true,
    disagreement: null,
  }
}

const show = (v) => `${v.bump || 'none'} ${v.tag || 'none'}`

export function seatNoteBlock({ date, role, current, proposed, reason }) {
  return [
    `## ${date} — SEAT NOTE (not human direction): ${role} disagrees with the human-set version`,
    `- Human-set (stands): ${show(current)}`,
    `- ${role} proposes: ${show(proposed)}`,
    `- Why: ${reason || '(no reason given)'}`,
    `- Only a human changes it: /resolve, or edit proposed_version (set_by stays "human").`,
    '',
  ].join('\n')
}

function main(argv) {
  const [cmd, ...rest] = argv
  const f = parseFlags(rest, { text: ['reason', 'bump', 'tag', 'by', 'plan-dir', 'at'] })
  const fail = (msg) => { console.error(`wolfpack-version: ${msg}`); return 2 }
  if (cmd !== 'set') return fail('usage: wolfpack-version.mjs set --plan-dir D --bump B --tag T --by ROLE [--reason TEXT] [--at ISO]')
  try {
    if (typeof f['plan-dir'] !== 'string') return fail('--plan-dir is required')
    if (typeof f.by !== 'string' || !ROLES.includes(f.by)) return fail(`--by must be one of ${ROLES.join(', ')}`)
    if (f.bump === undefined || f.bump === true) return fail('--bump is required (PATCH|MINOR|MAJOR|none)')
    if (f.tag === undefined || f.tag === true) return fail('--tag is required (vX.Y.Z|none)')
    const dir = resolve(f['plan-dir'])
    const mp = join(dir, 'metadata.json')
    if (!existsSync(mp)) return fail(`no metadata.json in ${dir}`)
    const meta = JSON.parse(readFileSync(mp, 'utf8'))
    normBump(f.bump)   // validate before touching anything
    const r = applyProposedVersion(meta, { bump: f.bump, tag: f.tag, by: f.by, reason: typeof f.reason === 'string' ? f.reason : undefined })
    if (r.applied) writeFileSync(mp, JSON.stringify(r.meta, null, 2) + '\n')
    if (r.disagreement) {
      const date = (typeof f.at === 'string' ? f.at : new Date().toISOString()).slice(0, 10)
      const np = join(dir, 'human-notes.md')
      const block = seatNoteBlock({ date, role: r.disagreement.role, current: r.disagreement.current, proposed: r.disagreement.proposed, reason: r.disagreement.reason })
      const prior = existsSync(np) ? readFileSync(np, 'utf8') : ''
      const sep = prior === '' ? '' : (prior.endsWith('\n\n') ? '' : (prior.endsWith('\n') ? '\n' : '\n\n'))
      if (prior === '') writeFileSync(np, block)
      else appendFileSync(np, sep + block)
    }
    console.log(JSON.stringify({ applied: r.applied, disagreement: r.disagreement, proposed_version: r.meta.proposed_version || null }, null, 2))
    return 0
  } catch (e) {
    return fail(e.message)
  }
}

if (process.argv[1] && process.argv[1].endsWith('wolfpack-version.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
