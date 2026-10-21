#!/usr/bin/env node
// scripts/wolfpack-release.test.mjs — unit tests for the [04] release helper.
// Run: node --test scripts/wolfpack-release.test.mjs
//
// Mirrors the prior-layer methodology (drive the real pure fns through
// scenarios). Covers: bump aggregation precedence + tooling-only, version math
// across major/minor/patch + prefix preservation + parse failure, release-queue
// classification (AC4 compliance exclusion), and acceptance-criteria parsing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  aggregateBump,
  nextVersion,
  releaseQueue,
  parseAcceptanceCriteria,
} from './wolfpack-release.mjs'

// ── aggregateBump ────────────────────────────────────────────────
test('aggregateBump: minor beats patch', () => {
  assert.equal(aggregateBump(['patch', 'minor', 'patch']), 'minor')
})

test('aggregateBump: major wins (ranked, surfaces loudly)', () => {
  assert.equal(aggregateBump(['minor', 'major', 'patch']), 'major')
})

test('aggregateBump: tooling-only contributes nothing → null', () => {
  assert.equal(aggregateBump([null, '', undefined]), null)
  assert.equal(aggregateBump([]), null)
})

test('aggregateBump: tooling-only mixed with patch → patch', () => {
  assert.equal(aggregateBump([null, 'patch', '']), 'patch')
})

test('aggregateBump: case-insensitive', () => {
  assert.equal(aggregateBump(['PATCH', 'Minor']), 'minor')
})

// ── nextVersion ──────────────────────────────────────────────────
test('nextVersion: patch bump', () => {
  assert.equal(nextVersion('v0.24.5', 'patch'), 'v0.24.6')
})

test('nextVersion: minor bump zeroes patch', () => {
  assert.equal(nextVersion('v0.24.5', 'minor'), 'v0.25.0')
})

test('nextVersion: major bump zeroes minor + patch', () => {
  assert.equal(nextVersion('v0.24.5', 'major'), 'v1.0.0')
})

test('nextVersion: preserves missing v prefix', () => {
  assert.equal(nextVersion('0.24.5', 'patch'), '0.24.6')
})

test('nextVersion: tolerates trailing describe suffix', () => {
  assert.equal(nextVersion('v0.24.5-3-gabc123', 'patch'), 'v0.24.6')
})

test('nextVersion: null bump → null (tooling-only wave)', () => {
  assert.equal(nextVersion('v0.24.5', null), null)
})

test('nextVersion: unparseable tag throws', () => {
  assert.throws(() => nextVersion('garbage', 'patch'), /cannot parse/)
})

// ── releaseQueue ─────────────────────────────────────────────────
test('releaseQueue: certified hunts are ready', () => {
  const q = releaseQueue([
    { slug: 'a', verdict: 'CERTIFIED_AWAITING_DEPLOY' },
    { slug: 'b', status: 'certified' },
  ])
  assert.deepEqual(q.ready, ['a', 'b'])
  assert.deepEqual(q.awaitingCompliance, [])
})

test('releaseQueue: AC4 — compliance_review park is excluded from ready', () => {
  const q = releaseQueue([
    { slug: 'a', verdict: 'CERTIFIED_AWAITING_DEPLOY' },
    { slug: 'cs-fix', verdict: 'PARKED', status: 'parked:compliance_review' },
  ])
  assert.deepEqual(q.ready, ['a'])
  assert.deepEqual(q.awaitingCompliance, ['cs-fix'])
})

test('releaseQueue: compliance flagged via reason field too', () => {
  const q = releaseQueue([
    { slug: 'cs-fix', verdict: 'PARKED', reason: 'compliance_review' },
  ])
  assert.deepEqual(q.awaitingCompliance, ['cs-fix'])
})

test('releaseQueue: failed/other hunts excluded, not released', () => {
  const q = releaseQueue([
    { slug: 'a', verdict: 'CERTIFIED_AWAITING_DEPLOY' },
    { slug: 'broke', verdict: 'WAVE_FAILED' },
    { slug: 'park', verdict: 'PARKED', status: 'parked:open_critical' },
  ])
  assert.deepEqual(q.ready, ['a'])
  assert.deepEqual(q.excluded.sort(), ['broke', 'park'])
})

// ── parseAcceptanceCriteria ──────────────────────────────────────
const SAMPLE = `# Acceptance — invoice-bundle

## Acceptance criteria (the contract)
- AC1 [auto] When a bundle is selected, the default line items apply.
- AC2 [auto] Tax rounds to cents on the invoice total.
- AC3 [manual] The invoice PDF layout looks right.
- AC4 [compliance] The CS record retains the disposition field per DEA 2yr.

## Out of scope
- Do not touch the scheduler.
`

test('parseAcceptanceCriteria: extracts id, tag, text, ref', () => {
  const c = parseAcceptanceCriteria(SAMPLE, 'invoice-bundle')
  assert.equal(c.length, 4)
  assert.deepEqual(c[0], {
    slug: 'invoice-bundle',
    id: 'AC1',
    tag: 'auto',
    text: 'When a bundle is selected, the default line items apply.',
    ref: 'invoice-bundle/1',
  })
  assert.equal(c[3].tag, 'compliance')
  assert.equal(c[3].ref, 'invoice-bundle/4')
})

test('parseAcceptanceCriteria: ignores out-of-scope bullets and prose', () => {
  const c = parseAcceptanceCriteria(SAMPLE, 'invoice-bundle')
  assert.ok(c.every((x) => x.id.startsWith('AC')))
  assert.ok(!c.some((x) => /scheduler/.test(x.text)))
})

test('parseAcceptanceCriteria: empty/garbage input → []', () => {
  assert.deepEqual(parseAcceptanceCriteria('', 'x'), [])
  assert.deepEqual(parseAcceptanceCriteria(null, 'x'), [])
})

test('parseAcceptanceCriteria: tolerates leading indentation', () => {
  const c = parseAcceptanceCriteria('   - AC1 [auto] Indented criterion holds.', 'x')
  assert.equal(c.length, 1)
  assert.equal(c[0].id, 'AC1')
})

// ── CLI ──────────────────────────────────────────────────────────
const SCRIPT = new URL('./wolfpack-release.mjs', import.meta.url).pathname

test('CLI version: aggregates + computes next', () => {
  const out = execFileSync('node', [SCRIPT, 'version', 'v0.24.5', 'patch', 'minor'], {
    encoding: 'utf8',
  })
  assert.match(out, /BUMP=minor/)
  assert.match(out, /VERSION=v0\.25\.0/)
})

test('CLI version: tooling-only wave → none/empty', () => {
  const out = execFileSync('node', [SCRIPT, 'version', 'v0.24.5'], { encoding: 'utf8' })
  assert.match(out, /BUMP=none/)
  assert.match(out, /VERSION=\s*$/m)
})

