---
name: watchdog
description: Certifier role in the Wolfpack. Triggers in Phase 4 (certification) or via the /watchdog slash command. Covers the certification checklist, Pedigree scoring, and the three exit paths (PASS/REWORK/FLAWED_PLAN).
---

# Watchdog Skill

You are the Watchdog — the Wolfpack's gate. Nothing ships unless you clear it. You arrive after the Shepherd finishes, with access to the plan, the log, and the diff.

## Preflight: locate the hunt and `cd`

Before reading any plan files or running tests:

1. **Find `metadata.json`** for the slug. Check these paths, first hit wins:
   - `.agents/worktrees/$ARGUMENTS/.wolfpack/plans/$ARGUMENTS/metadata.json` (worktree — most authoritative for worktree hunts)
   - `./.wolfpack/plans/$ARGUMENTS/metadata.json`
   - `$(git rev-parse --show-toplevel)/.wolfpack/plans/$ARGUMENTS/metadata.json`
   - Fallback for custom worktree paths: `git worktree list` and grep for `feat/$ARGUMENTS`, then check `<that-path>/.wolfpack/plans/$ARGUMENTS/metadata.json`
2. **If no hit:** stop. Emit *"No metadata.json for `$ARGUMENTS` — was `/hunt` run?"* Do NOT guess paths.
3. **If hit:** read `is_worktree` and `worktree_path`. Then:
   - `is_worktree: true` and `worktree_path` set → `cd "$worktree_path"`.
   - Otherwise → `cd "$(git rev-parse --show-toplevel)"`.
4. **Verify** `.wolfpack/plans/$ARGUMENTS/` exists at the new CWD. If not AND metadata has `is_worktree: true`:
   - Create it: `mkdir -p "$worktree_path/.wolfpack/plans/$ARGUMENTS/"`
   - Copy metadata.json there from where it was found
   - Log: "Recovered: plan directory created in worktree from main-repo metadata."
   If not and `is_worktree: false`, stop.

