#!/usr/bin/env node
// scripts/wolfpack-smoke-stage.mjs — the chain-mode POST-MERGE STAGE's deterministic core.
//
// After each wave of a chain campaign (`--chain`) auto-merges into `campaign/<slug>`, the
// campaign runner (.agents/workflows/campaign-runner.js → postMergeStage) runs, per wave:
//
//   begin → session:before (first iteration) → deploy → migrate → ensure-tenants → session:after
//   → integration (suites + SHA-stamped test record + baseline verdict) → smoke (plan, browser
//   probe, the /smoke-chain agent, ingest) → triage → act (blocks: revert; fixes: ≤2 reviewed
//   fix rounds through hunt-pipeline) → re-verify (back to deploy) … → done
//
// and, once at campaign end, one POLISH wave for the open `log` items, then the campaign
// release report. The Workflow runner has no filesystem, shell or clock, so EVERY decision that
// can be made deterministically is made here, in tested code, and relayed as JSON by a sonnet
// agent (the wolfpack-chain.mjs `chainCli` precedent). The operator doc is
// docs/post-merge-stage.md; keep the two in step.
//
// STATE: .wolfpack/campaigns/<c>/smoke-stage.json (schema 1, atomic writes):
//   { schema, campaign, staged_from_wave,
//     current: { wave, step, campaign_sha, iteration, merged:[slugs], polish:{slug,merge_commit,issues}|null,
//                fix_rounds:{hunt:n}, result, deploy_attempts:{deploy,migrate}, integration_attempts,
//                busy_retries, smoke_attempts, sessions:{before:{host:state}, after:{host:state}},
//                findings:[…], notices:[…], pending:{fix:{hunt:[ids]}, block:{hunt:[ids]}},
//                block_text:{hunt:{summary,evidence,question}}, fix_merges:[{hunt,slug,commit}],
//                suites:{labels,full,reason,hunt_apps,full_suite_hunts}|null, suites_override, wave_dir,
//                deployed_sha, report_url, park, park_history:[…], smoke_worktree },
//     waves: { "<n>": { result, campaign_sha, finished_at } },
//     mobile_passed: { "<ref>@mobile": <first wave it passed> },
//     polish: [ { open_set, slug, result } ], report_url }
//   step = the last step COMPLETED: begin, deploy, migrate, ensure, session, integration, smoke,
//   triage, act, done. result: null while running, then green | resolved | parked:<code>.
//
// ISSUE LOG: .wolfpack/campaigns/<c>/issue-log.json is the machine store (append-only: entries are
// never removed; only resolution, resolved_at and seen_waves change in place); issue-log.md is
// re-rendered from it on every write. Finding id: ISS-<sha1(kind|hunt|tenant|ref-or-test-id|
// normalised summary)[:10]>.
//
// CLI (JSON on stdout; exit 0 = decided, 2 = refused/error {status:'error', reason, code?}):
//   check-config   --campaign C
//   begin          --campaign C (--resume-only [--next-wave N] [--open-waves CSV] [--merged-by-wave JSON]
//                                | --wave N [--merged CSV] | --wave N --polish SLUG)
//   session        --campaign C --when before|after
//   deploy | migrate | ensure-tenants   --campaign C
//   suites         --campaign C [--wave N | --polish SLUG]
//   ingest-integration --campaign C --wave N
//   plan-smoke     --campaign C --wave N --sha SHA
//   worktree       add|remove --campaign C --wave N
//   ingest-smoke   --campaign C --wave N --raw FILE
//   smoke-failed   --campaign C --wave N --reason TEXT
//   triage         --campaign C --wave N
//   reclassify     --campaign C --hunt H --rule RULE          (pending fix → block)
//   fix-scaffold   --campaign C (--hunt H | --polish)
//   record-fix     --campaign C --hunt H --fix S --commit SHA --issues CSV
//   polish-plan    --campaign C
//   resolve        --campaign C --ids CSV --resolution R [--reason TEXT]
//                  [--polish-slug S --open-set H --polish-result merged|reverted|failed]
//   iterate        --campaign C [--clear-polish]
//   finish         --campaign C --result green|resolved
//   report         --campaign C
//   park           --campaign C --code CODE --detail TEXT
//
// Run tests: node --test scripts/wolfpack-smoke-stage.test.mjs

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHAIN_STATUS, chainClass, git, repoRoot, revParse, branchExists, findWorktree, readHuntMeta, writeHuntMeta,
  readCampaignMeta, campaignHunts, huntPlanDirs, parseFlags, TEXT_FLAGS,
} from './wolfpack-chain.mjs'
import { parseAcceptanceCriteria, CriteriaError } from './wolfpack-release.mjs'
import { loadConfig, STAGE_KEYS } from './wolfpack-config.mjs'

// ─── Constants (A-8: keep in step with run_tests.sh, hunt-pipeline.js and the docs) ─────────
// The longest a pipeline test record may hold the shared test DB: hunt-pipeline's shim relay
// gives up at ~60 min, so this cannot be raised. Every --timeout-min literal in the two
// workflows must be ≤ it (static test).
export const MAX_TEST_RECORD_MIN = 55
// The worst fresh --isolated-db full suite plus migrate; a record waits for the lock at most
// MAX_TEST_RECORD_MIN − SUITE_RESERVE_MIN minutes (the consuming project's test runner reads its own suite-reserve setting).
export const SUITE_RESERVE_MIN = 35
// A record whose test command exited 75 (test DB busy) is re-taken at once, up to this many times.
export const MAX_BUSY_RETRIES = 8
export const MAX_FIX_ROUNDS = 2
export const STEPS = Object.freeze(['begin', 'deploy', 'migrate', 'ensure', 'session', 'integration', 'smoke', 'triage', 'act', 'done'])
export const DISPOSITIONS = Object.freeze(['auto_pass', 'auto_fail', 'needs_human_run'])
export const MODEL_CLASSES = Object.freeze(['fix', 'log', 'block', 'uncertain', 'needs_decision'])
export const CONSOLE_DETAIL = 'console not reachable on dev'
export const CAPABILITY_NOTICE_RE = /^WARNING capabilities: not available\b/m
export const MANIFEST_SLUG = 'mobile-manifest'
export const STAGE_PSEUDO_SLUG = 'post-merge-stage'
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
const SHA_RE = /^[0-9a-f]{40}$/

export class StageError extends Error {
  constructor(message, code = null, extra = {}) { super(message); this.code = code; this.extra = extra }
}

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const normTier = (t) => { const s = String(t || '').trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : 'Red' }
const TIER_RANK = { Green: 0, Blue: 1, Yellow: 2, Orange: 3, Red: 4 }
const isRed = (t) => String(t || '').trim().toLowerCase() === 'red'
const nowIso = () => new Date().toISOString()

// ─── The prod-name guard (AC6) ───────────────────────────────────────────────
// kind 'command': the whole text — /prod/i, the prod host suffix, or a never-smoke host as a
//   whole hostname. `mask` (the substituted campaign slug) is masked back to `{campaign}` first,
//   so a legitimate slug such as reproduce-login-bug is never refused (the template itself was
//   checked unsubstituted at check-config).
// kind 'host' / 'url': ONLY the hostname (a URL's path/query is never tested: real dev routes
//   contain "prod", e.g. /inventory/medication_products/). An unparseable URL is refused.
// Returns null (allowed) or the refusal reason.
export function refuseProdTarget(text, cfg = {}, { kind = 'command', mask = null } = {}) {
  // A trailing-dot FQDN (`x.example.vet.`) is the same host: trailing dots are stripped from the
  // config values and from a url/host target before comparing (commands are matched as text).
  const noDot = h => h.replace(/\.+$/, '')
  const rawSuffix = (cfg && typeof cfg.prodHostSuffix === 'string') ? noDot(cfg.prodHostSuffix.trim().toLowerCase()) : ''
  const suffix = rawSuffix || null
  const never = ((cfg && Array.isArray(cfg.neverSmokeHosts)) ? cfg.neverSmokeHosts : []).map(h => noDot(String(h).trim().toLowerCase())).filter(Boolean)
  if (kind === 'command') {
    let t = String(text ?? '')
    if (mask) t = t.split(String(mask)).join('{campaign}')
    if (/prod/i.test(t)) return 'prod name'
    if (suffix && t.toLowerCase().includes(suffix)) return 'prod suffix'
    for (const h of never) {
      if (new RegExp(`(^|[^a-z0-9.-])${escapeRe(h)}($|[^a-z0-9-]|\\.(?![a-z0-9]))`, 'i').test(t)) return 'never-smoke'
    }
    return null
  }
  let host
  if (kind === 'url') {
    try { host = new URL(String(text)).hostname.toLowerCase() } catch { return 'unparseable url' }
  } else host = String(text ?? '').trim().toLowerCase()
  host = noDot(host)
  if (!host) return 'empty host'
  if (/prod/i.test(host)) return 'prod name'
  if (suffix && (host === suffix || host.endsWith(`.${suffix}`))) return 'prod suffix'
  if (never.includes(host)) return 'never-smoke'
  return null
}

// ─── Suite set (A-5) and attribution (A-6, A-17) ─────────────────────────────
// mergeDiffs: { hunt: [changed paths of its own merge commits] }. appMarkerDirs: top-level dirs
// holding the app marker file. fullSuitePaths: entries ending in `/` are dir prefixes, others
// exact files (or dir prefixes). A Red hunt or a full-suite path → full.
const underPath = (f, p) => (p.endsWith('/') ? f.startsWith(p) : (f === p || f.startsWith(`${p}/`)))
export function suiteSet(mergeDiffs, { tiers = {}, appMarkerDirs = [], fullSuitePaths = [] } = {}) {
  const apps = new Set(appMarkerDirs)
  const labels = new Set()
  const huntApps = {}
  const fullSuiteHunts = []
  const reasons = []
  let full = false
  for (const [hunt, files] of Object.entries(mergeDiffs || {})) {
    const mine = new Set()
    let touchesFull = false
    for (const f of files || []) {
      if (fullSuitePaths.some(p => underPath(f, p))) touchesFull = true
      const top = f.split('/')[0]
      if (f.includes('/') && apps.has(top)) mine.add(top)
    }
    huntApps[hunt] = [...mine].sort()
    for (const a of mine) labels.add(a)
    if (touchesFull) { fullSuiteHunts.push(hunt); full = true; reasons.push(`${hunt} touches a full-suite path`) }
    if (isRed(tiers[hunt])) { full = true; reasons.push(`${hunt} is Red`) }
  }
  const sorted = [...labels].sort()
  const reason = full ? `full suite: ${reasons.join('; ')}` : (sorted.length ? `touched apps: ${sorted.join(', ')}` : 'no app touched')
  return { labels: sorted, full, reason, hunt_apps: huntApps, full_suite_hunts: fullSuiteHunts }
}

// ids → candidates: the hunts whose app set holds the id's app (first dotted segment) PLUS every
// hunt that touched a full-suite path (it is exactly the class that triggered the full run).
export function attributeFailures(ids, huntApps = {}, fullSuiteHunts = []) {
  const attributed = []
  const unattributed = []
  for (const id of ids || []) {
    const app = String(id).split('.')[0]
    const hunts = Object.keys(huntApps).filter(h => (huntApps[h] || []).includes(app))
    for (const h of fullSuiteHunts) if (!hunts.includes(h)) hunts.push(h)
    if (hunts.length) attributed.push({ test_id: id, app, hunts })
    else unattributed.push(id)
  }
  return { attributed, unattributed }
}

// The verdict-output contract (docs/post-merge-stage.md): a line starting `NEW FAILURES`, then one
// test id per line until a blank line. A leading `- ` is tolerated.
export function parseNewFailures(text) {
  const lines = String(text || '').split(/\r?\n/)
  const i = lines.findIndex(l => /^NEW FAILURES/.test(l))
  if (i === -1) return []
  const out = []
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j].trim()
    if (!l) break
    out.push(l.replace(/^-\s+/, ''))
  }
  return out
}