test('CLI criteria: reads file and prints JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-rel-'))
  try {
    const p = join(dir, 'acceptance.md')
    writeFileSync(p, SAMPLE)
    const out = execFileSync('node', [SCRIPT, 'criteria', p, 'invoice-bundle'], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(out)
    assert.equal(parsed.length, 4)
    assert.equal(parsed[0].ref, 'invoice-bundle/1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// Chain-mode campaign release (campaign-chain-mode): releaseQueue chain branches,
// includedHunts / stampChangelog (pure), and revert / sign-off / check / summary /
// deploy / changelog / merge-commands / stamp-released against REAL git in a throwaway
// repo (git init -b main, isolated config, no network).
// ════════════════════════════════════════════════════════════════════════════
import * as nfs from 'node:fs'
import { dirname as pdirname } from 'node:path'
import { spawnSync as pspawn } from 'node:child_process'
import { fileURLToPath as toPath } from 'node:url'
import { after as afterAll } from 'node:test'
import {
  includedHunts, stampChangelog, loadCampaign, releaseCheck, releaseSummary, cmdSignOff, cmdRevert,
  cmdDeploy, cmdChangelog, cmdMergeCommands, cmdStampReleased,
} from './wolfpack-release.mjs'
import { CHAIN_STATUS as CS, cmdInit as chainInit, cmdMergeHunt as chainMerge, cmdSyncMain as chainSyncMain } from './wolfpack-chain.mjs'

const RCLI = join(pdirname(toPath(import.meta.url)), 'wolfpack-release.mjs')
const RCFG = nfs.mkdtempSync(join(tmpdir(), 'wprel-cfg-'))
nfs.writeFileSync(join(RCFG, 'gitconfig'), '')
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(RCFG, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Release Test', GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
  GIT_COMMITTER_NAME: 'Release Test', GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
})
const RROOTS = [RCFG]
afterAll(() => { for (const r of RROOTS) rmSync(r, { recursive: true, force: true }) })

const rg = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const rgOk = (cwd, ...a) => pspawn('git', a, { cwd, encoding: 'utf8' }).status === 0
const rsha = (cwd, ref) => rg(cwd, 'rev-parse', ref)
const rput = (dir, rel, text) => { nfs.mkdirSync(pdirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text) }
const rreadJ = (p) => JSON.parse(nfs.readFileSync(p, 'utf8'))
function rcommit(dir, files, msg) {
  for (const [rel, text] of Object.entries(files)) rput(dir, rel, text)
  rg(dir, 'add', '--', ...Object.keys(files))
  rg(dir, 'commit', '-q', '-m', msg)
  return rsha(dir, 'HEAD')
}
const RAT = '2026-10-17T00:00:00.000Z'
const R_CL_HEAD = '# Changelog\n\n## [Unreleased]\n\n### Tooling\n- base entry\n'
const R_CL_TAIL = '\n## [v0.1.0] — 2026-01-01\n- old\n'
const rcl = (...lines) => R_CL_HEAD + lines.map(l => `${l}\n`).join('') + R_CL_TAIL
const PRODWORD = 'pr' + 'od'   // assembled so no literal production command sits in this file

// A repo on main (optionally tagged v0.1.0) with campaign/c initialised over `graph`.
function rRepo({ graph, changelog = rcl(), tag = false } = {}) {
  const root = nfs.realpathSync(nfs.mkdtempSync(join(tmpdir(), 'wprel-repo-')))
  RROOTS.push(root)
  rg(root, 'init', '-q', '-b', 'main')
  rcommit(root, { '.gitignore': '.wolfpack/plans/\n.wolfpack/campaigns/\n.wt/\n', 'app.txt': 'l1\nl2\nl3\n', 'CHANGELOG.md': changelog }, 'initial')
  if (tag) rg(root, 'tag', 'v0.1.0')
  chainInit(root, { campaign: 'c', graph, at: RAT })
  return root
}
const rWtPlan = (root, s) => join(root, '.wt', s, '.wolfpack', 'plans', s)
const rMainPlan = (root, s) => join(root, '.wolfpack', 'plans', s)
function rMeta(root, slug, meta, { wt = true, main = false } = {}) {
  for (const d of [...(wt ? [rWtPlan(root, slug)] : []), ...(main ? [rMainPlan(root, slug)] : [])]) {
    nfs.mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n')
  }
}
const rGetMeta = (root, slug) => rreadJ(join(rMainPlan(root, slug), 'metadata.json'))
// A hunt forked from the CURRENT campaign tip, committed, certified, and merged into campaign/c.
function rHunt(root, slug, { edits, meta = {}, merge = true } = {}) {
  const wt = join(root, '.wt', slug)
  rg(root, 'worktree', 'add', '-q', wt, '-b', `feat/${slug}`, 'campaign/c')
  rcommit(wt, edits || { [`${slug}.txt`]: `${slug}\n` }, `feat(${slug})`)
  rMeta(root, slug, { feature: slug, status: 'certified', tier: 'Yellow', proposed_version: { bump: null }, ...meta })
  if (merge) {
    const r = chainMerge(root, { campaign: 'c', hunt: slug, at: RAT })
    assert.equal(r.status, 'merged', `${slug}: ${JSON.stringify(r)}`)
  }
  return wt
}
const rCli = (root, env, ...a) => {
  const r = pspawn(process.execPath, [RCLI, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* text output */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}
const rExists = (root, ref, path) => rgOk(root, 'cat-file', '-e', `${ref}:${path}`)
const bash = (root, line) => {
  const r = pspawn('bash', ['-c', line], { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, `${line}\n${r.stderr}`)
}

// ── 32. AC12 releaseQueue chain branches ─────────────────────────
test('releaseQueue (AC12): chain statuses — pending-compliance waits for sign-off; held/reverted are excluded', () => {
  const q = releaseQueue([
    { slug: 'p', status: CS.MERGED_PENDING_COMPLIANCE },
    { slug: 'ps', status: CS.MERGED_PENDING_COMPLIANCE, park: { compliance_signed_off: true } },
    { slug: 'm', status: CS.MERGED },
    { slug: 'mh', status: CS.MERGED, compliance_hold: { reason: 'billing' } },
    { slug: 'mhs', status: CS.MERGED, compliance_hold: { reason: 'billing' }, park: { compliance_signed_off: true } },
    { slug: 'ms', status: CS.MERGED, spec: { compliance_review_required: true } },
    { slug: 'held', status: CS.HELD_OVERLAP },
    { slug: 'cpc', status: CS.CERTIFIED_PENDING_COMPLIANCE },
    { slug: 'conf', status: CS.MERGE_CONFLICT },
    { slug: 'rev', status: CS.REVERTED },
    { slug: 'revd', status: CS.REVERTED_WITH_DEP },
  ])
  assert.deepEqual(q.ready, ['ps', 'm', 'mhs'])
  assert.deepEqual(q.awaitingCompliance, ['p', 'mh', 'ms'])
  assert.deepEqual(q.excluded, ['held', 'cpc', 'conf', 'rev', 'revd'])
  // the barrier classification is unchanged next to them
  const b = releaseQueue([{ slug: 'x', status: 'certified' }, { slug: 'y', status: 'parked:compliance_review' }, { slug: 'z', status: 'merged' }])
  assert.deepEqual(b, { ready: ['x'], awaitingCompliance: ['y'], excluded: ['z'] })
})

// ── includedHunts / stampChangelog (pure) ────────────────────────
test('includedHunts: campaign-merged only (released, unfinished, held, reverted excluded)', () => {
  const hs = ['merged', CS.MERGED, CS.MERGED_PENDING_COMPLIANCE, 'certified', CS.HELD_OVERLAP, CS.MERGE_CONFLICT, CS.REVERTED,
    CS.REVERTED_WITH_DEP, 'parked:model_quota', 'ready_for_alpha', 'missing'].map((status, i) => ({ slug: `s${i}`, status }))
  assert.deepEqual(includedHunts(hs).map(h => h.status), [CS.MERGED, CS.MERGED_PENDING_COMPLIANCE])
  assert.deepEqual(includedHunts(undefined), [])
  assert.deepEqual(includedHunts([null]), [])
})

const STAMP_SRC = [
  '# Changelog', '', '## [Unreleased]', '', '### Added', '- a1 <!-- hunt:a -->', '- untagged item', '',
  '### Tooling', '- t1 <!-- hunt:t -->', '- other <!-- hunt:other -->', '', '## [v0.1.0] — 2026-01-01', '- old <!-- hunt:a -->', '',
].join('\n')
test('stampChangelog: moves included lines under ONE heading, keeps their group, drops emptied groups, warns on unattributed', () => {
  const r = stampChangelog(STAMP_SRC, ['a', 't'], 'v0.1.1', '2026-10-17')
  assert.deepEqual(r.moved, ['- a1 <!-- hunt:a -->', '- t1 <!-- hunt:t -->'])
  assert.deepEqual(r.unattributed, ['- untagged item'])
  assert.equal(r.text.match(/^## \[v0\.1\.1\] — 2026-10-17$/gm).length, 1)
  const [unrel, rest] = r.text.split('## [v0.1.1] — 2026-10-17')
  assert.match(unrel, /### Added\n- untagged item/)
  assert.match(unrel, /### Tooling\n- other <!-- hunt:other -->/)
  assert.doesNotMatch(unrel, /hunt:a -->|hunt:t -->/)
  const [newSec, older] = rest.split('## [v0.1.0]')
  assert.match(newSec, /### Added\n- a1 <!-- hunt:a -->/)
  assert.match(newSec, /### Tooling\n- t1 <!-- hunt:t -->/)
  assert.match(older, /- old <!-- hunt:a -->/, 'an older release section is never touched')
  // a group whose ONLY items moved is dropped from [Unreleased]
  const r2 = stampChangelog(STAMP_SRC, ['a', 't', 'other'], 'v0.2.0', '2026-10-17')
  assert.doesNotMatch(r2.text.split('## [v0.2.0]')[0], /### Tooling/)
})
test('stampChangelog: an empty version (tooling-only) moves nothing; no [Unreleased] → unchanged', () => {
  const r = stampChangelog(STAMP_SRC, ['a', 't'], '', '2026-10-17')
  assert.equal(r.text, STAMP_SRC)
  assert.deepEqual(r.moved, [])
  assert.deepEqual(r.unattributed, ['- untagged item'])
  assert.deepEqual(stampChangelog('# x\n- y\n', ['a'], 'v1.0.0', 'd'), { text: '# x\n- y\n', moved: [], unattributed: [] })
})

// ── loadCampaign ─────────────────────────────────────────────────
test('loadCampaign: refuses a non-chain campaign and (Pointer r1 F8) a chain campaign with no hunts recorded', () => {
  const root = rRepo({ graph: {} })
  assert.throws(() => loadCampaign(root, 'c'), /has no hunts recorded/)
  assert.throws(() => loadCampaign(root, 'nochain'), /is not a chain campaign .* use \/merge-wave/)
  const p = join(root, '.wolfpack', 'campaigns', 'c', 'metadata.json')
  writeFileSync(p, JSON.stringify({ campaign: 'c', hunts: ['a', 'b'], chain: { mode: 'chain', branch: 'campaign/c' } }))
  const { hunts } = loadCampaign(root, 'c')
  assert.deepEqual(hunts.map(h => [h.slug, h.status]), [['a', 'missing'], ['b', 'missing']], 'unscaffolded hunts read as missing (unfinished), never as done')
})

// ── 33. AC12 sign-off gate (temp repo) ───────────────────────────
test('AC12: merge-commands refuses (exit 2, unsigned_compliance) while a pending-compliance hunt is unsigned; sign-off records who/when', () => {
  const root = rRepo({ graph: { red: { dependsOn: [] }, plain: { dependsOn: [] } } })
  rHunt(root, 'red', { meta: { status: CS.CERTIFIED_PENDING_COMPLIANCE, compliance_hold: { reason: 'billing' } } })
  rHunt(root, 'plain')
  assert.equal(rGetMeta(root, 'red').status, CS.MERGED_PENDING_COMPLIANCE)
  const refused = rCli(root, {}, 'merge-commands', '--campaign', 'c', '--version', '')
  assert.equal(refused.code, 2)
  assert.equal(refused.json.code, 'unsigned_compliance')
  assert.match(refused.json.reason, /awaiting compliance sign-off: red/)
  assert.throws(() => cmdMergeCommands(root, { campaign: 'c', version: '' }), /unsigned_compliance/)
  const chk = releaseCheck(root, { campaign: 'c' })
  assert.equal(chk.ok, false)
  assert.deepEqual(chk.refusals.map(r => r.code), ['unsigned_compliance'])
  assert.deepEqual(chk.hunts.find(h => h.slug === 'red'), { slug: 'red', status: CS.MERGED_PENDING_COMPLIANCE, class: 'campaign_merged', included: true, bump: null, needsSignOff: true, signedOff: false })
  // sign-off refusals
  assert.throws(() => cmdSignOff(root, { campaign: 'c', hunt: 'red' }), /--by NAME is required/)
  assert.throws(() => cmdSignOff(root, { campaign: 'c', hunt: 'red', by: true }), /--by NAME is required/)
  assert.throws(() => cmdSignOff(root, { campaign: 'c', hunt: 'plain', by: 'Reviewer' }), /owes no compliance sign-off/)
  assert.throws(() => cmdSignOff(root, { campaign: 'c', hunt: 'ghost', by: 'Reviewer' }), /is not a hunt of campaign c/)
  // sign off via the CLI
  const so = rCli(root, {}, 'sign-off', '--campaign', 'c', '--hunt', 'red', '--by', 'Reviewer Name', '--at', RAT)
  assert.equal(so.code, 0, so.stdout + so.stderr)
  assert.deepEqual(so.json, { status: 'signed_off', hunt: 'red', signed_off_by: 'Reviewer Name', signed_off_at: RAT })
  for (const m of [rGetMeta(root, 'red'), rreadJ(join(rWtPlan(root, 'red'), 'metadata.json'))]) {
    assert.equal(m.park.compliance_signed_off, true)
    assert.equal(m.park.signed_off_by, 'Reviewer Name')
    assert.equal(m.park.signed_off_at, RAT)
    assert.equal(m.status, CS.MERGED_PENDING_COMPLIANCE, 'the status keeps the audit trail visible')
    assert.deepEqual(m.compliance_hold, { reason: 'billing' })
  }
  assert.deepEqual(releaseQueue([{ slug: 'red', ...rGetMeta(root, 'red') }]).ready, ['red'])
  const ok = rCli(root, {}, 'merge-commands', '--campaign', 'c', '--version', '')
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  assert.equal(ok.stdout.trim(), `git merge --no-ff campaign/c -m "Merge branch 'campaign/c'"`)
})
test('sign-off: refuses a hunt that is not campaign-merged', () => {
  const root = rRepo({ graph: { h: { dependsOn: [] } } })
  rHunt(root, 'h', { merge: false, meta: { status: CS.CERTIFIED_PENDING_COMPLIANCE } })
  assert.throws(() => cmdSignOff(root, { campaign: 'c', hunt: 'h', by: 'Reviewer' }), /only a campaign-merged hunt can be signed off/)
})

// ── 34. AC10 revert (temp repo) ──────────────────────────────────
const REV_GRAPH = { h: { dependsOn: [] }, d: { dependsOn: ['h'] }, x: { dependsOn: [] } }
test('AC10: revert H takes out its campaign-merged dependent too (newest first), rebuilds feat/H, and a fixed re-merge carries the FULL change', () => {
  const root = rRepo({ graph: REV_GRAPH })
  const hwt = rHunt(root, 'h', { meta: { park: { compliance_signed_off: true, signed_off_by: 'Someone' } } })
  rHunt(root, 'd')
  rHunt(root, 'x', { merge: false })           // unmerged, independent: untouched by the revert
  const preTipH = rsha(root, 'feat/h')
  const r = cmdRevert(root, { campaign: 'c', hunt: 'h', reason: 'smoke failed: --broken login', at: RAT })
  assert.equal(r.status, 'reverted')
  assert.deepEqual(r.reverted.map(t => t.slug), ['d', 'h'], 'newest first')
  // d's revert commit lands BEFORE h's on the first-parent line
  assert.equal(rsha(root, 'campaign/c'), r.reverted[1].revert_commit)
  assert.equal(rsha(root, 'campaign/c~1'), r.reverted[0].revert_commit)
  assert.equal(r.campaign_sha, rsha(root, 'campaign/c'))
  assert.equal(rExists(root, 'campaign/c', 'h.txt'), false)
  assert.equal(rExists(root, 'campaign/c', 'd.txt'), false)
  // statuses
  const mh = rGetMeta(root, 'h')
  assert.equal(mh.status, CS.REVERTED)
  assert.equal(mh.campaign_revert_commit, r.reverted[1].revert_commit)
  assert.equal(mh.reverted_reason, 'smoke failed: --broken login')
  assert.equal(mh.park.reason, 'reverted_from_campaign')
  assert.equal(mh.park.resume_phase, 'Implement')
  assert.equal(mh.park.compliance_signed_off, false, 'a prior sign-off does not survive the revert')
  assert.equal('signed_off_by' in mh.park, false)
  const pmd = nfs.readFileSync(join(rMainPlan(root, 'h'), 'parked.md'), 'utf8')
  assert.match(pmd, /- reason: reverted_from_campaign/)
  assert.match(pmd, /Dependents reverted with it .*: d/)
  const md = rGetMeta(root, 'd')
  assert.equal(md.status, CS.REVERTED_WITH_DEP)
  assert.equal(md.reverted_because, 'h')
  assert.equal(md.campaign_revert_commit, r.reverted[0].revert_commit)
  assert.equal(rreadJ(join(rWtPlan(root, 'x'), 'metadata.json')).status, 'certified')
  // feat/h rebuilt = new campaign tip + ONE reapply commit; old tip saved
  assert.equal(rsha(root, 'refs/wolfpack/pre-revert/h'), preTipH)
  assert.equal(rsha(root, 'feat/h~1'), rsha(root, 'campaign/c'))
  assert.equal(rExists(root, 'feat/h', 'h.txt'), true)
  assert.equal(r.rebuilt.sha, rsha(root, 'feat/h'))
  assert.equal(rg(hwt, 'branch', '--show-current'), 'feat/h')
  assert.equal(rg(hwt, 'status', '--porcelain', '--untracked-files=no'), '')
  // the fix cycle: commit a fix, re-certify, re-merge → original change AND fix on the tip
  rcommit(hwt, { 'h-fix.txt': 'fix\n' }, 'fix(h)')
  const m0 = rGetMeta(root, 'h')
  rMeta(root, 'h', { ...m0, status: 'certified' }, { main: true })
  const rm = chainMerge(root, { campaign: 'c', hunt: 'h', at: RAT })
  assert.equal(rm.status, 'merged')
  assert.equal(rExists(root, 'campaign/c', 'h.txt'), true, 're-merging a reverted merge must not drop the old commits')
  assert.equal(rExists(root, 'campaign/c', 'h-fix.txt'), true)
  const mh2 = rGetMeta(root, 'h')
  assert.equal(mh2.campaign_merge_history.length, 1)
  assert.equal(mh2.campaign_merge_history[0].campaign_revert_commit, r.reverted[1].revert_commit)
  assert.equal('campaign_revert_commit' in mh2, false)
  // the dependent reapplies (reapply mode) once h is campaign-merged again
  const rd = chainMerge(root, { campaign: 'c', hunt: 'd', at: RAT })
  assert.equal(rd.status, 'merged')
  assert.equal(rExists(root, 'campaign/c', 'd.txt'), true)
  assert.equal(rg(root, 'log', '-1', '--format=%s', 'campaign/c'), "Merge branch 'feat/d' (reapplied) into campaign/c")
  const md2 = rGetMeta(root, 'd')
  assert.equal(md2.status, CS.MERGED)
  assert.equal('reverted_because' in md2, false)
  assert.equal(rgOk(root, 'rev-parse', '--verify', '--quiet', 'refs/heads/wolfpack/reapply-d'), false, 'temp reapply branch deleted')
})
test('AC10: a revert that conflicts → error, campaign branch, feat/H and statuses unchanged', () => {
  const root = rRepo({ graph: REV_GRAPH })
  const hwt = rHunt(root, 'h')
  rHunt(root, 'x', { edits: { 'h.txt': 'x rewrote it\n' } })     // a later, independent edit of h's file
  const before = rsha(root, 'campaign/c')
  const tip = rsha(root, 'feat/h')
  assert.throws(() => cmdRevert(root, { campaign: 'c', hunt: 'h', at: RAT }), /git revert of h's merge conflicted.*nothing reverted/)
  assert.equal(rsha(root, 'campaign/c'), before)
  assert.equal(rsha(root, 'feat/h'), tip)
  assert.equal(rg(hwt, 'branch', '--show-current'), 'feat/h')
  assert.equal(rGetMeta(root, 'h').status, CS.MERGED)
  assert.equal(rgOk(root, 'rev-parse', '--verify', '--quiet', 'refs/wolfpack/pre-revert/h'), false)
  assert.equal(rg(root, 'worktree', 'list', '--porcelain').includes('wolfpack-chain-'), false)
})
test('AC10: a dirty H worktree → refused BEFORE any revert (nothing touched)', () => {
  const root = rRepo({ graph: REV_GRAPH })
  const hwt = rHunt(root, 'h')
  rHunt(root, 'd')
  const before = rsha(root, 'campaign/c')
  const tip = rsha(root, 'feat/h')
  writeFileSync(join(hwt, 'app.txt'), 'dirty\n')
  assert.throws(() => cmdRevert(root, { campaign: 'c', hunt: 'h', at: RAT }), /uncommitted changes outside \.wolfpack\/: app\.txt/)
  assert.equal(rsha(root, 'campaign/c'), before)
  assert.equal(rsha(root, 'feat/h'), tip)
  assert.equal(rGetMeta(root, 'h').status, CS.MERGED)
  assert.equal(rGetMeta(root, 'd').status, CS.MERGED)
})
test('AC10 (Pointer r1 round 3 F3): tracked .wolfpack/ dirt in H\'s worktree → refused BEFORE any revert, naming the path (nothing touched)', () => {
  const root = rRepo({ graph: REV_GRAPH })
  const hwt = rHunt(root, 'h', { edits: { 'h.txt': 'h\n', '.wolfpack/pedigree/h.md': '# h pedigree\n' } })
  rHunt(root, 'd')
  const before = rsha(root, 'campaign/c')
  const tip = rsha(root, 'feat/h')
  writeFileSync(join(hwt, '.wolfpack', 'pedigree', 'h.md'), '# h pedigree\nstraggler\n')
  assert.throws(() => cmdRevert(root, { campaign: 'c', hunt: 'h', reason: 'smoke failed', at: RAT }),
    /h's worktree has uncommitted tracked \.wolfpack\/ changes the rebuild would refuse: \.wolfpack\/pedigree\/h\.md — commit or discard them, then re-run/)
  assert.equal(rsha(root, 'campaign/c'), before, 'campaign branch unchanged')
  assert.equal(rsha(root, 'feat/h'), tip, 'feat/h unchanged')
  assert.equal(rg(hwt, 'branch', '--show-current'), 'feat/h')
  assert.equal(rGetMeta(root, 'h').status, CS.MERGED)
  assert.equal(rGetMeta(root, 'd').status, CS.MERGED)
  assert.equal(rgOk(root, 'rev-parse', '--verify', '--quiet', 'refs/wolfpack/pre-revert/h'), false, 'no pre-revert ref written')
  assert.equal(rg(root, 'worktree', 'list', '--porcelain').includes('wolfpack-chain-'), false)
  // the dirt is the operator's: still there, untouched
  assert.equal(nfs.readFileSync(join(hwt, '.wolfpack', 'pedigree', 'h.md'), 'utf8'), '# h pedigree\nstraggler\n')
  // the CLI reports it as exit 2 with the same message
  const cli = rCli(root, {}, 'revert', '--campaign', 'c', '--hunt', 'h', '--reason', 'smoke failed')
  assert.equal(cli.code, 2)
  assert.equal(cli.json.status, 'error')
  assert.equal(rsha(root, 'campaign/c'), before)
  // ignored plan-dir files and untracked .wolfpack/ files are NOT dirt: once the tracked file is
  // restored the revert proceeds even with them present
  rg(hwt, 'checkout', '--', '.wolfpack/pedigree/h.md')
  writeFileSync(join(hwt, '.wolfpack', 'pedigree', 'untracked.md'), 'new\n')
  const r = cmdRevert(root, { campaign: 'c', hunt: 'h', reason: 'smoke failed', at: RAT })
  assert.equal(r.status, 'reverted')
  assert.deepEqual(r.reverted.map(t => t.slug), ['d', 'h'])
})
test('check / deploy: a dirty .wolfpack/ tracked file in the MAIN repo counts as dirt (includeWolfpack), named in full', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rput(root, '.wolfpack/pedigree/index.md', '# pedigree\n')
  rg(root, 'add', '--', '.wolfpack/pedigree/index.md')
  rg(root, 'commit', '-q', '-m', 'pedigree')
  rput(root, '.wolfpack/pedigree/index.md', '# pedigree\nedited\n')
  const c = releaseCheck(root, { campaign: 'c', checkpoint: true })
  const dt = c.refusals.find(x => x.code === 'dirty_tree')
  assert.ok(dt, JSON.stringify(c.refusals))
  assert.equal(dt.detail, 'the main-repo tree has uncommitted changes: .wolfpack/pedigree/index.md')
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd: 'true', migrateCmd: 'true' }),
    /refusing: the main-repo tree has uncommitted changes \(\.wolfpack\/pedigree\/index\.md\)/)
})
test('AC10: a rebuild that fails (WOLFPACK_CHAIN_FAULT=rebuild) rolls the campaign branch back and leaves feat/H checked out, nothing stamped', () => {
  const root = rRepo({ graph: REV_GRAPH })
  const hwt = rHunt(root, 'h')
  rHunt(root, 'd')
  const before = rsha(root, 'campaign/c')
  const tip = rsha(root, 'feat/h')
  process.env.WOLFPACK_CHAIN_FAULT = 'rebuild'
  try {
    assert.throws(() => cmdRevert(root, { campaign: 'c', hunt: 'h', at: RAT }), /WOLFPACK_CHAIN_FAULT=rebuild/)
  } finally { delete process.env.WOLFPACK_CHAIN_FAULT }
  assert.equal(rsha(root, 'campaign/c'), before, 'campaign/c reset to its pre-revert SHA')
  assert.equal(rsha(root, 'feat/h'), tip)
  assert.equal(rg(hwt, 'branch', '--show-current'), 'feat/h')
  assert.equal(rg(hwt, 'status', '--porcelain', '--untracked-files=no'), '')
  assert.equal(rGetMeta(root, 'h').status, CS.MERGED)
  assert.equal(rGetMeta(root, 'd').status, CS.MERGED)
  assert.equal(rgOk(root, 'rev-parse', '--verify', '--quiet', 'refs/wolfpack/pre-revert/h'), false, 'no pre-revert ref left behind')
  // the CLI reports the same failure as exit 2
  const cli = rCli(root, { WOLFPACK_CHAIN_FAULT: 'rebuild' }, 'revert', '--campaign', 'c', '--hunt', 'h')
  assert.equal(cli.code, 2)
  assert.equal(cli.json.status, 'error')
  assert.equal(rsha(root, 'campaign/c'), before)
})
test('revert: refuses a hunt that is not campaign-merged', () => {
  const root = rRepo({ graph: REV_GRAPH })
  rHunt(root, 'h', { merge: false })
  assert.throws(() => cmdRevert(root, { campaign: 'c', hunt: 'h' }), /only a campaign-merged hunt can be reverted/)
  assert.throws(() => cmdRevert(root, { campaign: 'c', hunt: 'ghost' }), /is not a hunt of campaign c/)
})

// ── 35. AC14 release steps 4–7 (temp repo) ───────────────────────
test('AC14 (i) tooling-only campaign: no version, CHANGELOG untouched, one merge line, stamped merged with released_version null, no tag', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] }, b: { dependsOn: [] } } })
  rHunt(root, 'a', { edits: { 'a.txt': 'a\n', 'CHANGELOG.md': rcl('- a <!-- hunt:a -->') } })
  rHunt(root, 'b', { edits: { 'b.txt': 'b\n', 'CHANGELOG.md': rcl('- a <!-- hunt:a -->', '- b <!-- hunt:b -->') } })   // forks after a merged
  const chk = releaseCheck(root, { campaign: 'c' })
  assert.equal(chk.ok, true, JSON.stringify(chk.refusals))
  assert.equal(nextVersion('v0.1.0', aggregateBump(chk.hunts.map(h => h.bump))), null)
  const ver = execFileSync(process.execPath, [RCLI, 'version', 'v0.1.0', ...chk.hunts.map(h => h.bump || '')], { encoding: 'utf8' })
  assert.equal(ver, 'BUMP=none\nVERSION=\n')
  const tip = rsha(root, 'campaign/c')
  const cl = cmdChangelog(root, { campaign: 'c', version: '', apply: true, at: RAT })
  assert.deepEqual(cl, { version: null, hunts: ['a', 'b'], moved: 0, unattributed: ['- base entry'], committed: null })
  assert.equal(rsha(root, 'campaign/c'), tip, 'nothing committed')
  const lines = cmdMergeCommands(root, { campaign: 'c', version: '' })
  assert.deepEqual(lines, [`git merge --no-ff campaign/c -m "Merge branch 'campaign/c'"`])
  assert.throws(() => cmdStampReleased(root, { campaign: 'c', version: '' }), /is not merged into main yet/)
  for (const l of lines) bash(root, l)
  assert.equal(rgOk(root, 'merge-base', '--is-ancestor', 'campaign/c', 'main'), true)
  assert.equal(rg(root, 'rev-list', '--parents', '-n', '1', 'main').split(' ').length, 3, 'a --no-ff merge commit on main')
  const st = rCli(root, {}, 'stamp-released', '--campaign', 'c', '--version', '', '--at', RAT)
  assert.equal(st.code, 0, st.stdout + st.stderr)
  assert.deepEqual(st.json.push, ['git push origin main'])
  assert.equal(st.json.released_version, null)
  assert.equal(st.json.release_merge_commit, rsha(root, 'main'))
  for (const s of ['a', 'b']) {
    const m = rGetMeta(root, s)
    assert.equal(m.status, 'merged')
    assert.equal(m.released_version, null)
    assert.equal(m.merge_commit, m.campaign_merge_commit)
    assert.equal(m.release_merge_commit, rsha(root, 'main'))
    assert.equal(m.merged_at, RAT)
    assert.equal(m.phase, 'done', 'merge-and-state-hygiene AC3: the shared stampMerged() also sets phase done')
  }
  assert.equal(rg(root, 'tag', '-l'), '', 'no tag for a tooling-only campaign')
})
test('AC14 (ii) patch-bump campaign: v0.1.0 → v0.1.1, ONE heading holding both hunts, unattributed warned, merge + tag, stamp gated on the merge', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] }, b: { dependsOn: [] } }, tag: true })
  rHunt(root, 'a', { edits: { 'a.txt': 'a\n', 'CHANGELOG.md': rcl('- a <!-- hunt:a -->') }, meta: { proposed_version: { bump: 'patch' } } })
  rHunt(root, 'b', { edits: { 'b.txt': 'b\n', 'CHANGELOG.md': rcl('- a <!-- hunt:a -->', '- b <!-- hunt:b -->') } })   // forks after a merged
  const chk = releaseCheck(root, { campaign: 'c' })
  const V = nextVersion(rg(root, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'), aggregateBump(chk.hunts.map(h => h.bump)))
  assert.equal(V, 'v0.1.1')
  const cl = rCli(root, {}, 'changelog', '--campaign', 'c', '--version', V, '--apply', '--at', RAT)
  assert.equal(cl.code, 0, cl.stdout + cl.stderr)
  assert.equal(cl.json.moved, 2)
  assert.deepEqual(cl.json.unattributed, ['- base entry'])
  assert.equal(cl.json.committed, rsha(root, 'campaign/c'))
  assert.equal(rg(root, 'log', '-1', '--format=%s', 'campaign/c'), 'docs(changelog): stamp v0.1.1 for campaign c')
  const text = rg(root, 'show', 'campaign/c:CHANGELOG.md')
  assert.equal(text.match(/^## \[v0\.1\.1\] — 2026-10-17$/gm).length, 1)
  const sec = text.split('## [v0.1.1] — 2026-10-17')[1].split('## [v0.1.0]')[0]
  assert.match(sec, /- a <!-- hunt:a -->/)
  assert.match(sec, /- b <!-- hunt:b -->/)
  assert.match(text.split('## [v0.1.1]')[0], /- base entry/, 'the unattributed line stays in [Unreleased]')
  assert.throws(() => cmdStampReleased(root, { campaign: 'c', version: V }), /not merged into main yet/)
  const lines = cmdMergeCommands(root, { campaign: 'c', version: V })
  assert.deepEqual(lines, [`git merge --no-ff campaign/c -m "Merge branch 'campaign/c'"`, `git tag -a v0.1.1 -m "v0.1.1 — campaign c: a, b"`])
  for (const l of lines) bash(root, l)
  assert.equal(rg(root, 'describe', '--tags'), 'v0.1.1')
  const st = cmdStampReleased(root, { campaign: 'c', version: V, at: RAT })
  assert.deepEqual(st.push, ['git push origin main', 'git push origin v0.1.1'])
  assert.deepEqual(st.hunts, ['a', 'b'])
  for (const s of ['a', 'b']) assert.equal(rGetMeta(root, s).released_version, 'v0.1.1')
})
test('AC14 (iii) --checkpoint: an unfinished and a previously-released hunt are left alone (CHANGELOG, tag message, metadata)', () => {
  const root = rRepo({
    graph: { a: { dependsOn: [] }, u: { dependsOn: [] }, r: { dependsOn: [] } }, tag: true,
    changelog: rcl('- u line <!-- hunt:u -->', '- r line <!-- hunt:r -->'),
  })
  rHunt(root, 'a', { edits: { 'a.txt': 'a\n', 'CHANGELOG.md': rcl('- u line <!-- hunt:u -->', '- r line <!-- hunt:r -->', '- a line <!-- hunt:a -->') }, meta: { proposed_version: { bump: 'patch' } } })
  rHunt(root, 'outsider', { merge: false })     // not in the graph: never touched
  rMeta(root, 'u', { feature: 'u', status: CS.MERGE_CONFLICT, park: { reason: 'campaign_merge_conflict' } }, { wt: false, main: true })
  rMeta(root, 'r', { feature: 'r', status: 'merged', released_version: 'v0.1.0' }, { wt: false, main: true })
  const uBefore = nfs.readFileSync(join(rMainPlan(root, 'u'), 'metadata.json'), 'utf8')
  const rBefore = nfs.readFileSync(join(rMainPlan(root, 'r'), 'metadata.json'), 'utf8')
  const full = releaseCheck(root, { campaign: 'c' })
  assert.equal(full.ok, false)
  assert.deepEqual(full.refusals.map(x => x.code), ['unfinished'])
  assert.match(full.refusals[0].detail, /u=parked:campaign_merge_conflict/)
  assert.doesNotMatch(full.refusals[0].detail, /\br=merged/, 'a released hunt is finished')
  const chk = releaseCheck(root, { campaign: 'c', checkpoint: true })
  assert.equal(chk.ok, true, JSON.stringify(chk.refusals))
  assert.deepEqual(chk.hunts.filter(h => h.included).map(h => h.slug), ['a'])
  const cl = cmdChangelog(root, { campaign: 'c', version: 'v0.1.1', apply: true, at: RAT })
  assert.equal(cl.moved, 1)
  const text = rg(root, 'show', 'campaign/c:CHANGELOG.md')
  const [unrel, rest] = text.split('## [v0.1.1] — 2026-10-17')
  assert.match(unrel, /- u line <!-- hunt:u -->/)
  assert.match(unrel, /- r line <!-- hunt:r -->/)
  assert.match(rest.split('## [v0.1.0]')[0], /- a line <!-- hunt:a -->/)
  const lines = cmdMergeCommands(root, { campaign: 'c', version: 'v0.1.1' })
  assert.equal(lines[1], `git tag -a v0.1.1 -m "v0.1.1 — campaign c: a"`)
  for (const l of lines) bash(root, l)
  const st = cmdStampReleased(root, { campaign: 'c', version: 'v0.1.1', at: RAT })
  assert.deepEqual(st.hunts, ['a'])
  assert.equal(nfs.readFileSync(join(rMainPlan(root, 'u'), 'metadata.json'), 'utf8'), uBefore)
  assert.equal(nfs.readFileSync(join(rMainPlan(root, 'r'), 'metadata.json'), 'utf8'), rBefore)
  assert.equal(rreadJ(join(rWtPlan(root, 'outsider'), 'metadata.json')).status, 'certified')
})
test('stamp-released: a FAST-FORWARDED main (no --no-ff merge) fails loud', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a')
  rg(root, 'merge', '-q', '--ff-only', 'campaign/c')
  assert.throws(() => cmdStampReleased(root, { campaign: 'c', version: '' }), /could not find the --no-ff merge .*fast-forwarded/)
  assert.equal(rGetMeta(root, 'a').status, CS.MERGED)
})

// ── 36. check (temp repo) ────────────────────────────────────────
test('check: dirty tree → dirty_tree naming the dirty file exactly', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a')
  writeFileSync(join(root, 'app.txt'), 'dirty\n')
  const chk = releaseCheck(root, { campaign: 'c' })
  assert.deepEqual(chk.refusals.map(r => r.code), ['dirty_tree'])
  const cli = rCli(root, {}, 'check', '--campaign', 'c')
  assert.equal(cli.code, 2)
  assert.equal(cli.json.ok, false)
  // git() trims stdout, so a fixed slice(3) of the FIRST porcelain line eats a character ("pp.txt")
  assert.match(chk.refusals[0].detail, /uncommitted changes: app\.txt$/)
})
test('check: main advanced → main_not_merged naming sync-main; sync-main then recovers (release preflight path)', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a')
  rcommit(root, { 'mainonly.txt': 'm\n' }, 'main advances')
  const chk = releaseCheck(root, { campaign: 'c' })
  assert.deepEqual(chk.refusals.map(r => r.code), ['main_not_merged'])
  assert.match(chk.refusals[0].detail, /node scripts\/wolfpack-chain\.mjs sync-main --campaign c/)
  // merge-commands refuses too (exit 2, code main_not_merged)
  const mc = rCli(root, {}, 'merge-commands', '--campaign', 'c', '--version', '')
  assert.equal(mc.code, 2)
  assert.equal(mc.json.code, 'main_not_merged')
  assert.equal(chainSyncMain(root, { campaign: 'c' }).status, 'merged')
  assert.equal(releaseCheck(root, { campaign: 'c' }).ok, true)
  const mc2 = rCli(root, {}, 'merge-commands', '--campaign', 'c', '--version', '')
  assert.equal(mc2.code, 0, mc2.stdout + mc2.stderr)
})
test('check: an unfinished hunt → unfinished unless --checkpoint; an unsigned compliance_hold on a merged_to_campaign hunt → unsigned_compliance', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] }, p: { dependsOn: [] }, z: { dependsOn: [] } } })
  rHunt(root, 'a')
  rHunt(root, 'p', { merge: false })
  rMeta(root, 'p', { feature: 'p', status: 'implementing' })
  assert.deepEqual(releaseCheck(root, { campaign: 'c' }).refusals.map(r => r.code), ['unfinished'])
  assert.match(releaseCheck(root, { campaign: 'c' }).refusals[0].detail, /p=implementing, z=missing/)
  assert.equal(releaseCheck(root, { campaign: 'c', checkpoint: true }).ok, true)
  // a drifted status cannot launder a hold: merged_to_campaign + an unsigned compliance_hold
  const ma = rGetMeta(root, 'a')
  rMeta(root, 'a', { ...ma, compliance_hold: { reason: 'billing' } }, { main: true })
  const chk = releaseCheck(root, { campaign: 'c', checkpoint: true })
  assert.deepEqual(chk.refusals.map(r => r.code), ['unsigned_compliance'])
  assert.throws(() => cmdMergeCommands(root, { campaign: 'c', version: '' }), /unsigned_compliance/)
})
test('check: a missing campaign branch → no_campaign_branch', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rg(root, 'branch', '-D', 'campaign/c')
  const chk = releaseCheck(root, { campaign: 'c' })
  assert.deepEqual(chk.refusals.map(r => r.code), ['no_campaign_branch'])
  assert.throws(() => cmdMergeCommands(root, { campaign: 'c', version: '' }), /no_campaign_branch/)
})
test('summary: per-hunt marks, the compliance summary + sign-off/reject commands, held/reverted/blocked lists', () => {
  const root = rRepo({ graph: { ok: {}, red: {}, held: {}, blk: {}, rv: {}, pend: {} } })
  rHunt(root, 'ok')
  rHunt(root, 'red', { meta: { status: CS.CERTIFIED_PENDING_COMPLIANCE } })
  writeFileSync(join(rWtPlan(root, 'red'), 'compliance-summary.md'), Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'))
  rMeta(root, 'held', { feature: 'held', status: CS.HELD_OVERLAP, held_on: [{ slug: 'blk', files: ['x'] }] }, { wt: false, main: true })
  rMeta(root, 'blk', { feature: 'blk', status: 'parked:open_critical' }, { wt: false, main: true })
  rMeta(root, 'rv', { feature: 'rv', status: CS.REVERTED_WITH_DEP, reverted_because: 'blk' }, { wt: false, main: true })
  rMeta(root, 'pend', { feature: 'pend', status: 'implementing' }, { wt: false, main: true })
  const s = releaseSummary(root, { campaign: 'c', checkpoint: true })
  assert.match(s, /✅ ok {2}merged_to_campaign/)
  assert.match(s, /⛔ red {2}merged_to_campaign_pending_compliance/)
  assert.match(s, /Awaiting compliance sign-off/)
  assert.match(s, / {5}line 40\n/)
  assert.doesNotMatch(s, /line 41/, 'first 40 lines only')
  assert.match(s, /sign off: node scripts\/wolfpack-release\.mjs sign-off --campaign c --hunt red --by "<name>"/)
  assert.match(s, /reject: {3}node scripts\/wolfpack-release\.mjs revert --campaign c --hunt red --reason "<why>"/)
  assert.match(s, /Held \(certified, unmerged — overlaps a blocked hunt\):\n {2}- held {2}certified_held_overlap held on blk/)
  assert.match(s, /Reverted:\n {2}- rv {2}reverted_with_dependency \(with blk\)/)
  assert.match(s, /Blocked \(needs a human\):\n {2}- blk {2}parked:open_critical/)
  assert.match(s, /Not finished:\n {2}- pend {2}implementing/)
  assert.match(s, /\[--checkpoint\]/)
})

// ── 37. deploy (temp repo) ───────────────────────────────────────
test('deploy: runs both commands on the detached campaign tip and ALWAYS restores the prior checkout', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a')
  const tip = rsha(root, 'campaign/c')
  const onTip = `test "$(git rev-parse HEAD)" = "${tip}"`
  const ok = cmdDeploy(root, { campaign: 'c', deployCmd: onTip, migrateCmd: onTip })
  assert.deepEqual(ok, { deployExit: 0, migrateExit: 0, restored: true, restored_to: 'main', branch: 'campaign/c' })
  assert.equal(rg(root, 'branch', '--show-current'), 'main')
  const failDeploy = cmdDeploy(root, { campaign: 'c', deployCmd: 'false', migrateCmd: 'true' })
  assert.equal(failDeploy.deployExit, 1)
  assert.equal(failDeploy.migrateExit, null, 'the migration is skipped when the deploy fails')
  assert.equal(failDeploy.restored, true)
  assert.equal(rg(root, 'branch', '--show-current'), 'main')
  const failMig = cmdDeploy(root, { campaign: 'c', deployCmd: 'true', migrateCmd: 'false' })
  assert.deepEqual([failMig.deployExit, failMig.migrateExit, failMig.restored], [0, 1, true])
  // CLI exit codes: 0 only when both ran clean and the restore worked
  assert.equal(rCli(root, {}, 'deploy', '--campaign', 'c', '--deploy-cmd', 'true', '--migrate-cmd', 'true').code, 0)
  const bad = rCli(root, {}, 'deploy', '--campaign', 'c', '--deploy-cmd', 'true', '--migrate-cmd', 'false')
  assert.equal(bad.code, 1)
  assert.equal(bad.json.restored_to, 'main')
  assert.equal(rg(root, 'branch', '--show-current'), 'main')
})
test('deploy (Pointer r1 F4): restores a side branch by name, and a detached HEAD by SHA', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a')
  rg(root, 'checkout', '-q', '-b', 'side')
  const r = cmdDeploy(root, { campaign: 'c', deployCmd: 'true', migrateCmd: 'true' })
  assert.equal(r.restored_to, 'side')
  assert.equal(rg(root, 'branch', '--show-current'), 'side')
  const s = rsha(root, 'main')
  rg(root, 'checkout', '-q', '--detach', s)
  const r2 = cmdDeploy(root, { campaign: 'c', deployCmd: 'false', migrateCmd: 'true' })
  assert.equal(r2.restored_to, s)
  assert.equal(rsha(root, 'HEAD'), s)
  assert.equal(rg(root, 'branch', '--show-current'), '')
})
test('deploy: refuses a dirty tree before any checkout, a production-named command, and missing commands', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a')
  writeFileSync(join(root, 'app.txt'), 'dirty\n')
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd: 'touch ran', migrateCmd: 'true' }), /refusing: the main-repo tree has uncommitted changes/)
  assert.equal(nfs.existsSync(join(root, 'ran')), false, 'the command never ran')
  assert.equal(rg(root, 'branch', '--show-current'), 'main')
  rg(root, 'checkout', '--', 'app.txt')
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd: `deploy-${PRODWORD}`, migrateCmd: 'true' }), /mentions prod/)
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd: 'true', migrateCmd: `migrate-${PRODWORD.toUpperCase()}` }), /mentions prod/)
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd: '', migrateCmd: 'true' }), /--deploy-cmd is required/)
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd: 'true' }), /--migrate-cmd or --no-migrate is required/)
  assert.equal(rg(root, 'branch', '--show-current'), 'main')
})
// pack-commands-canonical D8: `--no-migrate` for a project with no migration step.
test('deploy --no-migrate (D8): runs the deploy only on the campaign tip, returns migrate: skipped, restores the checkout', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a')
  const tip = rsha(root, 'campaign/c')
  const onTip = `test "$(git rev-parse HEAD)" = "${tip}" && touch "${join(root, '.git', 'deploy-ran')}"`
  const r = cmdDeploy(root, { campaign: 'c', deployCmd: onTip, noMigrate: true })
  assert.deepEqual(r, { deployExit: 0, migrateExit: null, migrate: 'skipped', restored: true, restored_to: 'main', branch: 'campaign/c' })
  assert.equal(nfs.existsSync(join(root, '.git', 'deploy-ran')), true, 'the deploy ran on the campaign tip')
  assert.equal(rg(root, 'branch', '--show-current'), 'main')
  // a failing deploy is still reported (migration skipped either way)
  const bad = cmdDeploy(root, { campaign: 'c', deployCmd: 'false', noMigrate: true })
  assert.deepEqual([bad.deployExit, bad.migrateExit, bad.migrate, bad.restored], [1, null, 'skipped', true])
  // the migrateCmd path keeps its old shape (no `migrate` key)
  const withMig = cmdDeploy(root, { campaign: 'c', deployCmd: 'true', migrateCmd: 'true' })
  assert.equal('migrate' in withMig, false)
  // CLI: --no-migrate → exit 0 on a clean deploy, 1 on a failed deploy
  const cli = rCli(root, {}, 'deploy', '--campaign', 'c', '--deploy-cmd', 'true', '--no-migrate')
  assert.equal(cli.code, 0)
  assert.equal(cli.json.migrate, 'skipped')
  assert.equal(cli.json.migrateExit, null)
  assert.equal(rCli(root, {}, 'deploy', '--campaign', 'c', '--deploy-cmd', 'false', '--no-migrate').code, 1)
  assert.equal(rg(root, 'branch', '--show-current'), 'main')
})
test('deploy (D8): neither --migrate-cmd nor --no-migrate throws; both throws; whitespace migrate counts as absent; prod regex still guards the deploy', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a')
  const marker = join(root, '.git', 'should-not-run')
  const deployCmd = `touch "${marker}"`
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd }), /--migrate-cmd or --no-migrate is required \(not both\)/)
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd, noMigrate: false }), /--migrate-cmd or --no-migrate is required/)
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd, migrateCmd: 'true', noMigrate: true }), /--migrate-cmd or --no-migrate is required \(not both\)/)
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd, migrateCmd: '   ' }), /--migrate-cmd or --no-migrate is required/)
  // noMigrate must be exactly true — a truthy string is not the flag
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd, noMigrate: 'yes' }), /--migrate-cmd or --no-migrate is required/)
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd: `deploy-${PRODWORD}`, noMigrate: true }), /mentions prod/)
  assert.throws(() => cmdDeploy(root, { campaign: 'c', deployCmd: '  ', noMigrate: true }), /--deploy-cmd is required/)
  assert.equal(nfs.existsSync(marker), false, 'no command ran on any refusal')
  // CLI: neither flag → non-zero, the deploy never runs
  assert.notEqual(rCli(root, {}, 'deploy', '--campaign', 'c', '--deploy-cmd', deployCmd).code, 0)
  assert.equal(nfs.existsSync(marker), false)
  assert.equal(rg(root, 'branch', '--show-current'), 'main')
})

