# The Wolfpack — User Guide

A multi-agent pipeline for planning, reviewing, implementing, code-reviewing, testing, and certifying features. Six roles, five tiers. Each role runs in a fresh session; information flows between roles only through files in `.wolfpack/plans/<slug>/`.

This guide covers the pipeline from **your** point of view — what to type, what you'll see, where to pause, and how to handle the outcomes.

---

## TL;DR

```
/hunt <slug> "<description>"
/clear → /spec <slug>              # Phase 0 — intent → acceptance.md + confidence gate
/clear → /alpha <slug>
/clear → /bloodhound <slug>        # (Blue+ tiers)
/clear → /debrief <slug>
/clear → /shepherd <slug>
/clear → /pointer <slug>           # (Blue+ tiers)
/clear → /tracker <slug>           # (Blue+ tiers)
/clear → /watchdog <slug>
/clear → /merge <slug>
<your dev deploy>             # see wolfpack-config.md → Deployment Notes
/clear → /smoke <slug>
```

Each phase's finishing message tells you the exact next command and which model to use. `/clear` between phases keeps context windows clean. Green tier skips Bloodhound, Pointer, and Tracker entirely — the fastest lane.

---

## When to Use the Pack vs Ad-Hoc

**Use the Pack when:**
- The feature touches more than one file or app
- You want adversarial review before AND after implementation
- You want an independent verifier diffing against main before merge
- You want execution quality tracked over time (Pedigree)

**Skip the Pack when:**
- Single-line typo fixes
- Emergency hotfixes where you already know the diff
- Exploratory spikes — you're still deciding *what* to build

---

## Tier System (5 Tiers)

| Tier | Bloodhound | Pointer | Tracker | Watchdog | When |
|------|-----------|---------|---------|----------|------|
| **Green** | skip | skip | skip | trust-Shepherd | Typos, config, tiny fixes |
| **Blue** | 1 round | 1 round (one-shot) | write + run (one-shot) | checklist | Small features, polish |
| **Yellow** | 1-2 rounds | 1-2 rounds (can loop) | write + run, can rewrite | full cert | Standard features |
| **Orange** | 2 rounds | 2 rounds (can loop) | write + run, can rewrite | full cert | Multi-app, API changes |
| **Red** | 3 rounds | 2 rounds + security/compliance | full coverage, can rewrite | full cert + manual smoke | Compliance, payments, architecture |

Alpha auto-selects the tier from `predicted_dimensions` scoring during planning.

## Workflow Modes — Update vs Feature

Mode is the **workflow axis** (paranoid vs fast-lane). Tier is a separate quality/complexity axis. Modes ride on top of tiers.

| | Update Sprint | Feature Addition |
|--|---------------|------------------|
| **For** | Bug fixes, polish, small cleanups | New features, model changes, compliance |
| **Bloodhound** | 1 round cap | Tier-scaled rounds |
| **Tracker tests** | Only when plan logic warrants | Full automated coverage + edge cases |
| **Watchdog** | Trust shepherd-log + tracker-log | Re-runs tests + independent verification |
| **Merge gate** | Smoke test confirmation (y/N) | Single Enter — automated tests carry the gate |

Alpha auto-selects mode: `domain_sensitivity ≥ 3` OR touches compliance apps OR any dim ≥ 4 → `feature`. Otherwise → `update`.

---
## Phase-by-Phase Walkthrough

### 1. `/hunt <slug> "<description>"` — Scaffold

Creates the plan directory, metadata.json, and git worktree (default) or in-place branch. Asks scope-envelope questions (target surface, mode guess, version tag). No LLM planning happens here.

### 2. `/alpha <slug>` — Alpha plans

Alpha reads CLAUDE.md, relevant source files, TODO.md, pedigree history. Writes `plan.md` with inlined source snippets, scores 7 predicted dimensions, computes tier + mode + review strategy. Finishes with the exact `/bloodhound` or `/debrief` command to run next.

### 3. `/bloodhound <slug>` — Adversarial plan review (Blue+ only)