// ─── Criteria and tenants (AC12, AC34) ───────────────────────────────────────
// hunts: [{slug, status, tier}]; readAcceptance(slug) → text | null. Campaign-merged hunts only.
export function criteriaSet(hunts, readAcceptance, { tenants } = {}) {
  const auto = []
  const manual = []
  const compliance = []
  const missing = []
  for (const h of hunts || []) {
    if (chainClass(h.status) !== 'campaign_merged') continue
    const text = readAcceptance(h.slug)
    if (text == null) { missing.push(h.slug); continue }
    for (const c of parseAcceptanceCriteria(text, h.slug, { tenants })) {
      const item = { ...c, hunt: h.slug, tier: normTier(h.tier) }
      if (c.tag === 'auto') auto.push(item)
      else if (c.tag === 'manual') manual.push(item)
      else compliance.push(item)
    }
  }
  return { auto, manual, compliance, missing }
}

// (criterion, tenant) pairs: each criterion on exactly the tenants its scope names; then every
// manifest flow (AC34), also by its own scope. An unconfigured tenant is a config error.
export function tenantPlan(criteria, tenants = {}, manifests = {}) {
  const names = Object.keys(tenants)
  const pairs = []
  const want = (c) => (c.tenant === 'both' || !c.tenant ? names : [c.tenant])
  const add = (c, manifest) => {
    for (const t of want(c)) {
      if (!(t in tenants)) throw new StageError(`Deployment Notes → Smoke tenants (${t}): no host configured for tenant ${t} (needed by ${c.ref})`, 'smoke_config_missing')
      pairs.push({ ref: c.ref, hunt: manifest ? MANIFEST_SLUG : (c.hunt || c.slug), text: c.text, tenant: t, host: tenants[t], key: `${c.ref}@${t}`, ...(manifest ? { manifest: true } : {}) })
    }
  }
  for (const c of criteria || []) add(c, false)
  for (const [t, list] of Object.entries(manifests || {})) {
    if (!(t in tenants)) throw new StageError(`Deployment Notes → Smoke tenants (${t}): no host configured for manifest tenant ${t}`, 'smoke_config_missing')
    for (const c of list || []) add(c, true)
  }
  return pairs
}

// AC15: a console-only criterion is needs_human_run; any auto_fail → FAIL; a 5xx anomaly → FAIL
// even when every criterion passed; any needs_human_run → PENDING; else PASS.
export function normaliseDisposition(c) {
  if (c && (c.needs_console === true || (typeof c.detail === 'string' && c.detail.toLowerCase().includes(CONSOLE_DETAIL)))) {
    return { ...c, disposition: 'needs_human_run', detail: CONSOLE_DETAIL }
  }
  return c
}
export function huntVerdict(criteria, anomalies = []) {
  const cs = (criteria || []).map(normaliseDisposition)
  if (cs.some(c => c.disposition === 'auto_fail' || c.disposition === 'manual_fail')) return 'FAIL'
  if ((anomalies || []).some(a => Number.isInteger(a.status) && a.status >= 500)) return 'FAIL'
  if (cs.some(c => c.disposition === 'needs_human_run')) return 'PENDING'
  return 'PASS'
}

// ─── Triage (AC18) ───────────────────────────────────────────────────────────
// finding: {kind: smoke|integration|anomaly|session|deploy|migrate, hunt|null, ref|test_id, tenant|null,
//   summary, evidence, model:{class, expected_from, cross_tenant}, http_status, prod_host, key}
// context: {tier, files, complianceRefs, fixRounds, mobilePassed, triageBlockPaths}
// Pure, ordered, first match wins. The reasoning is rendered from the rule, never model prose.
export const TRIAGE_RULES = Object.freeze([
  'deploy_or_migration', '5xx_or_cross_tenant', 'prod_host_touched', 'mobile_regression', 'money_medical_path',
  'red_compliance', 'fix_cap', 'needs_decision', 'uncertain_log_vs_block', 'session_drop', 'clear_defect', 'polish', 'default_block',
])
export function classifyFinding(finding, context = {}) {
  const f = finding || {}
  const m = f.model || {}
  const ctx = context || {}
  const what = f.ref || f.test_id || f.kind
  const key = f.key || (f.ref && f.tenant ? `${f.ref}@${f.tenant}` : null)
  const files = Array.isArray(ctx.files) ? ctx.files : []
  const blockPaths = (Array.isArray(ctx.triageBlockPaths) ? ctx.triageBlockPaths : []).map(p => (p.endsWith('/') ? p : `${p}/`))
  const out = (outcome, rule, reasoning) => {
    if (outcome === 'fix' && !f.hunt) return { outcome: 'block', rule: 'unattributed', reasoning: `${what}: no hunt to fix it in — blocks the campaign stage` }
    return { outcome, rule, reasoning }
  }
  if (f.kind === 'deploy' || f.kind === 'migrate') return out('block', 'deploy_or_migration', `${f.kind} failed: never smoked over`)
  if ((Number.isInteger(f.http_status) && f.http_status >= 500) || m.cross_tenant === true) {
    return out('block', '5xx_or_cross_tenant', m.cross_tenant === true ? `${what}: cross-tenant data seen` : `${what}: server error ${f.http_status}`)
  }
  if (f.prod_host === true) return out('block', 'prod_host_touched', `${what}: a refused (prod / never-smoke) host was visited`)
  if (f.tenant === 'mobile' && key && ctx.mobilePassed && Object.prototype.hasOwnProperty.call(ctx.mobilePassed, key)) {
    return out('block', 'mobile_regression', `${what}: passed on mobile in wave ${ctx.mobilePassed[key]}, fails now`)
  }
  if ((f.kind === 'smoke' || f.kind === 'integration') && files.some(p => blockPaths.some(b => p.startsWith(b)))) {
    return out('block', 'money_medical_path', `${what}: the hunt's merge touches a triage block path (${blockPaths.join(' ')})`)
  }
  if (isRed(ctx.tier) && f.ref && Array.isArray(ctx.complianceRefs) && ctx.complianceRefs.includes(f.ref)) {
    return out('block', 'red_compliance', `${what}: a Red hunt's compliance criterion failed`)
  }
  if (Number.isInteger(ctx.fixRounds) && ctx.fixRounds >= MAX_FIX_ROUNDS) return out('block', 'fix_cap', `${what}: ${ctx.fixRounds} fix rounds already ran (cap ${MAX_FIX_ROUNDS})`)
  if (m.class === 'needs_decision') return out('block', 'needs_decision', `${what}: needs a product decision`)
  if (m.class === 'uncertain') return out('block', 'uncertain_log_vs_block', `${what}: log vs block unclear — blocking`)
  if (f.kind === 'session') return out('log', 'session_drop', `${f.tenant || 'host'}: signed in before the deploy, signed out after (the post-deploy sign-out; prod-relevant)`)
  if ((m.class === 'fix' && m.expected_from && m.expected_from !== 'none') || f.kind === 'integration') {
    return out('fix', 'clear_defect', f.kind === 'integration' ? `${what}: a failing test is its own expected behaviour` : `${what}: clear defect (expected behaviour from ${m.expected_from})`)
  }
  if (m.class === 'log') return out('log', 'polish', `${what}: cosmetic / polish`)
  return out('block', 'default_block', `${what}: no clear expected behaviour (a product decision) — blocking`)
}

const normaliseSummary = (s) => String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
export function findingId(f) {
  const key = [f.kind, f.hunt || '-', f.tenant || '-', f.ref || f.test_id || '-', normaliseSummary(f.summary)].join('|')
  return `ISS-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`
}

// AC20: cookies, Authorization, csrftoken/sessionid and token-bearing query strings never reach
// the issue log or the report.
export function redact(text) {
  if (text == null) return text
  return String(text)
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi, '$1?[query removed]')
    .replace(/\b(set-cookie|cookie)\s*:\s*[^\n]*/gi, '$1: [REDACTED]')
    .replace(/\bauthorization\s*:\s*[^\n]*/gi, 'Authorization: [REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(/\b(sessionid|csrftoken|csrfmiddlewaretoken|session|token|access_token|refresh_token|id_token|code|key|api_key|password|secret|sig|signature)=([^;&\s"'<>]+)/gi, '$1=[REDACTED]')
}

