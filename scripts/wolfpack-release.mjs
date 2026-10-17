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
// Chain-mode campaign release (`/release-campaign`; JSON on stdout unless noted, exit 2 = refused/error):
//   revert         --campaign C --hunt H [--reason TEXT] [--at ISO]   revert H (+ campaign-merged dependents) out of campaign/C
//   sign-off       --campaign C --hunt H --by NAME [--at ISO]         record a Red/compliance sign-off
//   check          --campaign C [--checkpoint]                        release preflight {ok, refusals, hunts}
//   summary        --campaign C [--checkpoint]                        readable release summary (text)
//   deploy         --campaign C --deploy-cmd CMD --migrate-cmd CMD    deploy campaign/C to dev, always back on the prior checkout
//   changelog      --campaign C --version V [--apply] [--at ISO]      stamp included hunts' CHANGELOG lines under one heading
//   merge-commands --campaign C --version V                           print the main merge (+ tag) commands (text)
//   stamp-released --campaign C --version V [--at ISO]                stamp included hunts merged after the main merge
//
// Run tests: node --test scripts/wolfpack-release.test.mjs

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  CHAIN_STATUS, chainClass, needsComplianceHold, renderParkRecord, parkBlock, revertTargets,
  git, repoRoot, branchExists, revParse, isAncestor, findWorktree, dirtyPaths, withTempWorktree,
  unmergedFiles, revertInProgress, readHuntMeta, writeHuntMeta, readCampaignMeta, campaignHunts,
  huntPlanDirs, parseFlags, ChainError,
} from './wolfpack-chain.mjs'

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
    // Chain mode (AC12): a campaign-merged hunt is ready only when no compliance sign-off is
    // owed; the pending-compliance status waits for park.compliance_signed_off === true.
    // Held/reverted chain statuses fall through to excluded.
    else if (status === CHAIN_STATUS.MERGED_PENDING_COMPLIANCE) {
      if (h.park?.compliance_signed_off === true) ready.push(h.slug)
      else awaitingCompliance.push(h.slug)
    } else if (status === CHAIN_STATUS.MERGED) {
      if (needsComplianceHold(h)) awaitingCompliance.push(h.slug)
      else ready.push(h.slug)
    }
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

// ─── Chain-mode campaign release (/release-campaign) ─────────────
// The only route from a chain campaign's `campaign/<slug>` into `main`: check → summary →
// sign-off/revert → deploy → version → changelog → merge-commands (printed; run by the agent
// in its own visible Bash calls, or by the human) → stamp-released. /merge-wave and /merge refuse
// chain campaigns, so AC12's fail-closed sign-off gate has no bypass.

// The hunts a release includes: campaign-merged ones only. Hunts already `merged` (released by
// an earlier --checkpoint) are excluded so their CHANGELOG lines and release stamps are never
// rewritten; unfinished hunts are excluded too (a `check` refusal without --checkpoint).
export function includedHunts(hunts) {
  return (hunts || []).filter(h => chainClass(h && h.status) === 'campaign_merged')
}

// Move every [Unreleased] line ending in `<!-- hunt:<s> -->` for an included slug under ONE
// `## [version] — date` heading (inserted right after [Unreleased]), keeping its `### …`
// group. Returns { text, moved, unattributed } — unattributed = [Unreleased] list items with
// no hunt tag. An empty version (tooling-only) moves nothing.
export function stampChangelog(text, slugs, version, date) {
  const src = String(text || '')
  const lines = src.split('\n')
  const start = lines.findIndex(l => /^## \[Unreleased\]/.test(l))
  if (start === -1) return { text: src, moved: [], unattributed: [] }
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  if (end === -1) end = lines.length
  const want = new Set(slugs || [])
  const TAG = /<!--\s*hunt:([a-z0-9][a-z0-9-]*)\s*-->\s*$/
  const kept = []
  const moved = []
  const unattributed = []
  const groups = new Map()          // group heading ('' = none) → moved lines, in first-seen order
  const groupHadMove = new Set()
  let group = ''
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]
    if (/^### /.test(line)) { group = line.trim(); kept.push(line); continue }
    const m = line.match(TAG)
    if (version && m && want.has(m[1])) {
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(line)
      groupHadMove.add(group)
      moved.push(line)
      continue
    }
    if (!m && /^\s*-\s/.test(line)) unattributed.push(line)
    kept.push(line)
  }
  if (!moved.length) return { text: src, moved, unattributed }
  // Drop a group heading left with no items after its lines moved out.
  const keptClean = []
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i]
    if (/^### /.test(line) && groupHadMove.has(line.trim())) {
      let j = i + 1
      while (j < kept.length && !/^### /.test(kept[j]) && kept[j].trim() === '') j++
      if (j >= kept.length || /^### /.test(kept[j])) continue
    }
    keptClean.push(line)
  }
  while (keptClean.length && keptClean[keptClean.length - 1].trim() === '') keptClean.pop()
  const section = [`## [${version}] — ${date}`, '']
  for (const [g, ls] of groups) {
    if (g) section.push(g)
    section.push(...ls)
  }
  section.push('')
  const out = [...lines.slice(0, start + 1), ...keptClean, '', ...section, ...lines.slice(end)]
  return { text: out.join('\n'), moved, unattributed }
}

