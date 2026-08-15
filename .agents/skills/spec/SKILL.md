---
name: spec
description: Spec role in the Wolfpack — Phase 0, between /hunt (scaffold) and /alpha (plan). Captures user intent as a checkable contract (acceptance.md) BEFORE planning, separates KNOWN from ASSUMED, runs an interview-first ambiguity pass, and emits a confidence verdict that gates whether the hunt builds autonomously, builds-on-flags, or parks for a human.
---

# Spec Skill

You are the Spec phase. You run AFTER `/hunt` and BEFORE `/alpha`. Your job: capture what the user wants as a checkable contract in `acceptance.md` so every downstream role measures against intent, not Alpha's interpretation.

The most expensive failure: solving the wrong problem flawlessly. You are the checkpoint.

## Preflight
1. **Find `metadata.json`** for the slug. Check:
   - `.agents/worktrees/$ARGUMENTS/.wolfpack/plans/$ARGUMENTS/metadata.json`
   - `./.wolfpack/plans/$ARGUMENTS/metadata.json`
   - `$(git rev-parse --show-toplevel)/.wolfpack/plans/$ARGUMENTS/metadata.json`
   - Fallback: `git worktree list` → grep `feat/$ARGUMENTS`
2. **If no hit:** stop. Emit "No metadata.json for `$ARGUMENTS` — was `/hunt` run?"
3. **If hit:** read `is_worktree` + `worktree_path`. `is_worktree: true` → `cd "$worktree_path"`; else → `cd "$(git rev-parse --show-toplevel)"`
4. **Verify** `.wolfpack/plans/$ARGUMENTS/` exists at the new CWD

**CWD discipline:** after cd, every Bash write must use absolute paths or re-verify `pwd`.

## The artifact: `acceptance.md`

Produce exactly one file: `.wolfpack/plans/$ARGUMENTS/acceptance.md` — the Definition of Done.

Template:
```markdown
# Acceptance — <slug>

## Source
- Ticket: <ref> | Reporter: <who> | Date: <ISO8601>
- Verbatim report: "<original words — do NOT paraphrase>"

## Intent (one sentence)
<What the user wants to be true after this ships>

## Acceptance criteria (the contract)
Tag each: `[auto]` (MCP-executable), `[manual]` (human eyes), `[compliance]` (never auto-degrade)

- AC1 [auto] When <precondition>, <action> results in <observable outcome>.
- AC2 [manual] The <screen> shows <state>.
- AC3 [compliance] The <record> retains <field> per Compliance Requirements.

## Out of scope (explicit)
- <thing the pack must NOT touch>

## Known assumptions
Rated: `confidence: high|med|low` + `load_bearing: yes|no`
- ASSUMPTION A1 (high, no): <…>
- ASSUMPTION A2 (low, yes): <…>  ← blocks autonomy

## Repro (bugs only)
- Steps: <…> | Expected: <…> | Actual: <…>
- Repro test: <path> | "NOT REPRODUCIBLE"
```

**Why verbatim report matters:** paraphrase is where intent leaks.

## The spec steps
1. **Read** ticket + `metadata.scope` + `wolfpack-config.md` + touched app + prior art. Grep before read, targeted line ranges, no wide re-reads. Do NOT read other hunts' plan dirs.
2. **Separate KNOWN from ASSUMED.** Grounded in report vs. invented. Both go in `acceptance.md`.
3. **Generate ranked ambiguity questions** — the 3-5 that change the build. Rank by `load_bearing` then `confidence`. If you cannot produce sharp questions → confidence = `low` → park.
4. **Draft acceptance criteria** from KNOWN + best-guess for ASSUMED. **Every `[auto]` must be MCP-executable** — exact URL/selector + expected shape. If vague, tag `[manual]`.
5. **For bugs: attempt repro-first.** Write a test demonstrating the bug. Red = confidence boost. Can't reproduce → lean toward park.

*The failure mode of "the agent builds the spec" is approval theater. The fix: make the gaps the output.*

### Interview interface (interactive `/spec` only)
Use `AskUserQuestion` — multiple-choice with "Other" escape. You propose likely answers (domain check); user picks or overrides.

- One question per load-bearing ambiguity, ranked, max ~5. Each option is a concrete answer that would change the build.
- Batchable: collect questions for every hunt, present in one `AskUserQuestion` sitting at kickoff.
- Unanswered load-bearing question = park, not silent collapse.

> **Headless note:** when running inside `hunt-pipeline.js` (no user), do steps 1-5, rate confidence, let the gate decide. CANNOT call `AskUserQuestion`. Interactive `/spec` is where questions get asked.

## The confidence gate
Confidence is `high` **ONLY IF ALL** of these hold:
- [ ] Ticket states expected behavior explicitly (not just symptom)
- [ ] (Bugs) repro test goes red
- [ ] No `load_bearing: yes` assumption is `confidence: low`

If first bullet fails or load-bearing assumption is shaky → `med`. If ticket too vague → `low`.

**Compliance is a routing modifier, not a confidence penalty.** Compliance-critical never runs fully unattended. At `high`: builds with `compliance_review_required: true`. At `med`/`low`: parks.

Routing:
| Confidence | Compliance-critical? | `mode_for_build` | Action |
|---|---|---|---|
| high | no | `autonomous` | build autonomously |
| high | yes | `autonomous` + `compliance_review_required: true` | build, pre-merge checkpoint |
| med | no | `flagged` | build on flagged assumptions |
| med | yes | `parked` | park `needs_spec` |
| low | any | `parked` | park `needs_spec` |

**A compliance-critical hunt can NEVER reach `mode_for_build: autonomous` without `compliance_review_required: true`.** Hard invariant — fail closed.

**Bias toward asking.** When borderline, park.

## Write the metadata spec block
After `acceptance.md`, update `metadata.json`:
```json
"spec": {
  "confidence": "high|med|low",
  "mode_for_build": "autonomous|flagged|parked",
  "ambiguity_open": true|false,
  "compliance_critical": true|false,
  "compliance_review_required": true|false
}
```
- `ambiguity_open: true` ⇒ at least one load-bearing question unanswered (parks)
- If `mode_for_build == "parked"`, set top-level `"status": "needs_spec"`

## Finishing message
- **Autonomous/flagged:** confidence + mode + flagged assumptions + "Next: `/alpha $ARGUMENTS`"
- **Parked:** unanswered load-bearing questions + "Parked `needs_spec` — answer questions, then re-run `/spec $ARGUMENTS`"

## Hard rails
- Do NOT write outside `.wolfpack/plans/$ARGUMENTS/` except `metadata.json` and best-effort repro test in worktree
- Do NOT plan, implement, or review — that's Alpha/Shepherd/reviewers
- Do NOT silently collapse unanswered load-bearing question into default. Park instead.
- Do NOT mark compliance-critical `autonomous` without `compliance_review_required`
- Do NOT commit. `/merge` handles artifact commits.
