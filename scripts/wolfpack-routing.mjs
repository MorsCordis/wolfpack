#!/usr/bin/env node
// scripts/wolfpack-routing.mjs — [06] data-driven model→role routing (AC4 + AC5).
//
// Turns the work-horse/judgment tier table from docs/wolfpack-autonomy/06 into a
// DETERMINISTIC recommender that learns from the [03] fingerprint ledger + [05]
// spend telemetry (aggregated by scripts/wolfpack-model-stats.mjs) — and FAILS
// SAFE to the tier defaults whenever the data is too thin to route on (the spec's
// "guard against routing on 2–3 data points"). Until a calibration batch accrues,
// every recommendation IS the tier default; as cells fill, exploit takes over.
//
// ─── MODEL / PROVIDER AGNOSTIC ───────────────────────────────────
// This router is PROVIDER-NEUTRAL. It reasons about model *families* by ROLE in
// the pipeline, not by brand. Two implementer families and two reviewer families:
//
//   * judgment    — the judgment-tier family (heavy reasoning). Fixed for the
//                   planner (Alpha) and used for heavy/compliance implementation.
//   * work-horse  — the cheap, high-throughput implementer family.
//   * reviewer-a  — the primary reviewer family (also the verify specialist).
//   * reviewer-b  — the secondary reviewer family (cross-family alternate).
//
// Two OPTIONAL slots extend the pool (absent from DEFAULT_POOL, so a pool without
// them routes exactly as before):
//
//   * reviewer-c  — a third reviewer family, slotted into the examiner CHAIN between
//                   reviewer-a and reviewer-b (chain order: a → c → b).
//   * coder-alt   — an optional non-default IMPLEMENTER family for NON-heavy tiers
//                   (typically the same family as reviewer-c: a model that can both
//                   code and review). Heavy/compliance tiers still force `judgment`.
//                   Because coder-alt may also review, the cross-family rule is the
//                   CHAIN rule: a review seat walks the ordered examiner chain with the
//                   writer's family REMOVED, falling to the next link on a rate limit.
//
// `judgment` + `work-horse` are the IMPLEMENTER families (they may NOT review —
// adversarial review must be cross-family from the implementer). `reviewer-a` +
// `reviewer-b` are the REVIEWER families. A real project maps these neutral roles
// onto concrete models via wolfpack-config.md → "Model Pool" (e.g. judgment=Opus,
// work-horse=Sonnet, reviewer-a=Gemini, reviewer-b=Mistral). The DEFAULT_POOL below
// is a neutral example only — override it by passing `pool` to recommendModels()
// (or by editing wolfpack-config.md and threading it through the caller).
//
// HARD CONSTRAINTS (never relax — enforced + asserted, fail-loud):
//   * Alpha is ALWAYS the judgment family (planner). Never explore the planner seat.
//   * Reviewers (Bloodhound, Pointer, Watchdog) are NEVER an implementer family —
//     adversarial review must be cross-family. So they're reviewer-a or reviewer-b.
//   * Cross-family pairing: Pointer/Watchdog family ≠ Shepherd family.
//   * NEVER explore on Red/Orange/compliance — exploit known-best there; a miss is
//     too expensive. Explore only on Green/Blue/Yellow where a miss is cheap+caught.
//
// AC5 (domain-aware): UI/UX-heavy hunt → review goes to reviewer-a (the
// irreplaceable visual specialist); backend hunt → review VOLUME to reviewer-b + a
// THIN reviewer-a verify (window economics: route volume to the unmetered work
// horse reviewer, reserve the metered reviewer for the thin verify).
//
// AC5 cleanliness: NO Date.now()/new Date()/Math.random() — exploration is
// DETERMINISTIC (thin-data → explore the work horse to accrue data; rich-data →
// exploit the best), never random, so a workflow could call this and resume cleanly.
//
// Usage (CLI, for inspection/dry-run):
//   node scripts/wolfpack-routing.mjs <planDir>
//     reads <planDir>/metadata.json (tier + predicted_dimensions) and
//     .wolfpack/pedigree/model-stats.json, prints the recommendation as JSON.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ucbSelect } from './wolfpack-bandit.mjs'