const today = (at) => String(at || new Date().toISOString()).slice(0, 10)
const normVersion = (v) => (typeof v === 'string' ? v.trim() : '')

// Every campaign hunt with its authoritative metadata (worktree copy first).
export function loadCampaign(root, campaign) {
  const meta = readCampaignMeta(root, campaign)
  if (!meta || !meta.chain || meta.chain.mode !== 'chain') {
    throw new ChainError(`${campaign} is not a chain campaign (.wolfpack/campaigns/${campaign}/metadata.json has no chain.mode "chain") — use /merge-wave`)
  }
  const slugs = campaignHunts(meta)
  // Fail loud: an empty hunt list would let check/summary/changelog "pass" on nothing.
  if (!slugs.length) throw new ChainError(`${campaign} has no hunts recorded (no chain.graph and no metadata.hunts in .wolfpack/campaigns/${campaign}/metadata.json) — run the campaign with /run-campaign-local ${campaign} --chain first`)
  const hunts = slugs.map(slug => {
    const { meta: m } = readHuntMeta(root, slug)
    return { slug, ...(m || {}), status: m ? m.status : 'missing', __meta: m }
  })
  return { meta, branch: `campaign/${campaign}`, hunts }
}

const SYNC_REMEDY = (c) => `main has commits campaign/${c} lacks — run: node scripts/wolfpack-chain.mjs sync-main --campaign ${c}`

export function releaseCheck(root, { campaign, checkpoint }) {
  const { branch, hunts } = loadCampaign(root, campaign)
  const refusals = []
  if (!branchExists(root, branch)) {
    refusals.push({ code: 'no_campaign_branch', detail: `${branch} does not exist` })
    return { ok: false, refusals, hunts: hunts.map(h => ({ slug: h.slug, status: h.status })) }
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: root }).stdout
  if (dirty) refusals.push({ code: 'dirty_tree', detail: `the main-repo tree has uncommitted changes: ${dirty.split('\n').map(l => l.slice(3)).join(', ')}` })
  if (!isAncestor(root, 'refs/heads/main', `refs/heads/${branch}`)) refusals.push({ code: 'main_not_merged', detail: SYNC_REMEDY(campaign) })
  const included = new Set(includedHunts(hunts).map(h => h.slug))
  // Fail closed: ANY included hunt that still owes a sign-off refuses, whatever its status reads.
  const unsigned = hunts.filter(h => included.has(h.slug) && needsComplianceHold(h.__meta))
  if (unsigned.length) {
    refusals.push({ code: 'unsigned_compliance', detail: `awaiting compliance sign-off: ${unsigned.map(h => h.slug).join(', ')}` })
  }
  const unfinished = hunts.filter(h => !['campaign_merged', 'released'].includes(chainClass(h.status)))
  if (unfinished.length && !checkpoint) {
    refusals.push({ code: 'unfinished', detail: `not campaign-merged: ${unfinished.map(h => `${h.slug}=${h.status}`).join(', ')} (use --checkpoint to release the merged ones only)` })
  }
  return {
    ok: refusals.length === 0,
    refusals,
    hunts: hunts.map(h => ({
      slug: h.slug,
      status: h.status,
      class: chainClass(h.status),
      included: included.has(h.slug),
      bump: (h.proposed_version && h.proposed_version.bump) || null,
      needsSignOff: included.has(h.slug) && needsComplianceHold(h.__meta),
      signedOff: !!(h.park && h.park.compliance_signed_off === true),
    })),
  }
}

