#!/usr/bin/env node
// scripts/wolfpack-model-stats.mjs — [06] AC3 per-model stats meter.
//
// Aggregates the per-hunt pedigree.json scorecards into the per-model,
// per-role, per-domain metrics the [06] router reads — per docs/wolfpack-autonomy/06
// AC3: "pedigree.json + index carry per-model spend and ledger-derived signal/noise
// + miss rate, sliced by domain — and the routing reads THESE, not the cert score."
//
// Output schema (.wolfpack/pedigree/model-stats.json):
//   { meta: { hunts, sourced, generated_at? },
//     model_stats: { "<model>": { "<role>": { "<domain>": {
//        runs, spend_s, signal, noise, miss_rate, quality } } } } }
//
//   * runs      — how many hunts this (model × role × domain) cell has seen.
//   * spend_s   — total wall-clock the model spent in that role ([05] timing.by_model);
//                 null if no hunt in the cell carried timing yet.
//   * signal    — fraction of this reviewer's findings that grounded to real code
//                 (grounded/raised), from the [03]/[06] review_fingerprints ledger;
//                 null if no hunt in the cell carried it.
//   * noise     — fraction that were hallucinated/ungrounded (dropped/raised); null
//                 if no ledger.
//   * miss_rate — smoke-escapes / runs ([04] lagging signal); null until smoke data lands.
//   * quality   — mean execution_scores quality proxy (code_quality/plan_adherence),
//                 a COARSE pre-ledger stand-in so the meter isn't empty on day one.
//
// HONEST THINNESS (wolfpack-config.md fail-loud, spec "guard against routing on 2–3 points"):
// where a metric's source data is absent the field is NULL, not a fabricated 0 — the
// router's MIN_RUNS + signal-present checks then fail-safe to the tier defaults. The
// meta.provisional list names every cell still below the trust threshold, so "we have
// no signal yet" is VISIBLE, never silently presented as data.
//
// NO CLOCK: pure aggregation; generated_at only if passed via --stamp <iso> (the host
// driver supplies the agent clock — this script never calls Date, AC5-clean).
//
// Usage:
//   node scripts/wolfpack-model-stats.mjs [--stamp <iso>] [--out <path>] [<plansDir>]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// providerFamily() in wolfpack-routing.mjs owns the model-name → family mapping, so the
// model strings used here (and in the test) are routing's PROVIDER-NEUTRAL family
// vocabulary: judgment / work-horse / reviewer-a / reviewer-b. A real project maps those
// onto concrete models via wolfpack-config.md → "Model Pool"; this meter only ever sees
// the family names routing resolves to.
import { deriveDomain, providerFamily, MIN_RUNS } from './wolfpack-routing.mjs'

const ROLES = ['alpha', 'bloodhound', 'shepherd', 'pointer', 'tracker', 'watchdog']

// ─── Normalize one raw pedigree.json into a flat hunt record ─────
// Tolerates BOTH the pre-[03]/[05] format (model_assignments/shepherd_model +
// execution_scores, no ledger/timing) and the newer one (review_fingerprints,
// timing). Unknown/absent fields → null, never guessed.
export function normalizeHunt(p) {
  if (!p || typeof p !== 'object') return null
  const dims = p.predicted_dimensions || {}
  const domain = deriveDomain(dims)

  // Per-role model family. model_assignments is the authoritative source; fall
  // back to shepherd_model for the implementer on old cards.
  const ma = p.model_assignments || {}
  const models = {}
  for (const role of ROLES) {
    const raw = ma[role] || (role === 'shepherd' ? p.shepherd_model : null)
    models[role] = providerFamily(raw)   // null if unset/unrecognized
  }

  // Quality proxy (coarse, pre-ledger): mean of the two quality-ish scores.
  // execution_scores comes in TWO shapes: old cards use a flat number
  // (code_quality: 5); modern Watchdog cards use { score, rationale, tags }. scoreOf
  // tolerates both (and null/absent) so quality isn't silently nulled on modern cards.
  const es = p.execution_scores || {}
  const qParts = [scoreOf(es.code_quality), scoreOf(es.plan_adherence)].filter((x) => x != null)
  const quality = qParts.length ? qParts.reduce((a, b) => a + b, 0) / qParts.length : null

  // [05] timing.by_model: seconds per role-model. {role: {model: seconds}} OR
  // {model: seconds} — tolerate both shapes defensively.
  const byModel = p.timing?.by_model || null

  // [03]/[06] review_fingerprints ledger (role-keyed { role: [perRound...] }).
  // Reduce to per-role {raised, grounded, dropped}; legacy array-of-arrays → null.
  const ledger = summarizeFingerprints(p.review_fingerprints)

  // [04] smoke escape (lagging miss signal). Boolean if present, else null.
  const miss = typeof p.smoke_escape === 'boolean' ? p.smoke_escape : null

  return { models, domain, quality, byModel, ledger, miss, verdict: p.certifier_verdict || null }
}