// ─── The neutral model pool ──────────────────────────────────────
// DEFAULT_POOL is a provider-agnostic EXAMPLE. Real projects supply their own
// mapping via wolfpack-config.md → "Model Pool" and thread it in as `pool`.
//   * implementer families may NOT review (cross-family adversarial rule).
//   * reviewer families are the only legal reviewer/verify picks.
export const DEFAULT_POOL = {
  // Implementer families (forbidden as reviewers).
  judgment: 'judgment',     // judgment-tier planner/heavy implementer (fixed Alpha)
  workHorse: 'work-horse',  // cheap high-throughput implementer
  // Reviewer families (the only legal reviewers).
  reviewerA: 'reviewer-a',  // primary reviewer + verify specialist
  reviewerB: 'reviewer-b',  // secondary reviewer (cross-family alternate)
}

// The ordered examiner chain families for a pool: reviewer-a → reviewer-c → reviewer-b
// (reviewer-c only when the pool defines it).
export function reviewerOrder(pool = DEFAULT_POOL) {
  return [pool.reviewerA, pool.reviewerC, pool.reviewerB].filter(Boolean)
}

// The ordered examiner chain for one review seat: reviewerOrder ∩ enabled, minus every
// family in `exclude` (the WRITER of the artifact under review — the Shepherd for
// Pointer/Watchdog, the planner for Bloodhound). `enabled` (Set, optional) models env
// gates — omitted = every pool reviewer family. `prefer` rotates one eligible family
// to the front (pin / sticky pick) but never re-admits an excluded one. Returns [] when
// nothing is eligible: the caller must FAIL LOUD (park), never review same-family.
export function reviewerChain({ pool = DEFAULT_POOL, exclude = [], enabled = null, prefer = null } = {}) {
  const ex = new Set([...exclude].map((m) => providerFamily(m, pool) || m))
  const base = reviewerOrder(pool).filter((f) => (!enabled || enabled.has(f)) && !ex.has(f))
  const p = providerFamily(prefer, pool)
  if (p && base.includes(p)) return [p, ...base.filter((f) => f !== p)]
  return base
}

// Derived family sets for the running pool. IMPLEMENTER = families that must NOT
// review; REVIEWER = the eligible reviewer families. Built from a pool object so a
// caller can swap the concrete vocabulary while keeping all routing logic intact.
export function familySets(pool = DEFAULT_POOL) {
  return {
    IMPLEMENTER: new Set([pool.judgment, pool.workHorse]),
    REVIEWER: new Set(reviewerOrder(pool)),
  }
}

// Back-compat exports for callers/tests that want the default sets directly.
export const IMPLEMENTER_FAMILIES = new Set([DEFAULT_POOL.judgment, DEFAULT_POOL.workHorse])
export const REVIEWER_FAMILIES = new Set([DEFAULT_POOL.reviewerA, DEFAULT_POOL.reviewerB])

// Minimum runs in a (model × role × domain) cell before its stats are trusted to
// EXPLOIT. Below this the cell is "provisional" — fail-safe to the tier default,
// or (on explore-eligible tiers) deliberately run the work horse to accrue data.
export const MIN_RUNS = 3

// Explore is allowed only where a miss is cheap and caught.
export const EXPLORE_TIERS = new Set(['Green', 'Blue', 'Yellow'])

// ─── Domain axis (COARSE, per spec "start coarse, slice finer as volume earns it") ───
// One binary axis to start: frontend-heavy vs backend-heavy. Refine only once a
// cell has enough runs to mean something (guard against false precision).
export function deriveDomain(dimensions) {
  const fe = Number(dimensions?.frontend_complexity || 0)
  return fe >= 3 ? 'frontend' : 'backend'
}

// Is this hunt compliance-sensitive? domain_sensitivity is the compliance axis
// (controlled substances / billing). High → exploit-only, never explore.
export function isCompliance(dimensions) {
  return Number(dimensions?.domain_sensitivity || 0) >= 3
}

