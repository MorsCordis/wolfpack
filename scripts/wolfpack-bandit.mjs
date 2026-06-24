#!/usr/bin/env node
// wolfpack-bandit.mjs — deterministic UCB1 selection for the adaptive router.
//
// Turns the router's static "tier default vs best-by-data" pick into a bandit that
// balances EXPLOIT (highest mean reward) against EXPLORE (under-sampled cells) — so
// an early winner can't lock the pool and starve variance (and starve training-data
// coverage). Reward = pedigree-v2 `overall` aggregated per (model × role × domain) cell.
//
// DETERMINISTIC by design: UCB1 is argmax of a closed-form score — NO Math.random — so
// it preserves wolfpack-routing.mjs's resume-clean invariant. Exploration comes from the
// uncertainty term (low-n cells get a large bonus), not from randomness.

export const DEFAULT_C = Math.SQRT2;        // UCB1 exploration constant
export const DEFAULT_MIN_RUNS = 3;          // sampling floor (matches routing MIN_RUNS)

/**
 * Deterministic UCB selection over candidate cells.
 *   candidates: [{ model, runs, rewardMean }]  (rewardMean in [0,1] or null if no data)
 *   opts: { exploreAllowed = true, C = DEFAULT_C, minRuns = DEFAULT_MIN_RUNS }
 * Returns { model, source: 'floor'|'explore'|'exploit', ucb: number|null, reason } or null.
 *
 * Policy:
 *   1. exploit-only (exploreAllowed=false): pick the highest rewardMean among cells with
 *      runs >= minRuns. If none trusted → null (caller falls back to its safe default).
 *   2. sampling floor: if any candidate has runs < minRuns, force-sample the LEAST-sampled
 *      (source 'floor') — guarantees coverage before exploitation, which is also what gives
 *      the training corpus balanced (model × role) coverage.
 *   3. otherwise: argmax UCB1 = rewardMean + C*sqrt(ln(totalRuns)/runs). 'exploit' if the
 *      winner is also the highest-mean candidate, else 'explore'.
 * Ties break deterministically by candidate order (first wins).
 */
export function ucbSelect(candidates, opts = {}) {
  const { exploreAllowed = true, C = DEFAULT_C, minRuns = DEFAULT_MIN_RUNS } = opts;
  if (!candidates || candidates.length === 0) return null;

  if (!exploreAllowed) {
    const trusted = candidates.filter((c) => (c.runs || 0) >= minRuns && c.rewardMean != null);
    if (trusted.length === 0) return null;
    const best = argmax(trusted, (c) => c.rewardMean);
    return { model: best.model, source: 'exploit', ucb: null,
      reason: `exploit-only: best mean reward ${fmt(best.rewardMean)} over ${best.runs} runs` };
  }

  const under = candidates.filter((c) => (c.runs || 0) < minRuns);
  if (under.length > 0) {
    const least = argmin(under, (c) => c.runs || 0);
    return { model: least.model, source: 'floor', ucb: null,
      reason: `sampling floor: ${least.runs || 0}/${minRuns} runs — exploring to accrue data` };
  }

  const totalRuns = candidates.reduce((s, c) => s + (c.runs || 0), 0);
  const lnT = Math.log(Math.max(1, totalRuns));
  const scored = candidates.map((c) => ({ c, ucb: (c.rewardMean ?? 0) + C * Math.sqrt(lnT / Math.max(1, c.runs || 0)) }));
  const winner = argmax(scored, (s) => s.ucb);
  const bestMean = argmax(candidates, (c) => c.rewardMean ?? -Infinity);
  const source = winner.c.model === bestMean.model ? 'exploit' : 'explore';
  return { model: winner.c.model, source, ucb: round3(winner.ucb),
    reason: `UCB ${fmt(round3(winner.ucb))} (mean ${fmt(winner.c.rewardMean)}, ${winner.c.runs} runs) — ${source}` };
}

// First-wins-on-ties (strict >) → deterministic.
function argmax(arr, f) { let best = arr[0], bv = f(arr[0]); for (const x of arr) { const v = f(x); if (v > bv) { bv = v; best = x; } } return best; }
function argmin(arr, f) { let best = arr[0], bv = f(arr[0]); for (const x of arr) { const v = f(x); if (v < bv) { bv = v; best = x; } } return best; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function fmt(n) { return n == null ? 'n/a' : String(round3(n)); }
