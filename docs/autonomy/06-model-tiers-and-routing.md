---
status: design-only
tags:
  - docs/wolfpack
  - docs/autonomy
---

# 06 — Model Tiers & Routing

How models get assigned to roles, and how that assignment **learns from data instead of
folklore**. Captures the 2026-05-30 run-#5 musing thread. Builds on [03] (the fingerprint
ledger = grading substrate), [05] (spend telemetry), and [02] (park).

> **Implemented** (2026-06-08, live-edit build layer — the LAST layer; consumes everything
> before it). Two sub-commits:
> - **Step 0 — un-box the tools (AC1):** `podman-vibe.sh` runs a capable, sandbox-scoped
>   toolset (`read grep edit write_file bash`, `task` excluded) instead of the 2-tool cage;
>   `scripts/wolfpack-toolcheck.mjs` is the fail-loud preflight that catches a silent re-box.
> - **Routing + meter + observability (AC2–AC5):** `scripts/wolfpack-routing.mjs` is the
>   deterministic data-driven recommender (work-horse/judgment tier defaults → domain
>   override → explore/exploit, never-explore-on-Red, hard non-Claude-reviewer + Opus-planner
>   constraints, fail-safe to the tier table on thin data). `scripts/wolfpack-model-stats.mjs`
>   is the AC3 meter (per-model spend/signal/noise/miss sliced by domain, honest NULLs on thin
>   data, gitignored regenerated artifact). The orchestrator records a CLASSIFIED `fallback_log`
>   (AC2 — tool-starved vs capability vs quota) + a `reviewer_diff_violations` diff-catch
>   backstop, and refreshes the meter host-side at Certify. Alpha + Bloodhound + Tracker skills
>   reconciled (Tracker no longer fixed-Opus; Sonnet dropped from the reviewer pool).
>
> The router returns the **tier defaults today** because no calibration batch has run yet — the
> meter is intentionally thin (per § Sequencing, "the tier table is a hypothesis until 3–4
> land"). The mechanism + the fail-safe are what shipped; the learned policy accrues as hunts
> run through it. Built as live edits per docs/autonomy/README.md § Build process; Gemini
> cross-model reviewed each sub-layer (Mistral throttled out on the [05] cost cap, closed on
> Gemini + unit tests per precedent).

## The two tiers (a DEFAULT, not a cage)

| Tier | Models | Roles | Why |
|---|---|---|---|
| **Work horse** | Sonnet, Mistral | Sonnet → Shepherd (implement); Mistral → Bloodhound/Pointer (review volume) | mistake-tolerant *because* run-until-converged ([03]) + a judgment verify + tests catch the misses |
| **Judgment** | Opus, Gemini | Opus → Alpha (plan) + orchestrator; Gemini → Watchdog (verify/cert) + the irreplaceable UI/UX reviewer | reserve the metered/scarce quota for what you can't afford to be wrong |

**Hard constraint (never relax):** adversarial review is **always non-Claude** — a reviewer
never reviews its own family. So Sonnet's work-horse seat is *implementation*, Mistral's is
*review*; if Shepherd = Mistral, Pointer must be Gemini (cross-family). (Review-phase
failover stays Vibe↔Agy, never Claude Sonnet.)

**Tracker is a cross-tier, metered-with-fallback role — NOT pinned to a tier and no longer
fixed-Opus.** Route it across the whole pool — Opus, Gemini, Sonnet, even Mistral — gated on
two guards that make a weak tester *visible and survivable* rather than a run-killer:

1. **Trackable metrics in pedigree** — test pass/fail, tests-that-were-non-functional,
   miss rate ([03] ledger). A weak Tracker shows up in the data instead of silently
   shipping broken tests.
2. **A fallback on failure** — if the assigned model produces non-functional tests or errors
   out, fail over (to a more capable model) so the automation *continues* instead of
   imploding. Sonnet can run Tracker with a fallback in place; Mistral can too, under the
   same two guards. The old "Mistral tests are non-functional → always pay for Opus" lesson
   is retired: Tracker-owns-tests + the local-PG cycle + these guards contain the risk
   without pinning the role to the most expensive model.

The tiers are a **starting default**. Capability fit (next) overrides them per hunt.

## Why the lower tiers are viable now (the safety nets)

This whole tiering rests on a claim that earlier failed: *lower-tier models can carry
production work.* What changed isn't the models alone — it's the **process safety nets** that
now catch their slips before anything ships, so a cheaper model's mistake is contained
instead of fatal:

- **Adversarial code review (Pointer)** catches implementer slips a cheap Shepherd makes.
- **Tests separated from Shepherd (Tracker owns them)** — the implementer no longer
  self-certifies, so an implementer weakness doesn't hide behind its own green tests.
- **The local-PG test path** makes test cycles cheap enough to **run-until-converged** ([03])
  rather than one-shot — a work-horse that needs two passes is now affordable.

These are *why* a Sonnet/Mistral work-horse works in 2026-05 where it didn't in 2026-04. The
prior "escalate to Opus" lessons were learned **before** these nets existed (and under a
tighter model-availability regime); they're stale, not wrong-at-the-time. Treat capability
routing as gated on these nets being in place — if a net is down (e.g. review skipped on a
Green hunt), the work-horse assumption weakens for that hunt.

## Capability × economics — not economics alone

Cost-conservation only applies where a model is *interchangeable* with a work horse. Gemini
is the UI/visual specialist (operator decision) and catches Sonnet/Mistral misses in
UI/UX review **and** generation — there it is **not** interchangeable, so you pay the quota.
And capability matters **most** in false-negative-prone domains: more work-horse rounds never
re-surface a *miss*; only a more-capable independent check does.

Route domain-aware on `predicted_dimensions`: high `frontend_complexity` → Gemini reviews (or
a **thorough**, not thin, Gemini verify); pure backend → Mistral reviews + thin Gemini verify.
**Verify depth scales with domain risk.** Batch *composition* (the domain mix) drives the
window plan ([05]).

## Window economics

Run #5 burned ~40% of the 5h Gemini quota in 40 min — because the **metered** model carried
the **volume** (Gemini did Bloodhound ×3 + Pointer ×2 + a Watchdog fallback). The fix:

- **Route volume to the unmetered work horse** — Mistral (generous monthly, never approached).
- **Reserve Gemini for the thin verify + its irreplaceable domains.** Per-hunt Gemini cost
  collapses → many more hunts/window.
- **Parallel hunts come LAST.** Parallelism *accelerates* burn, so it's only affordable once
  each hunt barely touches the metered window. It is not the pacing fix.
- **Anti-idle:** unmetered Mistral overflow means "exhausted the window, can't do anything"
  never happens — batch the Gemini verifies when its window is low, keep building on Mistral.

**Usage-awareness asymmetry:** Claude + Gemini/Agy have usage commands; Mistral does **not** —
which is fine, because Mistral's limit is effectively non-binding. Gate only the constrained
providers (Gemini 5h, Claude window — [05]); treat Mistral as the overflow you route *toward*.
Its requirement is *reliability*, not metering.

## Give models their tools — don't box them

Every Mistral failure in the run-#5 shakedown was a **tool-box failure, not a capability
failure**:

1. `--enabled-tools read_file,grep` comma-joined → argparse `append` + fnmatch made it one
   bogus tool name → *all* tools filtered out → blind. (Fixed: repeat the flag per tool.)
2. read-only blocked `git diff` → Pointer/Watchdog (told to run it) couldn't see the code.
3. read-only blocked **artifact + metadata writes** — every role is a *producer* (writes
   `review-N.md` / `certification.md`, updates `metadata.json` via `search_replace`). The
   headless path bolted on a "shim ghost-writes the files from stdout" workaround; interactive
   runs forced manual approval of every action.

Proof it's the box, not the model: **same work, Agy/Gemini (capable native tools) succeeds,
Vibe/Mistral (boxed to 2 tools) fails.** Tight per-role allowlists are brittle — you must
*predict* every tool a role needs, and a miss fails **silently**.

**Principle:** give each model its **capable default toolset** and let it pick; make it safe
by **layering, not boxing**:

- The **sandbox + Bash denylist** is the real guardrail (no prod, no prod deploy command, no
  destructive ops, can't escape). Tool-freedom lives *inside* it.
- **Reviewer write-scope — RESOLVED (2026-05-31): un-box, enforce by role + diff-catch.**
  Per the user: models need real write access *including* in a pervasive module (e.g. a payments module), which touches a
  large fraction of the app — so a path-fence is both impractical (such a module is pervasive, you
  can't cleanly carve it out) and counter to the un-boxing thesis. So **no path boundary**:
  - **Implementers (Shepherd): full write, no fence — incl. the project's
    compliance areas.** Never restrict app source.
  - **Reviewers (Bloodhound/Pointer): full write tools too**, but read-only is enforced by
    **role instruction + diff-catch**, not a tool boundary. Cheap backstop (detection, not a
    fence): if a reviewer's `git diff` touches app source, **flag it loudly** in the review
    log + `metadata.json` — a reviewer that edits code is violating its role, so *detect* it
    (per the diff-catch model) instead of letting it pass silently. The sandbox + Bash
    denylist remain the real guardrail.
  Net: SKILL Key Invariant #3 becomes *enforced-by-detection* rather than a brittle tool box.
- Pair with a **logged** model-level fallback: capable tools (fewer failures) + fallback
  (catch the rest) + **fallback-logging** — tonight a *silent* fallback nearly hid that Mistral
  never worked; log *why* the primary fell back (exit code / stderr / missing-verdict / empty).

**Bonus — un-boxing un-confounds the metrics.** You can't grade Mistral-as-reviewer while it's
starved of review tools; a failure *with full tools* is a real model signal. **Fix tools
first, then the calibration batch is honest.**

**Guard against regression.** The `--enabled-tools` comma bug was a *silent* re-boxing — it
filtered every tool out and nobody noticed until the reviewer hallucinated. So a CI/preflight
check must assert each model still holds its full capable toolset before a run, and **fail
loudly** (not warn) if a model comes back re-boxed. `agy` confirms the diff-catch boundary is
the right model here too: it has **no `--enabled-tools` equivalent**, so full-tools + a
post-round `git diff` integrity check is the only clean reviewer boundary anyway (see [07]).

## Flexible allocation + learning (explore / exploit)

Allocation and measurement are coupled: to *grade* a model in a role you must *run* it there.
So **allocate flexibly across most roles** (within the hard non-Claude-reviewer constraint) —
that's **explore**; routing-to-best is **exploit**.

- Grades come from the [03] fingerprint ledger (signal/noise, miss rate) + [05] spend
  telemetry, sliced by domain → "best model per (role × domain)" learned from data.
- **Never explore on Red/compliance hunts.** Explore = deliberately running a maybe-worse
  model to grade it — on a hunt in a declared compliance area that means shipping a
  potential miss *to gather data*, exactly the "build unchecked" the rest of the design
  forbids. **Exploit known-best on Red/compliance; explore only on Green/Blue/Yellow** where
  a miss is cheap and caught. Same fail-closed rule as everywhere else, applied to routing.
- **Start COARSE, slice finer only as volume earns it.** `6 roles × 7 dimensions × N models`
  fragments the data so finely that each cell sees a handful of hunts for a long time —
  "best model per (role × domain)" will be *noise before it's signal*. Begin with per-role +
  a single binary domain axis (frontend-heavy vs backend-heavy); refine the slices only once
  a cell has enough runs to mean something. (Same false-precision trap as the old severity
  ceiling — a precise controller on thin input. Guard against routing on 2–3 data points.)
- **Calibration parallelism comes from hunts, not sub-agents.** Grading data accrues across
  **hunts** (the campaign-runner runs hunts 2-at-a-time) and across the capped, workflow-
  orchestrated review fan-out ([03] § Capped parallel review fan-out) — *not* by restoring
  cross-model CLI sub-agent self-orchestration, which stays disabled. So you get parallel
  model exercise for calibration without the run-#5 fragility.
- Pedigree becomes a **living scoreboard** — lagging signals (miss rate, [04] smoke escapes)
  update model profiles *retrospectively* as outcomes land, not a cert-time snapshot.
- The routing input is these ledger/spend metrics, **not** the saturated Watchdog `5/5` ([03]).
  Treat instantaneous signal/noise as *provisional* until the lagging miss-signal confirms it
  ([03] note) — accept/reject is a biased instrument (a lazy acceptor mislabels a good
  reviewer as noisy).

## Sequencing (this layer depends on the others)

1. **Un-box the tools** (above) — capable profiles, sandbox-scoped, logged fallback. Until
   this, every Mistral "grade" is a tool-box artifact, not a model signal.
2. **Ledger provenance + spend telemetry** ([03] ledger, [05] C1b) — build the meter.
3. **Calibration batch** under the tier defaults with flexible allocation — gather data.
4. **Tune routing from the curve** — capability × economics, domain-sliced.

Until 1–2 land, the tier table is a hypothesis; after 3–4 it's a learned policy.

## Acceptance criteria for THIS feature

- [x] Each model runs a **capable, sandbox-scoped** toolset (read / grep / git-read / write /
      `search_replace`), not a 2-tool allowlist; reviewer writes optionally path-scoped to the
      plan dir + metadata. — `podman-vibe.sh` capable set + `wolfpack-toolcheck.mjs` guard.
- [x] Cross-model fallback **records why** the primary failed (and the metrics treat a
      tool-starved failure differently from a capability failure). — `FALLBACK_LOG_NOTE` →
      classified `fallback_log` (rate_limited / tool_starved / capability / error).
- [x] `pedigree.json` + index carry **per-model spend** and **ledger-derived** signal/noise +
      miss rate, **sliced by domain** — and the routing reads *these*, not the cert score. —
      `wolfpack-model-stats.mjs` → `model-stats.json` (honest NULLs until data accrues).
- [x] Model→role assignment is **data-driven** (explore/exploit), honoring the
      non-Claude-reviewer and Opus-planner constraints. — `wolfpack-routing.mjs`
      `recommendModels()` (asserts the hard constraints; fail-safe to tier defaults on thin data).
- [x] A UI/UX-heavy hunt routes review to Gemini (or a thorough Gemini verify); a backend hunt
      routes volume to Mistral with a thin Gemini verify — chosen from `predicted_dimensions`. —
      `deriveDomain` + `tierDefaults` (frontend→Gemini thorough; backend→Mistral + Gemini thin).