function complianceSummaryText(root, slug, meta) {
  const d = huntPlanDirs(root, slug)
  const candidates = [
    meta && meta.compliance_hold && meta.compliance_hold.summary,
    d.worktreePlanDir && join(d.worktreePlanDir, 'compliance-summary.md'),
    join(d.mainPlanDir, 'compliance-summary.md'),
  ].filter(Boolean)
  const p = candidates.find(f => existsSync(f))
  if (!p) return null
  return readFileSync(p, 'utf8').split('\n').slice(0, 40).join('\n')
}

export function releaseSummary(root, { campaign, checkpoint }) {
  const chk = releaseCheck(root, { campaign, checkpoint })
  const { branch, hunts } = loadCampaign(root, campaign)
  const sha = branchExists(root, branch) ? revParse(root, `refs/heads/${branch}`).slice(0, 12) : '(missing)'
  const out = []
  out.push(`Campaign ${campaign} — chain release summary (${branch} @ ${sha})${checkpoint ? ' [--checkpoint]' : ''}`)
  out.push(chk.ok ? 'Preflight: ok' : `Preflight: ${chk.refusals.map(r => `${r.code} (${r.detail})`).join('; ')}`)
  out.push('')
  out.push('Hunts:')
  for (const h of chk.hunts) {
    const mark = h.included && !h.needsSignOff ? '✅' : (h.class === 'released' ? '✔' : '⛔')
    out.push(`  ${mark} ${h.slug}  ${h.status}  (bump: ${h.bump || 'none'})${h.class === 'released' ? '  [released earlier]' : ''}`)
  }
  const pending = chk.hunts.filter(h => h.needsSignOff)
  if (pending.length) {
    out.push('')
    out.push('Awaiting compliance sign-off (DEA: CS records ≥2yr, exact unit flow · NM: records ≥4yr, no hard-delete · PCI: SAQ A-EP):')
    for (const h of pending) {
      const meta = hunts.find(x => x.slug === h.slug).__meta
      out.push(`  ⏸ ${h.slug}`)
      const text = complianceSummaryText(root, h.slug, meta)
      out.push(text ? text.split('\n').map(l => `     ${l}`).join('\n') : '     (compliance-summary.md not found — review the diff before signing)')
      out.push(`     → sign off: node scripts/wolfpack-release.mjs sign-off --campaign ${campaign} --hunt ${h.slug} --by "<name>"`)
      out.push(`     → reject:   node scripts/wolfpack-release.mjs revert --campaign ${campaign} --hunt ${h.slug} --reason "<why>"`)
    }
  }
  const list = (title, pred) => {
    const xs = hunts.filter(pred)
    if (!xs.length) return
    out.push('')
    out.push(`${title}:`)
    for (const h of xs) {
      const extra = h.held_on ? ` held on ${(h.held_on || []).map(x => x.slug || x).join(', ')}` : (h.reverted_because ? ` (with ${h.reverted_because})` : '')
      out.push(`  - ${h.slug}  ${h.status}${extra}`)
    }
  }
  list('Held (certified, unmerged — overlaps a blocked hunt)', h => h.status === CHAIN_STATUS.HELD_OVERLAP || (h.held_on && h.held_on.length && chainClass(h.status) === 'awaiting_merge'))
  list('Reverted', h => h.status === CHAIN_STATUS.REVERTED || h.status === CHAIN_STATUS.REVERTED_WITH_DEP)
  list('Blocked (needs a human)', h => chainClass(h.status) === 'blocked' && h.status !== CHAIN_STATUS.REVERTED)
  list('Not finished', h => ['pending', 'quota'].includes(chainClass(h.status)) || (chainClass(h.status) === 'awaiting_merge' && !(h.held_on && h.held_on.length) && h.status !== CHAIN_STATUS.HELD_OVERLAP))
  return out.join('\n')
}