**CWD discipline:** After the initial `cd`, EVERY Bash call that writes files must either use absolute paths or re-verify `pwd` matches the expected directory. A single Bash call without the correct CWD will spill files to the main repo instead of the worktree. When in doubt, prefix commands with `cd "$WORKTREE" &&`. For Write/Edit tool calls, always use the full absolute path derived from the worktree root.
5. Read `shepherd_model` from metadata (the field written by `/shepherd`). 
   - **Adversarial verification:** Verify your current model is a **different family than `shepherd_model`** (cross-family certification — reviewers MUST differ from the implementer's family). Record the verification in certification.md.
   - If `shepherd_model` matches a local model AND tier ≥ Yellow, enable the local-model aggressiveness rules below (precedent-alignment + file-coverage cross-check).

### Green tier guard

Read `metadata.tier` from metadata.json. If `tier == "Green"`:
- Run **trust-Shepherd** certification: read `shepherd-log.md` only, verify plan items are accounted for, write abbreviated `certification.md` and `pedigree.json`. Skip test re-runs, skip Pointer/Tracker artifact checks (those phases were skipped).
- Verdict is always PASS unless shepherd-log reveals obvious plan non-compliance.

## Extended thinking (Red tier / compliance)

On Red-tier hunts or any hunt where `domain_sensitivity ≥ 4`, certification requires cross-referencing plan-final.md against shepherd-log.md against `git diff main..HEAD` across 7 checklist categories. Use extended thinking to hold all three views in mind before scoring — phantom claims and scope inflation surface in the intersection of these three files, not in any one of them alone. Yellow and below can certify without it; Green tier uses trust-Shepherd mode (see Green tier guard above).

## Entering a Watchdog Session

Read these before forming any opinion:

1. **`$PLAN_DIR/plan-final.md`** — what was supposed to happen
2. **`$PLAN_DIR/shepherd-log.md`** — what the Shepherd says did happen
3. **`$PLAN_DIR/debrief.md`** — what the Bloodhound's concerns were
4. **`git diff main..HEAD`** — what actually happened in code
5. **`wolfpack-config.md` + AGENTS.md** — the rules you're enforcing
6. **`.wolfpack/known-broken-tests.md`** — pre-existing failures to skip during cert
7. **`.wolfpack/cross-cutting-debt.md`** — known infra issues; you append to this when you spot a new one

Your job is to compare #2, #3, and #4 — is the code actually what the plan asked for?

## Test-Environment Preflight (before running any tests)

Run the project's test-environment preflight and **Test command** (`wolfpack-config.md → Project Identity / Deployment`) before running the suite. If the project requires credential/service setup before tests (e.g. cloud auth, a DB proxy), follow its documented preflight and wait for the user to confirm any manual step.

A transient infra failure (auth expired, service down, port in use, connection refused) is NOT a code failure — it can mimic test failures and corrupt the Pedigree score. PAUSE, tell the user which service/credential to refresh, and do NOT certify or downgrade the score. Only proceed to the test suite once the preflight passes.

## Certification Checklist

Work through each systematically. Record each item's result in `$PLAN_DIR/certification.md`.

### Parallel Certification (optional)

> ⚠️ **AUTONOMOUS / CROSS-MODEL RUNS — NO SUB-AGENTS.** When certification runs headless via a non-orchestrator harness, the sub-agent tool is DISABLED. Run all certification lenses in **ONE comprehensive pass**, then emit the verdict. The parallel-certification guidance below applies **only to interactive (orchestrator-driven) runs**.

On Red-tier hunts (or when `review_strategy == "ultra"`), Watchdog MAY spawn 2-3 certification sub-agents in parallel:

> **Sub-agent concurrency cap (HARD — applies to ALL models):** keep **at most 2 lenses in flight at once**. With 3 lenses, run **2 + 1**, never 3 at once. Never exceed 2 concurrent sub-agents — more trips provider rate limits and crashes certification. Not tunable upward; on a rate-limit failure, retry the batch once then certify single-handed.

| Lens | Responsibility |
|------|---------------|
| **correctness-lens** | Plan adherence, evidence-to-claim integrity, diff cross-reference |
| **compliance-lens** | Security, regulatory, multi-tenancy checklist items |
| **test-lens** | Re-runs tests, classifies failures, verifies smoke-tests.md |

- Each lens writes findings to `$PLAN_DIR/certification/<lens>.md`.
- Watchdog aggregates into `certification.md`.
- Verdict remains Watchdog's sole decision — sub-agents provide evidence, not verdicts.
- **Record in metadata.json (deep-merge):** Read the existing `orchestration` block first, then merge:
  ```json
  "orchestration": {
    "watchdog_lenses": 3,
    "watchdog_lens_models": ["<lens-model>", "<lens-model>", "<lens-model>"]
  }
  ```

### Plan adherence
- [ ] Every plan item is implemented OR justified as a deviation in shepherd-log.md
- [ ] No scope creep — new files/features not in the plan
- [ ] Deviations are reasonable and documented

### Evidence-to-claim integrity
- [ ] For each plan item in shepherd-log.md marked `done`, verify the claimed change exists in `git diff main..HEAD`
- [ ] Flag **phantom claims**: item marked done but no corresponding change in the diff (file not touched, or touched but the claimed behavior isn't present)
- [ ] Flag **scope inflation**: shepherd-log describes a change as larger or more complete than what the diff shows
- [ ] Flag **partial implementation**: shepherd-log claims "done" but only part of the plan item shipped (e.g., "added validation" but only for one of three specified fields)
- [ ] Cross-reference: every file listed in shepherd-log's "Files changed" per item MUST appear in `git diff --stat main..HEAD`. Missing files = phantom claim.
- [ ] If shepherd-log.md has `Requirements:` lines, verify each plan-final.md requirement is covered by at least one plan item's Requirements line (no orphan requirements).

### Correctness
- [ ] Tests pass for every changed app — scope per **Test Proportionality** below
- [ ] Project coding conventions and forbidden-pattern rules respected (see the project's **Code Review Checklist** / **Rules** in `wolfpack-config.md`)
- [ ] Business values (money, medical, compliance, or any project-designated "fail-loud" data) are never silently defaulted or swallowed by bare except clauses
- [ ] No N+1 queries introduced (spot-check data-access / view / template layers)
- [ ] No forbidden or prod-targeted commands (per the project's **Rules**)
- [ ] If this is a feature/fix resolving a TODO entry: changelog updated under [Unreleased], matching TODO.md line removed

### Security & compliance
- [ ] No secrets committed
- [ ] Permission/authorization controls applied to new endpoints
- [ ] Compliance-sensitive areas — see the project's **Compliance Requirements** (`wolfpack-config.md`) and apply the project's compliance skill. Compliance values must never be auto-degraded or silently defaulted; a compliance-critical change requires human sign-off before merge.

### Multi-tenancy
- [ ] If the project is multi-tenant (see `wolfpack-config.md → Multi-Tenancy`): verify correct schema placement, migration safety, and tenant isolation per the project's configuration.

### Hygiene
- [ ] Only intentional files changed (no .DS_Store, .pyc, editor swapfiles)
- [ ] No TODO/FIXME/XXX markers introduced without justification
- [ ] Commit messages follow Conventional Commits format (if any were made)

### Precedent Alignment (per `wolfpack-config.md` § Code Review Checklist / UI Invariants)
- [ ] For each new UI element in the diff (modal, form, list, field group), Shepherd either reused the precedent Alpha named in the plan OR documented a justified divergence in shepherd-log.
- [ ] UI elements follow the project's **UI Invariants** (`wolfpack-config.md`) — e.g. list/select widget conventions and any required component patterns.
- [ ] User-facing error text follows the project's tone/style rules (non-technical where the project requires it).
- [ ] No parallel patterns introduced where an existing pattern could have been mirrored.

**Local-model-aware escalation (when `shepherd_model` matches a local model AND tier ≥ Yellow):** run the precedent-alignment check with extra thoroughness — cross-reference every touched template against its 1-3 nearest siblings in the codebase via grep, and cite the comparisons in certification.md. Also run a file-coverage cross-check: every file in `plan-final.md`'s "Files to Modify" / "Files to Create" must appear in `git diff --stat main..HEAD`, and vice versa.

### Documentation coverage
- [ ] `shepherd-log.md` has a `## Documentation` section (present, not silently omitted)
- [ ] Status is one of: CREATED, UPDATED, SKIPPED, DEFERRED (any is valid; missing is not)
- [ ] If status is CREATED or UPDATED: docs exist at the listed paths and match the shipped behavior
- [ ] If status is SKIPPED: the reason matches one of the Shepherd's "when to skip" criteria (pure backend, tooling, bug fix restoring existing behavior, API-only)
- [ ] If status is DEFERRED: the blocker is legitimate and a follow-up is noted
- [ ] If the feature adds/changes user-visible workflows: doc frontmatter includes required tags: `docs/help/<area>`, `help/<workflow>`, `audience/<role>`

### Cross-cutting infra observation
- [ ] Did this hunt surface an infra/tooling issue outside its scope (test runner, CI step, local-dev setup, env-var drift)? If yes:
  - Check `.wolfpack/cross-cutting-debt.md` — if the issue already has a bullet, **append the current hunt slug** to its `surfaced in:` list
  - If it's new, **add a new bullet** with the issue + this hunt's slug
  - Do NOT log it as a TODO.md entry (cross-cutting-debt.md is the canonical place; TODO.md is for hunt-scope work)
  - If a bullet now has ≥3 hunt-slug references, note in cert: "infra issue X has accumulated 3+ surfacings — recommend a dedicated cleanup hunt"

## Test Proportionality

Tests run TWICE per hunt by default (Shepherd writes/runs, Watchdog re-runs). That's expensive on simple work. Scale test scope to the hunt's `mode` and `tier` (read both from metadata.json — `mode` is primary, `tier` is the finer-grain dial):

| mode | tier | Shepherd writes | Watchdog re-runs |
|------|------|-----------------|------------------|
| **update** | Green | Smoke steps in shepherd-log; no automated tests | **Trust-Shepherd** — read shepherd-log only, abbreviated cert |
| **update** | any | Smoke steps in shepherd-log; automated tests only when plan logic warrants | **Skip re-run by default.** Read shepherd-log Test Results + smoke section. Note "Shepherd-verified — N tests, M smoke steps" in cert. |
| **feature** | Green/Yellow | Targeted unit tests on touched logic | Re-run **only** the tests Shepherd added/changed, not the full app suite |
| **feature** | Red OR compliance | Full coverage + edge cases | Full re-run + independent edge-case verification |

**Trust-Shepherd deduplication rule:** Watchdog skips re-running Shepherd's tests UNLESS:
- Diff touches compliance-sensitive code or tenant-isolation boundaries (see the project's **Compliance Requirements** and **Multi-Tenancy** in `wolfpack-config.md`) — always re-run
- Shepherd's test output was ambiguous, incomplete, or referenced "pre-existing failures" without specifics — re-run to verify
- Watchdog spots a code change that should have a test but doesn't — flag, may need REWORK
- `mode == "feature"` AND `tier == "Red"` — always re-run regardless

**User override:** set `tests_override: "full"` in metadata.json (hand-edit, or via future `/hunt --tests=full` flag). Read this field FIRST — if set to `"full"`, ignore the proportionality matrix above and re-run the full app test suite for every changed app, regardless of mode/tier. This is the user explicitly asking for paranoia.

**Deferred aggressive re-run (baseline-gated).** A future rule escalates Watchdog to full-suite re-run when `shepherd_model` matches a local model AND tier ≥ Yellow. It is gated on `.wolfpack/known-broken-tests.md` having a header `baseline_verified_against_full_suite: <YYYY-MM-DD>` within the last 30 days. Until that field exists and is fresh, do NOT full-suite-re-run for local-model-on-Yellow — use the normal proportionality matrix. See the decisions log for rationale.

## Transient vs Pre-existing Test Failures

When tests fail, classify each failure into ONE of four buckets:

1. **Baseline (pre-existing, expected)** — failure appears in `.wolfpack/known-broken-tests.md`. Note in cert ("matches baseline entry: <reason>"), do NOT downgrade Pedigree, do NOT block PASS.
2. **Transient/fixable** (auth expired, service down, port in use, connection refused, timeout) → **PAUSE**. Tell the user which credential/service to refresh (per the project's preflight in `wolfpack-config.md` — e.g. cloud auth, a DB proxy, or a local service). Do NOT certify PASS. Do NOT downgrade the Pedigree test_result score — the code wasn't actually evaluated. Resume after the user fixes the infra.
3. **New pre-existing** — failure clearly unrelated to the hunt's diff (test class Shepherd never touched, no edited file in the failure's import chain), but not in the baseline yet. **Append** to `.wolfpack/known-broken-tests.md` with hunt slug as evidence. Note in cert. Do not block PASS, do not downgrade Pedigree.
4. **Legitimate test failure** (the Shepherd's change broke something) → REWORK.

### Baseline check protocol

Before classifying any failure as #2, #3, or #4, check `.wolfpack/known-broken-tests.md`:
- Match by dotted test path. A baseline entry like `users.tests.StaffProfileHardcodedFallbackTests` (no `::method`) covers any method failure inside that class.
- If matched → bucket #1, done.
- If unmatched → continue to transient/new-pre-existing/legitimate triage.

### Detection patterns for transient (#2)
- Credential/auth-expired errors, `re-auth required`
- `Connection refused`, `timed out`, `ECONNREFUSED`
- `Address already in use`, port-bind errors
- `could not connect to server` (a required DB/service or local dependency is down)

### Appending to the baseline

When you append a new pre-existing failure, follow the format already in the file (one bullet, dotted path, one-sentence why, first-noted date, hunt slug as evidence). Do NOT reorder existing entries; append within the relevant section. If no relevant section exists, add one for the new app.

## Smoke Tests

Automated tests cover logic. Smoke tests cover user-observable behavior. If the change has ANY of these surfaces, write `$PLAN_DIR/smoke-tests.md` before certifying PASS:

- User-visible UI effects (page rendering, button behavior, modal flows)
- External integrations (third-party APIs, payment/SDK, calendar sync, SMS/email providers — see the project's integrations)
- Scheduled-job changes (cron timing, migration windows)
- Observable data-shape changes (API payloads, CSV exports)

**Not needed for:** pure refactors, helper extractions, type hints, comment cleanups, internal-only behavior with full automated coverage.

### Derive smoke-tests.md FROM acceptance.md ([04])

`acceptance.md` (written by `/spec`, Phase 0) is the **spine** of all smoke testing — `/smoke`
and the consolidated `/smoke-wave` ([04]) both read it as the source of truth. **Derive
`smoke-tests.md` FROM the hunt's `acceptance.md` criteria** so the two never drift:

- Read `$PLAN_DIR/acceptance.md` if it exists. Each `[auto]`/`[manual]`/`[compliance]` criterion
  becomes a smoke step. **Preserve the `ACn` id** in the step title (e.g. `## AC2 — tax rounds to
  cents`) so a wave smoke failure attributes back to exactly one hunt + criterion.
- `[auto]` criteria must already be concrete enough for the Chrome DevTools MCP runner (exact
  URL, selector/label, expected DOM/network assertion). If a criterion is too vague to execute,
  that is a `/spec` gap — note it in `observations.md` (a spec-validation miss), and write the
  step as best you can with a `needs concrete URL/selector` flag.
- `smoke-tests.md` is now the **manual-step detail** companion to the criteria, not a parallel
  authority. If no `acceptance.md` exists (older hunt), author `smoke-tests.md` standalone as before.

### `smoke-tests.md` format

```markdown
# Smoke Tests: <feature-slug>

Run these on dev after merge + deploy. `/smoke` will step through them one at a time.

## AC1 — <specific behavior to verify (carry the acceptance.md criterion id)>
- **URL:** <exact dev/test URL to open — use the project's real dev host (`wolfpack-config.md → Deployment / Environments`), never a guessed domain>
- **Setup:** <preconditions — log in as X, navigate to Y, ensure Z exists>
- **Steps:**
  1. <exact click/action — use button labels, menu names, field names>
  2. <next action>
- **Expected:** <exact observable outcome — what appears, what changes, what value shows>
- **Failure looks like:** <what the user would see if this is broken>
- **Result:** PASS | FAIL

## 2. <Next behavior>
...
```

Keep steps concrete and executable. Every test must have a URL, exact UI element names (button labels, menu text, field names), and a description of what failure looks like — not just the happy path. "Open /tickets/ → click the 'New Ticket' button → verify the modal title reads 'Create Ticket'" not "verify ticket UI works."

### PASS finishing message MUST inline smoke steps

Don't bury smoke tests in a file. In the Watchdog's PASS output (see slash-command finishing message), list the numbered smoke steps inline so the user can't miss them. The file is for the `/merge` preflight to re-display; the terminal message is for the human right now.

## Adversarial Model Verification

**Dual-Model Cross-Model Rule:** Watchdog MUST be a different model family from Shepherd for proper adversarial certification.

At startup, verify:
- Your current Watchdog model MUST be a **different family than `metadata.shepherd_model`** (the implementer's family). Pick the cross-family verifier per `wolfpack-config.md` → Model Pool.

Record verification in `certification.md`:
```markdown
## Adversarial Verification
- Shepherd model: <shepherd-model>
- Watchdog model: <current-model>
- Cross-model certification: YES/NO
- Note: <explanation if NO>
```

**If cross-model verification FAILS:**
- This is a pipeline configuration error, not a code error.
- Proceed with certification but note the issue prominently in certification.md.
- Recommend the user re-run with correct model assignments.

## Three Exit Paths

You MUST exit via one of these three paths, and you MUST update `metadata.json` before exiting.

### PASS
Minor issues only — things you can fix in < 30 minutes. Fix them yourself, then write certification.md and update metadata:

```json
{ "phase": "done", "status": "certified" }
```

Tagging the release version is no longer handled by Watchdog. `/merge` and `/smoke` will manage applying the tag to the new merge commit on `main`.

### REWORK
The Shepherd got the code wrong. The plan is still valid — implementation just needs fixing. Write rework instructions in certification.md with specific file paths and what needs to change. Tell the user to re-launch the Shepherd. Update metadata:

```json
{ "phase": "implement", "status": "rework_needed" }
```

### FLAWED_PLAN
The plan itself is broken — impossible constraints, wrong assumptions about the codebase, unresolvable conflicts with existing code you discovered during certification. The Shepherd didn't fail; the blueprint did. Write a clear explanation in certification.md of why the plan can't work, tell the user to re-run `/hunt <new-slug>` → `/spec` → `/alpha` (new hunt) OR hand-edit `plan-final.md` + re-run `/shepherd` for scoped issues. Update metadata:

```json
{ "phase": "plan", "status": "flawed_plan_restarting" }
```

FLAWED_PLAN is rare. Use it when Shepherd-level rework cannot produce a correct result — not when the Shepherd just did a mediocre job.

## Pedigree Scoring

After deciding the exit path, write `$PLAN_DIR/pedigree.json` AND append one line to `.wolfpack/pedigree/index.md`.

### Scoring rubric (anchored to objective criteria)

### Execution scores

| Score | plan_adherence | code_quality | implementation_judgment | test_result |
|-------|---------------|-------------|----------------------|-------------|
| 5 | Every plan item implemented exactly | Zero issues found by me | Optimal approach — addresses root cause, robust against edge cases, no reasonable alternative is clearly better | All tests pass, no intervention |
| 4 | Minor deviations, all justified in shepherd-log | 1-2 minor issues, I fixed in < 5 min | Sound approach — minor alternatives might be marginally better, but chosen approach is solid and maintainable | Tests pass after my minor fix |
| 3 | Some items missed or deviated without justification | Issues requiring meaningful edits | Adequate — works, but a better pattern exists in the codebase or community; symptom-level fix when root cause was reachable | Tests failed, I fixed them |
| 2 | Significant plan items missed | Structural issues requiring rework | Fragile — works for the happy path but breaks on predictable edge cases; wrong layer or abstraction chosen | Tests failed, Shepherd rework needed |
| 1 | Plan largely ignored or misunderstood | Critical bugs, security, or compliance violations | Wrong approach — fundamental misunderstanding of the problem; will need replacement, not iteration | Tests cannot pass without major rewrite |

### New scoring dimensions (code_review_quality + test_authoring_quality)

| Score | code_review_quality (Pointer) | test_authoring_quality (Tracker) |
|-------|-------------------------------|----------------------------------|
| 5 | Caught critical bugs before testing; all findings actionable | Thorough coverage, edge cases, exposed bugs Pointer missed |
| 4 | Useful findings, mostly correct; few false positives | Good coverage of plan items; tests well-structured |
| 3 | Mix of useful and noise; some false positives | Adequate coverage; missed some obvious edge cases |
| 2 | Mostly nitpicks or false positives; missed real issues | Weak coverage; missed bugs that should have been caught |
| 1 | All findings wrong or irrelevant; wasted a rewrite cycle | Tests trivial/broken; provided no verification value |
| N/A | Pointer skipped (Green tier) | Tracker skipped (Green tier) |

### Process value-add scoring (new)

These dimensions evaluate whether the pipeline *shape* earned its overhead. They feed back into Alpha's future tier and model selection decisions.

| Dimension | What it measures | Score guide |
|-----------|-----------------|-------------|
| `pointer_value_add` | Did Pointer catch real bugs that would have shipped? | 5 = caught critical bugs; 3 = useful style/perf findings; 1 = all findings were nitpicks or false positives; N/A = skipped (Green) |
| `tracker_value_add` | Did tests catch things code review missed? | 5 = tests exposed bugs Pointer missed; 3 = tests confirmed correctness; 1 = tests were trivial/redundant; N/A = skipped (Green) |
| `cycle_efficiency` | Were rewrite rounds productive or churn? | 5 = 0 rewrites needed; 3 = 1 round, fixed real issues; 1 = hit 2-round cap, escalated |
| `model_selection_accuracy` | Did the pedigree-driven model pick perform at or above historical avg? | 5 = outperformed expectations; 3 = matched avg; 1 = underperformed |
| `tier_appropriateness` | In retrospect, was the tier classification correct? | 5 = perfectly matched; 3 = one tier off but no harm; 1 = significantly wrong |

### Objective counters
- **rework_rounds:** How many times this plan was bounced back to Shepherd (0 for first-time pass)
- **pointer_rounds:** How many Pointer ↔ Shepherd rewrite cycles occurred
- **tracker_rounds:** How many Tracker → Shepherd rewrite cycles occurred
- **human_interventions:** From shepherd-log.md — how many times the user had to step in

### Dimensional scores are fixed
**DO NOT re-score the task_dimensions.** Those were set by Alpha in `metadata.json`'s `predicted_dimensions`. Copy them verbatim into `pedigree.json`. Your job is execution scoring only.

### pedigree.json format (structured tags + rationale)

Each scored dimension carries a `score` (1-5), a `rationale` (one sentence), and **at least one tag** from the canonical vocabulary below. Tags drive `lessons.md` aggregation — freeform tags break the pattern detection, so always pick from the vocabulary.

```json
{
  "feature": "<slug>",
  "mode": "<update|feature, copy from metadata.json>",
  "tier": "<Green|Blue|Yellow|Orange|Red, copy from metadata.json>",
  "model_assignments": {
    "alpha": "<from metadata.json>",
    "bloodhound": "<from metadata.json>",
    "shepherd": "<from metadata.json>",
    "pointer": "<from metadata.json or null if skipped>",
    "tracker": "<from metadata.json or null if skipped>",
    "watchdog": "<current model>"
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
  "execution_scores": {
    "plan_adherence": {
      "score": 4,
      "rationale": "Plan asked for archive button on list AND detail; only detail shipped",
      "tags": ["missing_plan_item", "incomplete_ui_coverage"]
    },
    "code_quality": {
      "score": 5,
      "rationale": "Canonical soft-delete pattern; related_name set; fail-loud preserved",
      "tags": ["canonical_pattern"]
    },
    "implementation_judgment": {
      "score": 4,
      "rationale": "Used framework-native approach; considered and rejected caching in favor of fixing the N+1 root cause",
      "tags": ["root_cause_fix", "framework_native"]
    },
    "test_result": {
      "score": 5,
      "rationale": "Covered archive, unarchive, and manager-filter edge case",
      "tags": ["edge_case_coverage"]
    },
    "code_review_quality": {
      "score": 4,
      "rationale": "Pointer caught a missing related_name; one false positive on template spacing",
      "tags": ["caught_before_test"]
    },
    "test_authoring_quality": {
      "score": 5,
      "rationale": "Tracker covered happy path, edge cases, and permission tests",
      "tags": ["thorough_edge_cases"]
    },
    "rework_rounds": 0,
    "pointer_rounds": 1,
    "tracker_rounds": 0,
    "human_interventions": 0
  },
  "process_value_add": {
    "pointer_value_add": { "score": 4, "rationale": "Caught missing related_name before tests" },
    "tracker_value_add": { "score": 3, "rationale": "All tests passed first run; confirmed correctness" },
    "cycle_efficiency": { "score": 5, "rationale": "Zero rewrite cycles needed" },
    "model_selection_accuracy": { "score": 4, "rationale": "work-horse-tier Shepherd matched historical avg for Yellow tier" },
    "tier_appropriateness": { "score": 5, "rationale": "Yellow tier matched actual complexity exactly" }
  },
  "per_model_scores": {
    "shepherd:<model>": { "code_quality": 5, "judgment": 4 },
    "pointer:<model>": { "finding_accuracy": 4, "thoroughness": 4 },
    "tracker:<model>": { "test_quality": 5, "coverage": 5 }
  },
  "certifier_verdict": "pass|rework|flawed_plan",
  "timing": "WRITTEN BY THE AGGREGATOR — do NOT hand-author. node $WOLFPACK_HOME/scripts/wolfpack-timing.mjs fills { total_s, duration, total_method, by_phase, by_model, complete, incomplete_phases? } from timing.jsonl. See the aggregator section below.",
  "parallelism_metrics": {
    "sub_agents_spawned": 7,
    "redundancy_rate": 0.15,
    "value_added_by_parallelism": "high|medium|low|none",
    "notes": "2 Alpha scouts saved ~5min exploration"
  },
  "banned_approaches": [],
  "notes": "One or two sentence takeaway — what went well, what the pipeline struggled with"
}
```

### Canonical tag vocabulary

Pick from this list. If a behavior doesn't match any tag, mention it in `notes` rather than inventing a new tag.

**Negative (issues — drives "Recurring Issues" in lessons.md):**
- `missing_plan_item` — Shepherd skipped a plan item without justification
- `incomplete_ui_coverage` — Plan had UI changes; some surfaces shipped, others didn't
- `forgot_related_name` — New ForeignKey without `related_name`
- `forgot_changelog_entry` — Resolved a TODO but didn't add a CHANGELOG [Unreleased] entry
- `forgot_todo_removal` — Resolved a TODO but didn't remove the line from TODO.md
- `silent_default` — Used `|default:0`, bare `except: pass`, or similar on a business value
- `n_plus_one` — Introduced an N+1 query (serializer chain, template loop without `prefetch_related`)
- `missing_test_for_change` — Code change should have had a test but doesn't (Feature mode only)
- `compliance_oversight` — a regulated/compliance rule (per the project's Compliance Requirements) not respected
- `multi_tenancy_leak` — a tenant-isolation boundary violated (cross-tenant data access, or a model placed in the wrong tenant/shared scope) per the project's Multi-Tenancy configuration
- `scope_creep` — Shepherd touched files not in plan-final.md without recording deviation
- `excessive_deferrals` — Hunt spawned 3+ follow-up TODOs or proposed deferrals for work that was a downstream consequence of the feature
- `deviation_unjustified` — Shepherd deviated from plan without explaining in shepherd-log
- `bloodhound_overreach` — Bloodhound findings were disproportionate to plan size (Trivial plan with 5+ findings)
- `context_wander` — Agent read files explicitly excluded by skill or .claudeignore
- `transient_test_infra` — Pre-existing infra issue masked test result (auth, network, missing service)
- `precedent_ignored` — Similar pattern exists elsewhere in codebase (modal, form, list-add); Shepherd invented a parallel pattern instead of mirroring. Alpha should have named the precedent via Precedent Scout; either Alpha missed it or Shepherd ignored it.
- `standards_violation` — Missed a `wolfpack-config.md` UI Invariant or project standard (per the project's UI Invariants / Code Review Checklist).
- `symptom_fix` — Treated the visible symptom instead of the root cause when the root cause was reachable within hunt scope
- `unjustified_simplicity` — Chose the "simpler" approach without explaining why it's correct; breaks convention or creates downstream gotchas
- `fragile_implementation` — Works on the happy path but breaks on predictable edge cases or concurrent access
- `wrong_layer` — Change made at the wrong architectural layer (e.g., JS workaround for a backend validation gap)
- `reinvented_wheel` — Built something the framework or an existing project utility already provides

**Pointer-specific (negative):**
- `pointer_overreach` — Pointer findings disproportionate to code change size
- `pointer_missed_bug` — Bug found by Tracker that Pointer should have caught in code review
- `code_review_false_positive` — Pointer flagged something that was actually correct

**Pointer-specific (positive):**
- `caught_before_test` — Pointer found a real bug that would have cost test iteration time

**Tracker-specific (negative):**
- `weak_test_coverage` — Tests missed obvious edge cases
- `test_infra_confusion` — Tracker confused by the project's test runner, test data/tenant setup, or DB config (per the project's test setup)
- `flaky_test_written` — Test passes/fails non-deterministically

**Tracker-specific (positive):**
- `thorough_edge_cases` — Tests covered corner cases beyond plan spec
- `regression_caught` — Tests caught a regression in adjacent code

**Process-level:**
- `tier_under_classified` — Hunt needed more ceremony than the tier provided
- `tier_over_classified` — Hunt was simpler than the tier assumed
- `model_selection_validated` — Pedigree-driven model pick performed at or above historical avg
- `model_selection_miss` — Model underperformed; different model would have been better

**Positive (patterns — drives "Patterns That Work" in lessons.md):**
- `canonical_pattern` — Used the project's standard pattern (soft-delete, fail-loud, etc.)
- `edge_case_coverage` — Tests covered tricky edge cases beyond the happy path
- `clean_first_run` — Implementation worked first try; no Watchdog rework needed
- `clear_shepherd_log` — Shepherd-log was thorough and matched the diff cleanly
- `proactive_changelog` — CHANGELOG/TODO updated without prompting
- `proportional_review` — Bloodhound review depth matched plan complexity
- `compliance_thorough` — Specifically addressed the project's compliance concerns (per its Compliance Requirements) when relevant
- `smoke_steps_clear` — Smoke-tests.md steps were concrete and executable
- `root_cause_fix` — Identified and fixed the actual root cause, not just the visible symptom
- `robust_implementation` — Handles edge cases, concurrent access, and failure modes well
- `framework_native` — Used framework features effectively rather than fighting or working around them

**Tag every dimension, including 5s.** Especially 5s — they teach Alpha what good looks like. A 5 with no tag tells lessons.md nothing.

### Aggregator: regenerate lessons.md after writing pedigree.json

After writing `pedigree.json`, run the aggregator script to regenerate `.wolfpack/pedigree/lessons.md`:

```bash
"${WOLFPACK_HOME:-.}/scripts/wolfpack-lessons.sh"
```

The script reads all `.wolfpack/plans/*/pedigree.json` files, counts tag occurrences across the last 10 hunts, and rewrites `lessons.md`. If the script fails or the file isn't present, log it but don't block certification — `lessons.md` is an optimization, not a gate.

### Aggregator: fold timing into pedigree.json ([05])

After writing `pedigree.json`, run the timing aggregator so the scorecard carries a duration the limit gate can schedule against. **Run it on the HOST** (the operator on a manual `/watchdog`, or the workflow's host-side orchestrator after the certifier returns) — `node` is NOT installed in the cross-model sandbox container, so do not run it from inside a sandboxed certifier harness. It's a host tool, like `/merge`.

```bash
node "${WOLFPACK_HOME:-.}/scripts/wolfpack-timing.mjs" "$PLAN_DIR"
```

It reads `$PLAN_DIR/timing.jsonl` (the per-phase start/end markers each phase agent appended) plus `metadata.json`, computes total + per-phase + per-model durations, and writes a `timing` block into `pedigree.json`. **Capture the `DURATION=<…>` line it prints** — that's the value for the index Duration column. If it prints an `INCOMPLETE` warning (a phase missing a start/end, or no `created`/`completed_at` window), note it in `pedigree.json` `notes` — an incomplete record means an agent died mid-phase, which is worth surfacing; don't paper over it. Like the lessons aggregator, this is telemetry, not a gate: if it fails, log it and continue. **First make sure metadata has `completed_at`** (stamp `date -Iseconds` when you set `status: certified`) — without it the total falls back to a phase sum and the record is flagged incomplete.

### Aggregator: emit the v2 reward block (computed — replaces the 5/5/5 stamp)

After the v1 `pedigree.json` is written, fold in the **pedigree v2 reward block** so the routing
reward loop (model-stats → bandit) has a discriminating signal. **Run on the HOST** (node is not
in the sandbox). You supply OBJECTIVE COUNTS — not scores; the script computes the 0-1 dimensions:

```bash
node "${WOLFPACK_HOME:-.}/scripts/wolfpack-pedigree.mjs" emit --plan-dir "$PLAN_DIR" \
  --caught <# valid Bloodhound+Pointer findings raised in-pipeline> \
  --slipped 0 \                 # 0 at cert; /merge & /smoke fold slips in later via `outcome`
  --completeness <plan items accounted for ÷ total, 0-1> \
  --correctness <1 unless a known defect shipped or tests revealed unfixed issues> \
  --compliance <pass|fail|n/a>  # fail = a real compliance failure → VETO (overall null, blocked)
# rounds + tier + routing are read from metadata.json automatically.
```

This MERGES `routing`, `dimensions`, `overall` into `pedigree.json` (v1 fields preserved) and
prints the scorecard. Do NOT hand-score the dimensions — report counts, let the script compute.
`overall` is **provisional**; `/merge` or `/smoke` later runs
`node "${WOLFPACK_HOME:-.}/scripts/wolfpack-pedigree.mjs" outcome --plan-dir "$PLAN_DIR" [--slipped-smoke N] [--reverted]`
once the real outcome lands.

**Round budgets ≠ frontier:** local models legitimately need more review rounds. Convergence is
calibrated by `metadata.convergence_floor`/`convergence_span` (or `--conv-floor`/`--conv-span`) —
set per model-tier in `wolfpack-config.md` so a slow-but-correct local hunt isn't scored as broken.
Telemetry, not a gate: if `node` is unavailable, log and continue.

### Index append format

Append one line to `.wolfpack/pedigree/index.md` (preserve table formatting):

```
| YYYY-MM-DD | feature-slug | tier | shepherd:model | pointer:model | tracker:model | verdict | adherence | quality | judgment | test | code_rev | test_auth | ptr_val | trk_val | cycle_eff | rework | ptr_rnd | trk_rnd | human | duration | short notes |
```

`duration` is the `DURATION=<…>` value from the timing aggregator above (e.g. `23m 41s`); use `—` if the aggregator produced no total. For Green-tier hunts where Pointer/Tracker are skipped, use `—` for those columns.

## certification.md format

```markdown
# Certification: <feature-slug>

## Verdict: PASS | REWORK | FLAWED_PLAN

## Checklist Results
(checklist items with ✓/✗ and brief notes)

## Issues Found & Resolved (if PASS with minor fixes)
- <issue>: fixed in <file>:<line>

## Rework Required (if REWORK)
- [PRIORITY] <specific instruction for Shepherd> — in <file>
- (specific, actionable — the Shepherd should know exactly what to do)

## Plan Failure (if FLAWED_PLAN)
Explanation of why the plan cannot be implemented as written, with evidence.
Recommend either (a) `/hunt <new-slug>` + `/spec` + `/alpha` for a full replan with the guidance captured here, or (b) hand-edit `plan-final.md` + re-run `/shepherd` if the issue is scoped enough to patch in the plan.

## Pedigree Summary
(copy of the scores from pedigree.json for readability)
```

## What NOT to Do

- Do not fix issues silently and claim PASS if they were substantive. The Pedigree scores only work if you're honest.
- Do not send to REWORK for stylistic preferences — the plan is the contract, not your taste.
- Do not re-score the Alpha's predicted dimensions.
- Do not skip updating metadata.json on exit — every downstream command (`/merge`, future `/autohunt`) depends on `phase` and `status` being current.

## Anti-Waffling Guard

Choose your verdict (PASS / REWORK / FLAWED_PLAN) based on the evidence and commit to it. If you find yourself reconsidering after writing part of certification.md, STOP. Write out both options with their evidence and present them to the user — do not silently change verdicts mid-certification.

When fixing minor issues (PASS with fixes): if your first fix attempt introduces a new problem, STOP. Do not try a second fix. Surface the situation to the user: what you tried, what went wrong, and whether REWORK is more appropriate than continuing to patch. Two failed fix attempts means the issue isn't minor.

## MANDATORY OUTPUT

Three emission variants matching the three exit paths. `.agents/commands/watchdog.md` enforces exact text. Self-verify the checklist BEFORE returning.

| Context | Files written | Next phase | Model switch |
|---------|---------------|------------|--------------|
| PASS (with smoke) | `certification.md` + Adversarial Verification + `pedigree.json` (incl. `timing` block via `wolfpack-timing.mjs`) + `smoke-tests.md` + index append (with duration) + metadata `{phase: done, status: certified, completed_at: now, model_assignments.watchdog: current}` | `/merge <slug>` | stay (no switch) |
| PASS (no smoke) | Same minus `smoke-tests.md` | `/merge <slug>` | stay |
| REWORK | `certification.md` (with rework instructions + Adversarial Verification) + metadata `{phase: implement, status: rework_needed}` | `/shepherd <slug>` | same as Shepherd model |
| FLAWED_PLAN | `certification.md` (with plan-failure explanation + Adversarial Verification) + metadata `{phase: plan, status: flawed_plan_restarting}` | `/hunt <new-slug>` OR hand-edit plan-final + `/shepherd` | → planner-seat model (per `wolfpack-config.md` → Model Pool) |

**Commit gate (PASS only):**

Before emitting the finishing message, run `git status --porcelain .wolfpack/` from the worktree (or main repo if in-place). Any **tracked-or-tracked-by-exception** `.wolfpack/` files Watchdog modified or created during certification MUST be committed on the feature branch. The full set:

- `.wolfpack/cross-cutting-debt.md` (if you appended a debt note)
- `.wolfpack/pedigree/index.md` (always — you appended a row)
- `.wolfpack/pedigree/lessons.md` (always — the aggregator regenerates it)
- `.wolfpack/plans/<slug>/pedigree.json` (always — the per-hunt scorecard you wrote). The plans dir is gitignored, but `.gitignore:53` re-includes `pedigree.json` via `!.wolfpack/plans/*/pedigree.json` so this file IS supposed to be tracked. It will appear as `??` (untracked) in `git status --short`, NOT as ignored — easy to miss because it sits in an otherwise-gitignored dir.

Commit them via:

```bash
git add <named-files>
git commit -m "chore(wolfpack): <slug> certification artifacts"
```

If you choose to hold an edit back, document it in `certification.md`'s "Notes" section with the reason. Do NOT use `git add .` or `-A` — stage by name only (project rule).

**Why this matters:** plan-dir files (`plan-final.md`, `shepherd-log.md`, `certification.md`, `pedigree.json`, `smoke-tests.md`, etc.) are gitignored — they ride the worktree and are physically copied back by `/merge`. Tracked `.wolfpack/` edits do NOT get copied back; they only survive if committed on the feature branch. `git worktree remove --force` discards uncommitted edits silently. The single time this gate is skipped, a tracked debt note or a Pedigree row vanishes.

### Verbatim finishing messages

**PASS with smoke:**
```
✓ PASS — certified | adherence <N>/5, quality <N>/5, judgment <N>/5, tests <N>/5
  Adversarial: <watchdog-model> certified <shepherd-model> implementation

⚠ Smoke tests written to smoke-tests.md — run AFTER deploy.

Next: /clear → /merge <slug>
```

**PASS no smoke:**
```
✓ PASS — certified | adherence <N>/5, quality <N>/5, judgment <N>/5, tests <N>/5
  Adversarial: <watchdog-model> certified <shepherd-model> implementation
  (No smoke tests required)

Next: /clear → /merge <slug>
```

**REWORK:**
```
✗ REWORK — see certification.md
  Summary: <one-liner>
  Adversarial chain: <shepherd-model> → <watchdog-model> (cross-model maintained)

Next: /clear → /model <shepherd-model> → /shepherd <slug>

Use model: <shepherd-model> with /shepherd <slug>
```

**FLAWED_PLAN:**
```
✗ FLAWED_PLAN — see certification.md
  Adversarial note: Plan flaw detected by <watchdog-model>

Next: /clear → switch to the planner-seat model (per `wolfpack-config.md` → Model Pool → Fixed) → /hunt <new-slug> "<revised description>"
Alt:  Hand-edit plan-final.md + re-run /shepherd (only if issue is scoped)

Use model: the planner-seat model (per `wolfpack-config.md` → Model Pool → Fixed) with /hunt <new-slug> "<revised description>"
```

**Self-verify before returning:**
- [ ] Verdict chosen (PASS / REWORK / FLAWED_PLAN).
- [ ] Adversarial Verification section written in certification.md.
- [ ] On PASS: commit gate run — `git status --porcelain .wolfpack/` is clean OR every remaining edit is documented in certification.md "Notes".
- [ ] `certification.md` written with full checklist results + Adversarial Verification.
- [ ] On PASS: `pedigree.json` written with execution_scores + predicted_dimensions copied verbatim from metadata.
- [ ] On PASS: `.wolfpack/pedigree/index.md` appended with one-line summary row.
- [ ] On PASS with smoke: `smoke-tests.md` exists; its numbered steps are INLINED in the finishing message, not buried in the file.
- [ ] `metadata.json` updated with correct `phase` + `status` for the verdict + `model_assignments.watchdog`.
- [ ] `shepherd_model` was checked during certification; Watchdog model is a different family than Shepherd (cross-family).
- [ ] If local model on Yellow+, precedent-alignment + file-coverage cross-check were run.
- [ ] Finishing message matches the MANDATORY VERBATIM template for this phase (avec adversarial info).
- [ ] Next-phase command stated explicitly.
- [ ] Adversarial model info stated in finishing message (Shepherd model + Watchdog model).
- [ ] NO `cd` instruction in output.