Bloodhound explores the codebase (read-only), compares the plan against reality, writes structured findings in `review-N.md`. Alpha revises. Loop until approved or round cap reached. Green tier skips this entirely.

### 4. `/debrief <slug>` — Debrief synthesis

Alpha writes `debrief.md` (accepted/rejected findings, contention points) and `plan-final.md`. The debrief also contains the **6-role model assignment** table — which model runs each remaining phase, based on pedigree scores and cross-model requirements.

**Read `plan-final.md` + `debrief.md` before continuing.** If the plan looks wrong, stop and iterate.

### 5. `/shepherd <slug>` — Implementation (code only)

Shepherd implements `plan-final.md` — writes code, commits on the feature branch. Does NOT write or run tests (that's Tracker's job). Writes `shepherd-log.md` throughout. Finishes with the exact `/pointer` command.

### 6. `/pointer <slug>` — Adversarial code review (Blue+ only)

Pointer reviews `git diff main..HEAD` against the plan. Checks for plan fidelity, code correctness, security, precedent alignment, the project's Code Review Checklist (`wolfpack-config.md`), performance, error handling. Writes `pointer-review-N.md`.

Two outcomes:
- **APPROVED** — proceed to Tracker
- **REWRITE_NEEDED** — back to Shepherd with `--pointer-rewrite=N`

### 7. `/tracker <slug>` — Test writing + execution (Blue+ only)

Tracker (routable — metered-with-fallback, no longer pinned to Opus) writes and runs automated tests. Runs the project's test command (`wolfpack-config.md` → Project Identity) — the headless pipeline runs the local test command only, with no remote-database fallback. Writes `tracker-log.md`.

Two outcomes:
- **TESTS PASS** — proceed to Watchdog
- **REWRITE NEEDED** — back to Shepherd with `--tracker-rewrite=N`

### 8. `/watchdog <slug>` — Certification

Watchdog reads plan, shepherd-log, pointer reviews, tracker log, and the diff. Works through the certification checklist. Writes `certification.md` + `pedigree.json` (execution scores + process value-add metrics). Appends to `.wolfpack/pedigree/index.md`.

Three verdicts:

| Verdict | What happens |
|---------|--------------|
| **PASS** | Proceed to merge |
| **REWORK** | Code has issues but plan is valid. Re-launch Shepherd |
| **FLAWED_PLAN** | Plan itself is unsound. Back to Alpha |

### 9. `/merge <slug>` — Merge and push

Merges `feat/<slug>` → `main` with `--no-ff`, pushes to origin. Handles CHANGELOG stamping, version tagging, worktree plan-copy-back.

### 10. Dev deploy — Deploy to dev

Run your project's dev deploy (`wolfpack-config.md` → Deployment Notes). It is a user step, not a pack command.

### 11. `/smoke <slug>` — Post-deploy verification

Steps through smoke tests one at a time. Collects all issues, makes fixes in one batch, deploys once.

---

## Artifacts Reference

```
.wolfpack/plans/<slug>/
├── metadata.json          # Phase, status, 6 model assignments, dimensions, tier, mode
├── plan.md                # Alpha's first pass
├── review-N.md            # Bloodhound rounds (per tier cap; up to 3 on Red)
├── plan-revised-N.md      # Alpha revisions
├── plan-final.md          # The plan Shepherd implements — YOU READ THIS
├── debrief.md             # Review summary + 6-role model assignment — YOU READ THIS
├── shepherd-log.md        # Implementation diary (code only, no test results)
├── pointer-review-N.md    # Pointer code review findings (up to 2 rounds)
├── tracker-log.md         # Tests written, results, coverage
├── tracker-report-N.md    # Rewrite requests from Tracker (if tests exposed bugs)
├── smoke-tests.md         # Manual verification steps
├── certification.md       # Watchdog verdict — YOU READ THIS (on REWORK/FLAWED_PLAN)
├── pedigree.json          # Execution + process value-add scorecard (TRACKED IN GIT)
└── *-raw.log              # Raw tool-call streams (debugging only, gitignored)

.wolfpack/pedigree/
├── index.md               # Rolling one-line-per-run index (tracked)
└── lessons.md             # Aggregated tag patterns (regenerated, tracked)

.wolfpack/                 # Repo-wide files (tracked)
├── known-broken-tests.md  # Baseline of pre-existing test failures
└── cross-cutting-debt.md  # Infra issues spanning multiple hunts

.wolfpack/campaigns/<slug>/  # Multi-hunt campaigns from /expedition
├── metadata.json
├── campaign.md
└── results.md
```