export function cmdSignOff(root, { campaign, hunt, by, at }) {
  if (!by || by === true) throw new ChainError('--by NAME is required (who signed off)')
  const { hunts } = loadCampaign(root, campaign)
  const h = hunts.find(x => x.slug === hunt)
  if (!h || !h.__meta) throw new ChainError(`${hunt} is not a hunt of campaign ${campaign}`)
  if (chainClass(h.status) !== 'campaign_merged') throw new ChainError(`${hunt} is ${h.status} — only a campaign-merged hunt can be signed off`)
  if (!(h.status === CHAIN_STATUS.MERGED_PENDING_COMPLIANCE || needsComplianceHold(h.__meta))) {
    throw new ChainError(`${hunt} owes no compliance sign-off (status ${h.status}, no compliance_hold / spec flag)`)
  }
  const when = at || new Date().toISOString()
  writeHuntMeta(root, hunt, (meta) => {
    meta.park = { ...(meta.park || {}), compliance_signed_off: true, signed_off_by: String(by), signed_off_at: when }
  })
  return { status: 'signed_off', hunt, signed_off_by: String(by), signed_off_at: when }
}

// AC10 + A-11: revert H and every campaign-merged dependent (newest first) out of campaign/C,
// then rebuild feat/H as (new campaign tip + one reapply commit) so the fix cycle re-reviews and
// re-merges the FULL change. Preconditions first; any failure rolls everything back, stamps nothing.
export function cmdRevert(root, { campaign, hunt, reason, at }) {
  const { meta: camp, branch, hunts } = loadCampaign(root, campaign)
  if (!branchExists(root, branch)) throw new ChainError(`${branch} does not exist`)
  const graph = (camp.chain && camp.chain.graph) || {}
  const bySlug = Object.fromEntries(hunts.map(h => [h.slug, h]))
  const H = bySlug[hunt]
  if (!H || !H.__meta) throw new ChainError(`${hunt} is not a hunt of campaign ${campaign}`)
  if (chainClass(H.status) !== 'campaign_merged') throw new ChainError(`${hunt} is ${H.status} — only a campaign-merged hunt can be reverted from ${branch}`)
  const statuses = Object.fromEntries(hunts.map(h => [h.slug, h.status]))
  const firstParent = git(['rev-list', '--first-parent', `refs/heads/${branch}`], { cwd: root }).stdout.split('\n').filter(Boolean)
  const mergeOrder = hunts
    .filter(h => h.campaign_merge_commit && firstParent.includes(h.campaign_merge_commit))
    .sort((a, b) => firstParent.indexOf(a.campaign_merge_commit) - firstParent.indexOf(b.campaign_merge_commit))
    .map(h => h.slug)
  const targets = revertTargets(hunt, statuses, graph, mergeOrder)
  for (const t of targets) {
    if (!bySlug[t].campaign_merge_commit) throw new ChainError(`${t} is ${bySlug[t].status} but has no campaign_merge_commit`)
  }
  const wt = findWorktree(root, hunt)
  if (!wt) throw new ChainError(`no worktree has feat/${hunt} checked out — cannot rebuild it after the revert`)
  const dirty = dirtyPaths(wt)
  if (dirty.length) throw new ChainError(`${hunt}'s worktree has uncommitted changes outside .wolfpack/: ${dirty.join(', ')}`)
  const preSha = revParse(root, `refs/heads/${branch}`)
  const preTip = revParse(root, `refs/heads/feat/${hunt}`)
  const preRef = `refs/wolfpack/pre-revert/${hunt}`
  const priorRef = git(['rev-parse', '--verify', '--quiet', preRef], { cwd: root, allowFail: true })
  const r = withTempWorktree(root, branch, (dir) => {
    const reverts = {}
    try {
      for (const t of targets) {
        const rv = git(['revert', '--no-edit', '-m', '1', bySlug[t].campaign_merge_commit], { cwd: dir, allowFail: true })
        if (rv.code !== 0) {
          const files = unmergedFiles(dir)
          throw new ChainError(`git revert of ${t}'s merge conflicted${files.length ? ` (${files.join(', ')})` : `: ${rv.stderr.split('\n')[0]}`} — nothing reverted`)
        }
        reverts[t] = revParse(dir, 'HEAD')
      }
      const newTip = revParse(dir, 'HEAD')
      git(['checkout', '--quiet', '--detach', newTip], { cwd: wt })
      const re = git(['revert', '--no-edit', reverts[hunt]], { cwd: wt, allowFail: true })
      if (re.code !== 0) throw new ChainError(`rebuilding feat/${hunt} (reapply commit) failed: ${re.stderr.split('\n')[0]}`)
      git(['update-ref', preRef, preTip], { cwd: root })
      if (process.env.WOLFPACK_CHAIN_FAULT === 'rebuild') throw new ChainError('WOLFPACK_CHAIN_FAULT=rebuild (test-only fault before branch -f)')
      git(['branch', '-f', `feat/${hunt}`, 'HEAD'], { cwd: wt })
      git(['checkout', '--quiet', `feat/${hunt}`], { cwd: wt })
      return { reverts, newTip, rebuilt: revParse(wt, 'HEAD') }
    } catch (e) {
      if (revertInProgress(dir)) git(['revert', '--abort'], { cwd: dir, allowFail: true })
      git(['reset', '--hard', '--quiet', preSha], { cwd: dir, allowFail: true })
      if (revertInProgress(wt)) git(['revert', '--abort'], { cwd: wt, allowFail: true })
      git(['checkout', '--quiet', '--force', `feat/${hunt}`], { cwd: wt, allowFail: true })
      if (priorRef.code === 0) git(['update-ref', preRef, priorRef.stdout], { cwd: root, allowFail: true })
      else git(['update-ref', '-d', preRef], { cwd: root, allowFail: true })
      throw e
    }
  })
  const now = at || new Date().toISOString()
  const why = (typeof reason === 'string' && reason.trim()) ? reason.trim() : '(no reason given)'
  writeHuntMeta(root, hunt, (meta) => {
    meta.status = CHAIN_STATUS.REVERTED
    // A FRESH park block: a prior compliance sign-off must not survive the revert.
    meta.park = parkBlock({ reason: 'reverted_from_campaign', parkedAt: now, resumePhase: 'Implement', resolutionType: 'clarify', tier: meta.tier })
    meta.campaign_revert_commit = r.reverts[hunt]
    meta.reverted_reason = why
    meta.reverted_at = now
  }, {
    'parked.md': renderParkRecord({
      slug: hunt, reason: 'reverted_from_campaign', parkedAt: now, resumePhase: 'Implement', resolutionType: 'clarify',
      tier: H.tier,
      need: `${hunt} was reverted out of ${branch}: ${why}. feat/${hunt} was rebuilt as the campaign tip + one reapply commit, so the fix cycle reviews and re-merges the full change. Answer with the fix direction (clarify) or send it back to planning (redirect).`,
      context: `Revert commit(s) on ${branch}: ${targets.map(t => `${t}=${r.reverts[t]}`).join(', ')}\nOld feat/${hunt} tip saved at ${preRef}\nDependents reverted with it (auto re-merge once ${hunt} is campaign-merged again): ${targets.filter(t => t !== hunt).join(', ') || 'none'}`,
      options: `- A (clarify): here is the fix — resume at Implement.\n- B (redirect): re-plan the hunt.`,
    }),
  })
  for (const t of targets.filter(x => x !== hunt)) {
    writeHuntMeta(root, t, (meta) => {
      meta.status = CHAIN_STATUS.REVERTED_WITH_DEP
      meta.reverted_because = hunt
      meta.campaign_revert_commit = r.reverts[t]
      meta.reverted_at = now
    })
  }
  return {
    status: 'reverted', branch, campaign_sha: r.newTip,
    reverted: targets.map(t => ({ slug: t, revert_commit: r.reverts[t] })),
    rebuilt: { branch: `feat/${hunt}`, sha: r.rebuilt, pre_revert_ref: preRef },
  }
}

