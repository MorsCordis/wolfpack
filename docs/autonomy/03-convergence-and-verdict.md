---
status: design-only
tags:
  - docs/wolfpack
  - docs/autonomy
---

# 03 — Convergence & Verdict Enforcement

**Goal:** make cross-model review *trustworthy* (a hard structured verdict + grounding
check) and *progress-gated* (convergence detection that replaces the count-based severity
ceiling). On cron, round count doesn't matter — only that reviews are **good and
enforced**, and that the loop stops when it stops making progress, not at an arbitrary N.

Do the verdict contract **before** convergence detection — convergence reasons over
findings, so the findings must be reliable first.

---

## Part A — The structured verdict contract

### The hole today

The reviewer is non-Claude (good), but a *Claude* shim agent runs the CLI, reads the
free-text output, and decides `APPROVED` vs `ISSUES_FOUND` and extracts the
`findingsList` (`hunt-pipeline.js:473-522`, `:724-766`). The lenient parse (`:505`:
accept a `## Status:` line, accept "a clear final verdict statement") lets Claude declare
APPROVED when the reviewer was ambiguous. The cross-model independence is real at
*generation* but partly collapses at *adjudication* — Claude re-interprets the
adversary's verdict.

### The fix: reviewer emits a hard contract, or it's an ERROR

The non-Claude reviewer must end its output with a strict, machine-parseable block. The
shim's job shrinks from *interpret* to *extract-and-validate*:

```
<verdict>
{
  "verdict": "APPROVED" | "ISSUES_FOUND",
  "findings": [
    {
      "id": 1,
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "title": "short",
      "file": "app/payments/service.py",
      "line": 142,
      "claim": "one-sentence defect statement",
      "evidence": "what in the diff/file shows it"
    }
  ]
}
</verdict>
```

Enforcement rules:

- **No `<verdict>` block → ERROR (`missing_verdict_block`), full stop.** Do NOT prose-
  rescue. The current fallback ladder (`:505` (b)/(c)) is *removed* for the verdict
  itself — it's how an ambiguous review becomes a false APPROVED.
- The shim validates the JSON against the schema; malformed → retry once, then ERROR.
- `ISSUES_FOUND` with an empty `findings` array → ERROR (contradiction).
- This is enforced in the **review prompt** written to `/tmp/bloodhound-<slug>-r<n>.txt`
  (`:489-491`) and `/tmp/pointer-...`: append "Your response MUST end with exactly one
  `<verdict>{...}</verdict>` block matching this schema. No block = your review is
  discarded."

### The grounding check (catch the blind/hallucinating reviewer)

History: a blind Vibe reviewer once made 19 tool calls, 0 succeeded, 15 hallucinated
findings (`podman-vibe.sh` comment). The only defense now is "tools work." Add a cheap
post-hoc check the shim runs on each finding:

- **File exists:** every `finding.file` must exist in the worktree (`test -f`). A finding
  citing a non-existent file → drop it, flag `ungrounded` in the review log.
- **Normalize the path first (container vs host mismatch).** A containerized reviewer (esp.
  `agy`) emits paths under its mount — `/workspace/app/models.py` — but the shim runs
  `test -f` on the *host*, where `/workspace` doesn't exist, so every finding would be
  wrongly dropped as ungrounded. Mandate **repo-root-relative paths** in the reviewer's
  verdict output (skill instruction), AND have the shim **strip a leading `/workspace/` or
  `/`** before the existence check. Without this the grounding check silently nukes a
  correct review. (See [07] § path normalization.)
- **Line/symbol plausibility (optional, stronger):** `grep` the worktree for a token from
  `finding.claim`/`title` near `finding.line`. Zero matches across all findings while
  `verdict: ISSUES_FOUND` → the whole review is suspect → ERROR, fail over to the other
  model.
- Log grounding stats to `review-<n>.md` header: `grounded: 4/5 findings, 1 dropped`.

This is ~10 lines of bash in the shim agent and directly prevents the hallucination
regression from silently returning.

---

## Part B — Convergence detection (replaces the severity ceiling)

### Why the ceiling is the wrong abstraction

The current `CRIT_CEILING = base+2` / `HIGH_CEILING = base+1` math
(`hunt-pipeline.js:451-466, 538-549`) is a precise controller fed by a noisy proxy
(count of rounds). It conflates two opposite situations:

- **Healthy:** "fix critical A → reveal a *different* critical B" — the code is genuinely
  converging, just slowly. You WANT to keep going. A count cap wrongly halts this.
- **Pathological:** oscillation (fix A re-breaks B), whack-a-mole (count flat/rising),
  hallucinated new criticals each round. A count cap wrongly *continues* some of these
  up to the ceiling, burning tokens.

