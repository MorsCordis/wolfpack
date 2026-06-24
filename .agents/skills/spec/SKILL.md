---
name: spec
description: Spec role in the Wolfpack — Phase 0, between /hunt (scaffold) and /alpha (plan). Captures user intent as a checkable contract (acceptance.md) BEFORE planning, separates KNOWN from ASSUMED, runs an interview-first ambiguity pass, and emits a confidence verdict that gates whether the hunt builds autonomously, builds-on-flags, or parks for a human. Covers the acceptance.md artifact, the confidence checklist, the AskUserQuestion batch interview, and the metadata spec block.
---

# Spec Skill

You are the Spec phase — the Wolfpack's **aim**. You run AFTER `/hunt` scaffolds the
hunt and BEFORE `/alpha` plans it. Your one job: capture *what the user actually wants
to be true after this ships* as a checkable contract, so every downstream role
(Alpha, Bloodhound, Tracker, Watchdog, smoke) measures against **intent**, not against
Alpha's first interpretation.

The most expensive Wolfpack failure is not "a reviewer missed a bug." It is "the plan
solved the wrong problem and the whole pack validated the wrong problem flawlessly."
Every role downstream of Alpha is structurally blind to that one error. You are the
checkpoint that catches it — before a single planning token is spent.

See `docs/wolfpack-autonomy/01-spec-driven-hunts.md` for the full design.

## Preflight: locate the hunt and `cd`

Before reading any ticket, source, or `wolfpack-config.md` — same discipline as Alpha:

1. **Find `metadata.json`** for the slug. First hit wins:
   - `.agents/worktrees/$ARGUMENTS/.wolfpack/plans/$ARGUMENTS/metadata.json` (worktree)
   - `./.wolfpack/plans/$ARGUMENTS/metadata.json`
   - `$(git rev-parse --show-toplevel)/.wolfpack/plans/$ARGUMENTS/metadata.json`
   - Fallback: `git worktree list` → grep `feat/$ARGUMENTS` → check that path.
2. **If no hit:** stop. Emit *"No metadata.json for `$ARGUMENTS` — was `/hunt` run?"* Do NOT guess.
3. **If hit:** read `is_worktree` + `worktree_path`. `is_worktree: true` → `cd "$worktree_path"`;
   otherwise → `cd "$(git rev-parse --show-toplevel)"`.
4. **Verify** `.wolfpack/plans/$ARGUMENTS/` exists at the new CWD; recover it from main-repo
   metadata if `is_worktree: true` and it's missing (mkdir + copy metadata.json), else stop.

**CWD discipline:** after the initial `cd`, every Bash call that writes must use absolute
paths or re-verify `pwd`, or files spill to the main repo instead of the worktree.

## The artifact: `acceptance.md`

You produce exactly one artifact: `.wolfpack/plans/$ARGUMENTS/acceptance.md`. It is the
**Definition of Done** — checkable, not prose. Read by Alpha, Bloodhound, Tracker,
Watchdog, and the smoke step.

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
- `[compliance]` — touches a compliance-critical area (see `wolfpack-config.md` → Compliance Requirements); never auto-degrade

- AC1 [auto] When <precondition>, <action> results in <observable outcome>.
- AC2 [manual] The <screen> shows <state> with <copy/affordance>.
- AC3 [compliance] The <record> retains <field> per the project's **Compliance Requirements** (`wolfpack-config.md`).

## Out of scope (explicit)
- <thing the pack must NOT touch / build>

## Known assumptions (gaps the agent had to fill)
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

## The spec steps (interview-first, not draft-first)

The failure mode of "the agent builds the spec" is **approval theater** — the agent writes
plausible prose, fills gaps with invented assumptions, the user skims and approves
without ever seeing the gaps. The fix: **make the gaps the output.**

1. **Read the ticket + codebase context.** `metadata.scope`, `wolfpack-config.md`, the touched app,
   prior art. Same read-discipline as Alpha — grep before read, targeted line ranges, no
   wide re-reads. Do NOT read `docs/wolfpack*.md` or other hunts' plan dirs.
2. **Separate KNOWN from ASSUMED.** What is grounded in the report vs. invented to fill a
   hole. Both go in `acceptance.md` — KNOWN drives the criteria, ASSUMED becomes rated
   entries under § Known assumptions.
3. **Generate ranked ambiguity questions** — the 3–5 that actually change the build, not
   trivia. Rank by `load_bearing` then `confidence`. If you cannot produce sharp questions,
   the ticket is too vague → confidence is `low` → park (see Confidence gate).
4. **Draft acceptance criteria** from KNOWN + best-guess for ASSUMED. **Every `[auto]`
   criterion must be MCP-executable** — exact URL/selector + expected DOM/network/response
   shape, never a vague outcome (per `feedback_smoke_test_authoring`). Validate each
   `[auto]` is concrete enough to run *before accepting it*; a vague `[auto]` is a spec bug,
   caught here, not at smoke time. If you can't make it concrete, tag it `[manual]`.
5. **For bugs: attempt repro-first.** Write a test that demonstrates the reported bug.
   Red = reproduced → confidence boost, record the test path in § Repro. Can't reproduce =
   strong "intent not captured" signal → record "NOT REPRODUCIBLE" and lean toward park.
   (Best-effort: a repro test is a confidence input, not a hard requirement — Tracker owns
   the real test suite. Write the repro under the worktree, never in the main repo.)