// ─── AC23: review fingerprint lookup ─────────────────────────────────────────
// reviewFingerprints: metadata.review_fingerprints ({role: [roundEntry]}, or a legacy array =
// bloodhound). A review finding is a CANDIDATE when its fp symbol (the middle segment of
// role::symbol::claim_class) occurs as a whole word in the fix merge's diff, or its own `file`
// field is a path the diff changes. dispositions: {role: {round: revision-log text}}.
export function fingerprintLookup(finding, fixDiff = {}, reviewFingerprints, dispositions = {}) {
  if (reviewFingerprints == null || (typeof reviewFingerprints === 'object' && !Array.isArray(reviewFingerprints) && !Object.keys(reviewFingerprints).length)) {
    return { result: 'miss', note: '(no review ran)', candidate: null }
  }
  const byRole = Array.isArray(reviewFingerprints) ? { bloodhound: reviewFingerprints } : reviewFingerprints
  const text = String(fixDiff.text || '')
  const files = new Set(Array.isArray(fixDiff.files) ? fixDiff.files : [])
  const candidates = []
  for (const [role, rounds] of Object.entries(byRole)) {
    for (const [i, entry] of (Array.isArray(rounds) ? rounds : []).entries()) {
      if (!entry) continue
      const round = Number.isInteger(entry.round) ? entry.round : i + 1
      for (const rf of (Array.isArray(entry.findings) ? entry.findings : [])) {
        const segs = String(rf.fp || '').split('::')
        const symbol = segs.length === 3 ? segs[1] : null
        const bySymbol = symbol && new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(symbol)}($|[^A-Za-z0-9_])`).test(text)
        const byFile = typeof rf.file === 'string' && files.has(rf.file)
        if (bySymbol || byFile) candidates.push({ role, round, id: rf.id, title: rf.title || '', fp: rf.fp || '' })
      }
    }
  }
  if (!candidates.length) return { result: 'miss', note: null, candidate: null }
  const rejected = candidates.find(c => {
    const log = dispositions && dispositions[c.role] && dispositions[c.role][c.round]
    if (!log || c.id == null) return false
    return String(log).split('\n').some(l => new RegExp(`^\\s*(?:#+\\s*)?(?:Finding\\s+)?${escapeRe(c.id)}[.):]\\s.*\\bREJECTED\\b`, 'i').test(l))
  })
  if (rejected) return { result: 'wrong-rejection', note: null, candidate: rejected }
  return { result: 'raised-not-rejected', note: null, candidate: candidates[0] }
}
export const lookupLine = (r) => {
  if (r.result === 'miss') return `miss${r.note ? ` ${r.note}` : ''}`
  const c = r.candidate
  return `${r.result}: ${c.role} r${c.round} #${c.id} "${c.title}" (\`${c.fp}\`)`
}

// ─── Issue log (AC19) ────────────────────────────────────────────────────────
export const emptyStore = () => ({ schema: 1, entries: [] })
const ENTRY_FIELDS = ['id', 'wave', 'seen_waves', 'hunt', 'ref', 'tenant', 'kind', 'outcome', 'rule', 'reasoning', 'evidence', 'resolution', 'resolved_at']
// entries: [{id, wave, hunt, ref, tenant, kind, outcome, rule, reasoning, evidence, resolution?}].
// A known id keeps its entry (no duplicate); its seen_waves gains the wave. Returns {store, added}.
export function appendIssues(store, entries) {
  const s = store && Array.isArray(store.entries) ? store : emptyStore()
  let added = 0
  for (const e of entries || []) {
    const prior = s.entries.find(x => x.id === e.id)
    if (prior) {
      if (!prior.seen_waves.includes(e.wave)) prior.seen_waves.push(e.wave)
      continue
    }
    const entry = {}
    for (const k of ENTRY_FIELDS) entry[k] = null
    Object.assign(entry, {
      id: e.id, wave: e.wave, seen_waves: [e.wave], hunt: e.hunt ?? null, ref: e.ref ?? null, tenant: e.tenant ?? null,
      kind: e.kind, outcome: e.outcome, rule: e.rule, reasoning: redact(e.reasoning), evidence: redact(e.evidence ?? null),
      resolution: e.resolution ?? null, resolved_at: e.resolution ? (e.resolved_at || nowIso()) : null,
    })
    s.entries.push(entry)
    added++
  }
  return { store: s, added }
}
export function resolveIssue(store, id, resolution, at = nowIso()) {
  const e = (store && store.entries || []).find(x => x.id === id)
  if (!e) throw new StageError(`unknown issue id ${id}`)
  e.resolution = resolution
  e.resolved_at = at
  return e
}
export function renderIssueLog(store, campaign = '') {
  const lines = [`# Issue log${campaign ? `: ${campaign}` : ''}`, '',
    'Written by the chain-mode post-merge stage (docs/post-merge-stage.md). Re-rendered from issue-log.json on every write; do not edit by hand.', '']
  const entries = (store && store.entries) || []
  if (!entries.length) lines.push('No findings.')
  for (const e of entries) {
    lines.push(`## ${e.id} — ${e.outcome} (${e.rule})`)
    lines.push(`- wave: ${e.wave} (seen: ${e.seen_waves.join(', ')})`)
    lines.push(`- hunt: ${e.hunt || '(campaign)'} · ref: ${e.ref || '-'} · tenant: ${e.tenant || '-'} · kind: ${e.kind}`)
    lines.push(`- reasoning: ${e.reasoning}`)
    lines.push(`- evidence: ${e.evidence || '-'}`)
    lines.push(`- resolution: ${e.resolution || 'open'}${e.resolved_at ? ` (${e.resolved_at})` : ''}`)
    lines.push('')
  }
  return lines.join('\n')
}

// Open `log` items the polish wave takes: open resolution, a campaign-merged hunt, never a
// session item (that one goes to Cecil). Returns {items, open_set}.
export function openPolishSet(store, statuses = {}) {
  const items = ((store && store.entries) || []).filter(e =>
    e.outcome === 'log' && e.resolution == null && e.kind !== 'session' && e.hunt &&
    chainClass(statuses[e.hunt]) === 'campaign_merged')
  const ids = items.map(e => e.id).sort()
  return { items, open_set: ids.length ? createHash('sha1').update(ids.join(',')).digest('hex') : null }
}

// ─── Stage state ─────────────────────────────────────────────────────────────
const campDir = (root, c) => join(root, '.wolfpack', 'campaigns', c)
export const statePath = (root, c) => join(campDir(root, c), 'smoke-stage.json')
export const issueJsonPath = (root, c) => join(campDir(root, c), 'issue-log.json')
export const issueMdPath = (root, c) => join(campDir(root, c), 'issue-log.md')
export const waveStageDir = (root, c, n) => join(campDir(root, c), 'stage', `wave-${n}`)
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
function writeAtomic(p, text) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, p)
}
export function loadState(root, c) {
  const p = statePath(root, c)
  if (!existsSync(p)) return null
  const s = readJson(p)
  if (!s || s.schema !== 1) throw new StageError(`${p}: unknown schema`)
  return s
}
export function saveState(root, c, s) { writeAtomic(statePath(root, c), `${JSON.stringify(s, null, 2)}\n`) }
export function loadStore(root, c) {
  const p = issueJsonPath(root, c)
  return existsSync(p) ? readJson(p) : emptyStore()
}
export function saveStore(root, c, store) {
  writeAtomic(issueJsonPath(root, c), `${JSON.stringify(store, null, 2)}\n`)
  writeAtomic(issueMdPath(root, c), `${renderIssueLog(store, c)}\n`)
}
export function newCurrent({ wave, tip, merged = [], iteration = 1, fixRounds = {}, polish = null }) {
  return {
    wave, step: 'begin', campaign_sha: tip, iteration, merged: [...merged], polish,
    fix_rounds: { ...fixRounds }, result: null,
    deploy_attempts: { deploy: 0, migrate: 0 }, integration_attempts: 0, busy_retries: 0, smoke_attempts: 0,
    sessions: { before: {}, after: {} }, findings: [], notices: [], pending: { fix: {}, block: {} }, block_text: {},
    fix_merges: [], suites: null, suites_override: null, wave_dir: null, deployed_sha: null, report_url: null,
    park: null, park_history: [], smoke_worktree: null,
  }
}
// A new iteration at `tip`: the per-iteration fields reset; fix_rounds, mobile memory and the
// park history are kept.
export function resetIteration(cur, tip, { bump = false } = {}) {
  if (bump) cur.iteration += 1
  cur.step = 'begin'
  cur.campaign_sha = tip
  cur.findings = []
  cur.pending = { fix: {}, block: {} }
  cur.block_text = {}
  cur.deploy_attempts = { deploy: 0, migrate: 0 }
  cur.integration_attempts = 0
  cur.busy_retries = 0
  cur.smoke_attempts = 0
  cur.sessions = { before: { ...cur.sessions.before, ...cur.sessions.after }, after: {} }
  cur.suites = null
  cur.deployed_sha = null
  return cur
}
const ATTEMPT_OF_STEP = { deploy: ['deploy_attempts', 'deploy'], migrate: ['deploy_attempts', 'migrate'], integration: ['integration_attempts'], smoke: ['smoke_attempts'] }
// Re-arm (parked → running): the relaunch after Cecil cleared a blocker.
export function rearm(cur, at = nowIso()) {
  const code = String(cur.result).slice('parked:'.length)
  cur.park_history = [...(cur.park_history || []), { code, detail: cur.park ? cur.park.detail : null, step: cur.step, campaign_sha: cur.campaign_sha, at }]
  const parkedStep = cur.park && cur.park.at_step
  const attempt = ATTEMPT_OF_STEP[parkedStep]
  if (attempt && attempt.length === 2) cur[attempt[0]][attempt[1]] = 0
  else if (attempt) cur[attempt[0]] = 0
  if (parkedStep === 'integration') cur.busy_retries = 0
  cur.result = null
  cur.park = null
  return code
}