---

## Slash Command Reference

| Command | What it does |
|---------|--------------|
| `/expedition <slug> "desc"` | Scout: Alpha bundles TODO items into hunts, writes `campaign.md` |
| `/run-hunt <slug> "desc"` | Run one hunt end-to-end (scaffold → certification) inside the sandboxed Podman container |
| `/run-campaign <slug> [max-parallel]` | Launch/resume a whole campaign in the Podman container; shows a RESUME PLAN and confirms first (default max-parallel = 2) |
| `/run-campaign-local <slug> [max-parallel]` | Same campaign runner, but IN-SESSION via the Workflow tool (no headless container) — keeps Claude roles on this session's billing; GLM/Mistral still run in their pods |
| `/hunt <slug> "desc"` | Scaffold plan dir + metadata.json + worktree/branch |
| `/alpha <slug>` | Alpha writes plan.md or plan-revised-N.md |
| `/bloodhound <slug>` | One adversarial plan review round |
| `/debrief <slug>` | Alpha synthesizes debrief.md + plan-final.md + 6-role model assignments |
| `/shepherd <slug>` | Implement plan-final.md (code only, no tests) |
| `/pointer <slug>` | Adversarial code review of the implementation diff |
| `/tracker <slug>` | Write + run tests (routable — metered w/ fallback) |
| `/watchdog <slug>` | Certify code + tests, score Pedigree |
| `/merge <slug>` | Merge a single hunt to main, push, tag (wave-of-one) |
| `/merge-wave <campaign> <wave>` | Batch-merge a certified wave: sequential `--no-ff` merges, ONE aggregated version tag, then one dev deploy |
| `/smoke <slug>` | Post-deploy smoke test cycle for one hunt |
| `/smoke-wave <campaign> <wave>` | Consolidated wave smoke: union of every released hunt's `acceptance.md` criteria, `[auto]` via Chrome DevTools MCP, `[manual]` as a blocking checklist |
| `/release-campaign <slug> [--checkpoint]` | Release a chain-mode campaign: one dev deploy of `campaign/<slug>`, Red sign-offs, one version, one CHANGELOG stamp, one `--no-ff` merge into `main` + one tag after you approve; never pushes |

**Chain mode** (`/run-campaign-local <slug> --chain`): the campaign runs every wave on a local `campaign/<slug>` branch
with no wave barriers; non-conflicting hunts push through a blocked one, and `/release-campaign` ships it once.
Details: the wolfpack skill (`.agents/skills/wolfpack/SKILL.md` § Chain mode).

**Unattended + cron resume** (`/run-campaign-local <slug> --chain --unattended`): no confirmation, no pre-spec
sweep, no questions (anything needing a human parks). A 15-minute cron (`scripts/wolfpack-cron-resume.sh tick`)
relaunches an ARMED campaign's runner in tmux once the usage window allows, disarms after 3 failed relaunches and
pages your phone through a private ntfy topic. Install, arming and the state file: [cron-resume.md](cron-resume.md).

**Hunt flags:**
```
/hunt [--no-worktree] [--shepherd=<model>]
      [--bloodhound=<model>]
      [--watchdog=<model>]
      [--campaign=<slug>]
      <slug> "<description>"
```

---

## Usage limits (5-hour window and weekly cap)

Unattended pipeline runs stop starting work they cannot finish. Before the campaign runner
claims each **new** hunt it asks `scripts/wolfpack-window-gate.mjs` for a decision based on Claude
Code's **real** account usage (the START gate). Between the phases of a running hunt,
`hunt-pipeline.js` asks again in `--boundary` mode with near-exhaustion ceilings, and parks
`model_quota` cleanly at that phase (auto-resuming there) instead of dying mid-agent.