// Explore-eligible: cheap-tier AND not compliance. Red/Orange are exploit-only.
export function exploreEligible(tier, dimensions) {
  return EXPLORE_TIERS.has(tier) && !isCompliance(dimensions)
}

// ─── Tier defaults — the work-horse/judgment table (the HYPOTHESIS until data) ───
// Per docs/wolfpack-autonomy/06 § "The two tiers": the work-horse family implements,
// reviewer-b reviews volume (work horse), the judgment family plans + reviewer-a
// verifies (judgment). Domain overrides the reviewer/verify picks (AC5);
// Red/compliance forces the judgment family.
export function tierDefaults(tier, dimensions, pool = DEFAULT_POOL) {
  const domain = deriveDomain(dimensions)
  const compliance = isCompliance(dimensions)
  const heavy = tier === 'Red' || tier === 'Orange' || compliance

  // Implementer: work-horse family by default; judgment family on heavy/compliance.
  const shepherd = heavy ? pool.judgment : pool.workHorse

  // Reviewer (Bloodhound/Pointer): domain-aware. UI-heavy → reviewer-a (irreplaceable
  // visual reviewer). Backend → reviewer-b (route volume to the unmetered work horse).
  // reviewer-b stripped from the autonomous pipeline → reviewers always reviewer-a.
  // (Manual path can still pin reviewer-b.) Domain no longer splits the reviewer; it
  // still drives watchdogMode below.
  const reviewer = pool.reviewerA

  // Verify (Watchdog): always reviewer-a (judgment/verify); THOROUGH on UI-heavy,
  // THIN on backend (the window-economics reservation).
  const watchdogMode = domain === 'frontend' ? 'thorough' : 'thin'

  // Tracker: judgment family by default (test authoring is judgment-heavy), routable
  // on non-heavy tiers under the metered-with-fallback guards.
  const tracker = pool.judgment

  return { shepherd, reviewer, watchdog: pool.reviewerA, watchdogMode, tracker, domain, compliance, heavy }
}

// ─── Stats lookup ───────────────────────────────────────────────
// stats schema (from wolfpack-model-stats.mjs):
//   { "<model>": { "<role>": { "<domain>": { runs, spend_s, signal, noise, miss_rate } } } }
export function cellOf(stats, model, role, domain) {
  return stats?.[model]?.[role]?.[domain] || null
}

// A cell is trustworthy to EXPLOIT only with enough runs.
export function trusted(cell) {
  return !!cell && Number(cell.runs || 0) >= MIN_RUNS
}

// ─── Adaptive (bandit) selection ─────────────────────────────────
// When pedigree-v2 reward (per-cell `reward_mean`, aggregated from pedigree `overall`)
// is present, the router becomes an adaptive UCB bandit over the candidate families: it
// EXPLORES under-sampled cells (sampling floor) for coverage, then EXPLOITS the best mean
// reward — deterministically (no Math.random). Falls back to the legacy default/best-by-data
// path when no reward data exists yet, so pre-pedigree-v2 behavior (and tests) stay intact.
function rewardCandidates(models, stats, role, domain) {
  return models.map((model) => {
    const cell = cellOf(stats, model, role, domain)
    const rewardMean = cell && Number.isFinite(cell.reward_mean) ? Number(cell.reward_mean) : null
    // Floor on SCORED observations (reward_n) when present — a cell needs enough graded
    // outcomes to trust its reward, not merely enough total appearances.
    const runs = cell && Number.isFinite(cell.reward_n) ? Number(cell.reward_n) : Number(cell?.runs || 0)
    return { model, runs, rewardMean }
  })
}

function banditPick(models, stats, role, domain, explore) {
  const cands = rewardCandidates(models, stats, role, domain)
  if (!cands.some((c) => c.rewardMean != null)) return null   // no pedigree-v2 reward yet → legacy path
  const pick = ucbSelect(cands, { exploreAllowed: explore, minRuns: MIN_RUNS })
  if (!pick) return null                                       // exploit-only, nothing trusted → safe default
  const source = pick.source === 'exploit' ? 'exploit' : 'explore'
  return { model: pick.model, rationale: `bandit ${pick.source} — ${pick.reason}`, source }
}