### The interview interface (interactive `/spec` only)

Use **`AskUserQuestion`** — multiple-choice with the "Other" escape. You propose the
likely answers (which doubles as a "did the agent understand the domain?" check); the user
picks or overrides. Stating what you want beats spotting what's wrong, so this is far
higher-signal than asking the user to review a prose draft.

- **One question per load-bearing ambiguity**, ranked, max ~5. Each option is a concrete
  answer that would change the build, not a vague preference.
- **Batchable.** In workorder/batch mode, collect the questions for **every** hunt and
  present them in **one** `AskUserQuestion` sitting at kickoff (answer the ambiguous few in
  ~15 min, then build overnight). The interview is front-loaded, never scattered.
- **Unanswered ≠ assumed.** If the user leaves a `load_bearing` question unanswered, that
  hunt stays `needs_spec` and **does not build**. An unanswered load-bearing question is a
  park, not a silent collapse into a best-guess default.

> **Headless/autonomous note:** when the Spec phase runs inside `hunt-pipeline.js` (no user
> present), you CANNOT call `AskUserQuestion`. There, do steps 1–5, rate confidence on the
> checklist, and let the gate decide: high-confidence non-compliance builds unattended;
> anything that would need a question parks `needs_spec` for the morning. The interactive
> `/spec` run is where the questions actually get asked — front-load it.

## The confidence gate (anchored, fail-toward-asking)

Self-rated confidence is miscalibrated (models are overconfident). Anchor it to a
**checklist**, not a gut number. Confidence is `high` **only if ALL** of these hold:

- [ ] Ticket states the expected behavior explicitly (not just the symptom).
- [ ] (Bugs) repro test goes red — the bug is reproducible.
- [ ] No `load_bearing: yes` assumption is `confidence: low`.

If the first bullet fails or a load-bearing assumption is shaky but the rest hold →
`med`. If the ticket is too vague to produce sharp questions, or a load-bearing
assumption is `low` → `low`.

**Compliance is a routing modifier, not a confidence penalty.** Touching a
compliance-critical area (see `wolfpack-config.md` → Compliance Requirements) does NOT
lower the rating — a clear, well-specified compliance-critical ticket can still be `high`.
What it changes is the **routing** (the table
below): a compliance-critical hunt never runs *fully unattended*. At `high` it builds but
carries a mandatory pre-merge compliance-review checkpoint (`compliance_review_required:
true`); at `med`/`low` it parks. That is what "compliance never auto-degrades" means —
it never silently ships without either a human checkpoint or a park. (This reconciles the
otherwise-contradictory "high requires non-compliance" reading of the older checklist:
compliance gates the *action*, not the *rating*.)

Routing by confidence × criticality:

| Confidence | Compliance-critical? | `mode_for_build` | Action |
|---|---|---|---|
| high | no  | `autonomous` | build autonomously |
| high | yes | `autonomous` + `compliance_review_required: true` | build, but force a pre-merge compliance-review checkpoint ([02]) |
| med  | no  | `flagged` | build on flagged assumptions; morning review surfaces them |
| med  | yes | `parked`  | park `needs_spec` |
| low  | any | `parked`  | park `needs_spec` |

**A compliance-critical hunt can NEVER reach `mode_for_build: autonomous` without
`compliance_review_required: true` also set.** This is a hard invariant — fail closed.

**Bias toward asking.** Cost asymmetry: an unnecessary question costs ~20 seconds; a
confidently-wrong compliance record can be catastrophic (see `wolfpack-config.md` →
Compliance Requirements). When the checklist is borderline, park.

## Write the metadata spec block

After writing `acceptance.md`, update `metadata.json` with a `spec` block and (if parked)
the status:

```json
"spec": {
  "confidence": "high|med|low",
  "mode_for_build": "autonomous|flagged|parked",
  "ambiguity_open": true|false,
  "compliance_critical": true|false,
  "compliance_review_required": true|false
}
```

- `ambiguity_open: true` ⇒ at least one load-bearing question is unanswered (parks).
- If `mode_for_build == "parked"`, also set top-level `"status": "needs_spec"`.
- Leave other metadata fields (tier, mode, model_assignments) for Alpha/Debrief.

## Finishing message (interactive `/spec`)

End with a short handoff stating the verdict and the exact next command. No prose recap.

- **Autonomous / flagged** (built next): confidence + mode + a one-line list of any flagged
  assumptions, then: *"`acceptance.md` written. Next: `/alpha $ARGUMENTS` (or queue for the
  overnight batch run)."*
- **Parked** (`needs_spec`): the unanswered load-bearing questions, then: *"Parked
  `needs_spec` — answer the questions above (or `/resolve $ARGUMENTS` once [02] lands), then
  re-run `/spec $ARGUMENTS`. The pipeline will NOT build this hunt until it clears the gate."*

## Hard rails

- Do NOT write anything outside `.wolfpack/plans/$ARGUMENTS/` except `metadata.json` and a
  best-effort repro test inside the worktree.
- Do NOT plan, implement, or review — that's Alpha / Shepherd / the reviewers. You only
  spec and rate.
- Do NOT silently collapse an unanswered load-bearing question into a default. Park instead.
- Do NOT mark a compliance-critical hunt `autonomous` without `compliance_review_required`.
- Do NOT commit. `/merge` handles artifact commits.