What distinguishes them isn't *count*, it's *progress*. So gate on progress.

### Finding fingerprints

After Part A, every finding has `{file, line, claim}`. Fingerprint each:

```
fp = normalize(file) + ":" + defectClass(claim)
```

where `defectClass` buckets the claim (e.g. "missing related_name", "tenant leak",
"unrounded tax", "record retention below the required minimum" -- generic review classes) — a coarse semantic key, computed by the shim
agent from the claim text. Track the set of fingerprints seen per round in metadata:
`review_fingerprints: [["fpA","fpB"], ["fpC"], ...]` (one array per round).

### The convergence rules (per review loop — Bloodhound and Pointer)

Replace `while (!approved && round < roundCap)` with a convergence-gated loop. After each
`ISSUES_FOUND` round, classify:

| Signal | Condition | Action |
|---|---|---|
| **Converging** | all this-round fingerprints are NEW (unseen in prior rounds) AND count ≤ prior count | **continue** (no fixed cap) — it's working |
| **Oscillating** | any fingerprint from round *N-2 or earlier* reappears (fixed-then-returned) | **park `non_convergence`** — pack is fighting itself |
| **Stalled** | finding count not strictly decreasing over 2 consecutive rounds | **park `non_convergence`** |
| **Plan smell** | cumulative DISTINCT criticals across rounds ≥ `PLAN_SMELL_BOUND` (e.g. 12) | **kick to Alpha** (`FLAWED_PLAN`) — spec/plan is wrong, not the code |
| **Resolved** | `verdict: APPROVED` | **proceed** |
| **Critical stuck** | a CRITICAL fingerprint persists across `CRIT_PERSIST` rounds (e.g. 3) | **park `open_critical`** |

A hard safety bound still exists, but as a **circuit breaker, not a quality knob**:
`MAX_ROUNDS` (e.g. 8) and the token `budget` ([05]) — hitting either parks
`non_convergence`, never proceeds. The point: on cron you bound by *progress + a runaway
guard*, and you **park instead of proceed** when you hit the guard.

### What this removes

- `CRIT_CEILING` / `HIGH_CEILING` / `finalRoundHasCritical` / `roundCap++` extension
  logic (`:461-466, 538-549`) — gone, replaced by the table above.
- The "proceed-anyway at cap with ≤HIGH open" branch (`:618-626`) — **gone.** On cron,
  proceeding past open real findings is the anti-goal. Park instead.
- Net: *less* code than the ceiling math, measuring the right thing.

### What this keeps

- Hard-halt on a stuck critical (now `open_critical` park, [02]).
- The per-tier *base* round count as a floor (`:421-423`) — still a floor before
  convergence logic engages, so trivial hunts don't over-review.

### Capped parallel review fan-out (workflow-orchestrated, not CLI self-orchestration)

A review round MAY run **multiple single-pass cross-model reviews in parallel** (one per
lens — correctness / compliance / security — or one per app), but the fan-out is owned by
the **workflow JS**, never by the cross-model CLI. This is the line that keeps the
single-pass mandate intact while still allowing parallelism:

- **Disallowed:** a cross-model CLI (Vibe/Gemini) spawning its OWN sub-agents via
  `task`/`invoke_agent` in headless review — the run-#5 failure mode (timed out / blew turn
  limits / **never emitted a verdict, silently**). Vibe's `task` tool stays removed.
- **Allowed:** the workflow spawns N capped single-pass review agents via `parallel()`;
  each sub-agent is itself single-pass (no nested fan-out). One level only.

**Failure surfacing + n-1 concurrency degradation** — the reason workflow-level is the only
safe home: `parallel()` is a barrier that returns `null` for any agent that throws/errors,
so the orchestrator sees exactly which reviews failed the moment the batch resolves,
deterministically, no hang. On failure it re-spawns the **failed units at a lower
concurrency cap** and loops:

```
cap 3 → (any fail) → cap 2 → (any fail) → cap 1 (sequential single-pass) → (still fails) → park
```