// Best reviewer family for a role+domain BY DATA (signal − noise − miss), among
// trusted cells only; null if no candidate has trusted data. reviewer-b is stripped
// from autonomous routing, so only reviewer-a is considered here.
export function bestReviewerByData(stats, role, domain, pool = DEFAULT_POOL) {
  let best = null, bestScore = -Infinity
  for (const model of [pool.reviewerA]) {   // reviewer-b stripped from autonomous routing
    const cell = cellOf(stats, model, role, domain)
    // Exploit only a cell with ENOUGH runs AND real ledger signal — a runs≥MIN_RUNS
    // cell whose signal is still null (no [03] ledger yet) is provisional, not data.
    if (!trusted(cell) || !Number.isFinite(cell.signal)) continue
    const score = Number(cell.signal) - Number(cell.noise || 0) - Number(cell.miss_rate || 0)
    if (score > bestScore) { bestScore = score; best = model }
  }
  return best
}

// ─── The recommender ────────────────────────────────────────────
// Returns { assignments, domain, compliance, explore, warnings }. assignments is
// keyed by role: { model, mode?, rationale, source: 'default'|'exploit'|'explore'|'pin' }.
export function recommendModels({ tier, dimensions = {}, stats = {}, pins = {}, pool = DEFAULT_POOL, enabled = null } = {}) {
  const warnings = []
  const { REVIEWER } = familySets(pool)
  const t = tier || 'Red'            // fail-closed: unknown tier → heaviest ceremony
  if (!tier) warnings.push('no tier supplied — defaulting to Red (exploit-only, no explore)')
  const def = tierDefaults(t, dimensions, pool)
  const explore = exploreEligible(t, dimensions)
  const domain = def.domain

  const A = {}   // assignments

  // Alpha — fixed judgment family, always. A pin cannot move it (planner is load-bearing).
  A.alpha = { model: pool.judgment, rationale: 'planner is fixed judgment family', source: 'fixed' }
  if (pins.alpha && providerFamily(pins.alpha, pool) !== pool.judgment) {
    warnings.push(`ignoring alpha pin "${pins.alpha}" — Alpha is fixed ${pool.judgment}`)
  }

  // Shepherd — pin wins; else tier default. Heavy/compliance is exploit-only. A
  // coder-alt pin is honored only on non-heavy tiers (judgment override never relaxes)
  // and carries a `fallback` implementer for when coder-alt is rate-limited.
  A.shepherd = pickShepherd(pins, def, stats, domain, explore, warnings, pool, enabled)

  // Reviewers — NEVER an implementer family. Exploit best-by-data if trusted, else
  // tier default; on explore-eligible tiers with thin data, explore the work-horse default.
  // Bloodhound reviews the PLAN, so the planner (judgment) family is its excluded writer.
  A.bloodhound = pickReviewer('bloodhound', pins, def.reviewer, stats, domain, explore, warnings, pool, enabled, [A.alpha.model])

  // Pointer — domain default, but MUST be cross-family from Shepherd (and a reviewer family).
  const shepEx = [A.shepherd.model, A.shepherd.fallback].filter(Boolean)
  const pointerDefault = reviewerChain({ pool, exclude: shepEx, enabled, prefer: def.reviewer })[0] || def.reviewer
  A.pointer = pickReviewer('pointer', pins, pointerDefault, stats, domain, explore, warnings, pool, enabled, shepEx)
  enforceCrossFamily(A.pointer, A.shepherd, 'Pointer', warnings, pool, enabled)

  // Watchdog — reviewer-a verify by default; cross-family from Shepherd; carries mode.
  const wdDefault = reviewerChain({ pool, exclude: shepEx, enabled, prefer: def.watchdog })[0] || def.watchdog
  A.watchdog = pickReviewer('watchdog', pins, wdDefault, stats, domain, explore, warnings, pool, enabled, shepEx)
  A.watchdog.mode = def.watchdogMode
  A.watchdog.rationale += ` — ${def.watchdogMode} verify (${domain})`
  enforceCrossFamily(A.watchdog, A.shepherd, 'Watchdog', warnings, pool, enabled)

  // Tracker — judgment default; routable (metered-with-fallback) on explore-eligible
  // tiers only. NOT a reviewer, so it may be an implementer family.
  A.tracker = pickWithPin('tracker', pins, def.tracker, stats, domain, explore, warnings, pool)

  // Final hard-constraint assertions (fail-loud).
  assertConstraints(A, warnings, pool)

  return { assignments: A, domain, compliance: def.compliance, explore, warnings }
}

