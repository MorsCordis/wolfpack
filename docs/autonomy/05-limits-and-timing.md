---
status: design-only
tags:
  - docs/wolfpack
  - docs/autonomy
---

# 05 — Limits & Timing

> **Part C (Timing tracking) implemented** (2026-06-07, live-edit build layer): per-phase
> `timing.jsonl` markers folded into `hunt-pipeline.js`'s `heartbeat()` (agent-stamped
> clock — no `Date` in the workflow JS, AC5), `completed_at` stamped by the Watchdog on
> PASS, host-side aggregator `scripts/wolfpack-timing.mjs` (+`.test.mjs`, 11 cases) writes a
> `timing` block `{total_s, duration, by_phase, by_model, complete, incomplete_phases?}`
> into `pedigree.json` and emits the index Duration column, with C4 completeness flagging.
> **Parts A & B (limits — budget breaker, host-side rate-limit gate, reset-aware
> rescheduling, CLI 429 backoff, the AC6 `--max-price`/`--max-tokens` per-call bound) remain
> design-only** — the next layer, which consumes this timing history (`estimatedHuntCost`).
> The spend-by-model *token/quota* meter (C1b) is deferred with the limits layer too: model
> attribution by phase is recorded now (`by_model` durations), but real token/quota cost
> needs the shim cost-capture that lands with AC6 — not fabricated here.

**Goal:** keep the autonomous runner aware of usage limits (Claude account rate-limit +
self-imposed token budget; reactive backoff for Agy/Mistral), and track per-hunt
duration so overnight batches are *scheduled against the window* instead of dying at the
wall. These two features are the same feedback loop: timing history makes limit-awareness
*smart* instead of merely defensive.

---

## Two different things both called "limits" — keep them separate

- **Self-imposed token budget** — the Workflow harness `budget` global: `budget.total`
  (a ceiling you set), `budget.spent()` (output tokens across the main loop *and* all
  workflows — a *shared* pool), `budget.remaining()`. Real, usable today. A runaway
  guard, **not** the account rate-limit.
- **Account rate-limit** — the rolling 5-hour window / weekly Max caps. **Not** visible
  to `budget`. The signal lives outside the workflow, in the same usage telemetry the
  claude-hud "Usage" bar reads (`reference_context_window_and_hud`).

The mistake to avoid: wiring the pipeline to `budget.remaining()` and thinking it's
rate-limit-aware. It isn't. You want both, doing different jobs.

---

## Part A — Claude awareness: gate at hunt boundaries, be reset-aware

### A1. In-workflow circuit breaker (have now)

Before `campaign-runner.js` scaffolds the next hunt, check:

```js
if (budget.total && budget.remaining() < estimatedHuntCost(tier)) {
  // stop scaffolding NEW hunts; park the remaining queue; return WAVE_PAUSED_BUDGET
}
```

`estimatedHuntCost(tier)` comes from timing/cost history (Part C). Set `budget.total`
for an overnight run to "how much of my window I'll spend." This is your runaway guard,
and it lives entirely in the workflow.

### A2. Host-side rate-limit gate (the real one)

The precise account-limit signal isn't cleanly reachable *inside* a workflow agent — but
the **driver** (your systemd timer / loop wrapper that kicks off runs) can read it the
way `ccusage`/claude-hud do: token accounting from the local transcript JSONL against
your known plan limits. So the gate lives in the driver, checked **between hunts**:

```
before launching hunt:
  remaining_window = estimate_remaining_claude_usage()   # transcript accounting
  if remaining_window < safety_headroom:
      defer; ScheduleWakeup(after window reset)
```

**Critical rule: gate at clean boundaries, never mid-agent.** Halting mid-Shepherd leaves a
half-built worktree. The resume probe recovers it, but graceful > recoverable. The START gate
runs between hunts (the wave structure gives natural boundaries); the boundary gate below runs
between the phases of a running hunt.

### A2b. Boundary gate (between phases)