// ─── Host I/O helpers ────────────────────────────────────────────────────────
const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function ctx(campaign) {
  if (!SLUG_RE.test(String(campaign || ''))) throw new StageError('--campaign <slug> is required')
  const root = repoRoot()
  const cfg = loadConfig(join(root, 'wolfpack-config.md'))
  const branch = `campaign/${campaign}`
  return { root, cfg, campaign, branch }
}
const tipOf = (c) => {
  if (!branchExists(c.root, c.branch)) throw new StageError(`${c.branch} does not exist`)
  return revParse(c.root, `refs/heads/${c.branch}`)
}
function requireCurrent(c, s) {
  if (!s || !s.current) throw new StageError(`no stage state for ${c.campaign} — run begin first`)
  if (s.current.result != null) throw new StageError(`the stage is ${s.current.result} — begin/re-arm first`)
  return s.current
}
function requireTip(c, cur) {
  const tip = tipOf(c)
  if (tip !== cur.campaign_sha) throw new StageError(`${c.branch} moved (${String(cur.campaign_sha).slice(0, 12)} → ${tip.slice(0, 12)}) — restart the stage at deploy`, 'tip_moved')
  return tip
}
const markStep = (cur, step) => {
  if (STEPS.indexOf(step) > STEPS.indexOf(cur.step)) cur.step = step
}
// Run a shell command; its output goes to logPath (never this CLI's stdout). → {exit, last}
function runLogged(cmd, cwd, logPath, env = process.env) {
  mkdirSync(dirname(logPath), { recursive: true })
  const r = spawnSync('bash', ['-c', `exec </dev/null\n${cmd}`], { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const text = `${r.stdout || ''}${r.stderr || ''}`
  writeFileSync(logPath, text)
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  return { exit: r.status == null ? -1 : r.status, last: lines[lines.length - 1] || '', stdout: r.stdout || '', stderr: r.stderr || '', text }
}
const subst = (tmpl, vals) => String(tmpl).replace(/\{([a-z_]+)\}/g, (m, k) => (k in vals ? shq(vals[k]) : m))
function guardCommand(c, written, cmd) {
  const why = refuseProdTarget(cmd, c.cfg, { kind: 'command', mask: c.campaign })
  if (why) throw new StageError(`${written}: refused (${why}) — nothing executed`, 'smoke_config_missing', { key: written })
}
// A detached temp worktree named wolfpack-stage-* (begin prunes stale ones).
function addStageWorktree(root, ref, tag) {
  const parent = mkdtempSync(join(tmpdir(), `wolfpack-stage-${tag}-`))
  const dir = join(parent, 'wt')
  git(['worktree', 'add', '--quiet', '--detach', dir, ref], { cwd: root })
  return dir
}
function removeStageWorktree(root, dir) {
  if (!dir) return
  git(['worktree', 'remove', '--force', dir], { cwd: root, allowFail: true })
  try { rmSync(dirname(dir), { recursive: true, force: true }) } catch { /* best effort */ }
  git(['worktree', 'prune'], { cwd: root, allowFail: true })
}
function withStageWorktree(root, ref, tag, fn) {
  const dir = addStageWorktree(root, ref, tag)
  try { return fn(dir) } finally { removeStageWorktree(root, dir) }
}
function pruneStageWorktrees(root) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd: root }).stdout
  const pruned = []
  for (const block of out.split(/\n\s*\n/)) {
    const wt = block.split('\n').find(l => l.startsWith('worktree '))
    if (!wt) continue
    const p = wt.slice('worktree '.length).trim()
    if (basename(dirname(p)).startsWith('wolfpack-stage-')) { removeStageWorktree(root, p); pruned.push(p) }
  }
  return pruned
}
function linkWorktree(main, dir, links) {
  for (const l of links || []) {
    const src = join(main, l)
    const dst = join(dir, l)
    if (!existsSync(src) || existsSync(dst)) continue
    mkdirSync(dirname(dst), { recursive: true })
    symlinkSync(src, dst)
  }
}
const diffNames = (root, m) => git(['diff', '--name-only', `${m}^1`, m], { cwd: root }).stdout.split('\n').filter(Boolean)
// The hunts of the campaign with their metadata.
function campaignState(c) {
  const meta = readCampaignMeta(c.root, c.campaign)
  if (!meta) throw new StageError(`.wolfpack/campaigns/${c.campaign}/metadata.json not found`)
  const slugs = campaignHunts(meta)
  const hunts = slugs.map(slug => { const { meta: m } = readHuntMeta(c.root, slug); return { slug, meta: m || {}, status: m ? m.status : 'missing', tier: m && m.tier } })
  return { meta, hunts }
}
const readAcceptanceFor = (root) => (slug) => {
  const d = huntPlanDirs(root, slug)
  for (const dir of [d.worktreePlanDir, d.mainPlanDir]) {
    if (dir && existsSync(join(dir, 'acceptance.md'))) return readFileSync(join(dir, 'acceptance.md'), 'utf8')
  }
  return null
}
// The merge commits of the hunts this stage run covers (own + smoke-fix merges), with their tiers.
function mergedDiffs(c, cur) {
  const diffs = {}
  const tiers = {}
  if (cur.polish && cur.polish.merge_commit) {
    diffs[cur.polish.slug] = diffNames(c.root, cur.polish.merge_commit)
    tiers[cur.polish.slug] = 'Blue'
    return { diffs, tiers }
  }
  for (const h of cur.merged || []) {
    const { meta } = readHuntMeta(c.root, h)
    if (!meta) throw new StageError(`no metadata.json for merged hunt ${h}`)
    const commits = []
    if (meta.campaign_merge_commit) commits.push(meta.campaign_merge_commit)
    for (const fx of (Array.isArray(meta.smoke_fixes) ? meta.smoke_fixes : [])) if (fx && fx.merge_commit) commits.push(fx.merge_commit)
    diffs[h] = [...new Set(commits.flatMap(m => diffNames(c.root, m)))]
    tiers[h] = meta.tier
  }
  return { diffs, tiers }
}
function appMarkerDirs(c, sha) {
  const marker = c.cfg.appMarkerFile
  if (!marker) return []
  const tops = git(['ls-tree', '--name-only', '-d', sha], { cwd: c.root }).stdout.split('\n').filter(Boolean)
  return tops.filter(d => git(['cat-file', '-e', `${sha}:${d}/${marker}`], { cwd: c.root, allowFail: true }).code === 0)
}
const tenantNames = (cfg) => Object.keys(cfg.smokeTenants || {})
function readManifests(c) {
  const out = {}
  for (const [t, path] of Object.entries(c.cfg.smokeManifests || {})) {
    const abs = isAbsolute(path) ? path : join(c.root, path)
    if (!existsSync(abs)) throw new StageError(`Deployment Notes → Smoke tenant manifests (${t}): ${path} not found`, 'smoke_config_missing')
    let crit
    try { crit = parseAcceptanceCriteria(readFileSync(abs, 'utf8'), MANIFEST_SLUG, { tenants: tenantNames(c.cfg) }) } catch (e) {
      if (e instanceof CriteriaError) throw new StageError(`Deployment Notes → Smoke tenant manifests (${t}): ${e.message}`, 'smoke_config_missing')
      throw e
    }
    out[t] = crit.filter(x => x.tag === 'auto')
  }
  return out
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

// AC13 / AC6: every stage key present, every tenant host allowed, every command template allowed —
// all before any deploy or browser call.
export function checkConfig(cfg) {
  const problems = []
  if (!cfg.postMergeStage) return { ok: true, postMergeStage: false, problems }
  for (const [field, written, required] of STAGE_KEYS) {
    if (!required) continue
    const v = cfg[field]
    const empty = v == null || v === '' || (Array.isArray(v) && !v.length && field !== 'neverSmokeHosts') ||
      (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length && field !== 'smokeManifests')
    if (empty) problems.push(`${written}: missing`)
  }
  const tenants = cfg.smokeTenants || {}
  for (const t of Object.keys(cfg.smokeManifests || {})) {
    if (!(t in tenants)) problems.push(`Deployment Notes → Smoke tenants (${t}): missing (the ${t} manifest needs a host)`)
  }
  for (const [t, host] of Object.entries(tenants)) {
    const why = refuseProdTarget(host, cfg, { kind: 'host' })
    if (why) problems.push(`Deployment Notes → Smoke tenants (${t}): host ${host} refused (${why})`)
  }
  const COMMANDS = [
    ['testCommand', 'Project Identity → Test command'], ['testVerdictCommand', 'Project Identity → Test verdict command'],
    ['integrationTestArgs', 'Project Identity → Integration test args'], ['devDeployCommand', 'Deployment Notes → Dev deploy command'],
    ['migrateCommand', 'Deployment Notes → Migration command'], ['smokeTenantEnsureCommand', 'Deployment Notes → Smoke tenant ensure command'],
    ['waveReportDirCommand', 'Deployment Notes → Wave report dir command'], ['waveReportBuildCommand', 'Deployment Notes → Wave report build command'],
    ['campaignReportCommand', 'Deployment Notes → Campaign report command'], ['reportUrlCommand', 'Deployment Notes → Report URL command'],
    ['smokeLoginHook', 'Deployment Notes → Smoke login hook'],
  ]
  for (const [field, written] of COMMANDS) {
    if (typeof cfg[field] !== 'string' || !cfg[field]) continue
    const why = refuseProdTarget(cfg[field], cfg, { kind: 'command' })
    if (why) problems.push(`${written}: refused (${why})`)
  }
  if (cfg.migrationFilePattern) {
    try { new RegExp(cfg.migrationFilePattern) } catch (e) { problems.push(`Deployment Notes → Migration file pattern: not a regex (${e.message})`) }
  }
  return { ok: problems.length === 0, postMergeStage: true, problems }
}
function cmdCheckConfig(c) {
  const r = checkConfig(c.cfg)
  if (c.cfg.problems && c.cfg.problems.length) r.problems.push(...c.cfg.problems.filter(p => /Smoke tenants|Post-merge smoke stage|Smoke tenant manifests/.test(p)))
  if (r.problems.length) throw new StageError(`post-merge stage config: ${r.problems.join('; ')}`, 'smoke_config_missing', { problems: r.problems })
  return { status: 'ok', post_merge_stage: r.postMergeStage, tenants: c.cfg.smokeTenants || {} }
}

function cmdBegin(c, f) {
  const pruned = pruneStageWorktrees(c.root)
  const tip = tipOf(c)
  let s = loadState(c.root, c.campaign)
  if (f['resume-only'] === true) {
    let created = false
    let notStagedBelow = null
    if (!s) {
      const next = Number.parseInt(f['next-wave'], 10)
      const open = String(f['open-waves'] || '').split(',').map(x => Number.parseInt(x, 10)).filter(Number.isInteger)
      const cands = [next, ...open].filter(Number.isInteger)
      const from = cands.length ? Math.min(...cands) : 1
      s = { schema: 1, campaign: c.campaign, staged_from_wave: from, current: null, waves: {}, mobile_passed: {}, polish: [], report_url: null }
      created = true
      if (from > 1) notStagedBelow = from
      saveState(c.root, c.campaign, s)
    }
    let rearmed = null
    if (s.current && typeof s.current.result === 'string' && s.current.result.startsWith('parked:')) {
      rearmed = rearm(s.current)
      saveState(c.root, c.campaign, s)
    }
    let mergedByWave = {}
    if (typeof f['merged-by-wave'] === 'string' && f['merged-by-wave'].trim()) {
      try { mergedByWave = JSON.parse(f['merged-by-wave']) } catch (e) { throw new StageError(`--merged-by-wave is not JSON: ${e.message}`) }
    }
    const unstaged = Object.entries(mergedByWave)
      .map(([w, slugs]) => ({ wave: Number.parseInt(w, 10), merged: (slugs || []).filter(x => SLUG_RE.test(x)) }))
      .filter(x => Number.isInteger(x.wave) && x.merged.length && x.wave >= s.staged_from_wave && !s.waves[String(x.wave)] && !(s.current && s.current.wave === x.wave))
      .sort((a, b) => a.wave - b.wave)
    const cur = s.current
    return {
      status: 'ok', action: 'resume-only', created, staged_from_wave: s.staged_from_wave, not_staged_below: notStagedBelow,
      rearmed, unstaged, pruned,
      current: cur ? { wave: cur.wave, step: cur.step, result: cur.result, campaign_sha: cur.campaign_sha, iteration: cur.iteration, polish: cur.polish ? cur.polish.slug : null } : null,
      tip,
    }
  }
  const wave = Number.parseInt(f.wave, 10)
  if (!Number.isInteger(wave) || wave < 1) throw new StageError('--wave <n> is required')
  if (!s) s = { schema: 1, campaign: c.campaign, staged_from_wave: wave, current: null, waves: {}, mobile_passed: {}, polish: [], report_url: null }
  const merged = String(f.merged || '').split(',').map(x => x.trim()).filter(Boolean)
  for (const m of merged) if (!SLUG_RE.test(m)) throw new StageError(`--merged: bad slug ${m}`)
  if (typeof f.polish === 'string') {
    if (!SLUG_RE.test(f.polish)) throw new StageError('--polish <slug> is required')
    const cm = readCampaignMeta(c.root, c.campaign) || {}
    const pm = cm.stage && cm.stage.polish_merge_commit
    if (!pm || cm.stage.polish_slug !== f.polish) throw new StageError(`${f.polish} has no recorded polish merge (campaign metadata stage.polish_merge_commit)`)
    const prev = s.current
    const issues = (s.polish.find(p => p.slug === f.polish) || {}).issues || []
    s.current = newCurrent({ wave, tip, iteration: (prev ? prev.iteration : 0) + 1, fixRounds: prev ? prev.fix_rounds : {}, polish: { slug: f.polish, merge_commit: pm, issues } })
    s.current.sessions.before = prev ? { ...prev.sessions.after } : {}
    saveState(c.root, c.campaign, s)
    return { status: 'ok', action: 'new', wave, step: 'begin', campaign_sha: tip, iteration: s.current.iteration, merged: [], polish: f.polish, polish_merge: pm, polish_issues: issues, pruned }
  }
  const cur = s.current
  if (merged.length) {
    if (cur && cur.result == null && cur.wave === wave) {
      // More merges for the wave being staged: widen it and restart at deploy.
      cur.merged = [...new Set([...cur.merged, ...merged])]
      resetIteration(cur, tip)
      saveState(c.root, c.campaign, s)
      return { status: 'ok', action: 'restart', wave, step: 'begin', campaign_sha: tip, iteration: cur.iteration, merged: cur.merged, polish: null, pruned }
    }
    const fixRounds = cur ? cur.fix_rounds : {}
    s.current = newCurrent({ wave, tip, merged, iteration: 1, fixRounds })
    saveState(c.root, c.campaign, s)
    return { status: 'ok', action: 'new', wave, step: 'begin', campaign_sha: tip, iteration: 1, merged, polish: null, pruned }
  }
  if (!cur || cur.result != null || cur.wave !== wave) {
    return { status: 'ok', action: 'nothing', wave, reason: s.waves[String(wave)] ? `wave ${wave} already staged (${s.waves[String(wave)].result})` : 'nothing new', pruned }
  }
  const extra = { merged: cur.merged, polish: cur.polish ? cur.polish.slug : null, polish_merge: cur.polish ? cur.polish.merge_commit : null, polish_issues: cur.polish ? cur.polish.issues : [] }
  if (cur.campaign_sha === tip) return { status: 'ok', action: 'resume', wave, step: cur.step, campaign_sha: tip, iteration: cur.iteration, ...extra, pruned }
  resetIteration(cur, tip)
  saveState(c.root, c.campaign, s)
  return { status: 'ok', action: 'restart', wave, step: 'begin', campaign_sha: tip, iteration: cur.iteration, ...extra, pruned }
}

function cmdSession(c, f) {
  const when = f.when
  if (!['before', 'after'].includes(when)) throw new StageError('--when before|after is required')
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const hook = c.cfg.smokeLoginHook
  if (!hook) throw new StageError('Deployment Notes → Smoke login hook: missing', 'smoke_config_missing')
  const account = (c.cfg.smokeLoginAccounts || [])[0] || ''
  const sessions = {}
  const problems = []
  for (const [tenant, host] of Object.entries(c.cfg.smokeTenants || {})) {
    const hw = refuseProdTarget(host, c.cfg, { kind: 'host' })
    if (hw) { problems.push({ tenant, host, kind: 'refused', detail: `host refused (${hw})` }); continue }
    const cmd = `${subst(hook, { host, account })} --check`
    const cw = refuseProdTarget(cmd, c.cfg, { kind: 'command', mask: c.campaign })
    if (cw) { problems.push({ tenant, host, kind: 'refused', detail: `Smoke login hook refused (${cw})` }); continue }
    const r = runLogged(cmd, c.root, join(waveStageDir(c.root, c.campaign, cur.wave), `session-${when}-${tenant}.log`))
    const first = (r.stdout.split('\n').map(l => l.trim()).find(Boolean) || '').split(/\s+/)[0]
    if (first === 'SIGNED_IN' || first === 'SIGNED_OUT') sessions[host] = first
    else if (first === 'REFUSED' || r.exit === 2) problems.push({ tenant, host, kind: 'refused', detail: redact(r.last).slice(0, 200) })
    else problems.push({ tenant, host, kind: 'unreachable', detail: redact(r.last).slice(0, 200) || `exit ${r.exit}` })
  }
  cur.sessions[when] = { ...cur.sessions[when], ...sessions }
  const drops = []
  if (when === 'after') {
    for (const [tenant, host] of Object.entries(c.cfg.smokeTenants || {})) {
      if (cur.sessions.before[host] === 'SIGNED_IN' && sessions[host] === 'SIGNED_OUT') {
        drops.push(host)
        const finding = {
          kind: 'session', hunt: null, ref: `session@${host}`, tenant, key: null,
          summary: `signed out after the deploy on ${host}`, evidence: `session-after-${tenant}.log`, model: {},
        }
        finding.id = findingId(finding)
        if (!cur.findings.some(x => x.id === finding.id)) cur.findings.push(finding)
      }
    }
    if (!problems.length) markStep(cur, 'session')
  }
  saveState(c.root, c.campaign, s)
  return { status: 'ok', when, sessions, problems, session_drops: drops }
}

function cmdDeployStep(c, step) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const tip = requireTip(c, cur)
  const written = step === 'deploy' ? 'Deployment Notes → Dev deploy command' : 'Deployment Notes → Migration command'
  const cmd = step === 'deploy' ? c.cfg.devDeployCommand : c.cfg.migrateCommand
  if (!cmd) throw new StageError(`${written}: missing`, 'smoke_config_missing')
  guardCommand(c, written, cmd)
  if (step === 'migrate' && cur.deployed_sha !== tip) {
    throw new StageError(`refusing migrate: the deployed SHA ${String(cur.deployed_sha).slice(0, 12)} is not the tip ${tip.slice(0, 12)} — deploy first`, 'tip_moved')
  }
  const logPath = join(waveStageDir(c.root, c.campaign, cur.wave), `${step}-i${cur.iteration}.log`)
  const r = withStageWorktree(c.root, tip, step, (dir) => runLogged(cmd, dir, logPath))
  const out = { status: 'ok', step, exit: r.exit, sha: tip, log: logPath, last_line: redact(r.last).slice(0, 300) }
  if (r.exit === 0) {
    if (step === 'deploy') cur.deployed_sha = tip
    markStep(cur, step)
  } else {
    cur.deploy_attempts[step] = (cur.deploy_attempts[step] || 0) + 1
    out.attempts = cur.deploy_attempts[step]
    if (step === 'migrate') {
      const pattern = c.cfg.migrationFilePattern ? new RegExp(c.cfg.migrationFilePattern) : null
      const { diffs } = mergedDiffs(c, cur)
      const migrating = pattern ? Object.keys(diffs).filter(h => diffs[h].some(p => pattern.test(p))) : []
      out.migrating_hunts = migrating
      for (const h of migrating) {
        const others = migrating.filter(x => x !== h)
        const finding = {
          kind: 'migrate', hunt: h, ref: `migrate@${h}`, tenant: null, key: null,
          summary: `the migrate step failed (exit ${r.exit}) with ${h}'s migrations in the wave`,
          evidence: logPath, model: {}, blocked_with: others,
        }
        finding.id = findingId(finding)
        if (!cur.findings.some(x => x.id === finding.id)) cur.findings.push(finding)
      }
    }
  }
  saveState(c.root, c.campaign, s)
  return out
}

