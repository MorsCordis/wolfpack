# The chain-mode post-merge stage

Chain mode (`/run-campaign-local --chain`) auto-merges each certified wave into the local branch
`campaign/<slug>`. Without this stage nothing checks the merged result until `/release-campaign`.
With it, the campaign runner checks every wave right after it merges, fixes or reverts what broke,
polishes the cosmetic leftovers once at the end, and hands you one phone-friendly release report.

The runner sequences it (`.agents/workflows/campaign-runner.js` → `postMergeStage`); every decision is made
by the tested CLI `scripts/wolfpack-smoke-stage.mjs`; the browser part is the `/smoke-chain` command.

## When it runs

- Only in chain mode, and only when the project opts in: wolfpack-config.md → Deployment Notes →
  `Post-merge smoke stage: on`. Absent or `off`: the runner logs
  `post-merge stage: off (wolfpack-config.md → Deployment Notes → Post-merge smoke stage)` once and behaves
  exactly as before. Barrier (non-chain) campaigns never run it.
- After a wave's merge step merged at least one hunt. A wave that merged nothing logs
  `post-merge stage: nothing new on campaign/<slug>`.
- The next wave starts only after the stage for this wave resolved (green, or every failure fixed,
  logged or blocked-and-reverted).
- At chain start the runner runs `check-config`: a missing stage key, or a refused tenant host or command,
  stops the campaign as `smoke_config_missing` before any deploy or browser call.

## Step order

| # | Step (agent label) | What it does |
|---|---|---|
| S0 | `stage-begin` | opens (or resumes) the wave's stage state; prunes stale `wolfpack-stage-*` worktrees |
| S-pre | `stage-session:before` | first iteration only: the login hook's `--check` on every smoke host |
| S1 | `stage-deploy` | the Dev deploy command in a temp worktree at the campaign tip (one retry) |
| S2 | `stage-migrate` | the Migration command in a temp worktree at the SAME tip (one retry) |
| S3 | `stage-ensure-tenants` | the Smoke tenant ensure command (idempotent, every iteration) |
| S4 | `stage-session` | `--check` again; signed in before + signed out after = a `session_drop` for you |
| S5 | `stage-integration` | the touched apps' suites at the tip on the campaign's isolated test DB, judged by the Test verdict command |
| S6 | `stage-smoke:w<N>` | the smoke plan, the browser probe, the `/smoke-chain` agent, ingest |
| S7 | `stage-triage` | `classifyFinding` on every finding; the issue log |
| S8 | act | blocks first (revert), then fix rounds (max 2 per hunt) |
| — | re-verify | any revert or merge → back to S1 on the new tip |
| S9 | `stage-report` | the campaign release report and its URL |

The main checkout never leaves `main`: deploy, migrate and the smoke worktree all use temp worktrees
(removed in `finally`, also on failure). The migrate step is refused if the tip moved since the deploy.

## State and resume

`.wolfpack/campaigns/<c>/smoke-stage.json` (schema 1, written atomically; the full shape is in the
header of `scripts/wolfpack-smoke-stage.mjs`). `current.step` is the last step **completed**
(`begin, deploy, migrate, ensure, session, integration, smoke, triage, act, done`); `current.result` is
`null` while running, then `green`, `resolved` or `parked:<code>`.

- **Resume:** a relaunch with the same campaign tip continues after the last completed step; a moved tip
  restarts at deploy (fix rounds and the iteration count are kept).
- **Re-arm:** a relaunch re-arms a parked stage: the park goes to `current.park_history`, the parked step's
  attempt counter resets, and the normal resume rule applies. So after clearing any blocker you just re-run
  the campaign. `green` / `resolved` are final.
- **Reconcile:** a crash between the merge and the stage leaves a wave merged but unstaged; the next launch
  stages it (suites included) before the wave loop. Waves fully merged before the stage was turned on are
  never staged (logged once).
- **Usage gate:** a defer before a Claude-heavy step (smoke, a fix round, the polish wave) returns the
  re-runnable `WAVE_PAUSED_QUOTA` with the state saved — never a failure, never a park.

## Integration suites

- **Suite set:** each merged hunt's own merge commit(s) (`git diff --name-only M^1 M`, plus its smoke-fix
  merges) → the top-level directories holding the App marker file. A Red hunt, or a path under
  `Integration full-suite paths`, runs the full suite. Docs, `.wolfpack/` and scripts add no app.
- **The run:** `wolfpack-test-record.mjs run --stage integration --labels <csv|ALL> --campaign <c>
  --timeout-min 55` at the tip. Its command is the Test command plus the `Integration test args` with
  `{campaign}` substituted (an isolated, always-rebuilt test database).