A long Orange hunt that STARTED at 79% can still hit the wall mid-agent and die as a confusing
failure. So `hunt-pipeline.js` re-checks the window before every agent phase after Scaffold
(Spec, Plan, Review, Debrief, Implement, Code Review, Test, Certify; not per review round, not at
Verify) with `scripts/wolfpack-window-gate.mjs --json --boundary --phase <P> --record <plan dir>/usage-gate.jsonl`.

- **Mode and ceilings.** Boundary mode has its OWN tier-independent ceilings:
  `WOLFPACK_5H_BOUNDARY_MAX_PCT` (default 95) and `WOLFPACK_WEEKLY_BOUNDARY_PCT` (default 98).
  They are higher than the start ceilings on purpose: the start gate decides whether a whole hunt
  fits, the boundary gate only whether ONE more phase does. Parking at the start ceiling between
  phases would strand most long hunts half-built. Boundary mode never offloads.
- **Park shape.** A `defer` parks `model_quota` with `resume_phase` = that phase (clarify): the
  ordinary auto-resumable quota park, so the next pass resumes exactly there after the reset.
- **Degraded / error.** A stale snapshot falls back to the transcript estimate exactly as the
  start gate does (the decision is followed, labelled `degraded:true`, and the run logs
  `USAGE GATE DEGRADED`). A gate that FAILS (exit 1 or `decision:"error"`, e.g. an invalid
  threshold env) parks `usage_gate_error` (redirect). A gate whose answer cannot be READ (the
  relay agent died, garbled output, decision/exit mismatch) proceeds UNGATED but loudly:
  `USAGE GATE UNAVAILABLE` in the log, the event on the hunt result (`usageGateEvents`), and a
  `pipeline_note` line in `usage-gate.jsonl` (written by the next gate run or by the park /
  metadata agent that ends the run).
- **`usage-gate.jsonl`.** Append-only, one line per decision
  (`{at, mode, phase, decision, source, degraded, degraded_reason, reason, five_hour_pct, seven_day_pct, reset_at}`)
  plus `{at, kind:"pipeline_note", note}` lines. A write failure warns and never changes the decision.

### A3. Reset-aware self-resume (the useful part)

Don't just stop — *continue*. If the driver knows the window reset time, it
`ScheduleWakeup`s to resume right after reset. An overnight batch that exhausts the
5-hour window at 01:00 picks back up at ~06:00 automatically instead of failing the
batch. That's the difference between "limit-aware" and "actually useful overnight."

Per the `ScheduleWakeup` cache-window note: a long defer (past reset) is a deliberate
cache miss — fine here, you're waiting hours, not polling.

### A4. Estimation honesty (fail-loud)

Transcript-based remaining-usage is an *estimate* (it lags; shared-pool effects make it
approximate). Per the fail-loud rule, the gate is **conservative**: leave headroom, pause
early. A false "pause too soon" costs a few idle minutes; a false "plenty left" strands a
half-built compliance hunt at the wall. Log the estimate + decision so you can calibrate
the headroom from real runs.

---

## Part B — Agy / Mistral: reactive backoff, not proactive quota

Be realistic: proactively reading remaining Gemini/Mistral quota depends on whether
`agy`/`vibe` surface it, and they largely don't. Don't build a proactive reader you
can't trust — build **reactive backoff**, extending what the shims already do (failover +
flock cap of 2, `podman-vibe.sh`/`podman-agy.sh` `sem_run`).

In the shim, distinguish a **rate-limit signal** (HTTP 429 / quota message / known exit
code) from a **hard failure**:

- **Rate-limited** = "this model is napping," not "broken." Prefer the *other* model
  (sticky-away) and set a short per-model cooldown (a touch-file in
  `${TMPDIR}/wolfpack-sem/<model>.cooldown` with an expiry the shim checks before
  dispatch). Complements the existing flock cap.
- **Both models rate-limited** → don't fail the hunt → **park `model_quota`** ([02]) and
  let the driver reschedule (Part A3). The current behavior (`ERROR` → pipeline paused,
  `hunt-pipeline.js:532-534`, `:768-770`) becomes a park, not a dead-end.

