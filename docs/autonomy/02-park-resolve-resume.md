---
status: design-only
tags:
  - docs/wolfpack
  - docs/autonomy
---

# 02 — Park / Resolve / Resume

> **Implemented** (2026-06-02, live-edit build layer). `hunt-pipeline.js` (`parkHunt`,
> `COMPLIANCE_PATHS`, `HUMAN_NOTES_DIRECTIVE`, parked-guard, resume-tier fail-closed),
> `campaign-runner.js` (actionable filter + barrier bucket), `/parked` + `/resolve`
> commands, and `.agents/skills/parked/SKILL.md`. **Scope note:** the Bloodhound
> *proceed-anyway-at-cap* is deliberately NOT converted to `parked:non_convergence` here —
> that conversion needs [03] Part B's fingerprint convergence detection (without it,
> parking on "not APPROVED at the cap" would stall nearly every hunt). The
> `non_convergence` reason + resume machinery exist; [03] Part B wires the Bloodhound
> trigger. (Pointer-loop exhaustion, which already dead-ended, IS parked now.)

**Goal:** a hunt that can't safely proceed *halts cleanly, surfaces exactly what it needs
from you, and resumes autonomously* once you answer — without you manually re-driving the
pipeline. A pipeline that can halt but not cleanly un-halt just trades post-smoke
firefighting for a different babysitting.

Builds on: the existing resume probe (`hunt-pipeline.js:154-256`) and the wave barrier
(`campaign-runner.js:223-274`) — together ~70% of the machinery already exists. Pairs
with [01] (`needs_spec`), [03] (`non_convergence` / `open_critical` parks).

---

## The hunt state model

One status field drives both the cron driver and your work queue. The driver only
*touches* `ready` and just-resolved hunts; you only touch the three human states.

```
needs_spec                  → awaiting your spec interview            (YOU)   [01]
ready                       → spec'd, actionable                      (cron)
running                     → in pipeline                             (auto)
parked:<reason>             → halted, needs you                       (YOU)
                              reasons:
                                ambiguity        — load-bearing low-confidence assumption [01]
                                non_convergence  — review loop not making progress         [03]
                                open_critical    — CRITICAL survived its budget            [03]
                                repro_failed     — bug not reproducible                    [01]
                                model_quota      — both cross-model CLIs rate-limited       [05]
                                compliance_review— compliance-area diff awaits human sign-off
                                smoke_pending_human— wave smoke has un-runnable criteria you must run [04]
                                rebase_conflict  — Shepherd rebase failed (already exists)
certified                   → done, in the wave release queue         (YOU, batched) [04]
merged                      → terminal
```

Cron's actionable filter (extends `campaign-runner.js:111-112`): run hunts whose status
is `ready`; skip every `parked:*` and `needs_spec`; treat `certified`/`merged` as done.

---

## The park payload

When a hunt parks, it writes a structured record so you can answer in seconds without
opening the worktree. File: `.wolfpack/plans/<slug>/parked.md` + a metadata mirror.

```markdown
# PARKED — <slug>

- reason: <enum>
- parked_at: <ISO8601, written by the agent — NOT the workflow JS>
- resume_phase: <Spec|Plan|Review|Debrief|Implement|Code Review|Test|Certify>
- resolution_type_expected: clarify | redirect   (see below)

## What I need from you
<One or two sentences. The exact question, or the contested finding + why it's stuck.>

## Context (enough to decide without opening the worktree)
- <the relevant plan excerpt / finding / diff hunk — quoted, ≤20 lines>

## Options (if applicable — feeds AskUserQuestion)
- A: <…>
- B: <…>
```

