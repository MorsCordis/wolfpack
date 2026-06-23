---
name: wolfpack
description: The Wolfpack agentic handoff pipeline — roles, directory layout, metadata, and slash-command sequence. Triggers on "wolfpack", "run the pipeline", "plan a feature with the pipeline".
---

# Wolfpack Skill

Wolfpack is a multi-agent pipeline for planning, reviewing, implementing, and certifying features. Each role runs in a fresh session with a clean context — information flows between roles only through files.

## The Pack

| Role | Name | Default Model | When it runs |
|------|------|---------------|--------------|
| Planner | **Alpha** | Claude Opus (fixed) | Phase 1: writes the plan + predicted task dimensions |
| Adversarial plan reviewer | **Bloodhound** | Cross-model from Alpha (pool: Gemini, Mistral) | Phase 2: reviews the plan, explores the codebase, writes review-N.md |
| Implementer | **Shepherd** | Pedigree-selected from pool (Opus, Sonnet, Gemini, Mistral) | Phase 3: implements the plan (code only — no tests) |
| Adversarial code reviewer | **Pointer** | Cross-family from Shepherd; **non-Claude** (pool: Gemini, Mistral) | Phase 4: reviews the code, triggers Shepherd rewrites |
| Test writer | **Tracker** | Metered-with-fallback, routable across pool (Opus, Sonnet, Gemini, Mistral) — NOT a reviewer, so may be Claude | Phase 5: writes + runs tests, triggers Shepherd rewrites |
| Certifier | **Watchdog** | Cross-family from Shepherd; **non-Claude** (pool: Gemini, Mistral) | Phase 6: verifies code + tests, scores pedigree |