Operator decision: failover stays Vibe↔Agy only — never fall back to
Claude Sonnet for review phases.

### B1. Per-call review budget — the turn-cap U-curve (Phase-0 finding, fold in here)

Distinct from rate-limit backoff above: how a **single** reviewer call is bounded. The
Phase-0 build surfaced (validated 2026-06-02, 3 runs) that the `--max-turns` cap Vibe/Mistral
runs under has a **U-shaped failure curve**, and turn count is the wrong knob:

- **Too few turns → starvation.** Vibe spends one turn per tool call; `--output text` emits
  only the *final* response, so hitting the cap mid-review returns **empty output and the whole
  review is lost** (looks like a model failure — the likely mechanism behind the earlier
  auto-hunt "never emitted a verdict" flameouts).
- **Uncapped → context bloat.** Mistral keeps reading until the payload overruns its API
  ceiling (~190K chars observed) and the **server disconnects** (`Network error`).
- **Sweet spot → generous-bounded turns + read-discipline prompting** (lead with the diff, grep
  over full-reads, targeted line-range reads). Read-discipline, not a tight cap, is what holds
  context under the ceiling.

**Phase-0 left a stopgap, [05] does the real fix.** Stopgap shipped: `podman-vibe.sh` default
`30→80` (+ `MAX_TURNS=0` to disable), `hunt-pipeline.js` review/certify steps `30→80`. The
robust replacement here: bound each call by **`--max-price DOLLARS` / `--max-tokens N`** (Vibe
exposes both) instead of a turn count — these cap *cost/context* directly without the
starve/bloat tradeoff, and `--max-tokens` should pre-empt the bloat disconnect more gracefully
than a turn limit. Confirm the `agy`/Gemini equivalent (it has no `--enabled-tools`; check for a
token/price bound) and apply symmetrically; where one CLI lacks it, keep the generous turn cap +
read-discipline for that side. Feed the chosen ceiling from the Part C spend-by-model meter so
it's data-set, not guessed. Detail + the empirical trace live in the operator's Vibe-execution notes.

### B2. Retry/backoff implementation recipe (build this in `podman-vibe.sh`)

Concrete recipe (Mistral's own recommendation, 2026-06-07, tempered with the empirical data
from that day's failures). Implement in `podman-vibe.sh` so it covers BOTH the auto-pipeline and
manual `/bloodhound`/`/pointer` reviews:

1. **Retry wrapper — exponential backoff + jitter.** Wrap the `vibe -p` call:
   ```bash
   MAX_RETRIES="${WOLFPACK_MAX_RETRIES:-3}"
   BASE_DELAY="${WOLFPACK_RETRY_DELAY:-2}"
   MAX_DELAY="${WOLFPACK_MAX_DELAY:-30}"
   retry_with_backoff() {            # usage: retry_with_backoff vibe -p ...
     local attempt=0 delay=$BASE_DELAY
     while [ $attempt -lt $MAX_RETRIES ]; do
       if "$@"; then return 0; fi
       attempt=$((attempt+1)); [ $attempt -ge $MAX_RETRIES ] && break
       local sleep_time=$((delay + RANDOM % delay))
       echo "vibe retry $attempt/$MAX_RETRIES in ${sleep_time}s..." >&2
       sleep $sleep_time
       delay=$((delay*2)); [ $delay -gt $MAX_DELAY ] && delay=$MAX_DELAY
     done
     return 1
   }
   ```
   **⚠ Empirical caveat (2026-06-07): `MAX_DELAY=30` is almost certainly TOO SHORT.** That day's
   outage disconnected on the FIRST call (`message_count=2`, ~73K chars) and did NOT recover across
   30s→60s manual backoff. So either raise `MAX_DELAY` into the minutes, or — better — treat
   exponential-backoff-within-a-hunt as the *fast-path* and lean on the **circuit breaker + park**
   (below) as the real fallback when the API is having a bad day. Backoff alone is NOT a fix for a
   sustained throttle; don't burn the hunt retrying a down endpoint.
2. **Retry only transient errors.** Inspect stderr/exit. RETRY on: `Server disconnected`,
   `Network error`, `rate limit`, HTTP `429`, `5xx`, timeout, AND empty stdout (the starvation
   signal — `--output text` emits nothing when the turn cap is hit mid-review). DO NOT retry: auth
   failures, invalid-prompt/unknown-tool errors, file-not-found — retrying those just wastes the
   window. (Pair with B1: an empty-output retry should also bump the turn budget, not just wait.)
3. **Lower concurrency during a known outage.** The flock semaphore is concurrency control, not
   rate-limit control. Make it tunable — `SEM_MAX="${WOLFPACK_SEM_MAX:-2}"` — and drop it to `1`
   when Mistral is flaky so retries don't compete for the same throttled endpoint.
4. **Circuit breaker → park, don't spin.** Track consecutive failures across calls (a touch-file
   counter in `${TMPDIR}/wolfpack-sem/mistral.fails`). If > N failures within M minutes, stop
   dispatching to Mistral for a cooldown window, prefer Gemini (the existing sticky-away in Part B),
   and if BOTH models are circuit-broken → **park `model_quota`** ([02]) and let the driver
   reschedule past the window (A3). This is the same "both rate-limited → park" rule Part B states,
   just made stateful so one bad endpoint doesn't fail-loop every hunt in the batch.

