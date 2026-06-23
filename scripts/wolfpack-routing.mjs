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

// Derived family sets for the running pool. IMPLEMENTER = families that must NOT
// review; REVIEWER = the eligible reviewer families. Built from a pool object so a
// caller can swap the concrete vocabulary while keeping all routing logic intact.
export function familySets(pool = DEFAULT_POOL) {
  return {
    IMPLEMENTER: new Set([pool.judgment, pool.workHorse]),
    REVIEWER: new Set([pool.reviewerA, pool.reviewerB]),
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

  return { shepherd, reviewer, watchdog: pool.reviewerA, watchdogMode, tracker, domain, compliance }
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
export function recommendModels({ tier, dimensions = {}, stats = {}, pins = {}, pool = DEFAULT_POOL } = {}) {
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

  // Shepherd — pin wins; else tier default. Heavy/compliance is exploit-only.
  A.shepherd = pickWithPin('shepherd', pins, def.shepherd, stats, domain, explore, warnings, pool)

  // Reviewers — NEVER an implementer family. Exploit best-by-data if trusted, else
  // tier default; on explore-eligible tiers with thin data, explore the work-horse default.
  A.bloodhound = pickReviewer('bloodhound', pins, def.reviewer, stats, domain, explore, warnings, pool)

  // Pointer — domain default, but MUST be cross-family from Shepherd (and a reviewer family).
  let pointerDefault = def.reviewer
  const shepFam = providerFamily(A.shepherd.model, pool)
  if (shepFam === pointerDefault) pointerDefault = otherReviewer(pointerDefault, pool)
  A.pointer = pickReviewer('pointer', pins, pointerDefault, stats, domain, explore, warnings, pool)
  enforceCrossFamily(A.pointer, A.shepherd, 'Pointer', warnings, pool)

  // Watchdog — reviewer-a verify by default; cross-family from Shepherd; carries mode.
  let wdDefault = def.watchdog
  if (shepFam === wdDefault) wdDefault = otherReviewer(wdDefault, pool)
  A.watchdog = pickReviewer('watchdog', pins, wdDefault, stats, domain, explore, warnings, pool)
  A.watchdog.mode = def.watchdogMode
  A.watchdog.rationale += ` — ${def.watchdogMode} verify (${domain})`
  enforceCrossFamily(A.watchdog, A.shepherd, 'Watchdog', warnings, pool)

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
  const cell = cellOf(stats, defModel, role, domain)
  if (trusted(cell)) return { model: defModel, rationale: `tier default, confirmed by data (${cell.runs} runs)`, source: 'exploit' }
  return {
    model: defModel,
    rationale: explore ? `tier default (work horse) — exploring to accrue data` : `tier default (exploit-only tier, thin data → safe default)`,
    source: explore ? 'explore' : 'default',
  }
}

// Reviewer pick — always a reviewer family. Exploit best-by-data when a candidate is
// trusted; else the domain default. Coerces any implementer/garbage to a reviewer family.
function pickReviewer(role, pins, defModel, stats, domain, explore, warnings, pool) {
  const { REVIEWER } = familySets(pool)
  if (pins[role]) {
    const fam = providerFamily(pins[role], pool)
    if (fam && REVIEWER.has(fam)) return { model: fam, rationale: `operator pin (${pins[role]})`, source: 'pin' }
    if (fam) warnings.push(`ignoring ${role} pin "${pins[role]}" — reviewers must be a reviewer family (non-implementer)`)
    else warnings.push(`unrecognized ${role} pin "${pins[role]}" — using default`)
  }
  let base = REVIEWER.has(defModel) ? defModel : pool.reviewerA
  if (base !== defModel) warnings.push(`${role} default coerced to ${base} (reviewers must be a reviewer family)`)

  const best = bestReviewerByData(stats, role, domain, pool)
  if (best && best !== base) {
    return { model: best, rationale: `data-driven: ${best} best signal/noise for ${role}/${domain}`, source: 'exploit' }
  }
  const cell = cellOf(stats, base, role, domain)
  if (trusted(cell)) return { model: base, rationale: `${domain} default, confirmed by data (${cell.runs} runs)`, source: 'exploit' }
  return {
    model: base,
    rationale: explore ? `${domain} default (work horse) — exploring to accrue data` : `${domain} default (thin data → safe)`,
    source: explore ? 'explore' : 'default',
  }
}

// Given one reviewer family, return the OTHER reviewer family (the cross-family alternate).
function otherReviewer(m, pool = DEFAULT_POOL) {
  return m === pool.reviewerB ? pool.reviewerA : pool.reviewerB
}

// Coerce a reviewer assignment to differ from Shepherd's family (cross-family).
function enforceCrossFamily(reviewerA, shepherdA, label, warnings, pool) {
  if (providerFamily(reviewerA.model, pool) === providerFamily(shepherdA.model, pool)) {
    const fixed = otherReviewer(reviewerA.model, pool)
    warnings.push(`${label} collided with Shepherd family (${reviewerA.model}) — switched to ${fixed} (cross-family)`)
    reviewerA.model = fixed
    reviewerA.rationale += ` [cross-family from Shepherd]`
  }
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
  const families = [pool.judgment, pool.workHorse, pool.reviewerA, pool.reviewerB]
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
  if (problems.length) {
    // Fail-loud: these are invariant breaches, not soft warnings.
    throw new Error(`routing constraint violation: ${problems.join('; ')}`)
  }
  return warnings
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
    pins: meta.model_pins || {},
  })
  console.log(JSON.stringify(rec, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
}
