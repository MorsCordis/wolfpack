---
status: design-only
tags:
  - docs/wolfpack
  - docs/autonomy
---

# Wolfpack Autonomy — Design Set

> These design docs were written while the pack was hosted inside its first consuming project; project details appear only as labelled examples or as `wolfpack-config.md` references.

Design docs for making the Wolfpack pipeline run **unattended overnight and produce
code that's actually right** — without trading post-smoke firefighting for a different
kind of babysitting. Written 2026-05-30 as a planning artifact. **Nothing here is
implemented yet.** Implement after the current pipeline (main `be190bc` lineage) is
validated in real runs.

These specs build on what already exists — the resume probe, the wave barrier, the
worktree model, the flock-capped cross-model shims — and add the missing layers.

## The core problem

The hours lost post-smoke are almost never "a reviewer found three criticals instead
of one." They're **"the plan solved the wrong problem, and the whole pack validated
the wrong problem flawlessly."** Every role downstream of Alpha measures against the
*plan*, not against *intent*. If Alpha misread the ticket, Bloodhound/Pointer/Tracker/
Watchdog all do rigorous cross-model work confirming the wrong thing. The adversarial
machinery is structurally blind to the one error that costs the most.

So the strategy is two-pronged:

1. **Aim the pack** — capture intent as a checkable contract (`acceptance.md`) *before*
   planning, so every role checks against intent, not just internal consistency.
2. **Trust the pack** — make the cross-model verdict a hard structured contract with a
   grounding check, and replace the count-based review ceiling with convergence
   detection, so reviews are good and enforced rather than bounded-and-bypassed.

Then make the human checkpoints **cheap, rare, and front-loaded**, and make halted work
**cleanly resumable**, so autonomous batch runs are real.

## The philosophy flip: park is free

In a live session, the review ceiling existed to stop stalling *you*. On cron, that
pressure is gone — **parking a hunt costs nothing**, because there's no session to
unblock. So the rule inverts:

> Never ship suspect code autonomously. Anything with an open, real, non-converging
> CRITICAL/HIGH — or an unanswered load-bearing ambiguity — **parks for a human**
> instead of proceeding.

Human time moves from the *end* (expensive forensics on working-looking-but-wrong code)
to the *front* (cheap: answer a pointed question before any tokens are spent) and to
*exceptions* (rare: a non-converging pack hands you a tight diff). You never spend it on
routine post-smoke cleanup.

## Where your time goes — four checkpoints, everything else autonomous

| Checkpoint | When | Your effort | Spec |
|---|---|---|---|
| **Spec interview** | front, per hunt — *only the ambiguous ones* | answer 3–5 questions | [01](01-spec-driven-hunts.md) |
| **Park resolution** | mid, *only* non-converging/contested hunts | `/resolve`, one answer | [02](02-park-resolve-resume.md) |
| **Compliance review** | pre-merge, *only* hunts touching a declared compliance area | read a tight diff | [02](02-park-resolve-resume.md) |
| **Consolidated smoke** | end, per wave | walk auto-failed/manual criteria only | [04](04-batch-merge-smoke.md) |

## How "spec up front" and "build overnight" coexist

They only conflict if you spec *every* hunt *inline* and block on each. Decouple via:

- **Batchable interview** — spec the whole workorder in one sitting at kickoff (answer
  only the ambiguous few), *then* build overnight with good specs.
- **Confidence gating** — a clear ticket auto-specs at high confidence and builds
  unattended; only genuinely vague tickets generate questions. Fire-and-forget mode
  builds everything high-confidence and parks the rest as `needs_spec` for the morning.

Morning is **triage across three buckets**, not debugging: (1) built + auto-smoked green
→ merge; (2) built on flagged assumptions → review the flags; (3) parked `needs_spec` →
answer, queue for tonight. Detail in [01](01-spec-driven-hunts.md).

## The document set

| # | Doc | Covers |
|---|-----|--------|
| 01 | [Spec-driven hunts](01-spec-driven-hunts.md) | `acceptance.md` artifact, interview-first spec phase, confidence checklist, workorder integration |
| 02 | [Park / resolve / resume](02-park-resolve-resume.md) | hunt state model, park payload, `/parked` + `/resolve`, clarify-vs-redirect, compliance gate |
| 03 | [Convergence & verdict enforcement](03-convergence-and-verdict.md) | structured verdict contract, grounding check, fingerprint-based convergence detection (replaces the severity ceiling) |
| 04 | [Batch merge & consolidated smoke](04-batch-merge-smoke.md) | release queue, criteria-union smoke, MCP automation, per-hunt failure attribution |
| 05 | [Limits & timing](05-limits-and-timing.md) | token-budget breaker, host-side rate-limit gate, reset-aware rescheduling, CLI backoff, `timing.jsonl`, spend-by-model meter, pedigree integration |
| 06 | [Model tiers & routing](06-model-tiers-and-routing.md) | work-horse vs judgment tiers, capability×economics routing, capable-tools-not-boxes (sandbox as boundary), window economics, flexible allocation + data-driven learning |
| 07 | [Cross-model execution](07-cross-model-execution.md) | sandbox/`agy` execution reality — keyring→API-key for headless, `~/.gemini` mount scoping, grounding-path normalization, diff-catch tool boundary, `.gemini/skills` port-sync |