All four knobs are env-overridable so an operator can tighten them mid-incident without editing the
shim. Cross-model failover stays Vibe↔Agy only (operator decision) — never Claude
Sonnet for review.

---

## Part C — Timing tracking

Fully feasible, with **one hard constraint up front:**

> **Workflow scripts cannot call `Date.now()` / `new Date()`** — they throw (the harness
> blocks them; they'd break resume). All timestamps come from **agents** (real bash:
> `date -Iseconds`) or the host driver, stamped into files and read back. The workflow JS
> can sequence and compare strings, but cannot read the clock.

### C1. Markers

- **t0 (hunt start):** scaffold already writes a `created` ISO timestamp to
  `metadata.json` (`hunt-pipeline.js:281`, "current ISO8601 timestamp") — reuse it, or
  add a distinct `created_at` stamped when the worktree/pod is created.
- **t_end:** Watchdog/Verify stamps `completed_at` in metadata.
- **Per-phase:** each phase agent already writes a heartbeat as its first action
  (`heartbeat()`, `:149-152`). Extend the heartbeat JSON with a `ts` field, OR have each
  phase append a line to `.wolfpack/plans/<slug>/timing.jsonl`:

```jsonl
{"phase":"Plan","event":"start","ts":"2026-05-30T22:14:03-06:00","agent":"alpha"}
{"phase":"Plan","event":"end","ts":"2026-05-30T22:19:41-06:00"}
{"phase":"Review","event":"start","ts":"2026-05-30T22:19:50-06:00","round":1}
...
```

`timing.jsonl` is append-only (each agent appends its own start/end — no clobbering,
parallel-safe).

### C1b. Spend-by-model-by-phase (the routing meter — run-#5 thread)

Widen the same telemetry from *duration* to *spend*: each phase agent also appends its model
+ token/quota cost (to `timing.jsonl` or a sibling `spend.jsonl`):

```jsonl
{"phase":"Review","round":1,"model":"gemini","tokens":12044,"quota_pct":7.1}
```