// Reduce review_fingerprints into per-role {raised, grounded, dropped} tallies.
// The current ([06]) schema is an OBJECT keyed by role:
//   { "<role>": [ { round, raised, grounded, dropped, findings:[...] } ] }
// signal = grounded/raised, noise = dropped/raised (the grounding check in the
// review loop already split a reviewer's findings into grounded-vs-hallucinated).
// The LEGACY role-blind array-of-arrays (pre-[06]) carries no role and no
// disposition, so it yields NO usable signal → return null (honest thinness).
export function summarizeFingerprints(fp) {
  if (!fp || typeof fp !== 'object') return null
  if (Array.isArray(fp)) return null   // legacy role-blind ledger — no per-role signal
  const acc = {}
  let sawAny = false
  for (const role of Object.keys(fp)) {
    const rounds = fp[role]
    if (!Array.isArray(rounds)) continue
    let raised = 0, grounded = 0, dropped = 0, seen = false
    for (const r of rounds) {
      if (!r || typeof r !== 'object') continue
      if (Number.isFinite(r.raised)) { raised += r.raised; seen = true }
      if (Number.isFinite(r.grounded)) grounded += r.grounded
      if (Number.isFinite(r.dropped)) dropped += r.dropped
    }
    if (seen) { acc[role] = { raised, grounded, dropped }; sawAny = true }
  }
  return sawAny ? acc : null
}

// ─── Aggregate normalized hunts into the model_stats schema ──────
export function aggregateModelStats(hunts) {
  const stats = {}
  const provisional = []
  let sourced = 0

  const cell = (model, role, domain) => {
    stats[model] = stats[model] || {}
    stats[model][role] = stats[model][role] || {}
    stats[model][role][domain] = stats[model][role][domain] || {
      runs: 0, _spend: 0, _spendSeen: false,
      _raised: 0, _grounded: 0, _dropped: 0, _ledgerSeen: false,
      _miss: 0, _missRuns: 0, _q: 0, _qSeen: 0,
    }
    return stats[model][role][domain]
  }

  for (const h of hunts) {
    if (!h) continue
    sourced++
    for (const role of ROLES) {
      const model = h.models[role]
      if (!model) continue
      const c = cell(model, role, h.domain)
      c.runs++

      // spend
      const s = spendFor(h.byModel, role, model)
      if (s != null) { c._spend += s; c._spendSeen = true }

      // ledger signal/noise (reviewers): grounded/raised vs dropped/raised
      const led = h.ledger && h.ledger[role]
      if (led && led.raised > 0) {
        c._raised += led.raised
        c._grounded += led.grounded
        c._dropped += led.dropped
        c._ledgerSeen = true
      }

      // miss rate — denominator is runs WITH smoke data, not all runs (#3: a run
      // that never reported a smoke outcome must not dilute the rate toward 0).
      if (h.miss != null) { c._missRuns++; if (h.miss) c._miss++ }

      // quality proxy
      if (h.quality != null) { c._q += h.quality; c._qSeen++ }
    }
  }

  // Finalize: null out metrics whose source data never appeared (honest thinness).
  for (const model of Object.keys(stats)) {
    for (const role of Object.keys(stats[model])) {
      for (const domain of Object.keys(stats[model][role])) {
        const c = stats[model][role][domain]
        const out = {
          runs: c.runs,
          spend_s: c._spendSeen ? c._spend : null,
          signal: c._ledgerSeen && c._raised > 0 ? round3(c._grounded / c._raised) : null,
          noise: c._ledgerSeen && c._raised > 0 ? round3(c._dropped / c._raised) : null,
          miss_rate: c._missRuns > 0 ? round3(c._miss / c._missRuns) : null,
          quality: c._qSeen ? round3(c._q / c._qSeen) : null,
        }
        stats[model][role][domain] = out
        if (c.runs < MIN_RUNS || out.signal == null) {
          provisional.push(`${model}/${role}/${domain} (runs=${c.runs}${out.signal == null ? ', no ledger signal' : ''})`)
        }
      }
    }
  }

  return { model_stats: stats, sourced, provisional }
}

