---
status: design-only
tags:
  - docs/wolfpack
  - docs/autonomy
---

# 04 — Batch Merge & Consolidated Smoke

> **Implemented** (2026-06-08, live-edit build layer): the deterministic core lives in
> `scripts/wolfpack-release.mjs` (+`.test.mjs`, 22 cases) — `aggregateBump`/`nextVersion`
> (the wave owns ONE tag, highest-step-wins, tooling-only contributes nothing),
> `releaseQueue` (AC4 — compliance-review holds excluded), `parseAcceptanceCriteria` (the
> smoke spine). `campaign-runner.js`'s wave barrier now prints the formal RELEASE QUEUE
> (compliance-held hunts split into their own `WAVE_AWAITING_HUMAN`/partial bucket) and the
> exact `/merge-wave` → dev deploy → `/smoke-wave` handoff. New commands `/merge-wave`
> (sequential `--no-ff` merges, no per-hunt tag, then one aggregated version + tag + push)
> and `/smoke-wave` (union of every released hunt's `acceptance.md` criteria, regrouped by
> surface, `[auto]` via Chrome DevTools MCP, `[manual]` as a blocking checklist, no silent
> defer, fix-forward through review on a fresh `fix/<slug>-smoke-N` worktree). `/smoke` now
> reads `acceptance.md` as its spine and the Watchdog derives `smoke-tests.md` FROM it so the
> two never drift. AC1–AC5 covered; the [03]-ledger retrospective-grader lookup in the
> fix-forward path lands as instructions in `/smoke-wave` (the ledger substrate is [03]'s).

**Goal:** when a wave of hunts certifies, merge them sequentially, deploy **once**, and
run **one consolidated smoke pass** — mostly automated — so your testing time isn't
wasted re-context-switching per hunt. Your time is a cost; this is where a sloppy release
loop quietly spends it.

Depends on: [01] (`acceptance.md` criteria drive smoke) and [02] (release queue =
`certified` hunts, minus those parked for `compliance_review`). Extends the existing wave
barrier (`campaign-runner.js:223-274`).

---

## The release queue

The wave barrier already stops at every wave boundary and lists certified hunts with a
merge sequence (`campaign-runner.js:245-258`). Formalize that list as the **release
queue**: all hunts at status `certified` whose `compliance_review` (if required, [02])
is signed off. The queue is what `/merge`-batch and the consolidated smoke operate on.

```
RELEASE QUEUE — wave 2 (3 hunts ready, 1 awaiting compliance sign-off)
  ✅ invoice-bundle-defaults     certified
  ✅ scheduling-drag-polish      certified
  ✅ client-multi-contacts       certified
  ⏸ records-disposition-fix     compliance_review (run /resolve first)
```

---

## Sequential batch merge + per-wave version tag

On the **autonomous path the wave — not the individual hunt — owns the version tag.**
`/merge-wave <campaign> <wave>` splits the old per-hunt `/merge` into two steps:

**1. Per-hunt merge (no tag, no version heading).** Each certified hunt merges to main
**sequentially** (auto-rebase onto main, `--no-ff`, plan copy-back, push), folding its
CHANGELOG entries under `[Unreleased]` **with** the `<!-- hunt:slug -->` attribution. It
does **not** lay a tag and does **not** stamp a version heading. Sequential because `--no-ff`
merges stay cleanly revertible per hunt — a wave smoke failure reverts exactly one merge
commit (`git revert <that merge>`), leaving the rest.

**2. Wave finalization (once, after all merges, before deploy):**
- **Aggregate the bump** = the highest semver step across the wave's hunts'
  `proposed_version.bump` (MINOR beats PATCH; tooling-only hunts contribute nothing per
  the operator's tooling-only-no-bump rule; MAJOR stays reserved for prod launch).
- **Stamp the CHANGELOG** `[Unreleased]` → `[wave-version]` heading **once**, covering every
  hunt-attributed entry in the wave. (This is the stamping per-hunt `/merge` used to do — it
  moves here.)
- **Lay one annotated tag** on the final merge commit.

Then **one** dev deploy (`wolfpack-config.md` → Deployment Notes) for the whole wave (APP_VERSION bakes from the wave tag via
`git describe` — satisfies tag-before-deploy; image invariant preserved), then
`/smoke-wave`. Single deploy, single tag, not one-per-hunt.

**Scope:** this is the autonomous/batch path. A manually-run single hunt is a wave-of-one
and tags exactly as today — manual flow unchanged.

**Side benefit — kills the tag-collision class.** Wave-tagging resolves
the parallel-version-tag collision: hunts no longer each *claim* a tag string, they only
declare a bump *size*; the wave owns the single tag. The per-hunt collision scan and the
`/merge` pre-merge tag gate become wave-level concerns and the collision disappears.

**Tag reversion (post-smoke) — re-lay, don't half-measure.** If a hunt fails smoke and its
merge is reverted, the wave tag is **moved/re-laid onto the post-revert commit** so it
always points at exactly-what-shipped — never sitting ahead of the good state. (Prod only
ever sees what passed; dev tags hold the same discipline, so there's no point shipping a
half-measure for dev.)

---

## Consolidated smoke — criteria union, automation-first

The keystone is `acceptance.md`. The consolidated smoke set is the **union of every
released hunt's acceptance criteria**, deduplicated and reordered by app/surface so you
walk *one coherent path* through the deployed wave instead of bouncing per hunt.

### Automate what's tagged `[auto]`

You have Chrome DevTools MCP (43 tools; smoke can self-verify API calls + JS errors —
per `reference_chrome_devtools_mcp`). Each `[auto]` criterion becomes an MCP sequence:
navigate → act → assert (DOM/network/console). These run against the deployed feature
*before you touch anything* and report green/red.

```
CONSOLIDATED SMOKE — wave 2 @ <dev URL>
  Billing surface
    [auto] AC invoice-bundle/1   bundle default applies      ✅
    [auto] AC invoice-bundle/2   tax rounds to cents         ❌  (got 12.005, expected 12.01)
    [manual] AC invoice-bundle/3 PDF layout looks right      ⏳ needs you
  Scheduling surface
    [auto] AC scheduling/1       drag creates appt           ✅
    [manual] AC scheduling/2     mobile drag feels right     ⏳ needs you
```

You only run the `[manual]` (visual/judgment) criteria. That's the direct hit on "ensure
my time isn't wasted with testing" — the mechanical checks are done before you sit down.

### Disposition rule — no item is ever silently deferred

Every smoke criterion resolves to **exactly one terminal state inside the smoke cycle** —
there is no "deferred":

- **`auto_pass`** — MCP ran it, passed.
- **`auto_fail`** — MCP ran it, failed → fix-forward (review→Shepherd, below) or revert.
- **`needs_human_run`** — the agent **can't** execute it (genuinely `[manual]`, or an
  `[auto]` that won't actually automate). It is **surfaced to you as a blocking checklist
  item** with exact steps (URL, action, expected — per the operator's smoke-test-authoring rule). You
  run it and enter pass/fail. The wave **parks** (`smoke_pending_human`, [02]) until every
  one is cleared — it does **not** close with un-run criteria silently shelved.

**Hard prohibition:** the agent may **never** write an un-runnable smoke criterion into
`TODO.md`. Surface-and-wait is the only default; a smoke item becomes a TODO **only if you
explicitly decide** it's real future work — your call, never the agent's silent fallback.
This keeps `TODO.md` the human-curated engineering backlog instead of a dumping ground for
automation gaps, and is the stronger sibling of the operator's smoke-scope-expansion rule (findings
fixed in-cycle) — un-runnable *tests* don't get deferred either.

**Spec feedback loop:** an `[auto]` criterion that turns out un-automatable is a `/spec`
mis-tag ([01] requires `/spec` to validate `[auto]` executability). On hitting one, re-tag
it `[manual]`, surface it, and log it as a spec-validation miss so the aim point tightens —
the "can't run" signal flows back to the spec, not into the backlog.

### Per-hunt failure attribution

Because every criterion carries its owning hunt (`AC invoice-bundle/2`), a smoke failure
maps to exactly one merge commit. Revert that commit, redeploy, retest — the rest of the
wave stays. **This attribution is why criteria-per-hunt is load-bearing for batch smoke**;
without it, a failed consolidated smoke is an ambiguous mess.

### Smoke findings feed back through review — never Shepherd-direct (run-#5 thread)

A smoke failure that needs a *fix* (not a clean revert) does **not** go straight to Shepherd
to self-diagnose-and-patch. It re-enters as a mini-cycle:

```
smoke finding → fingerprint + attribute → review/plan the fix → Shepherd implements
             → Pointer/Tracker verify → re-smoke
```

Two load-bearing reasons:

1. **Same adversarial bar on smoke-fixes as on the original code** — no unreviewed patches
   sneaking in post-merge. Shepherd implementing its own unreviewed diagnosis is the
   un-adversarial path we avoid everywhere else.
2. **The fingerprint+attribute step is where the lagging signal is captured** ([03] ledger).
   Look the smoke fingerprint up in the originating hunt's ledger: *never raised* → a miss,
   debit the stage/model that should have caught it (by domain); *raised then rejected* → a
   wrong-rejection. **This is what turns "5/5 but 7 smoke findings" into actual movement on
   those models' scores.**

So smoke isn't only a gate — it's the **retrospective grader** that closes the loop the cert
score can't. (The clean-revert path above is unchanged; this is for the fix-forward case.)

**Open: where does the fix-forward code live? (2026-05-31 review).** Batch smoke runs *after*
merge-to-main + deploy, by which point the hunt's worktree may be cleaned up — so a
fix-forward mini-cycle has no obvious git home. Define one before implementing: cleanest is a
**fresh short-lived `fix/<slug>-smoke-N` branch+worktree off main**, run through the same
review/verify mini-cycle, merged like any hunt. (The clean-revert path needs no branch; only
fix-forward does.) Without a defined home the loop is specified but unrunnable.

### URL safety

Verify host+path against the real env/router before presenting: check the host matches the
project's dev host pattern (`wolfpack-config.md` → Deployment Notes), never prod.
The smoke runner resolves URLs from the router, never relays Alpha-authored URLs verbatim.

---

## Smoke-test authoring (so the criteria are runnable)

Per the operator's smoke-test-authoring rule: `[auto]` criteria in `acceptance.md` must specify
HOW — exact URL, button label/selector, the expected response shape or DOM assertion —
not just an outcome description. The `/spec` phase ([01]) is responsible for writing
`[auto]` criteria concretely enough that the MCP runner can execute them without
guessing. A vague `[auto]` criterion is a spec bug, caught at [01], not at smoke time.

---

## The flow end to end

```
wave certifies (campaign-runner wave barrier)
  ↓
/merge-wave <campaign> <wave>      → sequential --no-ff merges + tags + push
  ↓
<dev deploy>                        → ONE deploy for the wave (user-run; hook-gated)
  ↓
/smoke-wave <campaign> <wave>       → MCP runs all [auto] criteria, reports green/red
  ↓ you run the [manual] criteria
  ↓ any failure → git revert <hunt's merge>, redeploy, retest that hunt
  ↓ all green
/summary                            → wave retrospective (session note)
```

---

## Threading into existing code

- **`campaign-runner.js`:** the wave-barrier report (`:245-258`) already drafts the merge
  sequence — point it at the formal release queue (exclude `compliance_review`-pending).
- **New commands:** `/merge-wave`, `/smoke-wave` (`.agents/commands/`). `/merge-wave`
  loops the existing `/merge` per hunt; `/smoke-wave` reads each released hunt's
  `acceptance.md`, unions + dedupes criteria, drives MCP for `[auto]`, lists `[manual]`.
- **`/smoke` skill:** extend to consume `acceptance.md` criteria (today it reads
  `smoke-tests.md` written by Watchdog — keep that as the fallback/source for `[manual]`
  step detail, but criteria become the spine).
- **Watchdog:** continues writing `smoke-tests.md`, but now derives it FROM
  `acceptance.md` criteria so the two never drift.

---

## Acceptance criteria for THIS feature

- AC1 [auto] `/merge-wave` merges N certified hunts sequentially, each `--no-ff`, and a
  single dev deploy follows — not N deploys.
- AC2 [auto] `/smoke-wave` runs every `[auto]` criterion across all released hunts via
  MCP and reports pass/fail before any manual step.
- AC3 [auto] A failed `[auto]` criterion names its owning hunt; reverting that one merge
  leaves the other hunts intact and deployable.
- AC4 [compliance] A hunt pending `compliance_review` is excluded from the release queue
  until signed off.
- AC5 [manual] The consolidated smoke groups criteria by surface (one walk), not by hunt.