**The snapshot.** Claude Code sends `rate_limits.five_hour` and `rate_limits.seven_day`
(`used_percentage`, `resets_at`) to the status line on every render. The status-line wrapper
`scripts/wolfpack-statusline.mjs` passes the status JSON through to claude-hud byte-for-byte
and writes only those figures plus `captured_at` to `~/.cache/wolfpack/claude-usage.json`
(`WOLFPACK_USAGE_SNAPSHOT`). Nothing else from the status JSON is stored.

**Thresholds** (env, defaults; an invalid value is a hard error, never a silent default):

| env | default | effect |
|---|---|---|
| `WOLFPACK_5H_START_MAX_PCT` | 80 | 5h at/above ⇒ do not start a hunt (Green–Orange) |
| `WOLFPACK_5H_START_MAX_PCT_RED` | 70 | same, for Red and unknown tiers |
| `WOLFPACK_WEEKLY_DEFER_PCT` | 90 | 7d at/above ⇒ defer **all** new hunts |
| `WOLFPACK_WEEKLY_PACE_POINTS` | 15 | weekly pace above ⇒ usage offload |
| `WOLFPACK_USAGE_STALE_MINUTES` | 10 | snapshot older ⇒ degraded fallback |
| `WOLFPACK_5H_BOUNDARY_MAX_PCT` | 95 | boundary mode: 5h at/above ⇒ park `model_quota` before the next phase (every tier) |
| `WOLFPACK_WEEKLY_BOUNDARY_PCT` | 98 | boundary mode: 7d at/above ⇒ park `model_quota` before the next phase |

A defer stops scaffolding: in-flight hunts finish, the rest are deferred, and the runner returns
`WAVE_PAUSED_QUOTA` with `resetAt`. The overnight driver re-gates and sleeps until the reset.

**Pacing and offload.** Weekly pace = 7-day used % minus the share of the week already elapsed.
When it runs more than 15 points ahead, the next hunt runs with a **usage offload**:
`metadata.usage_offload` is recorded and the Shepherd moves to GLM (`glm:5.3`) on **every** tier,
Red/Orange/compliance included. On Red or compliance-critical hunts a **Claude final review**
round follows the cross-family Pointer approval (recorded in `metadata.claude_final_reviews`).
It is skipped, and logged, only if a Claude fallback Shepherd wrote code on the branch.

**The meter.** `scripts/wolfpack-usage` prints a one-liner (same rounding as claude-hud):
`Claude 5h 42% (resets 14:05) · week 61% (pace +8, resets Mon 09:00) · live`. `--json` prints
the raw figures. Every host-side phase heartbeat carries `usage`, and each hunt's
`metadata.json` records `usage_delta` (start/end readings; a window that reset during the hunt
gets a `null` delta and `window_reset_during_hunt: true`) and `mistral_rate_limits` (429 /
transient / breaker events per family; GLM and Mistral Large 4 share one API key). Containerized
Vibe seats (sandboxed review/certify, the GLM Shepherd) cannot stamp, so the end reading is the
last host-side phase boundary.

**Degraded mode.** With a missing, unparseable or stale snapshot the gate falls back to the
transcript estimate (`WOLFPACK_CLAUDE_WINDOW_LIMIT`). The output says
`source:"transcript_estimate", degraded:true`, a warning goes to stderr in every mode, and the
runner logs `USAGE GATE DEGRADED`. With no limit configured it proceeds, loudly.

**Boundary records.** Every boundary decision is appended to `<plan dir>/usage-gate.jsonl`. A gate
that cannot be read proceeds loudly (`USAGE GATE UNAVAILABLE`, recorded there and on the hunt
result); a gate that errors (an invalid threshold) parks `usage_gate_error`.