// ── merge-and-state-hygiene AC11 (chain path): cmdChangelog attributes untagged items first ──
test('AC11 chain: an untagged item introduced by an included hunt is tagged and moves under the release heading; others stay', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } }, tag: true })
  rHunt(root, 'a', { edits: { 'a.txt': 'a\n', 'CHANGELOG.md': rcl('- a tagged <!-- hunt:a -->', '- a forgot its tag') }, meta: { proposed_version: { bump: 'patch' } } })
  const cl = cmdChangelog(root, { campaign: 'c', version: 'v0.1.1', apply: true, at: RAT })
  assert.equal(cl.moved, 2, JSON.stringify(cl))
  assert.deepEqual(cl.unattributed, ['- base entry'], 'the pre-existing untagged item stays, loudly')
  const text = rg(root, 'show', 'campaign/c:CHANGELOG.md')
  const [unrel, rest] = text.split('## [v0.1.1]')
  assert.match(rest, /- a forgot its tag <!-- hunt:a -->/)
  assert.match(rest, /- a tagged <!-- hunt:a -->/)
  assert.match(unrel, /- base entry/)
  assert.doesNotMatch(unrel, /a forgot its tag/)
})

test('AC11 chain: attribution alone (no version heading) still commits the tag', () => {
  const root = rRepo({ graph: { a: { dependsOn: [] } } })
  rHunt(root, 'a', { edits: { 'a.txt': 'a\n', 'CHANGELOG.md': rcl('- a untagged') } })
  const tip = rsha(root, 'campaign/c')
  const cl = cmdChangelog(root, { campaign: 'c', version: '', apply: true, at: RAT })
  assert.equal(cl.moved, 0)
  assert.ok(cl.committed && cl.committed !== tip, JSON.stringify(cl))
  assert.equal(rg(root, 'log', '-1', '--format=%s', 'campaign/c'), 'docs(changelog): attribute untagged items for campaign c')
  assert.match(rg(root, 'show', 'campaign/c:CHANGELOG.md'), /- a untagged <!-- hunt:a -->/)
})
