#!/usr/bin/env node
// scripts/wolfpack-release.mjs — [04] Batch Merge & Consolidated Smoke helper.
//
// The deterministic core the /merge-wave and /smoke-wave commands shell out to,
// so the version math, release-queue filter, and acceptance-criteria parse are
// unit-tested rather than re-derived by an LLM each run. Mirrors the prior-layer
// methodology (real pure fns + node --test scenarios; clock/randomness-free per
// AC5 of [05]).
//
// CLI:
//   node scripts/wolfpack-release.mjs version <lastTag> <bumpA> [bumpB ...]
//       → prints BUMP=<level|none> and VERSION=<next|"" for tooling-only>
//   node scripts/wolfpack-release.mjs criteria <acceptance.md path> <slug>
//       → prints JSON array of parsed criteria
//
// Run tests: node --test scripts/wolfpack-release.test.mjs

import { readFileSync } from 'node:fs'

// ─── Version aggregation ──────────────────────────────────────────
// Per 04 § "Sequential batch merge + per-wave version tag": the WAVE owns the
// tag. Each hunt only declares a bump SIZE; the wave's bump is the highest step
// across them. Tooling-only hunts (null/empty bump) contribute nothing
// (feedback_tooling_only_no_version_bump). MAJOR is reserved for prod launch —
// it is still RANKED (so a stray major declaration wins and surfaces loudly for
// the human to confirm), never silently auto-applied.
const BUMP_RANK = { major: 3, minor: 2, patch: 1 }

export function aggregateBump(bumps) {
  let best = null
  let bestRank = 0
  for (const b of bumps || []) {
    const norm = String(b || '').toLowerCase()
    const rank = BUMP_RANK[norm] || 0
    if (rank > bestRank) {
      bestRank = rank
      best = norm
    }
  }
  return best // null when every hunt is tooling-only / declares no bump
}

export function nextVersion(lastTag, bump) {
  if (!bump) return null // tooling-only wave → no tag, no version heading
  const m = String(lastTag || '').match(/^(v?)(\d+)\.(\d+)\.(\d+)/)
  if (!m) throw new Error(`nextVersion: cannot parse last tag "${lastTag}"`)
  const [, prefix, MAJ, MIN, PAT] = m
  let [maj, min, pat] = [+MAJ, +MIN, +PAT]
  if (bump === 'major') {
    maj++
    min = 0
    pat = 0
  } else if (bump === 'minor') {
    min++
    pat = 0
  } else if (bump === 'patch') {
    pat++
  } else {
    throw new Error(`nextVersion: unknown bump "${bump}"`)
  }
  return `${prefix}${maj}.${min}.${pat}`
}

// ─── Release queue ────────────────────────────────────────────────
// Per 04 § "The release queue": all hunts at status `certified` whose
// compliance_review (if required, [02]) is signed off. A hunt parked for
// compliance_review is EXCLUDED until /resolve signs it off (AC4) — it goes to
// its own bucket so the report can say "awaiting sign-off", not "failed".
export function releaseQueue(hunts) {
  const ready = []
  const awaitingCompliance = []
  const excluded = []
  for (const h of hunts || []) {
    const status = h.status || ''
    const verdict = h.verdict || ''
    const isCompliancePark =
      status === 'parked:compliance_review' || h.reason === 'compliance_review'
    const isCertified =
      verdict === 'CERTIFIED_AWAITING_DEPLOY' || status === 'certified'
    if (isCompliancePark) awaitingCompliance.push(h.slug)
    else if (isCertified) ready.push(h.slug)
    else excluded.push(h.slug)
  }
  return { ready, awaitingCompliance, excluded }
}

// ─── Acceptance criteria parse ────────────────────────────────────
// Per 04 § "Consolidated smoke": the smoke spine is the union of every released
// hunt's acceptance criteria. Parse the `- ACn [tag] text` lines /spec writes
// (spec/SKILL.md § "The artifact"). Surface grouping is LLM judgment in the
// command; this just yields the structured criteria carrying their owning hunt
// so a smoke failure maps to exactly one merge commit (AC3 attribution).
export function parseAcceptanceCriteria(md, slug) {
  const out = []
  // Tolerate leading indentation (markdown auto-formatters indent nested bullets).
  const re = /^\s*-\s+(AC\d+)\s+\[(auto|manual|compliance)\]\s+(.*\S)\s*$/i
  for (const line of String(md || '').split('\n')) {
    const m = line.match(re)
    if (!m) continue
    const id = m[1].toUpperCase()
    out.push({
      slug,
      id,
      tag: m[2].toLowerCase(),
      text: m[3].trim(),
      ref: `${slug}/${id.replace(/^AC/, '')}`, // e.g. invoice-bundle/2
    })
  }
  return out
}

// ─── CLI ──────────────────────────────────────────────────────────
function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'version') {
    const [lastTag, ...bumps] = rest
    const bump = aggregateBump(bumps)
    if (!bump) {
      console.log('BUMP=none')
      console.log('VERSION=')
      return 0
    }
    let version
    try {
      version = nextVersion(lastTag, bump)
    } catch (e) {
      console.error(`wolfpack-release: ${e.message}`)
      return 1
    }
    console.log(`BUMP=${bump}`)
    console.log(`VERSION=${version}`)
    return 0
  }
  if (cmd === 'criteria') {
    const [path, slug] = rest
    if (!path || !slug) {
      console.error('usage: wolfpack-release.mjs criteria <acceptance.md path> <slug>')
      return 1
    }
    let md
    try {
      md = readFileSync(path, 'utf8')
    } catch (e) {
      console.error(`wolfpack-release: could not read ${path}: ${e.message}`)
      return 1
    }
    console.log(JSON.stringify(parseAcceptanceCriteria(md, slug), null, 2))
    return 0
  }
  console.error('usage: wolfpack-release.mjs <version|criteria> ...')
  return 1
}

// Only run when invoked directly, not when imported by the test module.
if (process.argv[1] && process.argv[1].endsWith('wolfpack-release.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