- **Verdict-output contract:** the Test verdict command's stdout is saved as
  `test-record-integration.verdict.log`. Exit 0 = green. Exit 1 = new failures, listed as a line starting
  `NEW FAILURES`, then one test id per line until a blank line. Anything else (exit 2, a timeout) =
  incomplete/infra: retried once, then `integration_infra`.
- **Attribution:** a failing id's app is its first dotted segment. Its candidates are the wave's hunts that
  touched that app plus every wave hunt that touched a full-suite path; each candidate gets its own finding.
  An id with no candidate parks `integration_unattributed`.
- **Shared test DB lock (record-behind-CI):** a record may spend up to 20 min of its 55-min budget waiting for
  the project's shared test-DB lock (the runner exports `WOLFPACK_RECORD_DEADLINE_EPOCH`; the project's test
  runner stops waiting in time). A test command that exits **75** means busy: the record is `tempfail` and is
  re-taken at once, up to 8 times, never counted as a failure. Every lock holder is capped at 55 min; whoever
  raises the record timeout, the hold cap or the pipeline concurrency cap must raise the lock wait and the
  CI timeout with it. Sandbox seats that run the test command against host PG take the lock in the
  container's `$HOME`, so the lock does not cover them (a known gap).

## Smoke

- **Criteria set:** the union of the `[auto]` criteria of every campaign-merged hunt (pending compliance
  included, reverted hunts excluded), refs `<slug>/<n>`. `[manual]` criteria are never run, only collected
  for the release checklist; `[compliance]` criteria go to the Red sign-off checklist.
- **Tenants:** each criterion runs on the tenants its `[tenant:<name>]` scope names (absent = `both` = every
  configured smoke tenant); each tenant's manifest (Smoke tenant manifests) runs on it every iteration.
- **Browser probe:** before the smoke agent, a probe agent makes one `mcp__chrome-devtools__list_pages` call.
  No tool, or an error → `smoke_browser_unavailable` (the fallback below).
- **The agent** follows `/smoke-chain` (`.agents/commands/smoke-chain.md`) and writes
  `stage/wave-<n>/smoke-raw-<sha12>.json`. An agent error or a raw file that fails validation (renamed
  `.invalid-<k>.json`) gets one more run; a second failure parks `smoke_agent_failed`.