The agent writes `parked_at` (it has real bash; the workflow JS can't — see [05]).

---

## clarify vs redirect — the critical distinction

Your answer determines *where* the hunt re-enters. Two kinds:

- **`clarify`** — your answer resolves a local ambiguity/finding without invalidating the
  plan. Inject the disposition, resume *in place* at `resume_phase`.
  *Example:* parked at Bloodhound round 3 over a contested finding; you say "that's out
  of scope" → write the disposition, resume the review loop / jump to Debrief.
- **`redirect`** — your answer changes intent and invalidates the plan. Rewind to Alpha
  (or Spec) with the corrected `acceptance.md`.
  *Example:* "actually I wanted X, not Y" → the plan is now wrong; restart from Plan with
  updated criteria.

`/resolve` infers the type from your answer but lets you override. The resume probe
already knows how to re-enter at a phase (`hunt-pipeline.js:240-256`); this just supplies
*which* phase + the corrected inputs.

---

## The two commands

### `/parked` — your work queue (inbox surface)

Lists every parked + `needs_spec` hunt across *all* campaigns, so you never grep
worktrees. Reads `parked.md` / metadata from both `.wolfpack/plans/*/` and
`<Worktree root>/*/.wolfpack/plans/*/` (`wolfpack-config.md` → Project Identity) (same dual-scan the version-collision check
already does, `wolfpack/SKILL.md:90`). Sorted by reason severity then age. Output:

```
PARKED HUNTS (3)
  ⛔ unfinalize-restore   open_critical     2h ago   "CRITICAL #4 (regulated-record disposition) unresolved after 5 rounds"
  ❓ scheduling-polish    needs_spec        9h ago   "3 questions — drag behavior, default view, mobile"
  🔁 invoice-bundle       non_convergence   1h ago   "review oscillating on tax-rounding finding"
```

### `/resolve <slug>` — answer and re-arm

1. Show the park payload (`parked.md`).
2. Collect your answer via `AskUserQuestion` (options from the payload if present).
3. Write the answer to an **authoritative** `.wolfpack/plans/<slug>/human-notes.md`
   (timestamped, append-only — this is the channel the resumed run reads).
4. Set `resolution_type` (clarify/redirect), set status to the resume phase, clear the
   park reason.
5. Done — the next cron tick picks it up. **You resolve; cron resumes.**

Resumed agents get an injected instruction: "Read `human-notes.md` — it contains
authoritative human direction that OVERRIDES prior plan assumptions where they conflict."

---

## The compliance-review checkpoint

A narrow, policy-driven park — *not* triggered by a finding, but by *what the hunt
touched*. After Watchdog PASS, if the diff touches a declared compliance area (`wolfpack-config.md` → Compliance Requirements),
the hunt parks `compliance_review` instead of going straight to the release queue. You
read a tight diff (Watchdog pre-summarizes the compliance-relevant hunks against the
`[compliance]` acceptance criteria) and sign off. Honors the project's "must be RIGHT" bar without
taxing cosmetic hunts.

Gate it on touched paths, computed from `git diff --name-only main..HEAD` against a
configured `COMPLIANCE_PATHS` list drawn from the project's declared compliance areas
(`wolfpack-config.md` → Compliance Requirements). Fail-closed: if path detection is uncertain, park anyway.

**Caveat — a pervasive module over-fires (2026-05-31 review).** A naive "touches module X" match
against a module most of the app imports (e.g. a payments module) will over-fire: gating on *any*
path under it would park most hunts and make the checkpoint noise. Narrow the trigger to the genuinely
risk-bearing surfaces, not every import — e.g. money/tax computation, the payment flow,
regulated-record retention/disposition fields — not a UI tweak that merely sits under the same
directory. The trigger needs a **risk-surface allowlist** (specific modules/functions), not a
top-level directory glob. Still fail-closed *within* that narrowed set; just don't let the
directory's breadth turn the gate into a rubber stamp.

**Starter allowlist (define in code, not prose).** `COMPLIANCE_PATHS` should enumerate the
specific risk surfaces declared in `wolfpack-config.md` → Compliance Requirements, not a whole
tree — e.g. a payments service module, tax-computation modules and a regulated-records
retention flow, not a whole `payments/` tree that most of the app imports. Maintain it as a
reviewed list: a new money/tax/regulated-record surface gets added deliberately, the same way a
new migration is. A UI tweak that merely imports from the payments module does not trip it.

---

## Threading into existing code

- **`hunt-pipeline.js`:** every `return { ... verdict: 'REVIEW_EXHAUSTED' }`-style exit
  (`:534`, `:616`, `:768-770`, `:823-825`, `:866-869`) becomes a *park*: write
  `parked.md`, set `status: parked:<reason>`, return the same verdict so the runner logs
  it. The hard-halt-on-critical (`:609-617`) → `parked:open_critical`. The
  "proceed-anyway at cap" (`:618-626`) → **remove**; on cron, proceed-anyway is exactly
  the "ship suspect code" anti-goal. Replace with `parked:non_convergence` (see [03] for
  the convergence trigger that supersedes the count cap).
- **Resume probe** (`:181-229`): add the new statuses to its ordering and to
  `STATUS_RESUME` (`:167-178`). A `parked:*` status maps to `resume_phase` from
  `parked.md`, not a fixed rung.
- **`campaign-runner.js`:** the actionable filter (`:111-124`) excludes `parked:*` and
  `needs_spec`. The wave barrier (`:223`) already stops for human steps — extend its
  report to list parked hunts alongside certified/failed.
- **New commands/skills:** `/parked`, `/resolve` (`.agents/commands/`, `.agents/skills/`).
- **metadata.json:** `park` block — `{ reason, parked_at, resume_phase,
  resolution_type, human_notes_seen: bool }`.

---

## Edge cases

- **Resume tier downgrade** (existing latent bug, `:437`): on resume, `tier =
  resumeProbe.tier || 'Yellow'` silently downgrades a Red hunt that lost its tier.
  Fail-closed: default unknown tier to **Red**, or carry tier in `parked.md` so resume
  never guesses.
- **Stale park:** a `parked.md` whose worktree was removed → `/parked` flags it as
  orphaned; `/resolve` offers re-scaffold (same path as `:244-247`).
- **Double-answer:** `human-notes.md` is append-only; a re-`/resolve` adds a new dated
  block, latest wins, history preserved.
- **redirect loops:** if a hunt redirects to Plan twice, third redirect forces
  `needs_spec` (the ticket itself is the problem, not the plan).

---

## Acceptance criteria for THIS feature

- AC1 [auto] A hunt that hard-halts on an open CRITICAL ends in `parked:open_critical`
  with a `parked.md` quoting the finding — not a bare `return`.
- AC2 [auto] `/parked` lists hunts from both main and worktree plan dirs in one view.
- AC3 [auto] After `/resolve` writes `human-notes.md` and flips status, the next runner
  pass re-enters at `resume_phase` and the resumed agent reads `human-notes.md`.
- AC4 [auto] A `redirect` resolution re-enters at Plan with the updated `acceptance.md`;
  a `clarify` re-enters at the parked phase.
- AC5 [compliance] A diff touching a declared compliance area parks `compliance_review`
  before entering the release queue, every time.