**Unattended runs.** Only an *interactive* Claude Code session renders the status line, so only
it writes the snapshot. For overnight or unattended runs, keep an interactive session open on the
host that runs the pipeline, or set `WOLFPACK_CLAUDE_WINDOW_LIMIT` as the degraded backstop. Otherwise the gate
proceeds degraded and the overnight log prints `live 5h/weekly gating and offload INACTIVE` every cycle.

**Vibe disk-full (exit 77).** A Vibe shim whose sandbox breaks (`[Errno 28]` / ENOSPC, disk
quota, read-only fs) exits **77** with `WOLFPACK_INFRA_ERROR:<family>`. That is an infrastructure
fault, not a rate limit: it skips the breaker and never parks a hunt as `model_quota`. The
`~/.vibe/logs` tmpfs is now 256 MB (`WOLFPACK_VIBE_LOGS_TMPFS_SIZE`).

**Install.** The status-line wrapper and the meter are set up in `SETUP.md` § Optional: usage snapshot (Claude Code); that section is the single source for the install steps.

## Test record

The pipeline does not take an agent's word for the test result. After the Tracker returns
TESTS_PASS, the pipeline runs the project's **Test command** once at the committed HEAD through
`scripts/wolfpack-test-record.mjs` (a relay agent only runs the script and returns its output) and
writes two files to the plan dir:

- `test-record-<stage>.json`: the commit, the raw exit code, the suite's own summary line, the
  `pass` verdict, the test command, timing, and where it ran (`repo`, or a scratch worktree when
  the checkout was dirty or at another commit);
- `test-record-<stage>.log`: the full raw output.

**Stages.** `tracker` (after the Tracker; at Certify entry when a resume skipped Test), `final`
(at the final HEAD after the certify commit) and `release` (the `campaign/<slug>` tip, in
`/release-campaign`).

**Reuse rule.** `ensure` reuses a record whose commit (and test command) equals the target and
re-runs only when HEAD moved, with one exception: a FAILING record is re-taken when the hunt was
re-armed after it (`human-notes.md` in the plan dir modified after the record's `finished_at`). That way,
an environment fix such as refreshed credentials gets a fresh run at the same commit. Watchdog cites the record when its commit equals HEAD instead of
re-running the suite.

**Gates.** A failing `tracker` record bounces the hunt to Implement before Certify. A failing
`final` record parks `final_test_record_failed` (not mergeable). `/merge` and `/merge-wave` run
`gate --stage final` and refuse without a passing record at the exact tip being merged (re-taking it
once when the tip moved, e.g. after the auto-rebase); `/release-campaign` requires a passing
`release` record. A refusal prints the exact `ensure` line that re-takes the record. A record the
pipeline cannot trust (script error, SHA or command mismatch) parks `test_record_error`.

**Trust anchor.** The test command is read from the MAIN checkout's `wolfpack-config.md`, never
the hunt branch's, and the workflow cross-checks the recorded command against its own config.

**`Test verdict command`.** Some suites exit non-zero by design on documented baseline failures.
Set Project Identity → **Test verdict command** to a command that decides pass/fail from the log
instead (placeholders `{log}`, `{exit}`, `{main}`; exit 0 = pass). The record keeps the raw exit
either way. `none` (the default) means the suite's exit code is the verdict.

## Troubleshooting

### Pointer/Tracker skipped unexpectedly
Check `metadata.tier` — Green tier skips both. If the tier seems wrong, edit `metadata.json` before running the skipped phase.

### Model conflict warning
Cross-model pairing is required. If you see a model conflict warning, re-run with a different model (`/model <other-model>` before the phase command).

### Role skill not found
The Wolfpack role skills (`wolfpack`, `alpha`, `bloodhound`, `shepherd`, `pointer`, `tracker`, `watchdog`) do **not** live in your project. They live in the pack at `$WOLFPACK_HOME/.agents/skills/<role>/SKILL.md` and are installed user-level (`~/.claude/skills`) by the pack's `install.sh`; the pipeline's host-side seats read them from the pack directly. If a role skill fails to load, run `bash <pack>/install.sh --check` and apply the fix it prints.