- **Ingest:** the stage validates the raw file, applies the hunt verdict (any `auto_fail` → FAIL; a 5xx on the
  hunt's pages → FAIL even when every criterion passed; any `needs_human_run` → PENDING), redacts every
  anomaly, writes `<wave dir>/results.json` and builds the wave page. A criterion that needs the platform
  console is `needs_human_run` with detail `console not reachable on dev`.
- **Manual items the stage writes** into results.json `manual`: `{ref, hunt, steps, expected, reason}` — the
  criterion text verbatim as `steps`, `expected` = "Passes as written; the automated run could not check it.",
  and the reason (e.g. `console not reachable on dev`). Deduped by ref with a `[manual]` entry (that one is
  kept and gains the reason).
- A criterion whose check is a test id the integration run already covered is marked from the integration
  record (`covered by integration run`) and not run twice. Command-style criteria run in a temp worktree of the
  tip, and test ids only through the plan's `test_command` (the isolated test DB).

## Triage

`classifyFinding(finding, context) → {outcome, rule, reasoning}` — pure, ordered, first match wins:

| # | Rule id | Condition | Outcome |
|---|---|---|---|
| 1 | `deploy_or_migration` | kind deploy/migrate | block |
| 2 | `5xx_or_cross_tenant` | any 5xx on the finding, or `model.cross_tenant` | block |
| 3 | `prod_host_touched` | a refused host was visited | block |
| 4 | `mobile_regression` | tenant mobile and `<key>@mobile` in `mobile_passed` | block |
| 5 | `money_medical_path` | kind smoke/integration and the hunt's merge diff touches a `triageBlockPaths` dir | block |
| 6 | `red_compliance` | the hunt is Red and the ref is one of its `[compliance]` criteria | block |
| 7 | `fix_cap` | `fix_rounds[hunt] >= 2` | block |
| 8 | `needs_decision` | `model.class == needs_decision` | block |
| 9 | `uncertain_log_vs_block` | `model.class == uncertain` | block |
| 10 | `session_drop` | kind session | log (resolution `needs Cecil` at once) |
| 11 | `clear_defect` | `model.class == fix` and `expected_from != none`; or kind integration (a failing test is its own expected behaviour) | fix |
| 12 | `polish` | `model.class == log` | log |
| 13 | `default_block` | anything else (incl. `fix` with no expected behaviour = a product decision; `block` from the model) | block |

A finding with no hunt that would be `fix` becomes `block` on the campaign stage. A hunt with any `block`
finding drops its `fix` findings (block wins). A manifest flow's failure is attributed to the hunts merged in
that stage run. A console / non-2xx anomaly on a passing criterion is polish unless the agent judged it
otherwise; a 5xx always blocks.

A migrate failure blocks every hunt of the wave whose merge diff adds a file matching the Migration file
pattern (the failing app cannot be read from the job's exit code). Each one's `parked.md` names the others
("the failing app could not be identified") and says that reverting does not un-apply what the dev database
already applied. A deploy failure, or a migrate failure with no migrating hunt, is infra: one retry, then
`dev_deploy_failed`.

## Fix rounds (max 2 per hunt)

A `fix` finding starts a fix round for its hunt:

1. `fix-scaffold` creates `fix-<hunt>-smoke-<n>` (branch `feat/fix-<hunt>-smoke-<n>`, worktree under the
   project's Worktree root) forked from the CURRENT campaign tip, with metadata `base_branch: campaign/<c>`,
   `parent_hunt`, the parent's tier (floor Blue), `test_isolation: <campaign>` and a cross-family
   writer/reviewer pair from the Model Pool.
2. A Claude fix planner writes `acceptance.md` (one `[auto]` criterion per finding) and `plan-final.md`.
3. `hunt-pipeline` runs it from Implement: Shepherd → cross-family Pointer → Tracker (a test that fails before
   the fix) → Watchdog.
4. Certified → `wolfpack-chain.mjs merge-hunt --fix-of <hunt>` (`--no-ff` into the campaign branch; the fix
   worktree is removed after the plan-dir copy-back) → `record-fix` appends to
   `.wolfpack/plans/<hunt>/smoke-findings.md` the finding, the review fingerprint lookup (`miss`,
   `wrong-rejection` or `raised-not-rejected`) and the fix merge commit → redeploy and re-verify everything.
5. Not certified (non-convergent review, open critical, a merge conflict) → the hunt blocks
   (`fix_review_failed`) and is reverted. A third failure after 2 rounds blocks (`fix_cap`); no round 3.

Fix and polish hunts are never added to `campaign.md` or the chain graph.

## Block → revert

`wolfpack-release.mjs revert` takes the hunt out of `campaign/<slug>` together with its smoke-fix merges and
its campaign-merged dependents (newest first), rebuilds `feat/<hunt>` (campaign tip + the reapply commits),
and writes `parked.md` from the stage's `--summary/--evidence/--issues/--question`. The runner holds the
dependents, lets non-conflicting later hunts keep running, rebuilds the report and sends one park page
(allowlisted fields + `report_url` only). A conflicting revert leaves the branch unchanged and parks
`campaign_revert_failed`.

## The issue log

`.wolfpack/campaigns/<c>/issue-log.json` is the machine store; `issue-log.md` is re-rendered from it on every
write. Append-only: one entry per finding id `ISS-<sha1(kind|hunt|tenant|ref-or-test-id|normalised
summary)[:10]>` — the same failure seen again keeps its id (`seen_waves` grows). Fields: id, wave,
seen_waves, hunt, ref, tenant, kind (smoke / integration / anomaly / session / deploy / migrate), outcome,
rule, reasoning, evidence (screenshot path or failing test id), resolution (`fixed in round <n>` /
`polished` / `reverted` / `needs Cecil`) and resolved_at. Cookies, `Authorization`, `csrftoken`,
`sessionid` and token query strings are redacted before anything is written.

## The polish wave

When the campaign is ready for release (or only waits on a human) and the issue log has open `log` items of
campaign-merged hunts, the runner runs ONE polish wave: `polish-<c>[-<k>]` (branch `feat/polish-<c>`), Blue,
one change for all the items → cross-family review → `merge-hunt --polish` → a polish iteration (redeploy,
the polish merge's own suites, the full smoke). Green → the items are `polished`; an item that still fails →
`needs Cecil`. A previously passing check that now fails (smoke or integration) → `revert-merge` of the polish
merge only, its items `needs Cecil`, one plain re-verify on the reverted tip. It never touches reverted or
parked hunts and never runs twice for the same open set.

## The release report

`report` runs the Campaign report command (`{campaign}`, `{issue_log}`) and the Report URL command
(`{dir}`): per-hunt verdicts with screenshots, each Red hunt's diff and compliance checklist marked UNSIGNED,
the riskiest 10 manual checks, the items needing you, and the fixed / polished / reverted / open counts. It
fails soft (`⚠ report: …`). The runner logs `Report: <url>` and the ready-for-release (or waiting-on-you)
notification carries it as `report_url`.

## Park codes — what you do

Every row ends "then re-run the campaign": the relaunch re-arms the parked stage.

| Code | Meaning | What you do |
|---|---|---|
| `smoke_config_missing` | a stage key is missing, or a tenant host / command is refused, or the login hook said REFUSED, or the Wave report dir command failed | fix the named wolfpack-config.md key (or the hook's password file / host), then re-run the campaign |
| `dev_deploy_failed` | the deploy failed twice, or migrate failed twice with no migrating hunt | read the step's log in `stage/wave-<n>/`, fix the deploy, then re-run the campaign |
| `smoke_tenant_ensure_failed` | the Smoke tenant ensure command failed (often: the unattended credential cannot run that job) | run the ensure command by hand on your own login (or grant the job), then re-run the campaign |
| `smoke_browser_unreachable` | the login hook could not reach the smoke browser (exit 3 / unrecognised output) | start the smoke Chrome, then re-run the campaign |
| `smoke_browser_unavailable` | the Workflow agent has no working `mcp__chrome-devtools__list_pages` | run `/smoke-chain <campaign> <wave>` in the interactive session (the fallback), then re-run the campaign |
| `integration_infra` | the integration run was incomplete twice, or the test DB stayed busy for 8 re-takes | read `test-record-integration.log`, fix the environment, then re-run the campaign |
| `integration_unattributed` | a failing test belongs to an app no wave hunt touched (main's change?) | fix it on main (or baseline it), then re-run the campaign |
| `smoke_agent_failed` | the smoke agent failed twice (no results, or results that fail validation) | read the `.invalid-<k>.json` files, fix the cause (or run `/smoke-chain` by hand), then re-run the campaign |
| `campaign_revert_failed` | a revert conflicted or was refused; the campaign branch is unchanged | resolve the revert by hand (or `/resolve` the hunt), then re-run the campaign |
| `stage_cli_error` | any other stage CLI error, named with its step | read the named step's error and fix it, then re-run the campaign |

## The A-0 fallback

A Workflow agent may not see the user-scope chrome-devtools MCP. Then the stage parks
`smoke_browser_unavailable`. Run `/smoke-chain <campaign> <wave>` in the interactive session (where the MCP
works); it writes the same `smoke-raw-<sha12>.json`. Re-run the campaign: the relaunch re-arms the stage,
which resumes at smoke, finds the raw file for the current tip and ingests it instead of launching its own
browser agent.

## Config keys

All optional unless `Post-merge smoke stage` is `on`; then all are required except
`Integration full-suite paths`, and `Smoke tenants` needs at least one tenant.

| Section → key | Example | Reader field |
|---|---|---|
| Deployment Notes → Post-merge smoke stage | `on` | `postMergeStage` |
| Deployment Notes → Dev deploy command | `scripts/deploy_dev.sh` | `devDeployCommand` |
| Deployment Notes → Migration command | `scripts/deploy_dev.sh migrate` | `migrateCommand` |
| Deployment Notes → Migration file pattern | `/migrations/[0-9]` | `migrationFilePattern` |
| Deployment Notes → Never-smoke hosts | `` `www.example.dev` `demo.example.dev` `` | `neverSmokeHosts` |
| Deployment Notes → Prod URL | `https://*.example.com` | `prodHostSuffix` (`example.com`) |
| Deployment Notes → Smoke tenants | `` `surgical=surgical.example.dev` `mobile=dev.example.dev` `` | `smokeTenants` |
| Deployment Notes → Smoke tenant manifests | `` `mobile=scripts/smoke/mobile-manifest.md` `` | `smokeManifests` |
| Deployment Notes → Smoke tenant ensure command | `scripts/ensure_smoke_tenants.sh` | `smokeTenantEnsureCommand` |
| Deployment Notes → Wave report dir command | `… wave-dir --campaign {campaign} --wave {wave}` | `waveReportDirCommand` |
| Deployment Notes → Wave report build command | `… build --dir {dir}` | `waveReportBuildCommand` |
| Deployment Notes → Campaign report command | `… build-campaign --campaign {campaign} --issue-log {issue_log}` | `campaignReportCommand` |
| Deployment Notes → Report URL command | `… url --dir {dir}` | `reportUrlCommand` |
| Deployment Notes → Smoke login hook | (existing key) | `smokeLoginHook` |
| Project Identity → App marker file | `apps.py` | `appMarkerFile` |
| Project Identity → Integration test args | `--isolated-db {campaign}` | `integrationTestArgs` |
| Project Identity → Integration full-suite paths | `` `settings/` `requirements.txt` `` | `integrationFullSuitePaths` |
| Compliance Requirements → Triage block paths | `` `billing/` `records/` `` | `triageBlockPaths` |

**The prod-name guard.** Every command the stage runs or hands to an agent is refused (nothing executed) when
it matches `/prod/i`, contains the prod host suffix, or names a never-smoke host — the templates at
`check-config`, and again after substitution with only the campaign slug masked back to `{campaign}` (so a
slug such as `reproduce-login-bug` is fine). Smoke hosts and visited URLs are checked on the hostname only
(a dev path may contain "prod").