function cmdEnsure(c) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  requireTip(c, cur)
  const written = 'Deployment Notes → Smoke tenant ensure command'
  const cmd = c.cfg.smokeTenantEnsureCommand
  if (!cmd) throw new StageError(`${written}: missing`, 'smoke_config_missing')
  guardCommand(c, written, cmd)
  const logPath = join(waveStageDir(c.root, c.campaign, cur.wave), `ensure-i${cur.iteration}.log`)
  const r = runLogged(cmd, c.root, logPath)
  const notices = []
  // A-12: a report-only notice (never a finding). The text is the command's own line, so the
  // pack never names a project's tenant.
  const m = CAPABILITY_NOTICE_RE.exec(r.text)
  if (m) {
    const line = r.text.slice(m.index).split('\n')[0].replace(/^WARNING\s+/, '').trim()
    notices.push({ kind: 'notice', text: redact(line).slice(0, 300) })
  }
  if (r.exit === 0) {
    cur.notices = notices
    markStep(cur, 'ensure')
  }
  saveState(c.root, c.campaign, s)
  return { status: 'ok', exit: r.exit, notices, last_line: redact(r.last).slice(0, 300), log: logPath }
}

function computeSuites(c, cur) {
  if (cur.suites_override) return cur.suites_override
  const { diffs, tiers } = mergedDiffs(c, cur)
  return suiteSet(diffs, { tiers, appMarkerDirs: appMarkerDirs(c, cur.campaign_sha), fullSuitePaths: c.cfg.integrationFullSuitePaths || [] })
}
function cmdSuites(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  if (typeof f.polish === 'string' && (!cur.polish || cur.polish.slug !== f.polish)) throw new StageError(`the current stage run is not the polish iteration of ${f.polish}`)
  const r = computeSuites(c, cur)
  cur.suites = r
  if (!r.full && !r.labels.length) markStep(cur, 'integration')   // nothing to run: the step is done
  saveState(c.root, c.campaign, s)
  const record = r.full ? 'ALL' : r.labels.join(',')
  const integration = c.cfg.integrationTestArgs
  const command = (r.full || r.labels.length) ? `${c.cfg.testCommand} ${subst(integration, { campaign: c.campaign })}${r.full ? '' : ` ${r.labels.join(' ')}`}` : null
  if (command) guardCommand(c, 'Project Identity → Test command', command)
  return { status: 'ok', ...r, record_labels: (r.full || r.labels.length) ? record : null, command, empty: !r.full && !r.labels.length }
}

function cmdIngestIntegration(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const dir = waveStageDir(c.root, c.campaign, cur.wave)
  const p = join(dir, 'test-record-integration.json')
  if (!existsSync(p)) throw new StageError(`${p} not found — take the integration record first`)
  const rec = readJson(p)
  if (rec.commit !== cur.campaign_sha) throw new StageError(`the integration record is for ${String(rec.commit).slice(0, 12)}, the stage tip is ${String(cur.campaign_sha).slice(0, 12)}`, 'tip_moved')
  const warnings = []
  if (Number.isFinite(rec.duration_ms) && rec.duration_ms > SUITE_RESERVE_MIN * 60 * 1000) {
    warnings.push(`⚠ integration: record took ${Math.round(rec.duration_ms / 60000)} min (> suite reserve ${SUITE_RESERVE_MIN}; re-derive A-8)`)
  }
  const done = (obj) => { saveState(c.root, c.campaign, s); return { status: 'ok', warnings, ...obj } }
  if (rec.tempfail === true) {
    cur.busy_retries = (cur.busy_retries || 0) + 1
    if (cur.busy_retries > MAX_BUSY_RETRIES) return done({ action: 'park', code: 'integration_infra', reason: 'test DB busy', busy_retries: cur.busy_retries })
    return done({ action: 'retake', busy: true, busy_retries: cur.busy_retries })
  }
  cur.busy_retries = 0
  if (rec.pass === true) { markStep(cur, 'integration'); return done({ action: 'pass', findings: 0 }) }
  const verdictText = rec.verdict_log && existsSync(rec.verdict_log) ? readFileSync(rec.verdict_log, 'utf8') : ''
  const ids = parseNewFailures(verdictText)
  const failureClass = rec.timed_out ? 'infra' : (rec.verdict_exit === 1 && ids.length ? 'new_failures' : (rec.verdict_exit == null && ids.length ? 'new_failures' : 'infra'))
  if (failureClass === 'infra') {
    cur.integration_attempts = (cur.integration_attempts || 0) + 1
    if (cur.integration_attempts >= 2) return done({ action: 'park', code: 'integration_infra', reason: rec.reason || `verdict exit ${rec.verdict_exit}`, attempts: cur.integration_attempts })
    return done({ action: 'retake', busy: false, attempts: cur.integration_attempts, reason: rec.reason || null })
  }
  const sx = cur.suites || computeSuites(c, cur)
  let attributed
  let unattributed
  if (cur.polish && cur.polish.slug) {
    attributed = ids.map(id => ({ test_id: id, app: String(id).split('.')[0], hunts: [cur.polish.slug] }))
    unattributed = []
  } else ({ attributed, unattributed } = attributeFailures(ids, sx.hunt_apps || {}, sx.full_suite_hunts || []))
  if (unattributed.length) return done({ action: 'park', code: 'integration_unattributed', reason: `failing test(s) no wave hunt touched: ${unattributed.join(', ')}`, ids: unattributed })
  let n = 0
  for (const a of attributed) {
    for (const h of a.hunts) {
      const finding = { kind: 'integration', hunt: h, test_id: a.test_id, ref: null, tenant: null, key: null, summary: `${a.test_id} fails`, evidence: a.test_id, model: {} }
      finding.id = findingId(finding)
      if (!cur.findings.some(x => x.id === finding.id)) { cur.findings.push(finding); n++ }
    }
  }
  markStep(cur, 'integration')
  return done({ action: 'findings', findings: n, ids })
}

