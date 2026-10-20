---
name: expedition
description: Scout-only Wolfpack Expedition — Alpha bundles backlog items into a hunt list (and optionally Bloodhound reviews the bundling). Stops after writing campaign.md so you can drive each hunt with /hunt → /spec → /alpha → ... Usage: /expedition [--no-review] [--max-hunts=N] <campaign-slug> "<description>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

Scout-only Wolfpack Expedition for: $ARGUMENTS

You are the Alpha in scouting mode. Your job is **bundling intelligence only** — you decompose a backlog into a sequence of hunts. You do NOT run any hunts here; the user drives each one with `/hunt` after reviewing your campaign plan.

## ⚠ Finishing message is MANDATORY VERBATIM
Your final response MUST end with the exact block in "## Finishing message" below. Do NOT paraphrase, reformat, or drop `/clear`. It's the user's copy-paste handoff — dropping steps forces them to reconstruct the cadence themselves.

## Input

Parse `$ARGUMENTS` as: `[--no-review] [--max-hunts=N] <campaign-slug> "<description>"`.

Flags:
- `--no-review` — skip the Phase 0.5 Bloodhound review of your campaign breakdown
- `--max-hunts=N` — cap how many hunts you may propose (default: 10)

If the slug or description is missing, tell the user the correct usage and stop.

## Setup

0. **CWD preflight.** Campaigns live at `.wolfpack/campaigns/<slug>/` in the main repo root. Resolve the pack and the worktree root first:

   **Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.

   **Worktree root (`WT_ROOT`).** In the main checkout run `node "$PACK/scripts/wolfpack-config.mjs" --json` and take `worktreeRoot` (wolfpack-config.md → Project Identity → Worktree root, repo-relative). If the reader exits 2 or `worktreeRoot` is null, STOP with the fix: "add ``- **Worktree root:** `<repo-relative dir, e.g. .agents/worktrees>` `` under ## Project Identity in wolfpack-config.md". Never assume a default location.

   Then verify you're in the main repo (not a sibling worktree): `git rev-parse --show-toplevel`. If the toplevel is inside `$WT_ROOT`, stop and tell the user to `cd` back to the main repo before `/expedition`. Campaigns are cross-hunt; they don't belong in a single-hunt worktree.
1. Verify `.wolfpack/campaigns/<slug>/` does NOT already exist. If it does, stop and tell the user to pick a different slug or hand-edit the existing campaign.
2. Create `.wolfpack/campaigns/<slug>/`.
3. Write `.wolfpack/campaigns/<slug>/metadata.json` with:
   ```json
   {
     "campaign": "<slug>",
     "description": "<description>",
     "created": "<ISO8601 now>",
     "status": "scouting",
     "max_hunts": <N or 10>,
     "no_review": <true|false>,
     "hunts": []
   }
   ```

## Phase 0 — Scouting (you, right now)

Read these files (and ONLY these for campaign-level decomposition — per-hunt scoping happens later in `/alpha <slug>`):

- the project's backlog file (wolfpack-config.md → Deployment Notes → **Backlog file**) — the scope source
- the project's instruction files (the project's CLAUDE.md / AGENTS.md or equivalent) and `wolfpack-config.md` — project rules
- `.wolfpack/pedigree/index.md` — Shepherd-success history per model
- `.wolfpack/pedigree/lessons.md` (if present) — recurring issues to address explicitly in hunt plans
- `.wolfpack/cross-cutting-debt.md` (if present) — known infra issues to avoid stepping on
- `.wolfpack/known-broken-tests.md` (if present) — tests Watchdog will baseline-pass; don't propose hunts to "fix" them

Do NOT read individual source files in this scouting phase. You're deciding *which* hunts to run, not *how* to implement them.

### Clarification check (REQUIRED before writing campaign.md)

A campaign's paragraph-length description often leaves room for interpretation. Getting the decomposition wrong means every hunt downstream inherits the wrong scope. Before writing `campaign.md`, scan for material ambiguities and ask the user via the AskUserQuestion tool if any exist. Questions to probe for:

- **Scope boundaries** — Which backlog items are in scope vs out? When the description says "clear all ticketing items" but the backlog has 20 ticketing-adjacent items, which specifically?
- **Mode/tier bias** — Is the user expecting fast-lane Update-mode hunts, or deliberate Feature-mode ones? ("Sprint cleanup" usually means Update; "V1 push" might mix both.)
- **Bundling aggression** — Bundle aggressively (fewer, bigger hunts) or split conservatively (more, smaller)? Pedigree may suggest a default, but user preference wins.
- **Compliance touch** — Does the campaign knowingly touch one of the project's compliance areas (wolfpack-config.md → Compliance Requirements → Compliance areas)? If yes, those hunts MUST be Feature-mode and solo.
- **Deploy cadence** — Does the user want incremental per-hunt deploys, or one batched deploy at the end? Affects the `Migration risk` recommendation.
- **Adjacent work** — Recent commits or in-flight feature branches that might conflict with proposed hunts.