// Pin-or-default for non-reviewer roles (Shepherd, Tracker). Heavy tiers never
// explore; explore-eligible tiers with thin data on the default keep the default
// (the work horse) and TAG it explore so the run accrues data.
function pickWithPin(role, pins, defModel, stats, domain, explore, warnings, pool) {
  if (pins[role]) {
    const fam = providerFamily(pins[role], pool)
    if (!fam) { warnings.push(`unrecognized ${role} pin "${pins[role]}" — using default ${defModel}`) }
    else return { model: fam, rationale: `operator pin (${pins[role]})`, source: 'pin' }
  }
  // Adaptive: on explore-eligible tiers, let the bandit pick among the implementer families
  // once pedigree-v2 reward exists. Heavy/compliance tiers are exploit-only and already
  // forced to the judgment family upstream, so the implementer bandit is NOT consulted there.
  if (explore) {
    const adaptive = banditPick([pool.workHorse, pool.judgment], stats, role, domain, explore)
    if (adaptive) return adaptive
  }
  const cell = cellOf(stats, defModel, role, domain)
  if (trusted(cell)) return { model: defModel, rationale: `tier default, confirmed by data (${cell.runs} runs)`, source: 'exploit' }
  return {
    model: defModel,
    rationale: explore ? `tier default (work horse) — exploring to accrue data` : `tier default (exploit-only tier, thin data → safe default)`,
    source: explore ? 'explore' : 'default',
  }
}

// Shepherd pick. A coder-alt pin (a family that is NOT judgment/work-horse, e.g. a
// model that also reviews) is honored only on non-heavy tiers with the family enabled,
// and carries `fallback` = the tier-default implementer the pipeline runs instead when
// coder-alt is rate-limited. Every other pin behaves exactly as before (pin wins).
function pickShepherd(pins, def, stats, domain, explore, warnings, pool, enabled) {
  const pinFam = providerFamily(pins.shepherd, pool)
  if (pool.coderAlt && pinFam === pool.coderAlt && pinFam !== pool.judgment && pinFam !== pool.workHorse) {
    if (def.heavy) {
      warnings.push(`ignoring shepherd pin "${pins.shepherd}" — heavy/compliance tiers force ${def.shepherd} (judgment)`)
      return pickWithPin('shepherd', {}, def.shepherd, stats, domain, explore, warnings, pool)
    }
    if (enabled && !enabled.has(pinFam)) {
      warnings.push(`ignoring shepherd pin "${pins.shepherd}" — ${pinFam} is disabled`)
      return pickWithPin('shepherd', {}, def.shepherd, stats, domain, explore, warnings, pool)
    }
    return { model: pinFam, fallback: def.shepherd, rationale: `operator pin (${pins.shepherd}) — coder-alt; falls back to ${def.shepherd} on rate limit`, source: 'pin' }
  }
  return pickWithPin('shepherd', pins, def.shepherd, stats, domain, explore, warnings, pool)
}