This is the **x/y the routing in [06] needs**: `predicted_dimensions` on the x-axis, measured
per-model spend on the y-axis. Without it you tune routing from a single anecdote ("run #5 ≈
40% Gemini"); with it, after a calibration batch you can *see* "UI-heavy hunts lean ~60% on
Gemini, backend hunts barely touch it, Mistral carried the volume at ~zero window cost" — and
route from the curve. **Build the meter before tuning the dial.** Aggregate into
`pedigree.json` (`spend: { by_model, by_phase }`) and the index alongside the duration data.

### C2. Aggregation → pedigree

A closing step (host-side script, or a final agent — NOT the workflow JS) reads
`timing.jsonl`, computes total + per-phase durations, and writes them into:

- `pedigree.json` (per-run scorecard) — `timing: { total_s, by_phase: {...} }`.
- The pedigree **index** (`.wolfpack/pedigree/index.md`) — add a duration column, so you
  accumulate a *historical dataset*, not a one-off number.

### C3. What the data tells you

- The long pole (bet: Bloodhound rounds + Tracker).
- Per-tier averages: "Yellow ≈ 14 min, Red ≈ 38 min" → realistic overnight batch sizing.
- Feeds `estimatedHuntCost(tier)` (Part A1) and the driver's "fits the window?" decision.

### C4. Completeness validation + fallback surfacing

Two integrity guards on the telemetry itself, both run by the host-side aggregator (C2):

- **Every completed hunt must have complete `timing.jsonl`** — a start+end for each phase
  that ran. An incomplete record is **flagged, not silently stored as partial**: a missing
  phase means an agent didn't append, which is itself a signal worth seeing (and would
  otherwise corrupt the per-phase averages C3 depends on).
- **Fallback reasons surface to you, not just a log.** When a primary cross-model CLI falls
  back to the other (run #5's silent Gemini fallback), the reason (exit code / stderr
  excerpt / missing-verdict / empty output) lands in the **hunt summary / notification** —
  per the project's fail-loud rule, a buried log isn't disclosure. A silent fallback also means the masked path
  (there, Mistral-as-certifier) went **unverified**, so the summary flags that too.

---

## The payoff: timing makes limits smart

Once you track duration **and** token-cost per hunt, indexed by tier, the driver can
answer the real question:

> "Can I fit this Red hunt before my window resets, or should I run two Yellows instead?"

Limit-awareness without timing history is a dumb stop sign. With it, the runner schedules
the overnight batch to actually fit the window — start the long Red early, slot Yellows
into the tail, defer what won't fit to the post-reset wake-up. Build both together; feed
both into the pedigree index (already your historical store).

---

## Threading into existing code

- **`campaign-runner.js`:** add the A1 budget check before each hunt scaffold in the
  batch loop (`:135-154`); on trip, park remaining + return `WAVE_PAUSED_BUDGET`.
- **Host driver (systemd timer / loop wrapper):** owns A2/A3 (rate-limit estimate +
  reset-aware `ScheduleWakeup`) and C2 (timing aggregation). This is the right home —
  it has clock + transcript access the workflow lacks.
- **`podman-vibe.sh` / `podman-agy.sh`:** add 429-detection + per-model cooldown
  touch-file checked before `sem_run` dispatch.
- **`hunt-pipeline.js`:** heartbeat (`:149-152`) gains `ts`; both-CLI-fail exits become
  `model_quota` parks; scaffold stamps `created_at`; Watchdog/Verify stamp `completed_at`.
- **metadata.json / pedigree.json:** `timing` blocks; pedigree index gains a duration col.

---

## Acceptance criteria for THIS feature

- AC1 [auto] With `budget.total` set, the runner stops scaffolding new hunts and parks
  the queue once `remaining()` drops below one hunt's estimated cost — it does not start
  a hunt it can't finish.
- AC2 [auto] The host gate defers a hunt when estimated remaining window < headroom and
  `ScheduleWakeup`s past the reset; the batch resumes automatically after reset.
- AC3 [auto] A 429 from Mistral makes the shim prefer Gemini (cooldown set), not fail the
  hunt; both rate-limited → `parked:model_quota`, not a dead pipeline.
- AC4 [auto] Each completed hunt has `timing.total_s` + per-phase breakdown in
  `pedigree.json` and a duration entry in the pedigree index.
- AC5 [auto] No timing/clock call appears in the workflow `.js` files (all timestamps are
  agent- or host-authored) — verified by grep for `Date`/`now(` in `.agents/workflows/`.
- AC6 [auto] Each reviewer call is bounded by a cost/token budget (`--max-price`/`--max-tokens`)
  rather than the stopgap turn cap, with the ceiling fed from the spend-by-model meter (C1b); a
  review that hits the budget parks/fails-over with a recorded reason, never returns empty (B1).