Phrase questions concretely with the actual option set. Batch them in ONE AskUserQuestion call rather than firing several — reduces context-switching for the user. Example:

```
Question 1: "Clear all ticketing items" — the backlog has 20 ticket-related items across three modules. Which scope?
  A. Only items tagged #ticketing in the backlog (14 items)
  B. All ticket-related items regardless of tag (20 items)
  C. Two modules only; defer the third module's tickets to a separate campaign (11 items)

Question 2: Preferred bundling style?
  A. Aggressive — fewer, larger hunts per module (~3-5 hunts total)
  B. Conservative — one hunt per ticket where scopes diverge (~10 hunts total)
  C. Alpha decides per heuristics
```

Do NOT ask when a reasonable default is obvious from the backlog + lessons + Pedigree. Skip the clarification entirely if the description is concrete and unambiguous (e.g. "Implement ticket #42 exactly as written"). One well-chosen question beats five defensive ones.

Record the asked questions and answers in a `## Clarifications` section at the top of `campaign.md` so the per-hunt `/alpha` calls inherit the context.

Apply the bundling heuristics from your skill:

**Bundle when:**
- Same module — high file overlap
- Each individual fix scores low (1-2) on complexity + domain + multi-tenancy dimensions
- No compliance areas touched (wolfpack-config.md → Compliance Requirements → Compliance areas / Risk-surface paths)
- Pedigree shows similar bundles went well

**Don't bundle when:**
- Different modules/domains
- Any single item scores high on complexity, domain sensitivity, or multi-tenancy risk
- Architectural changes (models, schema, permission structure)
- Conflicting change vectors (one item adds logging, another removes it)

Cap at the `--max-hunts` value (default 10). If the backlog is larger, propose only the top-priority N and note in `campaign.md` that more hunts are deferred.

## Wave assignment — optimize for parallel-ability, not just priority

A wave should run as many hunts together as SAFELY parallelize. Priority sets the *order* of work; it does NOT decide whether two hunts can share a wave. Assign waves in two passes:

1. **Parallel-safety (hard constraints) FIRST.** Within one wave, NO two hunts may:
   - **Add a migration to the same migration unit** (the directory a Migration file pattern match lives in, e.g. an app's `migrations/`). Skip this rule when wolfpack-config.md → Deployment Notes → **Migration file pattern** is `none`. Two hunts forking from the same `main` each grab the same next number → two leaf nodes → the project's migration command fails with "multiple leaf nodes." A single hunt can touch **several** migration units (dropping a table often also drops a foreign-key column in another unit), so compare the FULL **Migration unit(s)** set of every pair — *any* overlap disqualifies co-waving. (It's deconflictable at merge with the project's migration-merge procedure, so this is avoidable friction, not a hard failure — but the whole point of a wave is to not create it.) Resolve a clash by EITHER splitting the two into different waves, OR adding `Depends on: <first-hunt>` to the second so it scaffolds only AFTER the first merges — its worktree then forks from a `main` that already has the first's migration and it gets the *next* number.
   - Heavily rewrite the **same file(s)** (mergeable, so a *soft* avoid — co-wave only when the edits sit in clearly separate regions of the file).
2. **Priority SECOND.** Within the parallel-safety constraint, fill each wave by priority (urgents first) + dependency order. Priority chooses *which* safe hunts go earlier — never whether unsafe hunts share a wave.

Record every pair you separated for a migration-unit or same-file collision under `## Parallel Tracks → Constraints` with the reason. Maximize the count of genuinely-independent hunts per wave; never pad a wave with two hunts that will fight at the migration graph.

## Write campaign.md

Write `.wolfpack/campaigns/<slug>/campaign.md` with this structure:

```markdown
# Campaign: <slug>

## Description
<one paragraph restating the campaign>

## Recon recommendation
recon_recommended: true | false
reasoning: <one sentence — set true if ≥3 backlog items in this campaign hit the same module, suggesting a shared root cause that one recon hunt should investigate before fanning out>

## Proposed Hunts (max <N>)

### 1. <hunt-slug>
- **Description:** <one sentence>
- **Tier:** Green | Blue | Yellow | Orange | Red
- **Mode:** update | feature
- **Wave:** <N> (wave number — hunts in the same wave can run in parallel)
- **Track:** <letter> (parallel track within the wave, e.g. A, B, C)
- **Migration risk:** additive | destructive | none
- **Migration unit(s):** [<every migration unit whose migration graph this hunt adds a node to; include units touched indirectly>] or none — drives the same-unit wave-collision check above
- **Backlog items cleared:** ["<exact backlog line>", ...]
- **Ticket refs:** [<ticket refs, if any>] — when the project's ticket IDs are per-environment or per-tenant, write each qualified as `<scope> #<n>` (e.g. `dev #22`, `prod #58`): `dev #22` and `prod #22` are DIFFERENT tickets, so a bare `#22` is ambiguous. Carry the qualifier through to CHANGELOG attribution and any "close this ticket" note.
- **Depends on:** [<slugs of hunts that must complete first>] or None
- **Blocks:** [<slugs of hunts that cannot start until this completes>] or None
- **Rationale:** <why bundled this way / why solo>
- **Trigger:** `/hunt --campaign=<campaign-slug> <hunt-slug> "<exact one-sentence description>"`

### 2. <hunt-slug>
...

## Parallel Tracks

### Wave diagram
<table or ASCII diagram showing waves, tracks within each wave, and dependencies>

### Constraints
<list of hunts that CANNOT run in parallel and WHY (shared module surface, dependency chain, migration conflict)>

### Parallelism notes
<guidance on how many parallel tracks are practical given the user's worktree capacity, context switching, and deploy cadence>

## Ordering
<paragraph explaining the proposed sequence — dependencies, risk-first or risk-last, etc.>

## Skipped Bundlings
<list any backlog items you considered grouping but kept solo, with reasoning>

## Trigger Quick Reference

After `/clear`, all context is gone — this section is the copy-pasteable command list. Hunts within a wave can run in parallel in separate terminals/worktrees. Complete all hunts in a wave before starting the next wave.

Use `/hunt --campaign=<campaign-slug>` to auto-select and fire the next unstarted hunt.

```
--- Wave 1 (parallel) ---
Track A: /hunt --campaign=<campaign-slug> <slug-1> "<desc>"
Track B: /hunt --campaign=<campaign-slug> <slug-2> "<desc>"

--- Wave 2 (parallel, after Wave 1) ---
Track A: /hunt --campaign=<campaign-slug> <slug-3> "<desc>"  # depends on Wave 1 Track A
Track B: /hunt --campaign=<campaign-slug> <slug-4> "<desc>"

... (grouped by wave, annotated with track letters)
```

After each `/hunt`, the hunt runs through the per-phase cycle. Return to this file (or use `--campaign`) to grab the next trigger when ready.
```

## Phase 0.5 — Bloodhound campaign review (skip if --no-review)

After writing `campaign.md`, spawn a Bloodhound sub-agent via the Agent tool to critique your decomposition. Use this prompt verbatim (substitute the backlog file name):

```
You are the Bloodhound reviewing a CAMPAIGN decomposition (not a per-hunt code plan).

Read .wolfpack/campaigns/<slug>/campaign.md and <backlog file>.

Critique on:
1. Bundling correctness — are backlog items grouped by shared-cost? Any bundles to split? Solos to bundle?
2. Tier/mode assignment — are the tiers and update/feature realistic?
3. Coverage — does the campaign cover every backlog item implied by the description?
4. Ordering & dependencies — any hunt depending on a later hunt?
5. Migration risk soundness — additive flagged when actually destructive?
6. **Wave parallel-safety — do any two hunts in the SAME wave share a `Migration unit(s)` entry?** That's a migration-graph leaf collision (the project's migration command fails with multiple leaf nodes); flag it and require either a wave split or a `Depends on` to sequence them. Also flag heavy same-file overlap within a wave.
7. Blast radius — any hunt too large or too small?

Write findings to .wolfpack/campaigns/<slug>/campaign-review-1.md.
End with verdict: APPROVED or NEEDS_REVISION.

Proportionality: ≤3 hunts or all-Green campaign → 0-3 findings max (HIGH/CRITICAL only).
```

Use `subagent_type: "general-purpose"` for the Agent call.

If the review is APPROVED, note it in your finishing message. If `NEEDS_REVISION`, briefly summarize the top 1-3 findings to the user — they'll decide whether to revise `campaign.md` themselves before running `/hunt`, or accept as-is.

**Do NOT auto-revise the campaign.md based on the review.** That's a manual editing decision; the user owns the breakdown.

## Update metadata

After writing `campaign.md` (and optionally the review), update `metadata.json`:
- `status: "awaiting_approval"`
- Parse the hunt list from your `campaign.md` and write the slug list to `metadata.hunts` so the user has a quick reference

## Finishing message (mandatory last line)

End with EXACTLY:
```
✓ Campaign scouted: <slug> | Hunts: <N>
  .wolfpack/campaigns/<slug>/campaign.md
  Bloodhound: APPROVED | NEEDS_REVISION (<top>) | skipped

Next: Read campaign.md → /clear → copy the FIRST line from ## Trigger Quick Reference (or /hunt --campaign=<slug>)
After each /merge, /clear → copy the NEXT trigger line. Repeat until the list is exhausted.
```

## What NOT to do

- Do NOT run `/hunt` or any other hunt-phase commands from this command. Scouting writes `campaign.md` and stops.
- Do NOT read individual source files for hunt-level scoping — that's `/alpha`'s job per hunt.
- Do NOT auto-revise `campaign.md` based on the Bloodhound review. Surface findings; let the user decide.
- Do NOT commit anything. The campaign dir is gitignored except for tracked artifacts.

Begin.