- **n-1 lowers *concurrency*, not coverage.** You still run every review unit (lens/app);
  you just run fewer simultaneously. Failures are almost always contention/rate-limit driven
  (that's why the cross-model flock cap is 2 today), so dropping concurrency is the actual
  fix — coverage is never silently dropped.
- **Detection is at the barrier**, not mid-flight: you learn of failures when the batch
  resolves, then retry the failed subset at cap-1 next iteration. Batch-boundary retry is the
  right grain for review fan-out; instant-cancel isn't worth building.
- Each degradation step is **logged with the reason** (the null's error / exit code / empty
  output) — the same fallback-surfacing [05] + README field-finding #1 require.
- Floor is cap=1 (the proven-safe sequential single-pass); if even that fails, **park**
  (`review_error` / `model_quota`) — never hang, never proceed.

This is also how model-grading calibration ([06]) gets its parallelism: data accrues across
**hunts** (the campaign-runner already runs hunts 2-at-a-time) and across these capped
intra-phase fan-outs — *not* by restoring CLI sub-agent self-orchestration.

### The ledger as the model-grading substrate (run-#5 thread)

The fingerprint set is already a per-round record. Widen each entry from a bare key to a
row and the pipeline grows its own **model scoreboard for free**:

```
{ fp, first_round, raised_by: <model>, stage: bloodhound|pointer|watchdog,
  disposition: accepted|rejected|recurred|dropped, resolved_round }
```

Every model-grading metric is then a **query over this ledger**, not a separate instrument:

- **signal/noise per (model, stage, domain):** `accepted ÷ (accepted+rejected)` — a reviewer
  whose findings Alpha/Shepherd keep rejecting is generating noise, not catching bugs.
  **Caveat (2026-05-31 review):** the *acceptor* (Alpha/Shepherd) is the instrument, so this
  is biased — a lazy acceptor who wrongly rejects a real finding makes a *good* reviewer look
  noisy. Treat instantaneous signal/noise as **provisional**; let the lagging miss-attribution
  below confirm or correct it before it drives routing ([06]).
- **convergence quality:** how fast a model's fingerprints stop recurring.
- **miss attribution (the lagging gold signal):** fingerprint a *downstream* finding (a
  Tracker failure, an [04] smoke escape) and look it up — **never in the ledger** = a miss
  (no reviewer caught it; debit whichever stage *should* have, by domain); **raised then
  rejected** = a wrong-rejection (someone dismissed a real one).

This is the fix for the saturated-`5/5` problem (operator observation: a hunt scored
5/5/5 then spawned 7 smoke findings — the self-grade has zero discriminating power). **Route
model selection on these objective, varying, domain-sliced ledger metrics — not on the cert
score.** Keep `5/5` as a human-readable cert summary if you like; just don't *route* on it.
[06] is how the routing consumes this.

---

## Tier config consolidation (do alongside)

Tier round-counts currently live in 4 disagreeing places: `wolfpack/SKILL.md:44-49`
(stale: Red=2), the Pipeline-Shapes table (`SKILL.md:39`: Red=3), the workflow
`Math.max` floors (`:421-423`), and Alpha's metadata. Reconcile to **one source of
truth** — a `TIER_CONFIG` constant block (base rounds, `PLAN_SMELL_BOUND`,
`CRIT_PERSIST`, `MAX_ROUNDS` per tier) at the top of `hunt-pipeline.js`, with the SKILL
table generated-from / documented-as matching it. After convergence detection, "rounds"
is a floor + a few thresholds, not a cap — simpler to keep aligned.

---

## Threading into existing code

- **`hunt-pipeline.js`:** the review prompts (`:489-491`, `:740`) gain the verdict-
  contract instruction; the shim steps (`:504-520`, `:752-762`) gain JSON validation +
  grounding; the loop bodies (`:467-627`, `:720-827`) swap the ceiling math for the
  convergence table; new `TIER_CONFIG` at top.
- **`REVIEW_SCHEMA`** (`:33-55`) extends each finding with `line`, `claim`, `evidence`,
  `fingerprint`, and a top-level `grounded` count + `dropped` array.
- **metadata.json:** add `review_fingerprints` (per-round arrays) and `convergence`
  (`{ classification, cumulative_distinct_criticals }`).
- **Bloodhound/Pointer skills:** document the mandatory verdict block + that findings need
  `file`+`line`+`evidence` (so grounding can check them).

---

## Acceptance criteria for THIS feature

- AC1 [auto] A review with no `<verdict>` block returns ERROR `missing_verdict_block`;
  no prose-rescue path produces an APPROVED.
- AC2 [auto] A finding citing a non-existent file is dropped and logged `ungrounded`; a
  review where 0/N findings ground out fails over to the other model.
- AC3 [auto] "fix critical A → new critical B (different fingerprint)" continues past the
  old base cap; "critical A reappears after being fixed" parks `non_convergence`.
- AC4 [auto] ≥12 cumulative distinct criticals routes to `FLAWED_PLAN` (Alpha), not a
  Shepherd rewrite.
- AC5 [auto] No path proceeds to Debrief/Shepherd with an open real CRITICAL — it parks.