const TEST_ID_IN_TEXT = /\b([a-z_][a-z0-9_]*)\.tests?(?:\.[A-Za-z0-9_]+)+(?:::[A-Za-z0-9_]+)?/g
function cmdPlanSmoke(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const sha = f.sha
  if (!SHA_RE.test(String(sha || '')) || sha !== cur.campaign_sha) throw new StageError(`--sha must be the stage tip ${cur.campaign_sha}`)
  const chk = checkConfig(c.cfg)
  if (!chk.ok) throw new StageError(`post-merge stage config: ${chk.problems.join('; ')}`, 'smoke_config_missing', { problems: chk.problems })
  const testCommand = `${c.cfg.testCommand} ${subst(c.cfg.integrationTestArgs, { campaign: c.campaign })}`
  guardCommand(c, 'Project Identity → Test command', testCommand)
  const { hunts } = campaignState(c)
  const tenants = c.cfg.smokeTenants || {}
  let cs
  try { cs = criteriaSet(hunts.map(h => ({ slug: h.slug, status: h.status, tier: h.tier })), readAcceptanceFor(c.root), { tenants: Object.keys(tenants) }) } catch (e) {
    if (e instanceof CriteriaError) throw new StageError(`acceptance criteria: ${e.message}`, 'stage_cli_error')
    throw e
  }
  const pairs = tenantPlan(cs.auto, tenants, readManifests(c))
  const wdCmd = subst(c.cfg.waveReportDirCommand, { campaign: c.campaign, wave: String(cur.wave) })
  guardCommand(c, 'Deployment Notes → Wave report dir command', wdCmd)
  const dir = waveStageDir(c.root, c.campaign, cur.wave)
  const wd = runLogged(wdCmd, c.root, join(dir, 'wave-dir.log'))
  const waveDir = (wd.stdout.split('\n').map(l => l.trim()).filter(Boolean).pop() || '').replace(/\/+$/, '')
  if (wd.exit !== 0 || !waveDir || !isAbsolute(waveDir)) {
    throw new StageError(`Deployment Notes → Wave report dir command failed: ${redact(wd.last) || `exit ${wd.exit}`}`, 'smoke_config_missing', { key: 'Deployment Notes → Wave report dir command', detail: redact(wd.stderr.split('\n').filter(Boolean).pop() || wd.last) })
  }
  try { mkdirSync(join(waveDir, 'shots'), { recursive: true }); writeFileSync(join(waveDir, '.write-check'), ''); rmSync(join(waveDir, '.write-check')) } catch (e) {
    throw new StageError(`Deployment Notes → Wave report dir command: ${waveDir} is not writable (${e.message})`, 'smoke_config_missing', { key: 'Deployment Notes → Wave report dir command', detail: e.message })
  }
  const shots = join(c.root, '.wolfpack', 'smoke-shots', `${c.campaign}-wave-${cur.wave}`)
  rmSync(shots, { recursive: true, force: true })
  mkdirSync(shots, { recursive: true })
  // A-16: a criterion whose check is a test id the integration run already covers is not run twice.
  const sx = cur.suites || { labels: [], full: false }
  const covered = {}
  for (const p of pairs) {
    for (const m of String(p.text).matchAll(TEST_ID_IN_TEXT)) {
      if (sx.full || (sx.labels || []).includes(m[1])) { covered[p.key] = m[0]; break }
    }
  }
  const sha12 = sha.slice(0, 12)
  const plan = {
    schema: 1, campaign: c.campaign, wave: cur.wave, iteration: cur.iteration, sha, sha12,
    tenants, accounts: c.cfg.smokeLoginAccounts || [], login_hook: c.cfg.smokeLoginHook,
    pairs: pairs.map(p => ({ ...p, ...(covered[p.key] ? { covered_by_integration: covered[p.key] } : {}) })),
    manual: cs.manual.map(m => ({ ref: m.ref, hunt: m.hunt, text: m.text })),
    compliance: cs.compliance.map(m => ({ ref: m.ref, hunt: m.hunt, text: m.text })),
    missing_acceptance: cs.missing,
    wave_dir: waveDir, shots_dir: shots, test_command: testCommand,
    raw_path: join(dir, `smoke-raw-${sha12}.json`), worktree: cur.smoke_worktree,
  }
  cur.wave_dir = waveDir
  writeAtomic(join(dir, 'smoke-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
  saveState(c.root, c.campaign, s)
  return { status: 'ok', plan: join(dir, 'smoke-plan.json'), raw_path: plan.raw_path, raw_exists: existsSync(plan.raw_path), pairs: plan.pairs.length, wave_dir: waveDir }
}

function cmdWorktree(c, f) {
  const action = f._[0]
  const s = loadState(c.root, c.campaign)
  const cur = s && s.current
  if (!cur) throw new StageError('no stage state — run begin first')
  if (action === 'add') {
    if (cur.smoke_worktree && existsSync(cur.smoke_worktree)) return { status: 'ok', worktree: cur.smoke_worktree, reused: true }
    const dir = addStageWorktree(c.root, cur.campaign_sha, `${c.campaign}-w${cur.wave}`)
    linkWorktree(c.root, dir, c.cfg.worktreeLinks)
    cur.smoke_worktree = dir
    const planPath = join(waveStageDir(c.root, c.campaign, cur.wave), 'smoke-plan.json')
    if (existsSync(planPath)) { const plan = readJson(planPath); plan.worktree = dir; writeAtomic(planPath, `${JSON.stringify(plan, null, 2)}\n`) }
    saveState(c.root, c.campaign, s)
    return { status: 'ok', worktree: dir, reused: false }
  }
  if (action === 'remove') {
    removeStageWorktree(c.root, cur.smoke_worktree)
    cur.smoke_worktree = null
    saveState(c.root, c.campaign, s)
    return { status: 'ok', removed: true }
  }
  throw new StageError('usage: worktree add|remove --campaign C --wave N')
}

// Rename a bad raw file aside (so the fallback check never re-ingests it) and count the attempt.
function smokeFailed(c, s, cur, reason) {
  const dir = waveStageDir(c.root, c.campaign, cur.wave)
  const raw = join(dir, `smoke-raw-${String(cur.campaign_sha).slice(0, 12)}.json`)
  cur.smoke_attempts = (cur.smoke_attempts || 0) + 1
  let renamed = null
  if (existsSync(raw)) {
    renamed = raw.replace(/\.json$/, `.invalid-${cur.smoke_attempts}.json`)
    renameSync(raw, renamed)
  }
  saveState(c.root, c.campaign, s)
  return { status: 'ok', attempts: cur.smoke_attempts, renamed, reason }
}
function cmdSmokeFailed(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  return smokeFailed(c, s, cur, String(f.reason || 'smoke agent failed'))
}

// The raw results the /smoke-chain agent writes (schema in docs/post-merge-stage.md).
export function validateRaw(raw, plan) {
  const bad = (m) => { throw new StageError(`smoke raw results: ${m}`) }
  if (!raw || typeof raw !== 'object' || raw.schema !== 1) bad('expected {"schema": 1, …}')
  if (raw.sha !== plan.sha) bad(`sha ${raw.sha} is not the plan's ${plan.sha}`)
  if (!Array.isArray(raw.results)) bad('results must be an array')
  const want = new Map(plan.pairs.map(p => [p.key, p]))
  const seen = new Set()
  for (const [i, r] of raw.results.entries()) {
    const w = `results[${i}]`
    if (!r || typeof r.ref !== 'string' || typeof r.tenant !== 'string') bad(`${w}: ref and tenant are required`)
    const key = `${r.ref}@${r.tenant}`
    if (!want.has(key)) bad(`${w}: ${key} is not in the plan`)
    if (seen.has(key)) bad(`${w}: ${key} appears twice`)
    seen.add(key)
    if (!want.get(key).covered_by_integration && !DISPOSITIONS.includes(r.disposition)) bad(`${w}: disposition must be one of ${DISPOSITIONS.join(', ')}`)
    for (const k of ['anomalies', 'urls', 'screenshots']) if (r[k] != null && !Array.isArray(r[k])) bad(`${w}.${k} must be an array`)
    if (r.disposition === 'auto_fail' && r.model != null) {
      if (!MODEL_CLASSES.includes(r.model.class)) bad(`${w}.model.class must be one of ${MODEL_CLASSES.join(', ')}`)
    }
  }
  for (const [key, p] of want) if (!seen.has(key) && !p.covered_by_integration) bad(`missing result for ${key}`)
  return true
}

function cmdIngestSmoke(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const dir = waveStageDir(c.root, c.campaign, cur.wave)
  const planPath = join(dir, 'smoke-plan.json')
  if (!existsSync(planPath)) throw new StageError(`${planPath} not found — run plan-smoke first`)
  const plan = readJson(planPath)
  const rawPath = typeof f.raw === 'string' ? resolve(f.raw) : plan.raw_path
  let raw
  try {
    if (!existsSync(rawPath)) throw new StageError(`${rawPath} not found`)
    try { raw = readJson(rawPath) } catch (e) { throw new StageError(`smoke raw results: invalid JSON (${e.message})`) }
    validateRaw(raw, plan)
  } catch (e) {
    if (!(e instanceof StageError)) throw e
    const sf = smokeFailed(c, s, cur, e.message)
    throw new StageError(e.message, 'smoke_raw_invalid', { attempts: sf.attempts, renamed: sf.renamed })
  }
  // The integration record (for criteria the integration run covers, A-16).
  const recPath = join(dir, 'test-record-integration.json')
  const rec = existsSync(recPath) ? readJson(recPath) : null
  const failingIds = rec && rec.verdict_log && existsSync(rec.verdict_log) ? parseNewFailures(readFileSync(rec.verdict_log, 'utf8')) : []
  const byKey = new Map(raw.results.map(r => [`${r.ref}@${r.tenant}`, r]))
  const { hunts } = campaignState(c)
  const huntMeta = new Map(hunts.map(h => [h.slug, h]))
  const blockPaths = (c.cfg.triageBlockPaths || []).map(p => (p.endsWith('/') ? p : `${p}/`))
  const findings = []
  const perHunt = new Map()
  const manual = new Map()
  const huntOf = (slug) => {
    if (!perHunt.has(slug)) {
      const h = huntMeta.get(slug)
      const meta = h ? h.meta : {}
      const pseudo = slug === MANIFEST_SLUG || slug === STAGE_PSEUDO_SLUG
      const tier = pseudo ? 'Blue' : (meta.tier ? normTier(meta.tier) : 'Unknown')
      let files = []
      if (meta.campaign_merge_commit) files = diffNames(c.root, meta.campaign_merge_commit)
      const risk = tier === 'Red' ? 'red' : (files.some(p => blockPaths.some(b => p.startsWith(b))) ? 'money_medical' : 'normal')
      const redDiff = tier === 'Red' && meta.campaign_merge_commit
        ? git(['show', '--stat', '-m', '--first-parent', meta.campaign_merge_commit], { cwd: c.root, allowFail: true }).stdout || null : null
      perHunt.set(slug, {
        slug, branch: slug === MANIFEST_SLUG ? '(mobile manifest)' : (slug === STAGE_PSEUDO_SLUG ? '(stage notices)' : `feat/${slug}`), tier, verdict: 'PENDING', risk,
        criteria: [], anomalies: [], screenshots: [], red_diff: redDiff,
        ...(tier === 'Red' ? { compliance: (plan.compliance || []).filter(x => x.hunt === slug).map(x => ({ ref: x.ref, text: x.text })), signed: !!(meta.park && meta.park.compliance_signed_off === true) } : {}),
      })
    }
    return perHunt.get(slug)
  }
  const shotRel = (p) => {
    if (typeof p !== 'string' || !p) return null
    const abs = isAbsolute(p) ? p : join(plan.wave_dir, p)
    const rel = relative(plan.wave_dir, resolve(abs))
    return rel.startsWith('..') || isAbsolute(rel) ? null : rel
  }
  // A manifest flow failure is attributed to the hunts merged in this stage run (or the polish).
  const blameFor = (pair) => (pair.manifest ? (cur.polish ? [cur.polish.slug] : [...(cur.merged || [])]) : [pair.hunt])
  for (const pair of plan.pairs) {
    const hb = huntOf(pair.hunt)
    const r = byKey.get(pair.key) || {}
    let crit
    if (pair.covered_by_integration) {
      const id = pair.covered_by_integration
      const failed = failingIds.some(x => x === id || x.startsWith(`${id}.`) || x.startsWith(`${id}::`))
      crit = { ref: pair.ref, tag: 'auto', text: pair.text, tenant: pair.tenant, disposition: failed ? 'auto_fail' : 'auto_pass', detail: null, covered_by: 'integration run' }
    } else {
      crit = normaliseDisposition({ ref: pair.ref, tag: 'auto', text: pair.text, tenant: pair.tenant, disposition: r.disposition, detail: r.detail ? redact(r.detail) : null })
      const refused = (r.urls || []).map(u => ({ u, why: refuseProdTarget(u, c.cfg, { kind: 'url' }) })).filter(x => x.why)
      if (refused.length) {
        crit.disposition = 'auto_fail'
        crit.detail = 'refused host'
        for (const h of blameFor(pair)) {
          const fd = { kind: 'smoke', hunt: h, ref: pair.ref, tenant: pair.tenant, key: pair.key, summary: `visited a refused host (${refused.map(x => x.why).join(', ')})`, evidence: null, model: {}, prod_host: true }
          fd.id = findingId(fd); findings.push(fd)
        }
      }
    }
    hb.criteria.push(crit)
    for (const sh of (r.screenshots || [])) { const rel = shotRel(sh); if (rel && !hb.screenshots.includes(rel)) hb.screenshots.push(rel) }
    const anomalies = (r.anomalies || []).map(a => ({
      kind: ['console', 'network'].includes(a && a.kind) ? a.kind : 'console', text: redact(String((a && a.text) || '')).slice(0, 500), tenant: pair.tenant,
      ...(Number.isInteger(a && a.status) ? { status: a.status } : {}),
    }))
    hb.anomalies.push(...anomalies)
    const status5xx = anomalies.find(a => Number.isInteger(a.status) && a.status >= 500)
    if (crit.disposition === 'auto_fail' && crit.detail !== 'refused host') {
      const evidence = (r.screenshots || []).map(shotRel).filter(Boolean)[0] || null
      for (const h of blameFor(pair)) {
        const fd = {
          kind: 'smoke', hunt: h, ref: pair.ref, tenant: pair.tenant, key: pair.key,
          summary: redact(crit.detail || r.reason || 'criterion failed'), evidence: evidence ? join(plan.wave_dir, evidence) : null,
          model: r.model || {}, ...(status5xx ? { http_status: status5xx.status } : {}),
        }
        fd.id = findingId(fd); findings.push(fd)
      }
    } else if (status5xx || anomalies.length) {
      // A non-failing criterion with page anomalies: a 5xx always becomes a finding (rule 2);
      // a console / non-2xx anomaly on a passing check is polish unless the agent says otherwise.
      for (const a of status5xx ? [status5xx] : anomalies) {
        for (const h of blameFor(pair)) {
          const fd = {
            kind: 'anomaly', hunt: h, ref: pair.ref, tenant: pair.tenant, key: pair.key, summary: a.text || `${a.kind} anomaly`, evidence: null,
            model: status5xx ? {} : (r.model && MODEL_CLASSES.includes(r.model.class) ? r.model : { class: 'log', expected_from: 'none' }),
            ...(Number.isInteger(a.status) ? { http_status: a.status } : {}),
          }
          fd.id = findingId(fd); findings.push(fd)
        }
      }
    }
    if (crit.disposition === 'needs_human_run' && pair.hunt !== MANIFEST_SLUG) {
      manual.set(pair.ref, {
        ref: pair.ref, hunt: pair.hunt, steps: pair.text,
        expected: 'Passes as written; the automated run could not check it.',
        reason: crit.detail || (r.reason ? redact(r.reason) : 'the automated run could not check it'),
      })
    }
    if (pair.tenant === 'mobile' && crit.disposition === 'auto_pass' && !(pair.key in s.mobile_passed)) s.mobile_passed[pair.key] = cur.wave
  }
  for (const m of plan.manual || []) {
    const prior = manual.get(m.ref)
    if (prior) { manual.set(m.ref, { ref: m.ref, hunt: m.hunt, steps: m.text, expected: 'As written in the criterion.', reason: prior.reason }); continue }
    manual.set(m.ref, { ref: m.ref, hunt: m.hunt, steps: m.text, expected: 'As written in the criterion.' })
  }
  // Report-only notices (A-12) and session anomalies (A-15).
  for (const n of cur.notices || []) {
    const hb = huntOf(STAGE_PSEUDO_SLUG)
    hb.anomalies.push({ kind: 'notice', text: n.text, ...(n.tenant ? { tenant: n.tenant } : {}) })
  }
  for (const fd of cur.findings.filter(x => x.kind === 'session')) {
    const hb = huntOf(STAGE_PSEUDO_SLUG)
    hb.anomalies.push({ kind: 'session', text: fd.summary, tenant: fd.tenant })
  }
  for (const hb of perHunt.values()) hb.verdict = huntVerdict(hb.criteria, hb.anomalies)
  const results = {
    campaign: c.campaign, wave: cur.wave, dev_url: `https://${Object.values(plan.tenants)[0] || 'dev'}`,
    generated_at: nowIso(), iteration: cur.iteration,
    session_before_deploy: cur.sessions.before, session_after_deploy: cur.sessions.after,
    hunts: [...perHunt.values()], manual: [...manual.values()],
  }
  writeAtomic(join(plan.wave_dir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  let build = null
  if (c.cfg.waveReportBuildCommand) {
    const cmd = subst(c.cfg.waveReportBuildCommand, { dir: plan.wave_dir })
    const why = refuseProdTarget(cmd, c.cfg, { kind: 'command', mask: c.campaign })
    build = why ? { exit: -1, last: `refused (${why})` } : runLogged(cmd, c.root, join(dir, 'wave-build.log'))
  }
  for (const fd of findings) if (!cur.findings.some(x => x.id === fd.id)) cur.findings.push(fd)
  markStep(cur, 'smoke')
  saveState(c.root, c.campaign, s)
  return {
    status: 'ok', results: join(plan.wave_dir, 'results.json'), findings: findings.length,
    verdicts: Object.fromEntries([...perHunt.values()].map(h => [h.slug, h.verdict])),
    ...(build && build.exit !== 0 ? { warning: `⚠ report: wave build failed: ${redact(build.last)}` } : {}),
  }
}

function triageContext(c, s, cur, hunt, cache) {
  if (cache.has(hunt)) return cache.get(hunt)
  const { meta } = readHuntMeta(c.root, hunt)
  const m = meta || {}
  const commits = [m.campaign_merge_commit, ...((Array.isArray(m.smoke_fixes) ? m.smoke_fixes : []).map(x => x && x.merge_commit))].filter(Boolean)
  if (cur.polish && hunt === cur.polish.slug && cur.polish.merge_commit) commits.push(cur.polish.merge_commit)
  const files = [...new Set(commits.flatMap(x => diffNames(c.root, x)))]
  const acc = readAcceptanceFor(c.root)(hunt)
  let complianceRefs = []
  if (acc) { try { complianceRefs = parseAcceptanceCriteria(acc, hunt, { tenants: tenantNames(c.cfg) }).filter(x => x.tag === 'compliance').map(x => x.ref) } catch { complianceRefs = [] } }
  const out = { tier: m.tier, files, complianceRefs, fixRounds: (cur.fix_rounds || {})[hunt] || 0, mobilePassed: s.mobile_passed || {}, triageBlockPaths: c.cfg.triageBlockPaths || [] }
  cache.set(hunt, out)
  return out
}
function cmdTriage(c) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const store = loadStore(c.root, c.campaign)
  const cache = new Map()
  const classified = []
  const entries = []
  for (const fd of cur.findings) {
    const context = fd.hunt ? triageContext(c, s, cur, fd.hunt, cache) : {}
    const r = classifyFinding(fd, context)
    classified.push({ id: fd.id, hunt: fd.hunt, outcome: r.outcome, rule: r.rule, reasoning: r.reasoning, finding: fd })
    entries.push({
      id: fd.id, wave: cur.wave, hunt: fd.hunt, ref: fd.ref || fd.test_id, tenant: fd.tenant, kind: fd.kind,
      outcome: r.outcome, rule: r.rule, reasoning: r.reasoning, evidence: fd.evidence || fd.test_id || null,
      resolution: r.rule === 'session_drop' ? 'needs Cecil' : null,
    })
  }
  appendIssues(store, entries)
  // Polish iteration (AC27/AC28): a failure that is not one of the polished items is a regression.
  if (cur.polish) {
    const targeted = new Set(cur.polish.issues || [])
    const failing = classified.filter(x => x.finding.kind !== 'session')
    const regressions = failing.filter(x => !targeted.has(x.id))
    const failingIds = new Set(failing.map(x => x.id))
    saveStore(c.root, c.campaign, store)
    markStep(cur, 'triage')
    saveState(c.root, c.campaign, s)
    return {
      status: 'ok', polish: {
        slug: cur.polish.slug, regressions: regressions.map(x => ({ id: x.id, what: x.finding.ref || x.finding.test_id })),
        fixed: [...targeted].filter(id => !failingIds.has(id)), still_failing: [...targeted].filter(id => failingIds.has(id)),
      }, classified: classified.map(({ finding, ...rest }) => rest),
    }
  }
  const pending = { fix: {}, block: {} }
  const blockText = {}
  const campaignBlocks = []
  for (const x of classified) {
    if (x.outcome === 'log') continue
    if (!x.hunt) { if (x.outcome === 'block') campaignBlocks.push(x.id); continue }
    const bucket = x.outcome === 'block' ? pending.block : pending.fix
    ;(bucket[x.hunt] = bucket[x.hunt] || []).push(x.id)
  }
  for (const h of Object.keys(pending.block)) delete pending.fix[h]   // block wins
  for (const [h, ids] of Object.entries(pending.block)) {
    const xs = classified.filter(x => ids.includes(x.id))
    const others = [...new Set(xs.flatMap(x => x.finding.blocked_with || []))]
    const rules = [...new Set(xs.map(x => x.rule))]
    const summary = `The post-merge stage blocked ${h} (${rules.join(', ')}): ${xs.map(x => x.reasoning).join(' · ')}` +
      (others.length ? ` Blocked with ${others.join(', ')}: the failing app could not be identified.` : '') +
      (rules.includes('deploy_or_migration') ? ' Reverting a broken migration does not un-apply what the dev database already applied: check migrate-dev state.' : '')
    const evidence = [...new Set(xs.map(x => x.finding.evidence || x.finding.test_id).filter(Boolean))].join(', ') || '(see the issue log)'
    blockText[h] = { summary: redact(summary).slice(0, 1500), evidence: redact(evidence).slice(0, 1000), question: `What should ${h} do instead? Answer clarify with the fix direction, or redirect to re-plan it.` }
  }
  cur.pending = pending
  cur.block_text = blockText
  saveStore(c.root, c.campaign, store)
  markStep(cur, 'triage')
  saveState(c.root, c.campaign, s)
  return { status: 'ok', pending, block_text: blockText, campaign_blocks: campaignBlocks, classified: classified.map(({ finding, ...rest }) => rest) }
}

function cmdReclassify(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const h = f.hunt
  const rule = String(f.rule || '')
  if (!SLUG_RE.test(String(h || '')) || !/^[a-z0-9_]+$/.test(rule)) throw new StageError('--hunt H --rule RULE are required')
  const ids = cur.pending.fix[h] || []
  delete cur.pending.fix[h]
  cur.pending.block[h] = [...new Set([...(cur.pending.block[h] || []), ...ids])]
  const reason = typeof f.reason === 'string' && f.reason.trim() ? redact(f.reason.trim()) : rule
  cur.block_text[h] = { summary: `The post-merge stage blocked ${h} (${rule}): ${reason}`.slice(0, 1500), evidence: ids.join(', ') || '(see the issue log)', question: `What should ${h} do instead? Answer clarify with the fix direction, or redirect to re-plan it.` }
  const store = loadStore(c.root, c.campaign)
  for (const id of ids) { const e = store.entries.find(x => x.id === id); if (e) { e.outcome = 'block'; e.rule = rule; e.reasoning = `${e.reasoning} → ${rule}: ${reason}` } }
  saveStore(c.root, c.campaign, store)
  saveState(c.root, c.campaign, s)
  return { status: 'ok', hunt: h, ids, block_text: cur.block_text[h] }
}

function cmdFixScaffold(c, f) {
  const s = loadState(c.root, c.campaign)
  if (!s) throw new StageError(`no stage state for ${c.campaign}`)
  // A polish wave runs at campaign end, after the last stage run finished.
  const cur = f.polish === true ? (s.current || newCurrent({ wave: 0, tip: tipOf(c) })) : requireCurrent(c, s)
  const tip = tipOf(c)
  const worktreeRoot = c.cfg.worktreeRoot
  if (!worktreeRoot) throw new StageError('Project Identity → Worktree root: missing')
  const models = c.cfg.models || {}
  const writer = models.judgment
  const reviewer = models['reviewer-a']
  if (!writer || !reviewer) throw new StageError('Model Pool: judgment and reviewer-a are required for fix rounds')
  const fam = (t) => String(t).split(':')[0].toLowerCase()
  if (fam(writer) === fam(reviewer)) throw new StageError(`Model Pool: reviewer-a ${reviewer} shares the writer's family ${fam(writer)} — a fix round needs a cross-family reviewer`)
  const store = loadStore(c.root, c.campaign)
  let slug, parent = null, tier, issues, description
  if (f.polish === true) {
    const statuses = Object.fromEntries(campaignState(c).hunts.map(h => [h.slug, h.status]))
    const open = openPolishSet(store, statuses)
    if (!open.items.length) throw new StageError('no open log items to polish')
    const k = (s.polish || []).length + 1
    slug = k === 1 ? `polish-${c.campaign}` : `polish-${c.campaign}-${k}`
    tier = 'Blue'
    issues = open.items.map(e => e.id)
    description = `Polish wave for campaign ${c.campaign}: fix the ${issues.length} open logged smoke item(s) in one change (${issues.join(', ')}).`
    s.polish = [...(s.polish || []).filter(p => p.slug !== slug), { open_set: open.open_set, slug, result: null, issues }]
  } else {
    parent = f.hunt
    if (!SLUG_RE.test(String(parent || ''))) throw new StageError('--hunt <slug> is required')
    const { meta: pm } = readHuntMeta(c.root, parent)
    if (!pm) throw new StageError(`no metadata.json for ${parent}`)
    if (chainClass(pm.status) !== 'campaign_merged') throw new StageError(`${parent} is ${pm.status} — a fix round is only for a campaign-merged hunt`)
    const n = ((cur.fix_rounds || {})[parent] || 0) + 1
    if (n > MAX_FIX_ROUNDS) throw new StageError(`${parent} already had ${MAX_FIX_ROUNDS} fix rounds — it blocks (fix_cap)`)
    slug = `fix-${parent}-smoke-${n}`
    const pt = normTier(pm.tier)
    tier = (TIER_RANK[pt] ?? 4) < TIER_RANK.Blue ? 'Blue' : pt
    issues = (cur.pending.fix[parent] || [])
    if (!issues.length) throw new StageError(`${parent} has no pending fix findings`)
    description = `Smoke fix round ${n} for ${parent} (campaign ${c.campaign}): ${issues.join(', ')}.`
  }
  const branch = `feat/${slug}`
  const wtPath = join(c.root, worktreeRoot, slug)
  const existing = findWorktree(c.root, slug)
  let reused = false
  if (existing) reused = true
  else {
    if (branchExists(c.root, branch)) throw new StageError(`${branch} exists without a worktree — remove it or re-attach it, then re-run`)
    git(['worktree', 'add', '--quiet', '-b', branch, wtPath, tip], { cwd: c.root })
    linkWorktree(c.root, wtPath, c.cfg.worktreeLinks)
  }
  const wt = existing || wtPath
  const planDir = join(wt, '.wolfpack', 'plans', slug)
  mkdirSync(planDir, { recursive: true })
  const metaPath = join(planDir, 'metadata.json')
  const base = existsSync(metaPath) ? readJson(metaPath) : {}
  const meta = {
    ...base,
    feature: slug, description, created: base.created || nowIso(),
    status: base.status || 'ready', phase: base.phase || 'implement',
    is_worktree: true, worktree_path: wt, branch, base_branch: c.branch, campaign: c.campaign,
    ...(parent ? { parent_hunt: parent, smoke_fix_round: Number(slug.match(/-(\d+)$/)[1]) } : { polish_of: c.campaign }),
    tier, mode: 'update', test_isolation: c.campaign, smoke_issues: issues,
    model_assignments: { alpha: writer, bloodhound: reviewer, shepherd: writer, pointer: reviewer, tracker: writer, watchdog: reviewer, ...(base.model_assignments || {}) },
    proposed_version: base.proposed_version || { bump: null, tag: null, set_by: 'stage', note: 'post-merge stage fix/polish: no version bump' },
  }
  writeAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  const entries = issues.map(id => store.entries.find(e => e.id === id)).filter(Boolean)
  const findingsMd = [`# Findings for ${slug}`, '', `Campaign ${c.campaign}, wave ${cur.wave}, iteration ${cur.iteration}. Campaign tip ${tip}.`, '',
    ...entries.map(e => `- ${e.id} (${e.kind}, ${e.tenant || '-'}, ${e.ref || '-'}) [${e.rule}]: ${e.reasoning}${e.evidence ? `\n  - evidence: ${e.evidence}` : ''}`), '']
  writeFileSync(join(planDir, 'findings.md'), findingsMd.join('\n'))
  saveState(c.root, c.campaign, s)
  return { status: 'ok', slug, parent_hunt: parent, tier, branch, worktree: wt, plan_dir: planDir, base_sha: tip, issues, description, reused }
}

function cmdRecordFix(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const h = f.hunt
  const fix = f.fix
  const commit = f.commit
  if (!SLUG_RE.test(String(h || '')) || !SLUG_RE.test(String(fix || '')) || !SHA_RE.test(String(commit || ''))) throw new StageError('--hunt H --fix S --commit <40-hex> are required')
  const ids = String(f.issues || '').split(',').map(x => x.trim()).filter(Boolean)
  const store = loadStore(c.root, c.campaign)
  const n = Number((String(fix).match(/-smoke-(\d+)$/) || [])[1]) || (((cur.fix_rounds || {})[h] || 0) + 1)
  const { meta } = readHuntMeta(c.root, h)
  if (!meta) throw new StageError(`no metadata.json for ${h}`)
  const diffText = git(['diff', `${commit}^1`, commit], { cwd: c.root }).stdout
  const diffFiles = diffNames(c.root, commit)
  const d = huntPlanDirs(c.root, h)
  const dispositions = { bloodhound: {} }
  for (const dir of [d.worktreePlanDir, d.mainPlanDir].filter(Boolean)) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const m = /^revision-log-(\d+)\.md$/.exec(name)
      if (m && !dispositions.bloodhound[m[1]]) dispositions.bloodhound[m[1]] = readFileSync(join(dir, name), 'utf8')
    }
  }
  const file = join(c.root, '.wolfpack', 'plans', h, 'smoke-findings.md')
  mkdirSync(dirname(file), { recursive: true })
  let text = existsSync(file) ? readFileSync(file, 'utf8') : `# Smoke findings: ${h}\n`
  const marker = (id) => `<!-- smoke-fix:${fix}:${id} -->`
  const fresh = ids.filter(id => !text.includes(marker(id)))
  if (fresh.length) {
    const lines = ['', `## Fix round ${n}, wave ${cur.wave} (${nowIso()})`, `- Fix: ${fix}, merge commit ${commit}`]
    for (const id of fresh) {
      const e = store.entries.find(x => x.id === id) || { kind: '?', tenant: null, ref: null, reasoning: '' }
      const lk = fingerprintLookup(e, { text: diffText, files: diffFiles }, meta.review_fingerprints, dispositions)
      lines.push(`- ${id} (${e.kind}, ${e.tenant || '-'}, ${e.ref || '-'}): ${redact(String(e.reasoning || '')).split('\n')[0]} ${marker(id)}`)
      lines.push(`  - Review fingerprint lookup: ${lookupLine(lk)}`)
    }
    text = `${text.replace(/\n*$/, '\n')}${lines.join('\n')}\n`
    writeFileSync(file, text)
  }
  for (const id of ids) { try { resolveIssue(store, id, `fixed in round ${n}`) } catch { /* unknown id: recorded in the file only */ } }
  saveStore(c.root, c.campaign, store)
  const already = (cur.fix_merges || []).some(x => x.slug === fix)
  if (!already) {
    cur.fix_rounds[h] = ((cur.fix_rounds || {})[h] || 0) + 1
    cur.fix_merges = [...(cur.fix_merges || []), { hunt: h, slug: fix, commit }]
    writeHuntMeta(c.root, h, (m) => { m.smoke_fix_rounds = cur.fix_rounds[h] })
  }
  delete cur.pending.fix[h]
  saveState(c.root, c.campaign, s)
  return { status: 'ok', hunt: h, fix, fix_rounds: cur.fix_rounds[h], file, appended: fresh.length }
}

function cmdPolishPlan(c) {
  const s = loadState(c.root, c.campaign) || { polish: [] }
  const store = loadStore(c.root, c.campaign)
  const statuses = Object.fromEntries(campaignState(c).hunts.map(h => [h.slug, h.status]))
  const open = openPolishSet(store, statuses)
  if (!open.items.length) return { status: 'ok', items: [], open_set: null, reason: 'no open log items' }
  if ((s.polish || []).some(p => p.open_set === open.open_set && p.result)) return { status: 'ok', items: [], open_set: open.open_set, reason: 'this open set was already polished once' }
  return { status: 'ok', items: open.items.map(e => ({ id: e.id, hunt: e.hunt, ref: e.ref, tenant: e.tenant, reasoning: e.reasoning, evidence: e.evidence })), open_set: open.open_set }
}

function cmdResolve(c, f) {
  const store = loadStore(c.root, c.campaign)
  const ids = String(f.ids || '').split(',').map(x => x.trim()).filter(Boolean)
  const res = String(f.resolution || '')
  if (!(['polished', 'reverted', 'needs Cecil'].includes(res) || /^fixed in round \d+$/.test(res))) throw new StageError(`--resolution must be polished, reverted, needs Cecil or "fixed in round <n>" (got ${res})`)
  const reason = typeof f.reason === 'string' && f.reason.trim() ? redact(f.reason.trim()) : null
  for (const id of ids) {
    const e = resolveIssue(store, id, res)
    if (reason) e.reasoning = `${e.reasoning} — ${reason}`
  }
  saveStore(c.root, c.campaign, store)
  if (typeof f['polish-slug'] === 'string') {
    const s = loadState(c.root, c.campaign)
    if (s) {
      const p = (s.polish || []).find(x => x.slug === f['polish-slug'])
      if (p) { p.result = String(f['polish-result'] || 'failed'); if (typeof f['open-set'] === 'string') p.open_set = f['open-set'] }
      else s.polish = [...(s.polish || []), { slug: f['polish-slug'], open_set: f['open-set'] || null, result: String(f['polish-result'] || 'failed') }]
      saveState(c.root, c.campaign, s)
    }
  }
  return { status: 'ok', resolved: ids, resolution: res }
}

function cmdIterate(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const tip = tipOf(c)
  // After a polish revert: one plain re-verify with the SAME suite set but no hunt to blame, so a
  // failure that persists was not the polish merge's (it parks integration_unattributed).
  const prior = cur.suites
  resetIteration(cur, tip, { bump: true })
  if (f['clear-polish'] === true) {
    cur.polish = null
    cur.suites_override = prior ? { ...prior, hunt_apps: {}, full_suite_hunts: [], reason: `${prior.reason} (re-verify after the polish revert)` } : null
  }
  saveState(c.root, c.campaign, s)
  return { status: 'ok', iteration: cur.iteration, campaign_sha: tip }
}

function cmdFinish(c, f) {
  const s = loadState(c.root, c.campaign)
  const cur = requireCurrent(c, s)
  const result = f.result
  if (!['green', 'resolved'].includes(result)) throw new StageError('--result green|resolved is required')
  cur.result = result
  cur.step = 'done'
  s.waves[String(cur.wave)] = { result, campaign_sha: tipOf(c), finished_at: nowIso(), iteration: cur.iteration }
  saveState(c.root, c.campaign, s)
  return { status: 'ok', wave: cur.wave, result }
}

function cmdReport(c) {
  const s = loadState(c.root, c.campaign)
  if (!existsSync(issueJsonPath(c.root, c.campaign))) saveStore(c.root, c.campaign, emptyStore())
  const warn = (m) => ({ status: 'ok', report_url: null, warning: `⚠ report: ${m}` })
  if (!c.cfg.campaignReportCommand || !c.cfg.reportUrlCommand) return warn('Campaign report command / Report URL command not configured')
  const build = subst(c.cfg.campaignReportCommand, { campaign: c.campaign, issue_log: issueJsonPath(c.root, c.campaign) })
  const bw = refuseProdTarget(build, c.cfg, { kind: 'command', mask: c.campaign })
  if (bw) return warn(`Deployment Notes → Campaign report command refused (${bw}) — nothing executed`)
  const logDir = join(campDir(c.root, c.campaign), 'stage')
  const b = runLogged(build, c.root, join(logDir, 'campaign-report.log'))
  if (b.exit !== 0) return warn(`campaign report failed: ${redact(b.last)}`)
  const dir = (b.stdout.split('\n').map(l => l.trim()).filter(Boolean).pop() || '').replace(/\/+$/, '')
  if (!dir || !isAbsolute(dir)) return warn(`campaign report printed no directory (${redact(b.last)})`)
  const url = subst(c.cfg.reportUrlCommand, { dir })
  const uw = refuseProdTarget(url, c.cfg, { kind: 'command', mask: c.campaign })
  if (uw) return warn(`Deployment Notes → Report URL command refused (${uw}) — nothing executed`)
  const u = runLogged(url, c.root, join(logDir, 'report-url.log'))
  const reportUrl = (u.stdout.split('\n').map(l => l.trim()).filter(Boolean).pop() || '')
  if (u.exit !== 0 || !/^https?:\/\//.test(reportUrl) || /0\.0\.0\.0/.test(reportUrl)) return warn(`report url failed: ${redact(u.last)}`)
  if (s) {
    s.report_url = reportUrl
    if (s.current) s.current.report_url = reportUrl
    saveState(c.root, c.campaign, s)
  }
  return { status: 'ok', report_url: reportUrl, dir }
}

function cmdPark(c, f) {
  const s = loadState(c.root, c.campaign)
  if (!s || !s.current) throw new StageError('no stage state to park')
  const code = String(f.code || '')
  if (!/^[a-z0-9_]+$/.test(code)) throw new StageError('--code <park_code> is required')
  const detail = typeof f.detail === 'string' ? redact(f.detail).slice(0, 1000) : null
  const atStep = STEPS[Math.min(STEPS.indexOf(s.current.step) + 1, STEPS.length - 1)]
  s.current.result = `parked:${code}`
  s.current.park = { code, detail, step: s.current.step, at_step: typeof f.step === 'string' ? f.step : atStep, at: nowIso() }
  saveState(c.root, c.campaign, s)
  return { status: 'ok', result: s.current.result, park: s.current.park }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const STAGE_TEXT_FLAGS = Object.freeze([...TEXT_FLAGS, 'detail', 'merged-by-wave', 'reason'])
export function main(argv) {
  const [cmd, ...rest] = argv
  const f = parseFlags(rest, { text: STAGE_TEXT_FLAGS })
  const emit = (obj, code = 0) => { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); return code }
  try {
    const c = ctx(f.campaign)
    const run = {
      'check-config': () => cmdCheckConfig(c),
      begin: () => cmdBegin(c, f),
      session: () => cmdSession(c, f),
      deploy: () => cmdDeployStep(c, 'deploy'),
      migrate: () => cmdDeployStep(c, 'migrate'),
      'ensure-tenants': () => cmdEnsure(c),
      suites: () => cmdSuites(c, f),
      'ingest-integration': () => cmdIngestIntegration(c, f),
      'plan-smoke': () => cmdPlanSmoke(c, f),
      worktree: () => cmdWorktree(c, f),
      'ingest-smoke': () => cmdIngestSmoke(c, f),
      'smoke-failed': () => cmdSmokeFailed(c, f),
      triage: () => cmdTriage(c),
      reclassify: () => cmdReclassify(c, f),
      'fix-scaffold': () => cmdFixScaffold(c, f),
      'record-fix': () => cmdRecordFix(c, f),
      'polish-plan': () => cmdPolishPlan(c),
      resolve: () => cmdResolve(c, f),
      iterate: () => cmdIterate(c, f),
      finish: () => cmdFinish(c, f),
      report: () => cmdReport(c),
      park: () => cmdPark(c, f),
    }[cmd]
    if (!run) return emit({ status: 'error', reason: `usage: wolfpack-smoke-stage.mjs <${['check-config', 'begin', 'session', 'deploy', 'migrate', 'ensure-tenants', 'suites', 'ingest-integration', 'plan-smoke', 'worktree', 'ingest-smoke', 'smoke-failed', 'triage', 'reclassify', 'fix-scaffold', 'record-fix', 'polish-plan', 'resolve', 'iterate', 'finish', 'report', 'park'].join('|')}> --campaign C [...]` }, 2)
    return emit(run())
  } catch (e) {
    if (e instanceof StageError) return emit({ status: 'error', reason: e.message, ...(e.code ? { code: e.code } : {}), ...e.extra }, 2)
    return emit({ status: 'error', reason: (e && e.message) || String(e) }, 2)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
void PACK_ROOT