export function cmdDeploy(root, { campaign, deployCmd, migrateCmd }) {
  if (typeof deployCmd !== 'string' || !deployCmd.trim() || typeof migrateCmd !== 'string' || !migrateCmd.trim()) {
    throw new ChainError('--deploy-cmd and --migrate-cmd are both required')
  }
  if (/prod/i.test(deployCmd) || /prod/i.test(migrateCmd)) throw new ChainError('refusing: a deploy/migrate command mentions prod — this command deploys dev only')
  const { branch } = loadCampaign(root, campaign)
  if (!branchExists(root, branch)) throw new ChainError(`${branch} does not exist`)
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { cwd: root }).stdout
  if (dirty) throw new ChainError(`refusing: the main-repo tree has uncommitted changes (${dirty.split('\n').map(l => l.slice(3)).join(', ')})`)
  // Restore whatever the operator had checked out (a branch by name, else the detached SHA).
  const sym = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, allowFail: true })
  const original = sym.code === 0 && sym.stdout.trim() ? sym.stdout.trim() : revParse(root, 'HEAD')
  git(['checkout', '--quiet', '--detach', `refs/heads/${branch}`], { cwd: root })
  // The commands' own stdout goes to stderr so this CLI's stdout stays one parseable JSON object.
  const run = (cmd) => {
    const p = spawnSync('bash', ['-c', cmd], { cwd: root, stdio: ['inherit', 2, 2] })
    return p.status == null ? -1 : p.status
  }
  let deployExit = null
  let migrateExit = null
  let restored = false
  try {
    deployExit = run(deployCmd)
    if (deployExit === 0) migrateExit = run(migrateCmd)
  } finally {
    restored = git(['checkout', '--quiet', original], { cwd: root, allowFail: true }).code === 0
  }
  return { deployExit, migrateExit, restored, restored_to: original, branch }
}

