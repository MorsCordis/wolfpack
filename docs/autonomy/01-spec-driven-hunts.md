---
status: design-only
tags:
  - docs/wolfpack
  - docs/autonomy
---

# 01 — Spec-Driven Hunts

**Goal:** capture *your intent* as a checkable contract before any planning, so every
downstream role measures against intent rather than against Alpha's first interpretation.
This is the single highest-leverage change for "it should just work."

Prereq for: [04 — consolidated smoke](04-batch-merge-smoke.md) (criteria drive smoke),
[02 — park](02-park-resolve-resume.md) (`needs_spec` status). Pairs with [03] (the pack
checks against criteria).

---

## The artifact: `acceptance.md`

Lives in the plan dir: `.wolfpack/plans/<slug>/acceptance.md`. Written by the spec phase
(below), read by Alpha, Bloodhound, Tracker, Watchdog, and the smoke step. It is the
**Definition of Done** — checkable, not prose.

```markdown
# Acceptance — <slug>

## Source
- Ticket: <ref or "ad-hoc">  |  Reporter: <who>  |  Date: <ISO8601>
- Verbatim report: "<the original words — do NOT paraphrase>"

## Intent (one sentence)
<What the user actually wants to be true after this ships.>

## Acceptance criteria (the contract)
Each criterion is a single, checkable, user-observable statement. Tag each:
- `[auto]`  — verifiable by an automated test or MCP browser step
- `[manual]`— needs human eyes (visual/judgment)
- `[compliance]` — touches a compliance area declared in `wolfpack-config.md` → Compliance Requirements; never auto-degrade

- AC1 [auto] When <precondition>, <action> results in <observable outcome>.
- AC2 [manual] The <screen> shows <state> with <copy/affordance>.
- AC3 [compliance] The <regulated record> retains <field> per <the retention rule in `wolfpack-config.md` → Compliance Requirements>.

## Out of scope (explicit)
- <thing the pack must NOT touch / build>

## Known assumptions (gaps Claude had to fill)
Each assumption is something NOT stated in the ticket that changes the build. Rated:
- `confidence: high|med|low` and `load_bearing: yes|no`
- ASSUMPTION A1 (high, no): <…>
- ASSUMPTION A2 (low, yes): <…>   ← a low+load_bearing assumption blocks autonomy

## Repro (bugs only)
- Steps to reproduce: <…>
- Expected: <…>  |  Actual: <…>
- Repro test: <path to the failing test that demonstrates it> | "NOT REPRODUCIBLE"
```

**Why verbatim report matters:** paraphrase is where intent leaks. Keep the original
words so Bloodhound/Watchdog can re-derive whether the criteria actually capture them.

---

## The spec phase: interview-first, not draft-first

The failure mode of "Claude builds the spec" is **approval theater** — Claude writes
plausible prose, fills gaps with invented assumptions, you skim and approve without ever
seeing the gaps. Fix: make the *gaps* the output.

New phase, **Phase 0 (Spec)**, between `/hunt` (scaffold) and `/alpha` (plan). Slash
command `/spec <slug>`, skill at `.agents/skills/spec/SKILL.md`. Steps the spec agent runs:

1. **Read the ticket + codebase context** (CLAUDE.md, the touched app, prior art). Same
   read-discipline as Alpha (grep before read).
2. **Separate KNOWN from ASSUMED.** What's grounded in the report vs. invented to fill
   holes. Write both to `acceptance.md`.
3. **Generate ranked ambiguity questions** — the 3–5 that actually change the build, not
   trivia. Rank by `load_bearing` and `confidence`. If it can't produce sharp
   questions, the ticket is too vague → see Confidence gate below.