// timing.by_model can be {role:{model:sec}} or {model:sec}. Return seconds or null.
export function spendFor(byModel, role, model) {
  if (!byModel || typeof byModel !== 'object') return null
  const r = byModel[role]
  if (r && typeof r === 'object') return Number.isFinite(r[model]) ? r[model] : null
  if (Number.isFinite(byModel[model])) return byModel[model]
  return null
}

function round3(x) { return Math.round(x * 1000) / 1000 }

// A score field may be a flat number (old cards) or { score, ... } (modern). → number|null.
export function scoreOf(x) {
  if (Number.isFinite(x)) return x
  if (x && typeof x === 'object' && Number.isFinite(x.score)) return x.score
  return null
}

// Merge a hunt's pedigree.json (cert scorecard — execution_scores, timing,
// certifier_verdict) with its metadata.json (review_fingerprints, convergence,
// model_assignments, predicted_dimensions, tier). review_fingerprints + convergence
// live ONLY in metadata.json (which is gitignored), so the meter must read it there —
// it always regenerates at Certify in the working repo, where metadata.json is present.
// pedigree wins on overlapping keys (cert is authoritative for scores). On a fresh
// clone (no metadata.json) the ledger fields are simply absent → signal/noise null →
// the router fail-safes to tier defaults, same as "no data yet".
export function mergeHuntSources(meta, ped) {
  return { ...(meta || {}), ...(ped || {}) }
}

// ─── CLI ────────────────────────────────────────────────────────
function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url))
  let stamp = null, out = null, plansDir = null
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--stamp') stamp = argv[++i]
    else if (argv[i] === '--out') out = argv[++i]
    else plansDir = argv[i]
  }
  plansDir = plansDir || join(here, '..', '.wolfpack', 'plans')
  out = out || join(here, '..', '.wolfpack', 'pedigree', 'model-stats.json')

  if (!existsSync(plansDir)) { console.error(`plans dir not found: ${plansDir}`); process.exit(2) }
  const hunts = []
  for (const name of readdirSync(plansDir)) {
    const pj = join(plansDir, name, 'pedigree.json')
    if (!existsSync(pj)) continue   // pedigree.json is the per-hunt anchor (tracked)
    const mj = join(plansDir, name, 'metadata.json')
    try {
      const ped = JSON.parse(readFileSync(pj, 'utf8'))
      const meta = existsSync(mj) ? JSON.parse(readFileSync(mj, 'utf8')) : null
      hunts.push(normalizeHunt(mergeHuntSources(meta, ped)))
    } catch (e) { console.error(`skip ${name}: ${e.message}`) }
  }
  const agg = aggregateModelStats(hunts)
  const doc = { meta: { hunts: hunts.filter(Boolean).length, sourced: agg.sourced,
    provisional: agg.provisional, ...(stamp ? { generated_at: stamp } : {}) },
    model_stats: agg.model_stats }
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
  console.log(`model-stats: ${doc.meta.hunts} hunts → ${out} (${agg.provisional.length} provisional cells)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
}
