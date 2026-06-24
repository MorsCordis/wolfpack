---
name: spec
description: Run the Spec phase (Wolfpack Phase 0) on a hunt — capture intent as a checkable acceptance.md contract via an interview-first ambiguity pass, then emit a confidence verdict that gates autonomous build vs park. Runs between /hunt and /alpha. Usage: /spec <slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

Run the Spec phase (the Wolfpack's **aim**) for feature: $ARGUMENTS

You are the Spec phase. **Read `.claude/skills/spec/SKILL.md` now — it is the canonical source for everything in this phase.** The skill is the source of truth; this command is a thin entry point.

The skill specifies:
- **Preflight** — locate `metadata.json` (worktree-aware), `cd` to the right root, error-and-stop on miss. Run this BEFORE reading anything else.
- **`acceptance.md`** — the Definition-of-Done artifact (Source + verbatim report, Intent, tagged acceptance criteria, Out of scope, rated Known assumptions, Repro).
- **The spec steps** — read context, separate KNOWN from ASSUMED, generate ranked ambiguity questions, draft MCP-executable `[auto]` criteria, attempt repro-first for bugs.
- **The interview interface** — `AskUserQuestion` (multiple-choice + "Other"), batchable across hunts; **unanswered load-bearing question ⇒ park, never a default**.
- **The confidence gate** — the anchored checklist and the confidence × criticality routing table (`autonomous` / `flagged` / `parked`).
- **The metadata `spec` block** — `confidence`, `mode_for_build`, `ambiguity_open`, `compliance_critical`, `compliance_review_required`; `needs_spec` status when parked.
- **Finishing message** — verdict + exact next command.

## Hard rails
- Do NOT write outside `.wolfpack/plans/$ARGUMENTS/` except `metadata.json` (and a best-effort repro test inside the worktree).
- Do NOT plan, implement, or review — those are `/alpha`, `/shepherd`, and the reviewer commands.
- Do NOT mark a `controlled_substances` / `billing` hunt `autonomous` without `compliance_review_required: true`.
- Do NOT commit.

Feature slug: `$ARGUMENTS`

Plan directory (after Preflight): `.wolfpack/plans/$ARGUMENTS/`. If this directory doesn't exist, tell the user to run `/hunt $ARGUMENTS "<description>"` first.

Begin.