export function cmdChangelog(root, { campaign, version, apply, at }) {
  const { branch, hunts } = loadCampaign(root, campaign)
  if (!branchExists(root, branch)) throw new ChainError(`${branch} does not exist`)
  const V = normVersion(version)
  const slugs = includedHunts(hunts).map(h => h.slug)
  const show = git(['show', `refs/heads/${branch}:CHANGELOG.md`], { cwd: root, allowFail: true })
  if (show.code !== 0) throw new ChainError(`${branch} has no CHANGELOG.md`)
  const raw = spawnSync('git', ['show', `refs/heads/${branch}:CHANGELOG.md`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout
  const res = stampChangelog(raw, slugs, V, today(at))
  let committed = null
  if (apply === true && res.moved.length) {
    committed = withTempWorktree(root, branch, (dir) => {
      writeFileSync(join(dir, 'CHANGELOG.md'), res.text)
      git(['add', '--', 'CHANGELOG.md'], { cwd: dir })
      git(['commit', '--quiet', '-m', `docs(changelog): stamp ${V} for campaign ${campaign}`], { cwd: dir })
      return revParse(dir, 'HEAD')
    })
  }
  return { version: V || null, hunts: slugs, moved: res.moved.length, unattributed: res.unattributed, committed }
}

export function cmdMergeCommands(root, { campaign, version }) {
  const chk = releaseCheck(root, { campaign, checkpoint: true })
  const unsigned = chk.refusals.find(r => r.code === 'unsigned_compliance')
  if (unsigned) throw new ChainError(`unsigned_compliance: ${unsigned.detail} — sign off (or revert) first; no code path merges campaign/${campaign} into main while one is unsigned`)
  const notMerged = chk.refusals.find(r => r.code === 'main_not_merged' || r.code === 'no_campaign_branch')
  if (notMerged) throw new ChainError(`${notMerged.code}: ${notMerged.detail}`)
  const V = normVersion(version)
  const slugs = chk.hunts.filter(h => h.included).map(h => h.slug)
  const lines = [`git merge --no-ff campaign/${campaign} -m "Merge branch 'campaign/${campaign}'"`]
  if (V) lines.push(`git tag -a ${V} -m "${V} — campaign ${campaign}: ${slugs.join(', ')}"`)
  return lines
}

export function cmdStampReleased(root, { campaign, version, at }) {
  const { branch, hunts } = loadCampaign(root, campaign)
  if (!branchExists(root, branch)) throw new ChainError(`${branch} does not exist`)
  const tip = revParse(root, `refs/heads/${branch}`)
  if (!isAncestor(root, tip, 'refs/heads/main')) throw new ChainError(`${branch} is not merged into main yet — run the merge-commands first`)
  // The --no-ff merge on main's first-parent line whose second parent contains the campaign tip.
  let releaseMerge = null
  const merges = git(['rev-list', '--first-parent', '--merges', '--parents', '-n', '500', 'refs/heads/main'], { cwd: root }).stdout.split('\n').filter(Boolean)
  for (const row of merges) {
    const [sha, , second] = row.split(' ')
    if (second && isAncestor(root, tip, second)) { releaseMerge = sha; break }
  }
  if (!releaseMerge) throw new ChainError(`could not find the --no-ff merge of ${branch} on main's first-parent history (fast-forwarded?)`)
  const V = normVersion(version)
  const now = at || new Date().toISOString()
  const included = includedHunts(hunts)
  for (const h of included) {
    writeHuntMeta(root, h.slug, (meta) => {
      meta.status = 'merged'
      meta.merge_commit = meta.campaign_merge_commit || null
      meta.release_merge_commit = releaseMerge
      meta.released_version = V || null
      meta.merged_at = now
    })
  }
  return {
    status: 'stamped', hunts: included.map(h => h.slug), release_merge_commit: releaseMerge, released_version: V || null,
    push: ['git push origin main', ...(V ? [`git push origin ${V}`] : [])],
  }
}

function chainMain(cmd, rest) {
  const f = parseFlags(rest)
  const emit = (obj, code = 0) => { console.log(JSON.stringify(obj, null, 2)); return code }
  const SLUG = /^[a-z0-9][a-z0-9-]*$/
  try {
    if (!SLUG.test(String(f.campaign || ''))) throw new ChainError('--campaign <slug> is required')
    if (['revert', 'sign-off'].includes(cmd) && !SLUG.test(String(f.hunt || ''))) throw new ChainError('--hunt <slug> is required')
    const root = repoRoot()
    const checkpoint = f.checkpoint === true
    const version = f.version === true ? '' : f.version
    if (cmd === 'revert') return emit(cmdRevert(root, { campaign: f.campaign, hunt: f.hunt, reason: f.reason, at: f.at }))
    if (cmd === 'sign-off') return emit(cmdSignOff(root, { campaign: f.campaign, hunt: f.hunt, by: f.by, at: f.at }))
    if (cmd === 'check') { const r = releaseCheck(root, { campaign: f.campaign, checkpoint }); return emit(r, r.ok ? 0 : 2) }
    if (cmd === 'summary') { console.log(releaseSummary(root, { campaign: f.campaign, checkpoint })); return 0 }
    if (cmd === 'deploy') {
      const r = cmdDeploy(root, { campaign: f.campaign, deployCmd: f['deploy-cmd'], migrateCmd: f['migrate-cmd'] })
      return emit(r, (r.restored && r.deployExit === 0 && r.migrateExit === 0) ? 0 : 1)
    }
    if (cmd === 'changelog') return emit(cmdChangelog(root, { campaign: f.campaign, version, apply: f.apply === true, at: f.at }))
    if (cmd === 'merge-commands') { console.log(cmdMergeCommands(root, { campaign: f.campaign, version }).join('\n')); return 0 }
    if (cmd === 'stamp-released') return emit(cmdStampReleased(root, { campaign: f.campaign, version, at: f.at }))
  } catch (e) {
    const code = /^(unsigned_compliance|main_not_merged|no_campaign_branch):/.exec(e.message)
    return emit({ status: 'error', ...(code ? { code: code[1] } : {}), reason: e.message }, 2)
  }
  return null
}
const CHAIN_COMMANDS = ['revert', 'sign-off', 'check', 'summary', 'deploy', 'changelog', 'merge-commands', 'stamp-released']

// ─── CLI ──────────────────────────────────────────────────────────
function main(argv) {
  const [cmd, ...rest] = argv
  if (CHAIN_COMMANDS.includes(cmd)) return chainMain(cmd, rest)
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
  console.error(`usage: wolfpack-release.mjs <version|criteria|${CHAIN_COMMANDS.join('|')}> ...`)
  return 1
}

// Only run when invoked directly, not when imported by the test module.
if (process.argv[1] && process.argv[1].endsWith('wolfpack-release.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