## Pre-work: reconcile the docs (do this first, it's cheap)

The current SKILL/docs describe a system the workflow no longer runs. Fix before
layering new behavior on top, or the drift compounds:

- **Rewrite (don't just delete) the "Sub-Agent Orchestration" section**
  (`wolfpack/SKILL.md:60-82`). The new rule: intra-phase fan-out is **workflow-orchestrated**
  — the `.js` spawns N capped single-pass cross-model reviews via `parallel()`, surfaces
  failures as nulls, and degrades n-1 *concurrency* (see [03] § Capped parallel review
  fan-out) — while **cross-model CLI self-orchestration stays disabled** (`podman-vibe.sh`
  keeps the `task` tool removed; the old `review_strategy: parallel_specialized|ultra`
  self-orchestration is dead). One level of fan-out, owned by the deterministic orchestrator.
- **Update `wolfpack/SKILL.md` Tracker = "Claude Opus (fixed)"** (`SKILL.md:18`) — [06]
  makes Tracker a metered-with-fallback role routable across the whole pool; the SKILL must
  match or it contradicts the routing layer.
- **Drop "Sonnet" from the Bloodhound pool** (`SKILL.md:15`, the pipeline user guide, now `docs/user-guide.md`).
  Alpha is fixed-Opus, so Bloodhound can never be any Claude; the workflow already
  hardcodes never-Claude.
- **Fix the Red round count** — `SKILL.md:48` says `bloodhound: 2`; the Pipeline-Shapes
  table two sections up and the workflow both say 3. Pick one source of truth.
- **Fix Tracker DB claim** — the pipeline user guide (now `docs/user-guide.md`) says "falls back to a remote
  database proxy"; the workflow hardcodes `--local` only.

None break a *workflow* run (the JS is authoritative) but all mislead manual `/hunt`
runs. Convergence/spec work will also want a single source of truth for tier config —
see [03](03-convergence-and-verdict.md) § Tier config consolidation.

## Field findings — first real end-to-end run (v1-push-3 `unfinalize`, run #5, 2026-05-30)

These docs were written earlier the same day as a planning artifact; that evening
`unfinalize-inventory-restore` became the **first hunt to run fully autonomous,
plan → cert, with no human input** — validating the tactical fixes that preceded this
set (cross-model reviewers actually reading files, reviewer-assignment honored + sticky,
shims invoked from the repo root so worktree drift can't re-break them, severity-gated
review that *proceeds* past a converged HIGH/LOW instead of halting). Trace: Bloodhound
3 rounds → APPROVED (sighted Gemini); Shepherd implemented; Pointer 2 rounds → APPROVED
(caught two real bugs); Tracker `19 pass / 1 baseline` on the headless local PG; Watchdog
**PASS**; a compliance-correct compensating reversal landed.

Three robustness gaps surfaced — refinements, not blockers. Fold each into the noted layer:

1. **Silent cross-model fallbacks → [03] + [05].** Watchdog certified on
   `gemini:flash-3.5` though metadata assigned `mistral:medium` — a silent
   primary→fallback with no recorded reason. The verdict contract + timing/observability
   work should capture *why* a primary fell back (exit code / stderr excerpt /
   missing-verdict / empty output) into the structured verdict and a `fallback_log` /
   `timing.jsonl`, and **surface it in the hunt summary / notification** (a buried log isn't
   disclosure, per the project's fail-loud rule). A silent fallback also means the masked path goes
   **unverified** (here: Mistral-as-certifier with the `--enabled-tools` fix never ran).
2. **Phase-end state not written on every path → [02].** The Watchdog PASS did not stamp
   `status=certified` / `phase=done`; metadata stayed at `tested` because the
   Gemini-fallback cert path skipped the metadata write. Resume currently survives via
   artifact-derivation (`certification.md` present → Verify), but the state model should
   make the phase-completion write **unconditional and deterministic** (independent of
   which model ran), with a per-phase done-marker the resume probe trusts — so a crash
   mid-phase never repeats completed work.
3. **Pedigree committed to `main` mid-run → [02] / cross-cutting.** The Watchdog
   "commit wolfpack artifacts" step did a direct `git commit` to `main` during the run
   (`6e17fbc`) rather than the hunt branch. Benign content (pedigree/lessons bookkeeping)
   but it violates never-commit-to-main. Cert artifacts must commit to the **hunt branch**
   (or defer to `/merge`) — never `main` mid-run.

(Most pre-`be190bc`-lineage behavior was patched tactically to push functionality
through; this set is where it gets refined into a well-oiled machine.)

## Suggested implementation order

Each layer is independently shippable and independently valuable. Recommended sequence,
highest-leverage first:

> **Phase 0 vs the layers:** a few prereqs are pulled out and done *first* as direct edits
> (Build process below) because they're circular to build through the pipeline — **doc
> reconciliation** (item 1), the grounding-**path** normalization slice of [03] (the
> container-vs-host fix, *not* the full verdict contract), and the `podman-agy.sh` shim
> fixes. The numbered items below are then the live-edit **layer** order.

1. **Doc reconciliation** (above) — half a day, removes confusion for everything after.
2. **[03] Structured verdict + grounding check** — hardens the signal everything else
   trusts. Do this before convergence detection (convergence needs reliable findings).
3. **[01] `acceptance.md` + spec interview** — the single biggest hit on "it should just
   work." Aims the pack.
4. **[02] Park/resolve/resume** — turns "halt" into "halt and cleanly continue,"
   prerequisite for true unattended runs.
5. **[03] Convergence detection** — replaces the severity ceiling once findings are
   structured and reliable.
6. **[05] Timing tracking** — cheap, and its data feeds the limit gate.
7. **[05] Limit awareness** — uses timing history to schedule batches against the window.
8. **[04] Batch merge + consolidated smoke** — depends on `acceptance.md` (criteria) and
   park/resume being in place. Includes the smoke→review→Shepherd feedback loop that
   captures the lagging miss signal.
9. **[06] Model tiers & routing** — comes last because it *consumes* everything above: it
   needs un-boxed tools (so failures are real), the [03] fingerprint ledger + [05]
   spend telemetry (the meter), and a calibration batch to tune from. Step 0 within it —
   **un-box the model tools** — is cheap and unblocks honest measurement, so pull that
   one forward; the routing-learning sits on top of the metrics.

## Build process — how this set actually gets built

This set **builds the pipeline**, so it can't be built *through* the pipeline — running the
formal hunt flow on the machinery it's rewriting is circular and unstable (a bug in an early
layer breaks the very review/test meant to catch a later one). So the build runs as **live
edits on a build branch**, with adversarial review reconstructed manually — the standalone
shims (`podman-vibe.sh`, `podman-agy.sh --review`) work even while the workflow orchestrator
is half-rebuilt, because they only need a worktree + a prompt.

**Phase 0 — direct edits, no hunt** (prereqs; circular to hunt them):
- the two `podman-agy.sh` fixes (keyring→API-key, `~/.gemini` mount scoping) — [07]
- grounding-path normalization — [03] / [07]
- doc reconciliation (SKILL Sub-Agent rewrite, Tracker-not-fixed-Opus, Sonnet pool, Red
  rounds, Tracker DB claim) — pre-work above
- `podman-vibe.sh` tmpfs writability fix (`mode=1777`) — surfaced during the Phase 0 build
  itself: on podman 5.8+ a partially-optioned `--tmpfs` mounts root-owned `0755`, so the
  keep-id reviewer user can't write and vibe crashes at import; same reviewer-plumbing class
  as the agy fixes, so folded into Phase 0

Phase 0 edits still get the **same Mistral + Gemini shim review** as the layers — they're
real code (bash/instructions), so they're not exempt. The one wrinkle: the `podman-agy.sh`
fixes are *reviewing the reviewer's own plumbing*, which is fine in a human-present build
session (the shims still run for review; the fixes only change *unattended* behavior).

**Then the layers, as live edits — one design layer at a time**, in the dependency order
above. Per layer: (1) edit code + tests; (2) the project's test command (`wolfpack-config.md` → Project Identity); (3) call the shims for
a **Mistral + Gemini** read-only review of the diff against that layer's spec (cross-model
holds — Claude wrote it, reviewers are non-Claude; the diff includes the tests, so
test-authoring gets adversarial eyes too); (4) address findings, re-review until clean
(manual convergence — the human + Claude *are* the orchestrator the workflow will become);
(5) human checkpoint on the diff + both reviews → commit → next layer.

Doing the build by hand-performing the system's own loop **is** the spec's calibration run:
if a layer's manual review is painful or surfaces a gap, that directly tunes the automated
design. The keyring fix isn't a blocker *for the build* — your desktop session is live, so
`agy` works; the API-key fix only matters for the *unattended* runs this is building toward.

## Cross-cutting constraints (apply to every doc)

- **Workflow scripts cannot call `Date.now()` / `new Date()` / `Math.random()`** — they
  throw (would break resume). All timestamps and randomness come from *agents* (real
  bash) or the host driver, stamped into files and read back. See [05].
- **`budget` (the Workflow global) is a self-imposed token target, NOT the account
  rate-limit.** Do not confuse them. See [05].
- **Fail loud / fail closed** (the fail-loud rule, `wolfpack-config.md` → Hard Rules): ambiguous tier → treat as
  Red; uncertain limit → pause early; missing verdict block → ERROR, never prose-rescue.
- **Compliance-critical hunts** (the areas in `wolfpack-config.md` → Compliance Requirements) never auto-degrade
  and never auto-merge without the compliance-review checkpoint.
- **PreToolUse hook still blocks prod deploys (the project's forbidden commands, `wolfpack-config.md` → Hard Rules).** None
  of this changes that; deploys stay user-only.
