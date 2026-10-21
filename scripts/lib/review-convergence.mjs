// scripts/lib/review-convergence.mjs — the review-convergence PURE CORE.
//
// The Workflow runner cannot import modules, so `.agents/workflows/hunt-pipeline.js` carries
// this block pasted inline. The block between the BEGIN/END markers below appears
// byte-identically (minus the leading `export ` on declarations) in hunt-pipeline.js; a drift
// test fails if the two copies differ (Hard Rule 7, the same rule as the `wolfpack-chain core`).
// This module exists so tests can replay REAL recorded review histories against the REAL
// classifier, not a re-implementation of it.
//
// What lives here:
//   • the finding FINGERPRINT — composed by the pipeline (never by a seat) from three
//     normalized legs, `<file>::<symbol>::<claim_class>`. The old seat-invented
//     `file:defect-class` slug let two different defects in one file collide, so a review
//     round read as "a fixed finding returned" (a false oscillation park). The symbol leg
//     separates them; the closed claim-class vocabulary stops seats inventing near-synonyms.
//     Plan files (`plan.md`, `plan-revised-N.md`, `plan-final.md`) all normalize to `plan`,
//     so a genuine plan oscillation can match across revisions.
//   • the CONVERGENCE CLASSIFIER (`classifyConvergence` / `commitRound`) — moved verbatim.
//   • `suspectedSymbolDrift` — a log-only safety net for the false-negative side of exact
//     symbol matching (a returning defect a different seat names with another symbol). It
//     never decides a park.
//
// No imports, no I/O: every function is pure and deterministic (resume-safe).
//
// Run tests: node --test scripts/wolfpack-hunt-pipeline.test.mjs

// ── BEGIN wolfpack-convergence core (keep byte-identical: scripts/lib/review-convergence.mjs ⇄ hunt-pipeline.js) ──
// Closed claim-class vocabulary. An unknown or missing class normalizes to 'other'.
export const CLAIM_CLASSES = Object.freeze(['logic-error', 'missing-handling', 'silent-fallback', 'missing-test', 'weak-test',
  'contract-drift', 'scope-gap', 'scope-creep', 'spec-misread', 'security', 'data-integrity', 'concurrency',
  'performance', 'leak', 'docs-drift', 'config', 'other'])
export const SYMBOL_NONE = '-'
const PLAN_FILE_RE = /(^|\/)\.wolfpack\/plans\/[^/]+\/plan(-revised-\d+|-final)?\.md$/