// Reviewer pick — always a reviewer family, enabled, and never a family in `exclude`
// (the writer of the reviewed artifact). Exploit best-by-data when a candidate is
// trusted; else the domain default. Coerces any implementer/garbage to a reviewer family.
// The returned assignment carries `chain`: its ordered fallback list (model first).
function pickReviewer(role, pins, defModel, stats, domain, explore, warnings, pool, enabled = null, exclude = []) {
  const { REVIEWER } = familySets(pool)
  const withChain = (a) => ({ ...a, chain: reviewerChain({ pool, exclude, enabled, prefer: a.model }) })
  const eligible = reviewerChain({ pool, exclude, enabled })
  if (pins[role]) {
    const fam = providerFamily(pins[role], pool)
    if (fam && REVIEWER.has(fam) && eligible.includes(fam)) return withChain({ model: fam, rationale: `operator pin (${pins[role]})`, source: 'pin' })
    if (fam && REVIEWER.has(fam)) warnings.push(`ignoring ${role} pin "${pins[role]}" — same family as the artifact's writer (cross-family rule) or disabled`)
    else if (fam) warnings.push(`ignoring ${role} pin "${pins[role]}" — reviewers must be a reviewer family (non-implementer)`)
    else warnings.push(`unrecognized ${role} pin "${pins[role]}" — using default`)
  }
  let base = eligible.includes(defModel) ? defModel : (eligible[0] || pool.reviewerA)
  if (base !== defModel) warnings.push(`${role} default coerced to ${base} (reviewers must be a reviewer family)`)

  // Adaptive: bandit over BOTH reviewer families once reward exists — you can't learn the
  // best reviewer without sampling both, so this re-introduces reviewer-b as an explore
  // candidate on cheap tiers (exploit-only tiers just pick the best KNOWN reviewer).
  // Only chain-eligible families are candidates (never the writer's family).
  const adaptive = banditPick([pool.reviewerA, pool.reviewerB].filter((m) => eligible.includes(m)), stats, role, domain, explore)
  if (adaptive) return withChain(adaptive)
  const best = bestReviewerByData(stats, role, domain, pool)
  if (best && best !== base && eligible.includes(best)) {
    return withChain({ model: best, rationale: `data-driven: ${best} best signal/noise for ${role}/${domain}`, source: 'exploit' })
  }
  const cell = cellOf(stats, base, role, domain)
  if (trusted(cell)) return withChain({ model: base, rationale: `${domain} default, confirmed by data (${cell.runs} runs)`, source: 'exploit' })
  return withChain({
    model: base,
    rationale: explore ? `${domain} default (work horse) — exploring to accrue data` : `${domain} default (thin data → safe)`,
    source: explore ? 'explore' : 'default',
  })
}

// Coerce a reviewer assignment to differ from Shepherd's family (cross-family): move to
// the first link of the chain with the Shepherd's family (and its fallback) removed.
// An empty chain is an invariant breach — throw (fail loud), never keep the collision.
function enforceCrossFamily(reviewerA, shepherdA, label, warnings, pool, enabled = null) {
  const shepEx = [shepherdA.model, shepherdA.fallback].filter(Boolean)
  const exFams = new Set(shepEx.map((m) => providerFamily(m, pool)))
  if (exFams.has(providerFamily(reviewerA.model, pool))) {
    const chain = reviewerChain({ pool, exclude: shepEx, enabled })
    if (!chain.length) throw new Error(`routing constraint violation: ${label} has no cross-family reviewer left (Shepherd ${shepherdA.model})`)
    warnings.push(`${label} collided with Shepherd family (${reviewerA.model}) — switched to ${chain[0]} (cross-family)`)
    reviewerA.model = chain[0]
    reviewerA.rationale += ` [cross-family from Shepherd]`
  }
  reviewerA.chain = reviewerChain({ pool, exclude: shepEx, enabled, prefer: reviewerA.model })
}