**Adversarial Cross-Model Rule:** Review/verification roles MUST use a different model family from the role they review. Bloodhound ≠ Alpha. Pointer ≠ Shepherd. Watchdog ≠ Shepherd. This ensures independent perspective at every critical checkpoint. **All three review roles (Bloodhound, Pointer, Watchdog) are always non-Claude** (Gemini or Mistral) — never Opus or Sonnet ([06]; Sonnet is retired from the reviewer pool). A Claude reviewing Claude is not adversarial cross-model review. (Tracker is exempt — it writes tests, it doesn't review, so it may be Claude.)

**Multi-Model Pool:** Four model families are available: Opus, Sonnet, Gemini, Mistral. Alpha selects models for each role during the Debrief based on pedigree scores from past hunts. Only Alpha is fixed (= Opus). The rest are pedigree-driven with cross-model constraints — including Tracker, which is **metered-with-fallback** (routable across the whole pool, gated on pedigree metrics plus a capability fallback; see `docs/wolfpack-autonomy/06-model-tiers-and-routing.md`), no longer pinned to Opus.

**Gemini sync:** Gemini maintains its own skill ports in `.gemini/skills/`. Before invoking a hunt skill, Gemini checks git HEAD against `.gemini/SYNC_BASELINE` and ports any changes from `.agents/skills/`. Mistral reads `.agents/skills/` directly.

The Debrief (written by Alpha after Phase 2) is a summary of accepted/rejected review points plus the 6-role model assignment. Users read plan-final.md + debrief.md before authorizing Phase 3.

## Pipeline Shapes by Tier

Pipeline ceremony scales with hunt complexity. Tier is set by Alpha during dimension scoring. Five tiers (Patch is folded into Green).

| Tier | Bloodhound | Pointer | Tracker | Watchdog | When to use |
|------|-----------|---------|---------|----------|-------------|
| **Green** | skip | skip | skip | trust-Shepherd (read shepherd-log only) | Typos, config, tiny fixes (avg ≤ 1.5, max ≤ 2) |
| **Blue** | 1 round | 1 round (one-shot, no loop) | write + run (one-shot, no loop) | checklist (abbreviated) | Small features, polish (avg ≤ 2.0, max ≤ 3, compliance ≤ 2) |
| **Yellow** | 1-2 rounds | 1-2 rounds (can loop) | write + run, can trigger rewrite | full cert | Standard features (avg ≤ 2.5, max ≤ 3) |
| **Orange** | 2 rounds | 2 rounds (can loop) | write + run, can trigger rewrite | full cert | Multi-app features, API changes (avg ≤ 3.5, max ≤ 4, compliance ≤ 3) |
| **Red** | 3 rounds | 2 rounds + security/compliance lens | full coverage, can trigger rewrite | full cert + manual smoke | Compliance-critical / business-critical / architectural — see `wolfpack-config.md` (else) |

### Rounds per tier (FLOOR, not cap — [03] Part B)

Under the automated pipeline these are a **floor**, not a ceiling. The single source of
truth is `TIER_CONFIG` at the top of `.agents/workflows/hunt-pipeline.js` — this table is
documented-as-matching it; change `TIER_CONFIG` and update here together.

```
            base   plan-smell   crit-persist   max-rounds   (base = bloodhound floor)
Green:        1        12             3             4
Blue:         1        12             3             4
Yellow:       2        12             3             6
Orange:       2        12             3             6
Red:          3        12             3             8
```
Pointer floor = base (≥1); Tracker = 1. The manual `/hunt` Green fast lane still skips review.

**Convergence detection replaces the old severity ceiling.** Each review loop (Bloodhound,
Pointer) runs at least `base` rounds, then **continues while it makes progress** (this
round's finding fingerprints are all NEW and the count isn't growing) — no fixed cap — and
**parks the moment progress stops**, classified by finding *fingerprints* not round count:

| Signal | Action |
|---|---|
| all-new fingerprints, count not growing | **continue** (converging — no fixed cap) |
| a fixed fingerprint reappears | **park `non_convergence`** (oscillation) |
| count not strictly decreasing over 2 rounds (past floor) | **park `non_convergence`** (stall) |
| a CRITICAL fingerprint persists `crit-persist` rounds | **park `open_critical`** |
| cumulative DISTINCT criticals ≥ `plan-smell` | **kick to Alpha** (`FLAWED_PLAN`) |
| `max-rounds` reached, or both reviewers fail at cap 1 | **park** (`non_convergence` / `review_error`) |
| reviewer APPROVED | **proceed** |

No path proceeds past an open real CRITICAL/HIGH — it parks. The old
`CRIT_CEILING`/`HIGH_CEILING`/`roundCap++` math and the Bloodhound "proceed-anyway-at-cap"
branch are gone. Finding fingerprints + per-round ledger land in `metadata.review_fingerprints`
+ `metadata.convergence` (the [06] model-grading substrate). See
`docs/wolfpack-autonomy/03-convergence-and-verdict.md` § Part B.

### Rewrite cycles

Pointer and Tracker can each trigger Shepherd rewrites:
- **Pointer → Shepherd:** Pointer writes `pointer-review-N.md` with findings → Shepherd reads it and fixes code → Pointer re-reviews. Under the automated pipeline the loop is **convergence-gated** ([03] Part B), not a fixed 2-round cap: it continues while the diff converges and **parks** (`non_convergence` / `open_critical`) when it stalls or a critical sticks. A manual `/hunt` still escalates to the user at the tier's round count.
- **Tracker → Shepherd:** Tracker writes `tracker-report-N.md` with failing tests and root cause → Shepherd fixes → Tracker re-runs. Max 2 rounds before user escalation.
- **Blue tier exception:** Pointer and Tracker run one-shot — report findings but do NOT loop back to Shepherd.

Green is the fastest lane: no review phases, trust-Shepherd Watchdog. Blue adds lightweight review and testing. Yellow is the standard pipeline. Orange and Red add full ceremony where risk justifies it.

## Intra-Phase Fan-Out

Within a phase, parallel work (multiple review lenses, multiple test files) is **owned by the
deterministic workflow orchestrator** (`.agents/workflows/hunt-pipeline.js`) — not by an agent
spawning its own sub-agents. The `.js` fans out N **capped, single-pass, cross-model** review
agents via `parallel()`, surfaces a failed shim as a `null` (so one dead reviewer doesn't abort
the wave), and degrades concurrency `n → n-1` on flock contention rather than dropping coverage.
This is **one level of fan-out**, held by the orchestrator — see
`docs/wolfpack-autonomy/03-convergence-and-verdict.md` § Capped parallel review fan-out.

**Cross-model CLI self-orchestration is disabled.** A headless reviewer — Vibe/Mistral via
`podman-vibe.sh`, Agy/Gemini via `podman-agy.sh` — runs **one comprehensive single-pass review**
and emits its verdict; it does **not** spawn sub-agents:

- `podman-vibe.sh` runs with a **capable, sandbox-scoped toolset** (`read grep edit write_file
  bash`; `VIBE_TOOLS_DEFAULT`), NOT a 2-tool cage — [06] un-boxed it so the reviewer can read
  the diff, grep the code, and run git-read without being blinded (every run-#5 Mistral failure
  was a tool-box failure, not a capability one). The **one** deliberate omission is `task`: that
  keeps cross-model self-orchestration off, so Vibe still physically cannot spawn sub-agents.
  The read-only worktree mount + sandbox are the real guardrail; reviewer-writes-to-source are
  read-only-by-ROLE (caught by diff-catch), not by a tool fence. `scripts/wolfpack-toolcheck.mjs`
  is the preflight that FAILS LOUD if the set ever silently re-boxes (the `read,grep` comma bug).
- Agy has no tool-allowlist flag; the prompt forbids sub-agent fan-out and the container mount
  set + diff-catch are the boundary.
- The old `review_strategy: parallel_specialized | ultra` **self-orchestration is dead** —
  cross-models proved too fragile as orchestrators (roster fan-out timed out / hit turn limits /
  never emitted a verdict on v1-push-3 Reds). Each reviewer skill enforces this with its
  "AUTONOMOUS / CROSS-MODEL RUNS — NO SUB-AGENTS" guard.

**Interactive, Claude-orchestrated manual runs** may still spawn read-only `Explore` sub-agents
for research breadth within a phase, per each role skill's roster guidance. That is the exception
for a human-driven `/hunt` — the automated pipeline's fan-out lives in the workflow `.js`, not in
agent self-orchestration.

### Metrics tracking

Each phase records its orchestration in metadata.json's `orchestration` block via **deep-merge** — read the existing block first, then merge phase-specific keys. Alpha creates the block; subsequent phases append to it. See each phase's skill for the specific keys.

## Parallel Hunt Infrastructure

Multiple hunts can run concurrently in separate worktrees. Infrastructure for safe concurrent merges:

- **Auto-rebase on merge:** When main has moved since the feature branch was created, `/merge` auto-rebases the feature branch onto main before the `--no-ff` merge. If the rebase fails (conflict), it aborts cleanly and provides manual resolution instructions.
- **Shared file append safety:** `.gitattributes` configures the `union` merge driver on three append-only files: `pedigree/index.md`, `known-broken-tests.md`, `cross-cutting-debt.md`. The `union` driver auto-resolves by keeping all lines from both sides — correct for append-only markdown lists where ordering doesn't matter.
- **Version tag collision prevention:** `/hunt` scans in-progress hunts' `proposed_version.tag` across BOTH `.wolfpack/plans/*/` AND `.agents/worktrees/*/.wolfpack/plans/*/`, and computes the next version from the highest of {latest git tag, all claimed in-progress tags}. `/merge` runs a pre-merge gate that blocks if the proposed tag already exists (`exit 1`).

## Running the Pipeline

Slash commands drive the pipeline. Fresh session (`/clear`) between phases.

```
/hunt <slug> "<desc>"       → /spec <slug>             (capture intent → acceptance.md)
/spec <slug>                → /alpha <slug>            (confidence gate: builds, or parks needs_spec)
/alpha <slug>               → /bloodhound <slug>       (cross-model from Alpha)
/bloodhound <slug>          → /alpha <slug> OR /debrief <slug>
/debrief <slug>             → /shepherd <slug>         (pedigree-selected)
/shepherd <slug>            → /pointer <slug>          (cross-model from Shepherd)
/pointer <slug>             → /tracker <slug>          (routable — metered w/ fallback)
                              OR /shepherd <slug> --pointer-rewrite=N (if issues found)
/tracker <slug>             → /watchdog <slug>         (cross-model from Shepherd)
                              OR /shepherd <slug> --tracker-rewrite=N (if tests expose bugs)
/watchdog <slug>            → /merge <slug>             (single hunt)  OR  /merge-wave <campaign> <wave> (batch)
/merge <slug>               → <deploy> → /smoke <slug>
/merge-wave <campaign> <N>  → <deploy> → /smoke-wave <campaign> <N>
```

(`<deploy>` = the project's **Deploy command** — `wolfpack-config.md` → Project Identity.)

**Single-hunt vs batch release ([04]).** A manually-run single hunt is a *wave-of-one*: use
`/merge <slug>` → the project's **Deploy command** → `/smoke <slug>` (tags as today). When a whole campaign **wave**
certifies, the wave — not the hunt — owns the version tag: `/merge-wave <campaign> <wave>`
merges every certified hunt sequentially (`--no-ff`, no per-hunt tag), aggregates one wave
version + tag, then **one** deploy, then `/smoke-wave` runs a single consolidated smoke =
the union of every released hunt's `acceptance.md` criteria (auto-run via Chrome DevTools MCP,
`[manual]` surfaced as a blocking checklist). A hunt parked `compliance_review` is excluded from
the release queue until `/resolve` signs it off. The campaign-runner wave barrier prints the
release queue + the exact `/merge-wave` / `/smoke-wave` handoff.

See each command's MANDATORY VERBATIM finishing message for exact handoff syntax. Each skill's preflight reads `metadata.worktree_path` and self-navigates — no copy-paste `cd` needed.

**Human checkpoints when a hunt can't safely proceed (`/parked`, `/resolve`).** In
autonomous/campaign runs a hunt that hits an unresolved CRITICAL, a non-converging review,
or a compliance-touching diff does NOT ship suspect code — it **parks** (`status:
parked:<reason>`) and writes a `parked.md` payload. `/parked` lists every parked +
`needs_spec` hunt across all campaigns (your inbox); `/resolve <slug>` shows the payload,
collects your answer, writes the authoritative append-only `human-notes.md`, and flips the
status to the resume rung. **You resolve; the next runner pass resumes** — you never
re-drive the pipeline by hand. The runner skips `parked:*`/`needs_spec` hunts as
non-actionable. Park reasons, the clarify-vs-redirect distinction, the compliance-review
sign-off, and the redirect-loop guard live in `.agents/skills/parked/SKILL.md` and
`docs/wolfpack-autonomy/02-park-resolve-resume.md`.

**Documentation phase (Shepherd):** After implementation, Shepherd assesses whether user-facing docs are needed and drafts/updates them before committing. Watchdog verifies doc coverage during certification. See `.agents/skills/shepherd/SKILL.md` § Documentation Phase and `.agents/skills/watchdog/SKILL.md` § Documentation coverage.

Per-hunt override: `/hunt --shepherd=opus <slug>` forces Opus Shepherd on a known-risky hunt.

The legacy `scripts/howl.sh` orchestrator was retired 2026-04-21. Slash commands only.

## Directory Layout

```
.wolfpack/plans/<feature-slug>/
  metadata.json          # Phase, status, model routing, predicted_dimensions
  plan.md                # Alpha's initial plan (with inlined source snippets)
  review-1.md            # Bloodhound round 1
  plan-revised-1.md      # Alpha revision after round 1
  review-2.md            # (if needed, up to 2 rounds)
  plan-final.md          # Copy of the last accepted plan
  debrief.md             # Review summary + 6-role model assignment
  shepherd-log.md        # Written by Shepherd during Phase 3 (implementation only)
  pointer-review-1.md    # Pointer code review round 1
  pointer-review-2.md    # (if needed, up to 2 rounds)
  tracker-log.md         # Tracker's test log (tests written, results, coverage)
  tracker-report-1.md    # Tracker rewrite request round 1 (if tests expose bugs)
  certification.md       # Watchdog verdict (covers code + tests as separate artifacts)
  pedigree.json          # Execution scorecard (6-role, process value-add metrics + timing block)
  timing.jsonl           # [05] append-only per-phase start/end markers (agent-stamped clock); aggregated into pedigree.json at Certify by wolfpack-timing.mjs
  <phase>-raw.log        # Raw API output (for debugging)

.wolfpack/pedigree/
  index.md               # Rolling table, one line per completed run (tracked in git)
```

## metadata.json Schema

```json
{
  "feature": "slug",
  "description": "Short description",
  "created": "ISO8601 timestamp — t0, stamped at Scaffold",
  "completed_at": "ISO8601 timestamp — t_end, stamped by Watchdog on PASS ([05] timing)",
  "status": "needs_spec|ready_for_alpha|planning|reviewing|revising|ready|implementing|code_reviewing|code_rewrite_needed|testing|test_rewrite_needed|certifying|certified|done|rework_needed|flawed_plan_restarting|timeout|parked:<reason>",
  "phase": "plan|review-N|revise-N|ready|implement|code-review-N|code-rewrite-N|test|test-rewrite-N|certify|done",
  "review_round": 0,
  "pointer_round": 0,
  "tracker_round": 0,
  "branch": "feat/slug",
  "is_worktree": false,
  "worktree_path": null,
  "scope": {
    "target_surface": "string — module/feature area hunt touches",
    "out_of_scope": "string — explicit exclusions (or empty)",
    "mode_guess": "update|feature — /hunt user-provided; Alpha re-evaluates",
    "known_traps": "string — prior attempts, contentions, non-obvious constraints (or empty)"
  },
  "predicted_dimensions": {
    "file_spread": 0,
    "logic_complexity": 0,
    "domain_sensitivity": 0,
    "multi_tenancy_risk": 0,
    "test_authoring": 0,
    "api_surface": 0,
    "frontend_complexity": 0
  },
  "tier": "Green|Blue|Yellow|Orange|Red",
  "review_strategy": "sequential|mini_orchestrator|parallel_specialized|ultra",
  "bloodhound_rounds": 0,
  "pointer_rounds": 0,
  "tracker_rounds": 0,
  "smoke_tests_required": null,
  "mode": "update|feature",
  "models": {
    "planner": "claude:opus:high",
    "reviewer": "mistral:medium",
    "architect": "claude:sonnet:medium",
    "architect_recommended": null,
    "code_reviewer": null,
    "test_writer": "claude:opus:high",
    "certifier": "claude:opus:high"
  },
  "proposed_version": {
    "bump": null,
    "tag": null
  },
  "model_assignments": {
    "alpha": null,
    "bloodhound": null,
    "shepherd": null,
    "pointer": null,
    "tracker": null,
    "watchdog": null
  },
  "orchestration": {
    "alpha_scouts": 0,
    "alpha_scout_models": [],
    "bloodhound_specialists": 0,
    "bloodhound_specialist_models": [],
    "bloodhound_redundancy_rate": 0.0,
    "pointer_rounds_used": 0,
    "tracker_rounds_used": 0,
    "watchdog_lenses": 0,
    "watchdog_lens_models": []
  },
  "review_fingerprints": {},
  "convergence": {
    "classification": "converging|continue|non_convergence|open_critical|flawed_plan",
    "cumulative_distinct_criticals": 0,
    "rounds": 0
  },
  "park": {
    "reason": "open_critical|compliance_review|non_convergence|review_error|repro_failed|model_quota|smoke_pending_human|rebase_conflict",
    "parked_at": "ISO8601 — stamped by the park agent, not the workflow JS",
    "resume_phase": "Spec|Plan|Review|Debrief|Implement|Code Review|Test|Certify|Verify",
    "resolution_type": "clarify|redirect — set by /resolve",
    "tier": "carried so resume never guesses a downgraded tier",
    "human_notes_seen": false,
    "redirect_count": 0,
    "compliance_signed_off": false
  }
}
```

**Field notes:**
- `park` ([02]) is written only when a hunt halts for a human (`status: parked:<reason>`).
  It pairs with a `parked.md` payload + an append-only `human-notes.md` (written by
  `/resolve`). `compliance_signed_off: true` is what stops the post-resume compliance gate
  from re-parking. Absent on hunts that never parked. See `.agents/skills/parked/SKILL.md`.
- `worktree_path` is the absolute path when `is_worktree` is true; `null` otherwise. Every phase skill's preflight reads this to self-navigate.
- `scope` is populated by `/hunt` via interactive prompts at scaffold time. Alpha reads `scope` BEFORE codebase exploration to frame the plan.
- `pointer_round` and `tracker_round` track the current rewrite cycle count. Compared against `pointer_rounds` and `tracker_rounds` (caps set by tier) to enforce the 2-round escalation limit.
- `models.code_reviewer` is set by Alpha during Debrief (cross-model from Shepherd). `models.test_writer` defaults to a metered model with a capability fallback — routable across the pool, no longer pinned to `claude:opus:high`.
- `model_assignments` tracks which model actually ran each phase (6 roles). `models` tracks the configured/recommended models.
- `review_fingerprints` ([03] Part B + [06] AC3) is an **object keyed by role** — `{ "bloodhound": [perRound...], "pointer": [perRound...] }` — so Bloodhound and Pointer rounds (each counting from 1) never collide at the same index. Each per-round entry is `{ role, round, raised, grounded, dropped, findings: [{ fp, severity, id, title }] }` (`fp` = `normalize(file):defect-class`, the coarse semantic key the review shim computes; `raised`/`grounded`/`dropped` are the grounding split — `signal = grounded/raised`, `noise = dropped/raised`). It is the convergence input AND the model-grading substrate [06] queries (per-model signal/noise, sliced by domain). `convergence` records the loop's final `{ classification, cumulative_distinct_criticals, rounds }`. The orchestrator writes both **once per round** via the next agent (revision / park / flawed-plan stamp), never the review shims (concurrent fan-out writes would race).
- **Backward compatibility:** Older metadata files from completed hunts lack `pointer_round`, `tracker_round`, `review_fingerprints`, `convergence`, `models.code_reviewer`, `models.test_writer`, `model_assignments.pointer`, `model_assignments.tracker`. All new skills handle missing fields by defaulting to `null` / `0` / `[]` / skip.

The `status` and `phase` fields are how `--resume` knows where to pick up. Roles MUST update these before exiting.

## Pedigree System

- `.wolfpack/pedigree/index.md` — one line per completed feature. Alpha reads this for Shepherd recommendations.
- `.wolfpack/plans/<feature>/pedigree.json` — individual scorecard per run. Not loaded by default.
- Alpha owns `predicted_dimensions`; Watchdog only scores `execution_scores`. No re-scoring allowed.
- Execution scores are anchored to objective criteria (test pass/fail, Watchdog interventions, rework rounds). See `watchdog` skill.

## Key Invariants

1. **Fresh sessions.** Each role starts with no conversational context from prior roles.
2. **Files are the channel.** Roles communicate only by reading/writing files in the plan directory.
3. **Bloodhound and Pointer are read-only (instruction-enforced).** Both review roles CAN write files at the tool layer — but the role prohibits it. They read/grep only; writes beyond their review output files are a discipline violation caught by the user and the Watchdog.
4. **Watchdog owns final state transitions.** On exit, Watchdog must update `metadata.json` to `certified`, `rework_needed`, `flawed_plan_restarting`, or `timeout`.
5. **All CLI output redirected during animations.** Raw logs at `$PLAN_DIR/<phase>-raw.log` for debugging.

## Handoff Contract

Each slash command (`.agents/commands/<phase>.md`) enforces a MANDATORY VERBATIM finishing message. The corresponding role skill (this directory) specifies WHICH variant to emit (PASS vs REWORK, APPROVED vs ISSUES_FOUND, etc.) and what the output must contain.

What the user expects at every phase handoff:
- `/clear` between phases (fresh session per role).
- Explicit next-phase command.
- Explicit model switch when the next role uses a different model.
- **No copy-paste `cd` instruction** — each phase skill's preflight reads `metadata.worktree_path` and self-navigates.

Each phase skill ends with a MANDATORY OUTPUT block listing its exact handoff contract.

## Related Skills

- `alpha` — planner role: plan structure, dimension scoring, model pool selection
- `bloodhound` — adversarial plan reviewer
- `shepherd` — implementer (code only, no tests)
- `pointer` — adversarial code reviewer
- `tracker` — test writer and runner
- `watchdog` — certification checklist + Pedigree scoring rubric (including process value-add)