// '' / null → 'plan'; '\' → '/'; collapse '//'; strip leading './', '/workspace/', '/';
// any hunt plan revision file → 'plan'.
export function normalizeFingerprintFile(file) {
  let p = String(file ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  for (;;) {
    const q = p.replace(/^\.\//, '').replace(/^\/workspace\//, '').replace(/^\//, '')
    if (q === p) break
    p = q
  }
  if (!p || PLAN_FILE_RE.test(p)) return 'plan'
  return p
}

// trim; strip quotes/backticks; strip one leading keyword; strip a trailing '(...)';
// lowercase; '::' → '-' (a fingerprint always has exactly 3 '::'-legs); whitespace → '-'.
export function normalizeSymbol(symbol) {
  let s = String(symbol ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '').trim()
  s = s.replace(/^(?:function|def|class|const|let|var|method|fn|section)\s+/i, '').replace(/^§\s*/, '')
  s = s.replace(/\s*\([^()]*\)\s*$/, '').trim()
  s = s.toLowerCase().replace(/::/g, '-').replace(/\s+/g, '-')
  return s || SYMBOL_NONE
}

export function normalizeClaimClass(c) {
  const k = String(c ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
  return CLAIM_CLASSES.includes(k) ? k : 'other'
}

export function findingFingerprint({ file, symbol, claimClass }) {
  return `${normalizeFingerprintFile(file)}::${normalizeSymbol(symbol)}::${normalizeClaimClass(claimClass)}`
}

// Returns a copy with the pipeline-composed fingerprint; a seat-supplied value is overwritten.
export function fingerprintFinding(f) {
  return { ...f, fingerprint: findingFingerprint({ file: f.file, symbol: f.symbol, claimClass: f.claim_class ?? f.claimClass }) }
}

export const isCriticalSev = (s) => String(s || '').toLowerCase().includes('critical')

export function newConvergenceHistory() {
  return { fpRounds: [], counts: [], cumulativeCritFps: new Set(), critStreak: new Map() }
}

export function classifyConvergence({ round, findings, history, cfg, floor }) {
  const thisFps = findings.map(f => f.fingerprint).filter(Boolean)
  const thisFpSet = new Set(thisFps)
  const thisCount = findings.length
  const critFps = [...new Set(findings.filter(f => isCriticalSev(f.severity)).map(f => f.fingerprint).filter(Boolean))]

  // cumulative distinct criticals if we commit this round (caller commits after).
  const cumulativeCrit = new Set(history.cumulativeCritFps)
  critFps.forEach(fp => cumulativeCrit.add(fp))

  // (1) CRITICAL STUCK — a critical fingerprint present for critPersist CONSECUTIVE
  // rounds (counting this one). Ungated by floor: a stuck critical must halt ASAP. (AC5)
  for (const fp of critFps) {
    if ((history.critStreak.get(fp) || 0) + 1 >= cfg.critPersist) {
      return { action: 'park_open_critical', detail: `critical fingerprint "${fp}" stuck ${cfg.critPersist} rounds`, cumulativeCrit }
    }
  }
  // (2) PLAN SMELL — cumulative DISTINCT criticals ≥ bound: the plan/spec is wrong, not
  // the code → FLAWED_PLAN (Alpha re-plans), NOT a Shepherd rewrite. Ungated. (AC4)
  if (cumulativeCrit.size >= cfg.planSmellBound) {
    return { action: 'flawed_plan', detail: `${cumulativeCrit.size} cumulative distinct criticals ≥ ${cfg.planSmellBound}`, cumulativeCrit }
  }
  // (3) CIRCUIT BREAKER — the hard runaway guard. Checked BEFORE the converging green
  // light: "continue past the BASE cap" is the goal (AC3), "run forever" is not. Hitting
  // maxRounds PARKS (never proceeds) even if this round looks healthy — N rounds without
  // a clean APPROVED is itself the signal to hand a human a tight diff.
  if (round >= cfg.maxRounds) {
    return { action: 'park_non_convergence', detail: `MAX_ROUNDS (${cfg.maxRounds}) reached without convergence`, cumulativeCrit }
  }
  // (4) CONVERGING — all this-round fingerprints are NEW (unseen in ANY prior round) AND
  // count not growing. The healthy case: the pack keeps surfacing genuinely distinct
  // defects without re-breaking old ones → CONTINUE (no fixed cap). Checked BEFORE
  // oscillation/stall so "new distinct critical each round" never trips the stall on a
  // flat count (AC3 first clause; the runaway is bounded by plan-smell + the breaker).
  const allSeen = new Set()
  history.fpRounds.forEach(s => s.forEach(fp => allSeen.add(fp)))
  const allNew = thisFps.length > 0 && thisFps.every(fp => !allSeen.has(fp))
  const prevCount = history.counts.length ? history.counts[history.counts.length - 1] : Infinity
  if (allNew && thisCount <= prevCount) {
    return { action: 'continue', detail: 'converging (all-new fingerprints, count not growing)', cumulativeCrit }
  }
  // (5) OSCILLATING — a fingerprint last seen in round ≤ N-2 (then ABSENT in N-1 =
  // "fixed") reappears now: the pack is fighting itself. Ungated: a fixed-then-returned
  // defect is unambiguously pathological the moment it returns (AC3 second clause).
  const prevRound = history.fpRounds.length ? history.fpRounds[history.fpRounds.length - 1] : new Set()
  const earlierRounds = history.fpRounds.slice(0, -1) // rounds 1 .. N-2
  for (const fp of thisFpSet) {
    if (!prevRound.has(fp) && earlierRounds.some(s => s.has(fp))) {
      return { action: 'park_non_convergence', detail: `oscillation: fingerprint "${fp}" returned after being fixed`, cumulativeCrit }
    }
  }
  // (6) STALLED — finding count not strictly decreasing over the last 2 transitions.
  // Floor-gated: give the pack its baseline rounds before declaring a stall (a transient
  // up-tick during the floor rounds is not yet pathological). Needs 2 prior counts.
  if (round > floor && history.counts.length >= 2) {
    const prev = history.counts[history.counts.length - 1]
    const prev2 = history.counts[history.counts.length - 2]
    if (thisCount >= prev && prev >= prev2) {
      return { action: 'park_non_convergence', detail: `stall: counts ${prev2}→${prev}→${thisCount} not strictly decreasing`, cumulativeCrit }
    }
  }
  // (7) Still making progress (e.g. count dropping while some N-1 findings carry over) —
  // continue. Bounded by the circuit breaker (check 3) above.
  return { action: 'continue', detail: 'making progress', cumulativeCrit }
}

// Commit a classified round into the running history (mutates `history`). Critical
// streaks rebuild from THIS round's criticals so an absent critical resets to 0.
export function commitRound(history, findings, cumulativeCrit) {
  const thisFpSet = new Set(findings.map(f => f.fingerprint).filter(Boolean))
  const critFps = new Set(findings.filter(f => isCriticalSev(f.severity)).map(f => f.fingerprint).filter(Boolean))
  history.fpRounds.push(thisFpSet)
  history.counts.push(findings.length)
  history.cumulativeCritFps = cumulativeCrit
  const next = new Map()
  for (const fp of critFps) next.set(fp, (history.critStreak.get(fp) || 0) + 1)
  history.critStreak = next
}

// LOG-ONLY (never parks, never feeds classifyConvergence): a finding whose exact
// fingerprint was never seen, but whose file + claim class match a fingerprint seen in
// some round ≤ N-2 and absent in N-1, under a DIFFERENT symbol — possibly the same defect
// renamed by another seat. Call BEFORE commitRound (history = prior rounds only).
// Fingerprints split on '::': first leg = file, last leg = class, middle leg(s) = symbol.
export function suspectedSymbolDrift(history, findings) {
  const rounds = history.fpRounds
  if (rounds.length < 2) return []
  const split = (fp) => {
    const legs = String(fp).split('::')
    if (legs.length < 3) return null
    return { file: legs[0], symbol: legs.slice(1, -1).join('::'), claimClass: legs[legs.length - 1] }
  }
  const seen = new Set()
  rounds.forEach(s => s.forEach(fp => seen.add(fp)))
  const last = rounds[rounds.length - 1]
  const out = []
  const keys = new Set()
  for (const f of findings || []) {
    const fp = f && f.fingerprint
    if (!fp || seen.has(fp)) continue
    const cur = split(fp)
    if (!cur) continue
    for (const s of rounds.slice(0, -1)) {
      for (const old of s) {
        if (last.has(old)) continue
        const o = split(old)
        if (!o || o.file !== cur.file || o.claimClass !== cur.claimClass || o.symbol === cur.symbol) continue
        const k = JSON.stringify([cur.file, cur.claimClass, o.symbol, cur.symbol])
        if (keys.has(k)) continue
        keys.add(k)
        out.push({ file: cur.file, claimClass: cur.claimClass, was: o.symbol, now: cur.symbol })
      }
    }
  }
  return out
}
// ── END wolfpack-convergence core ──