// Map a model token to its family. PROVIDER-NEUTRAL: matches against the running
// pool's family names as substrings (so "reviewer-a:flash-3.5" or
// "judgment:opus:high" still resolve). Returns the family name or null. A real
// project that uses concrete brand tokens supplies a pool whose values ARE those
// brand strings (wolfpack-config.md → Model Pool) and this still works by substring.
export function providerFamily(m, pool = DEFAULT_POOL) {
  if (!m) return null
  const s = String(m).toLowerCase()
  // Order: longest/most-specific family names first so a substring of one family
  // name can't shadow another. The default neutral names are mutually non-overlapping.
  // reviewer-c / coder-alt are matched BEFORE reviewer-b: a concrete pool may run
  // reviewer-c through reviewer-b's CLI (e.g. GLM via Vibe on the Mistral API), so its
  // labels can contain reviewer-b's brand too.
  const families = [pool.judgment, pool.workHorse, pool.reviewerA, pool.reviewerC, pool.coderAlt, pool.reviewerB]
  for (const fam of families) {
    if (fam && s.includes(String(fam).toLowerCase())) return fam
  }
  return null
}

// Fail-loud invariant check on the final assignment set.
export function assertConstraints(A, warnings, pool = DEFAULT_POOL) {
  const { IMPLEMENTER } = familySets(pool)
  const problems = []
  if (providerFamily(A.alpha.model, pool) !== pool.judgment) problems.push('Alpha is not the judgment family')
  for (const role of ['bloodhound', 'pointer', 'watchdog']) {
    const fam = providerFamily(A[role].model, pool)
    if (IMPLEMENTER.has(fam)) problems.push(`${role} is an implementer family (${A[role].model}) — reviewers must be a reviewer family`)
  }
  if (providerFamily(A.pointer.model, pool) === providerFamily(A.shepherd.model, pool)) problems.push('Pointer shares Shepherd family (not cross-model)')
  if (providerFamily(A.watchdog.model, pool) === providerFamily(A.shepherd.model, pool)) problems.push('Watchdog shares Shepherd family (not cross-model)')
  // Chain rule: no fallback link of a code reviewer may be the Shepherd's family (or its
  // fallback), and no link of any reviewer may be an implementer family.
  const shepFams = new Set([A.shepherd.model, A.shepherd.fallback].filter(Boolean).map((m) => providerFamily(m, pool)))
  for (const role of ['bloodhound', 'pointer', 'watchdog']) {
    for (const link of A[role].chain || []) {
      if (IMPLEMENTER.has(providerFamily(link, pool))) problems.push(`${role} chain contains an implementer family (${link})`)
      if (role !== 'bloodhound' && shepFams.has(providerFamily(link, pool))) problems.push(`${role} chain contains the Shepherd's family (${link})`)
    }
  }
  if (problems.length) {
    // Fail-loud: these are invariant breaches, not soft warnings.
    throw new Error(`routing constraint violation: ${problems.join('; ')}`)
  }
  return warnings
}

// Operator pins from metadata: /hunt --shepherd/--bloodhound/--watchdog land in
// metadata.models.{architect_recommended,reviewer,certifier}; explicit model_pins win.
export function pinsFromMeta(meta = {}) {
  const m = meta.models || {}
  const pins = {}
  if (m.architect_recommended) pins.shepherd = m.architect_recommended
  if (m.reviewer) pins.bloodhound = m.reviewer
  if (m.certifier) pins.watchdog = m.certifier
  return { ...pins, ...(meta.model_pins || {}) }
}

// ─── CLI ────────────────────────────────────────────────────────
function main(argv) {
  const planDir = argv[2]
  if (!planDir) { console.error('usage: node wolfpack-routing.mjs <planDir>'); process.exit(2) }
  const metaPath = join(planDir, 'metadata.json')
  if (!existsSync(metaPath)) { console.error(`metadata.json not found in ${planDir}`); process.exit(2) }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const here = dirname(fileURLToPath(import.meta.url))
  const statsPath = join(here, '..', '.wolfpack', 'pedigree', 'model-stats.json')
  const stats = existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, 'utf8')) : {}
  const rec = recommendModels({
    tier: meta.tier,
    dimensions: meta.predicted_dimensions || {},
    stats: stats.model_stats || stats,
    pins: pinsFromMeta(meta),
  })
  console.log(JSON.stringify(rec, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
}