4. **Draft acceptance criteria** from KNOWN + best-guess for ASSUMED. **`[auto]` criteria
   must be MCP-executable** — exact URL/selector + expected DOM/network/response, not a
   vague outcome (per the operator's smoke-test-authoring rule). `/spec` validates each `[auto]`
   criterion is concrete enough to run *before accepting it*; a vague `[auto]` is a spec
   bug, caught here, not at smoke time. (If smoke later finds an `[auto]` that can't
   actually be automated, that's a `/spec` mis-tag → re-tag `[manual]`, surface it, and log
   it as a spec-validation miss — see [04] § Disposition rule.)
5. **For bugs: attempt repro-first** — write a test that demonstrates the reported bug.
   Red = reproduced (confidence boost). Can't reproduce = strong "intent not captured"
   signal → park.

### The interview interface

Use `AskUserQuestion` (multiple-choice + "Other" escape). Claude proposes the likely
answers — which doubles as a "did Claude understand the domain?" check — and you pick or
override. Far lower friction than free-form, and far higher signal than reviewing a
draft (stating what you want > spotting what's wrong).

**Batchable:** in workorder mode, the questions for *every* hunt are collected and
presented in one sitting at kickoff. You answer the ambiguous few (15 min), then it
builds overnight. The interview is front-loaded, not scattered across the night.

**Unanswered ≠ assumed.** If you leave a load-bearing question unanswered, that hunt stays
`needs_spec` and **does not build** (fire-and-forget mode) — nothing proceeds on an
unanswered load-bearing question. Unanswered questions never silently collapse into a
best-guess assumption; they're a park, not a default.

---

## The confidence gate (anchored, fail-toward-asking)

Self-rated confidence is miscalibrated (models are overconfident). Anchor it to a
**checklist**, not a gut number. Confidence is `high` **only if ALL**:

- [ ] Ticket states the expected behavior explicitly (not just the symptom).
- [ ] (Bugs) repro test goes red — the bug is reproducible.
- [ ] No `load_bearing: yes` assumption is `confidence: low`.

> **Compliance gates the action, not the rating** (build-calibration clarification,
> [01] layer review). The original fourth bullet — "touched apps are NOT
> a declared compliance area" — read as a confidence penalty, which contradicts the
> `high | yes` row of the routing table (a compliance hunt could never be `high`, so that
> row was unreachable). Reconciled: compliance-criticality is a **routing modifier**, not
> a confidence penalty. A clear, well-specified ticket in a compliance area can still rate `high` on
> the three anchors above; what compliance changes is that the hunt never runs *fully
> unattended* — at `high` it builds with a mandatory pre-merge compliance-review checkpoint
> (`compliance_review_required: true`), at `med`/`low` it parks. "Never auto-degrades"
> means it never silently ships without either a human checkpoint or a park.

Routing by confidence × criticality:

| Confidence | Compliance-critical? | Action |
|---|---|---|
| high | no | **build autonomously** |
| high | yes | build, but force compliance-review checkpoint pre-merge ([02]) |
| med  | no | **build on flagged assumptions**; morning review surfaces them |
| med  | yes | **park `needs_spec`** |
| low  | any | **park `needs_spec`** |

**Bias toward asking.** Cost asymmetry: an unnecessary question costs ~20 seconds; a
confidently-wrong regulated record can cost the project its licence or certification (e.g. a regulated-records module). When the checklist is borderline, park.

---

## Morning triage (the unattended-run payoff)

You wake to three buckets, all triage rather than debugging:

1. **Built + auto-smoked green** ([04]) → merge.
2. **Built on flagged assumptions** → review the assumptions the hunt surfaced in
   `acceptance.md` § Known assumptions + the certification, accept or kick back.
3. **Parked `needs_spec`** → `/resolve` the questions, queue for tonight ([02]).

---

## Workorder integration

Extends the existing `/workorder` skill (pulls bug-report emails → daily workorder). New
pipeline:

```
/workorder            → pull tickets, write workorder.md  (existing)
  ↓ for each ticket:
/spec <slug>          → acceptance.md + confidence verdict  (NEW, Phase 0)
  ↓ batch the ambiguity questions across ALL tickets, present once (AskUserQuestion)
  ↓ user answers the ambiguous few
/hunt + cron run      → build high-confidence + answered hunts overnight
  ↓ park the rest as needs_spec
```

Two run modes (a dial, user picks per batch):

- **Evening batch-interview:** present, answer ambiguous few before bed, build overnight.
  Highest quality; ~15 min of your evening.
- **Fire-and-forget:** kick off and leave immediately; builds high-confidence hunts,
  parks ambiguous ones for the morning (they build the *next* night).

---

## Threading into existing code

- **New `/spec` command** (`.agents/commands/spec.md`) + skill (`.agents/skills/spec/`).
- **`hunt-pipeline.js`:** add a `Spec` phase to `meta.phases` and `PHASE_ORDER`
  (`hunt-pipeline.js:162`), positioned after `Scaffold`, before `Plan`. The resume probe
  (`:181-229`) gains an `acceptance.md present → Plan` rung; absence of `acceptance.md`
  on a non-fresh hunt means resume at `Spec`.
- **metadata.json:** add `spec` block — `{ confidence: high|med|low, mode_for_build:
  autonomous|flagged|parked, ambiguity_open: bool }`. New status value `needs_spec`.
- **Alpha prompt** (`:371-405`): prepend "Read `acceptance.md` FIRST; plan to satisfy the
  criteria; if the plan cannot satisfy a criterion, that's a flag, not a silent drop."
- **Confidence gate** runs at the end of `/spec`; in automated mode the runner reads
  `spec.mode_for_build` to decide build vs park (see [02]).

---

## Acceptance criteria for THIS feature (dogfood)

- AC1 [auto] A vague ticket ("make scheduling better") yields ≥3 ambiguity questions and
  `confidence: low`, and the hunt parks `needs_spec` without building.
- AC2 [auto] A clear bug ticket with a reproducible repro yields `confidence: high` and
  builds with zero human questions.
- AC3 [compliance] Any hunt touching a declared compliance area never reaches
  `mode_for_build: autonomous` without a compliance-review checkpoint flag set.
- AC4 [manual] The batch interview presents all hunts' questions in one
  `AskUserQuestion` sitting, not one prompt per hunt.
