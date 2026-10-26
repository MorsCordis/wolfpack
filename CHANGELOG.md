# Changelog

All notable changes to the Wolfpack pack. Semver per campaign wave. Every entry ends with `<!-- hunt:<slug> -->` so `/merge-wave` can attribute and stamp it.

## [Unreleased]

### Added
- `wolfpack-cron-resume.sh ping --reason <code> [--campaign <s>] [--hunt <h>]`: a general-purpose phone page, armed or not, with the same token-only body as every other notification (the reason is a code, never free text). <!-- hunt:notify-ping -->

### Fixed
- `wolfpack-pedigree.mjs index-row --upsert` refused a hunt with more than one earlier index row ("--upsert found 2 rows … fix index.md by hand") and parked a passed certification as `pedigree_incomplete`. It now replaces the first row and drops the rest. <!-- hunt:upsert-collapse -->
- A hand-launched (unarmed) campaign run never paged the phone when a hunt parked or the run stopped waiting on a human: `wolfpack-cron-resume.mjs event park` / `event waiting-on-you` were no-ops unless the campaign was armed. Both now page unarmed too (no dedupe state, nothing disarmed); arming still controls the automatic relaunch. <!-- hunt:notify-unarmed -->
- A re-certified hunt no longer parks `pedigree_incomplete`: the pipeline writes its index row with the new `wolfpack-pedigree.mjs index-row --upsert` (replaces the hunt's one earlier row, e.g. from before a chain rebase; two rows still refuse), and the writer reads the round counters from a `rounds` block as well as `execution_scores` and the top level. <!-- hunt:pedigree-recert-counters -->
- `wolfpack-human-patches.mjs check` no longer re-parks a hunt `human_patch` after the human applied a whole stack of protected-path patches: an earlier patch that a later, applied patch for the same file rewrote is superseded, not pending (one that still applies forward stays pending). <!-- hunt:stacked-human-patches -->
- The chain post-merge stage no longer reverts a hunt as a mobile regression because a mobile check that still passes logged an anomaly (such as the 404 a "mobile sees no change" criterion expects); the rule now needs the criterion itself to fail. <!-- hunt:mobile-regression-anomaly -->
- The Orange/Red audit-only certification gate no longer parks a shell-backed PASS because the certifier lacked optional memory tools (`memory_recall`/`memory_remember`) or reported a `read_file` "file not found" on a pack path its pod does not mount; denied tools are judged by their leading tool name. A denied shell, read, grep or `write_file`, or a shell state other than `ok`, still parks. <!-- hunt:audit-evidence-optional-tools -->

## [v1.2.0] - 2026-10-22

### Added
- Chain-mode post-merge stage: after each wave auto-merges into `campaign/<slug>`, the runner deploys the tip to dev from a temp worktree, runs the touched apps' suites on an isolated test DB, smokes every merged `[auto]` criterion on each configured smoke tenant, and triages findings (fix ≤2 reviewed rounds / log / block-and-revert), then polishes logged items once at campaign end and builds the campaign report (`scripts/wolfpack-smoke-stage.mjs`, `/smoke-chain`, `docs/post-merge-stage.md`). Opt-in via `Post-merge smoke stage: on`. <!-- hunt:wave-auto-smoke -->
- `wolfpack-release.mjs`: `[tenant:<name>]` criterion scope; `revert` takes fix-round merges with it; `revert-merge` for a polish merge. `wolfpack-chain.mjs merge-hunt --fix-of/--polish`. `wolfpack-test-record.mjs --stage integration`, `WOLFPACK_RECORD_DEADLINE_EPOCH` and `tempfail` (exit 75, re-taken by hunt-pipeline). Notifier field `report_url` (meshnet http URL, no query). <!-- hunt:wave-auto-smoke -->

### Fixed
- Cross-family review of the post-merge stage (2 rounds): a crash between a fix merge and its bookkeeping no longer re-runs or reverts an already-landed fix; a mobile-manifest failure with several merged hunts blocks the stage as one unattributed finding instead of a fix round per hunt; test-DB isolation fails loud (the resume probe requires `testIsolation`, `Integration test args` must hold `{campaign}`); a merged hunt with no readable `acceptance.md` fails loud; JSON-form session values are redacted; `check-config` requires `.wolfpack/smoke-shots/` gitignored and keeps the isolation / Prod URL problems; app labels are checked as plain names and never trip the prod guard; `report_url` refuses prod, query and fragment URLs; `merge-hunt --polish` requires `polish_of`; prespec lint reads the configured smoke tenants. <!-- hunt:wave-auto-smoke -->

## [v1.1.0] - 2026-10-22

### Added
- `scripts/wolfpack-cron-resume.sh` (+ `.mjs`): cron-driven resume for an ARMED local chain campaign — `flock`-guarded 15-minute tick (heartbeat liveness across main and worktree layouts, usage-gate defer, tmux relaunch of an interactive `claude --permission-mode auto` running `/run-campaign-local <slug> --chain --unattended`), crash-loop guard (3 failed relaunches → disarm + notify), `arm`/`disarm`/`status`/`note-pause`/`note-exit`/`event`/`notify-test`/`--print-crontab`; never edits the crontab. <!-- hunt:campaign-cron-resume -->
- Phone notifications through a private ntfy.sh topic (topic in a 600 file, allowlisted token-only payload with 5h/weekly usage, failures logged and shown by `status`, never blocking). <!-- hunt:campaign-cron-resume -->
- `/run-campaign-local --unattended` (chain mode only): no RESUME PLAN confirmation, no pre-spec sweep, no questions; anything needing a human parks. `campaign-runner` takes `unattended`, sends park / ready-for-release / waiting-on-you events and disarms the armed campaign at the end of a chain run. <!-- hunt:campaign-cron-resume -->

### Fixed
- Cross-family review of the cron-resume half (3 rounds): a failed park page is not marked sent; a dropped event (state lock busy) prints `dropped:` and the runner logs a ⚠; a campaign whose only remaining work is a compliance sign-off pages `waiting-on-you`; `--print-crontab` quotes paths and refuses `%` or non-printable ones; the tick requires tmux 3.2+ (or `master`) and an existing gate file, naming the gate path in its error. <!-- hunt:campaign-cron-resume -->

## [v1.0.1] - 2026-10-21

### Fixed
- `wolfpack-test-record.mjs ensure` re-takes a FAILING record when the hunt was re-armed after it (`human-notes.md` modified after the record's `finished_at`). Before, a hunt re-armed after an environment fix (expired credentials, a shared test-DB deadlock) reused the stale failure at the same commit and bounced to Implement in minutes. <!-- hunt:pack-close-bugs -->
- `wolfpack-pedigree.mjs index-row` reads `rework_rounds` / `pointer_rounds` / `tracker_rounds` / `human_interventions` from the top level of `pedigree.json` when they are missing from `execution_scores` (the GLM Watchdog's layout), instead of refusing and parking the hunt `pedigree_incomplete`. <!-- hunt:pack-close-bugs -->
- `install.sh` and the workflow stamp name the nearest release tag (`git describe --tags --match 'v[0-9]*'`), never a lightweight `pre-hunt-*` marker tag. <!-- hunt:pack-close-bugs -->
- `wolfpack-merge-state.mjs copy-back` skips files git tracks on the hunt branch (reported as `skipped_tracked`). They arrive with the merge, and an untracked copy made before `git merge` made the merge abort. <!-- hunt:pack-close-bugs -->
- `wolfpack-test-record.mjs ensure --fresh` always re-takes the record, and a `gate`/`check` refusal on a FAILED record prints its fix line with `--fresh`, because plain `ensure` would reuse the failure. <!-- hunt:pack-close-bugs -->
- A `SEAT NOTE` appended by `wolfpack-version.mjs` keeps `human-notes.md`'s mtime (and back-dates a file it creates), so a seat note never counts as a human re-arm. <!-- hunt:pack-close-bugs -->
- Alpha's "Last released tag" and the config example's `VERSION` use `--match 'v[0-9]*'`; the pack-version error now says "no v* release tag reachable". <!-- hunt:pack-close-bugs -->

## [v1.0.0] - 2026-10-21

### Added
- `scripts/wolfpack-human-patches.mjs check`: the human-patch gate's deterministic probe. A patch under `human-patches/consumer/` targets the consumer worktree recorded in `metadata.consumer_worktree`; it is checked there and the park prints that repo's apply/add/commit commands and branch. <!-- hunt:consolidation-acceptance -->
- `wolfpack-pedigree.mjs index-row`: writes the pedigree index row from `pedigree.json` and refuses (naming the missing fields) a scorecard without execution scores; Certify parks `pedigree_incomplete` instead of writing a dashed row. <!-- hunt:consolidation-acceptance -->
- README and SETUP state the one-source model. <!-- hunt:consolidation-acceptance -->
### Changed
- The boundary usage gate decides on the last-known live figures (labelled `source: last_known`, degraded) when the snapshot is only stale, up to `WOLFPACK_USAGE_LAST_KNOWN_MAX_MINUTES` (default 120), instead of reporting "window gate DISABLED". <!-- hunt:consolidation-acceptance -->
### Fixed
- `backfill-merged` proves the older `Merge <branch> (…)` / `Merge <branch>: …` merge subjects, for `feat/<slug>` and the metadata `branch`. <!-- hunt:consolidation-acceptance -->
- `attribute-changelog` fails closed (exit 2, naming the git error) when `git rev-list --first-parent` fails, instead of treating every entry as unattributable. <!-- hunt:consolidation-acceptance -->
- `wolfpack-version.mjs set --tag` rejects anything but `vMAJOR.MINOR.PATCH[-prerelease]` or `none`. <!-- hunt:consolidation-acceptance -->
- The merge-and-state-hygiene pedigree row carries scores (re-scored after the fact by a cross-family seat). <!-- hunt:consolidation-acceptance -->
- The wolfpack skill and `/merge` no longer claim a `.gitattributes` `union` merge driver on the shared append-only files; none was ever committed. <!-- hunt:consolidation-acceptance -->
- The Watchdog skill's Index append format section now says the pedigree index-row writer falls back to the `metadata.json` `pointer_round` / `tracker_round` counters for PtrRnd/TrkRnd and refuses only when both are absent. <!-- hunt:acceptance-green-wolfpack -->

## [v0.5.0] - 2026-10-21

### Added
- `scripts/wolfpack-test-record.mjs`: the pipeline's SHA-stamped full-suite record (commit, exit code, the suite's own summary line, verdict, full raw log beside it), taken by a script with no agent in between, after Tracker (`tracker`), at the final HEAD after the certify commit (`final`) and at the campaign tip (`release`); `ensure` reuses a record whose commit equals the target and re-runs only when it moved. <!-- hunt:run-observability -->
- Optional `Test verdict command` config key (Project Identity; `{log}`, `{exit}`, `{main}` placeholders) for suites that exit non-zero on documented baseline failures; `wolfpack-config.mjs --json` exposes it as `testVerdictCommand`. <!-- hunt:run-observability -->
- `wolfpack-window-gate.mjs --boundary` (with `WOLFPACK_5H_BOUNDARY_MAX_PCT`, default 95, and `WOLFPACK_WEEKLY_BOUNDARY_PCT`, default 98) and `--record` / `--record-note` (append-only `usage-gate.jsonl` in the plan dir). <!-- hunt:run-observability -->
- `scripts/wolfpack-merge-state.mjs`: `copy-back` (copies a worktree plan dir's contents into the main checkout — never nests, a tracked `pedigree.json` is overwritten in place), `stamp-merged`, `backfill-merged` (git-proven, dry-run by default, idempotent `--apply`) and `attribute-changelog` (tags untagged `[Unreleased]` items from the merge that carried them; never deletes one). <!-- hunt:merge-and-state-hygiene -->
- `scripts/wolfpack-version.mjs set`: the one write path for `proposed_version`, with `set_by` provenance; a human-set version is immutable to seats, and a seat's disagreement is appended to `human-notes.md` as a `SEAT NOTE`. <!-- hunt:merge-and-state-hygiene -->
- `wolfpack-config.mjs --json` exposes `releaseTags` (`false` when Deployment Notes → Tag pattern is `none`); `/release-campaign`, `/merge` and `/merge-wave` skip the tag and record `released_version: null` for such projects. <!-- hunt:merge-and-state-hygiene -->
- The GLM review image ships `node` 22, so a GLM review seat can run the node suites. <!-- hunt:merge-and-state-hygiene -->
### Changed
- Review-finding fingerprints are composed by the pipeline from file, symbol and a closed claim class (`scripts/lib/review-convergence.mjs`, byte-identical with the workflow), so a different defect in the same file no longer reads as a fixed finding returning; plan-file revisions normalize to one `plan` key. Seats now supply `symbol` and `claim_class` on every finding. <!-- hunt:run-observability -->
- `hunt-pipeline.js` re-checks the usage window before every agent phase and parks `model_quota` at the boundary (auto-resuming at that phase) instead of dying mid-agent; a gate that cannot be read proceeds loudly and is recorded, and a gate error parks `usage_gate_error`. <!-- hunt:run-observability -->
- A failing pipeline test record bounces at Test before Certify; Watchdog takes the test result from the record when its commit equals HEAD; a failing final-HEAD record parks `final_test_record_failed` and the hunt is not mergeable. <!-- hunt:run-observability -->
- `/merge`, `/merge-wave` and `/release-campaign` refuse to merge without a passing test record at the exact tip being merged, printing the command that re-takes it. <!-- hunt:run-observability -->
- `/merge`, `/merge-wave` and `/release-campaign` always stamp `status: merged` (with `merge_commit`, `merged_at`), including `--no-worktree` hunts, and attribute untagged `[Unreleased]` items before stamping a version. <!-- hunt:merge-and-state-hygiene -->
- `hunt-pipeline.js`: a Tracker `TESTS_FAIL` / `REWRITE_NEEDED` loops back to Implement → Code Review → Test in the same run (bounded by `tracker_rounds`, then parks `non_convergence`) instead of returning; review and Tracker report numbering continues across bounces. <!-- hunt:merge-and-state-hygiene -->
- Certify runs the hunt worktree's seat shim when the hunt's own diff changes `scripts/podman-vibe.sh` or a library it sources, and parks (`cert_shim_probe_failed`) rather than guess when it cannot tell. <!-- hunt:merge-and-state-hygiene -->
- Tracker guidance forbids test assertions that a release stamp invalidates. <!-- hunt:merge-and-state-hygiene -->
### Fixed
- The pipeline's test-record run passes `--timeout-min 55`, so the record script times out (an honest `timed_out` record and a Test bounce) before the ~60-minute shim relay gives up and parks `model_quota` in a loop. <!-- hunt:merge-and-state-hygiene -->
- The run-start config probe's key leg single-quotes the Wolfpack home (`PACK='<home>'`) in both workflows. <!-- hunt:run-observability -->
- `install.sh` refuses loudly when `~/.claude` is a regular file, and gitignores `.wolfpack/pedigree/model-stats.json` in the consumer (also ignored in the pack). <!-- hunt:merge-and-state-hygiene -->
- `installFix()` shell-quotes paths containing `'`; `wolfpack-lessons.sh` prints "Not in a git repo" outside git; `wolfpack-live-watch.py` reads `WOLFPACK_MODELS_BIN` (default: `wolfpack-models` on PATH); the no-copies guard gives a nested or non-`.md` command entry a delete/move fix. <!-- hunt:merge-and-state-hygiene -->

## [v0.4.0] - 2026-10-20

### Added
- `docs/autonomy/` (README + 01–07): the autonomy design set — spec-driven hunts, park/resolve/resume, convergence and verdict, batch merge and smoke, limits and timing, model tiers and routing, cross-model execution — now lives in the pack, project-neutral (project specifics are labelled examples or `wolfpack-config.md` references). <!-- hunt:autonomy-docs-into-pack -->
- `docs/user-guide.md`: the operator's guide (phase walkthrough, tier and mode tables, artifacts, slash commands, usage limits, troubleshooting), moved from the first consuming project's pipeline guide and genericized. <!-- hunt:autonomy-docs-into-pack -->
- `scripts/wolfpack-no-copies.mjs` has a `scripts` class: a consuming project that tracks a `scripts/wolfpack-*` or `scripts/lib/wolfpack-*` file fails the guard, with a fix naming the pack copy that runs from the Wolfpack home. <!-- hunt:scripts-unfork -->
- Model Pool lines take an optional `gate=<ENV>` word (e.g. `gate=WOLFPACK_ENABLE_GLM`); `wolfpack-config.mjs --json` exposes it as `gates`, and the router turns the gates into the enabled reviewer set (`0`/`false` disables a family). <!-- hunt:scripts-unfork -->
- `scripts/wolfpack-prespec.edge.test.mjs`, the pre-spec helper's edge-case suite, now lives in the pack. <!-- hunt:scripts-unfork -->
### Changed
- Every skill, command, workflow and script citation of the design docs now points at the pack's own `docs/autonomy/` (and `docs/user-guide.md`); README and SETUP link the docs. <!-- hunt:autonomy-docs-into-pack -->
- `/release-campaign` is a pack command: one dev deploy of `campaign/<slug>` (from the configured Dev deploy and Migration commands; skipped when the project declares no deploy step), Red sign-offs, one version, one CHANGELOG stamp, then one `--no-ff` merge + tag after approval; it never pushes. <!-- hunt:pack-commands-canonical -->
- `scripts/wolfpack-no-copies.mjs`: fails when a consuming project tracks a pack command (outside its `Project commands` allow-list), a pack skill or a workflow copy, and when the pack's own `.claude/{commands,skills,workflows}` are not links to `.agents/`; `scripts/test-all.sh` runs it. <!-- hunt:pack-commands-canonical -->
- `Smoke login hook` (Deployment Notes) and `Project commands` (Project Identity) config keys, exposed by `wolfpack-config.mjs --json` as `smokeLoginHook` / `smokeLoginAccounts` / `projectCommands`. <!-- hunt:pack-commands-canonical -->
- `/run-campaign-local --chain` and its Chain mode section, the `/merge-wave` and `/merge` chain-campaign stops, and chain-mode forking in `/hunt` now live in the running pack commands (they existed only in shadowed copies). <!-- hunt:pack-commands-canonical -->
- `/smoke` and `/smoke-wave` run a post-deploy session probe and sign in only through the project's smoke login hook (or say visibly that none is configured), re-sign-in on a sign-in redirect, and read released hunts as `merged`. <!-- hunt:pack-commands-canonical -->
- Every pack command takes the worktree location from `Worktree root` and runs pack scripts, skills and sibling commands from the Wolfpack home, so the commands work unchanged in any consuming project. <!-- hunt:pack-commands-canonical -->
- `/expedition` and `/smoke` carry the full scouting and smoke-cycle procedures, genericized; seat commands carry their hard rails. <!-- hunt:pack-commands-canonical -->
- `wolfpack-release.mjs deploy` accepts `--no-migrate` for projects without a migration step. <!-- hunt:pack-commands-canonical -->
- Every pack script now runs from the Wolfpack home: both workflows (including the run-start config probe), the alpha/spec/watchdog/release-notes/wolfpack skills and the run-hunt/run-campaign watcher lines call `<pack>/scripts/…`, never a copy in the consuming repo. <!-- hunt:scripts-unfork -->
- Pack scripts run from the pack operate on the invoking repo's data: `wolfpack-model-stats.mjs`, `wolfpack-watch.sh` (`--repo <dir>`), `wolfpack-live-watch.py` and `wolfpack-overnight.sh` (`--dry-run`) take their root from the repo you run them in, and the router reads that repo's `model-stats.json` (`--stats` overrides). Outside a git repo they stop with a fix instead of reading the pack's `.wolfpack/`. <!-- hunt:scripts-unfork -->
- `wolfpack-model-stats.mjs` reads the consuming project's Model Pool, so concrete model tokens fill the routing meter. <!-- hunt:scripts-unfork -->
- `wolfpack-watch.sh` and `wolfpack-live-watch.py` scan both worktree layouts (`.agents/worktrees`, `.claude/worktrees`); `WOLFPACK_WATCH_CONTAINER_MATCH` adds container-name filters. <!-- hunt:scripts-unfork -->
- `wolfpack-window-gate.mjs` accepts the legacy `WOLFPACK_CLAUDE_WINDOW_LIMIT` (deprecated, warned; conflicting values fail) and defaults the transcript dir to whichever harness layout exists. <!-- hunt:scripts-unfork -->
- The router warns about Model Pool roles it does not route (e.g. a documented last-resort line) and fails loud (exit 3) when a review seat has no eligible examiner. <!-- hunt:scripts-unfork -->
### Fixed
- `hunt-pipeline.js` and `campaign-runner.js` no longer die at launch with `ReferenceError: meta is not defined`: the Workflow runtime strips the `export const meta` block, so the run-start stamp check now names its own file from a plain `WORKFLOW_NAME` constant (kept equal to `meta.name`, guarded by a test). The test harnesses now REMOVE the meta block the way the runtime does instead of rewriting it to `const meta`, which hid the bug. <!-- hunt:workflow-meta-runtime -->
- The run-start project-config and workflow-stamp probes run in their starting directory with no `cd`, and each reports the `pwd` it ran in. The run stops with a "host repo drifted between probes" error naming both paths when the stamp probe's directory or the checker's consumer differs from the config probe's directory, or when either probe omits it. A probe can no longer wander into another repo and check the wrong consumer. <!-- hunt:workflow-meta-runtime -->
- `hunt-pipeline.js` always computes the hunt's plan dir as `<worktree>/.wolfpack/plans/<slug>`. It no longer adopts a plan dir reported by the scaffold or resume agent, which once pointed every review seat at the main checkout. A differing reported value is logged as a WARNING and ignored. <!-- hunt:workflow-meta-runtime -->
- When a review or code review cannot start because the pipeline itself threw (a configuration error, no seat ran), the hunt now parks with that error text verbatim in `parked.md` and in the metadata `park.error` field. It used to say "likely a model outage or quota exhaustion". The test harness's `parallel()` now nulls a throwing unit the way the runtime does, so a thrown error can no longer hide behind it. <!-- hunt:workflow-meta-runtime -->

## [v0.3.0] - 2026-10-20

### Added
- Review and certify seats (Bloodhound, Pointer, Watchdog; GLM and Mistral) write their own handoff file with `write_file` into one shim-mounted read-write out dir (`<plan dir>/.seat-out/<seat>-r<N>[-<lens>]/`); the worktree stays read-only and `edit` stays denied. <!-- hunt:seat-handoff-writes -->
- `podman-vibe.sh --deliver-to <plan dir> --out-dir <dir> --expect <artifact>…`: after the seat exits the shim moves exactly the expected artifact(s) byte-for-byte into the plan dir and prints `WOLFPACK_ARTIFACT_DELIVERED: <name> sha256=…`; a missing artifact, any extra file, a symlink or any change to tracked/untracked source fails with exit 78 and `WOLFPACK_ARTIFACT_ERROR:` markers, and the out dir is quarantined, never delivered. A non-empty out dir at start is refused (exit 2). <!-- hunt:seat-handoff-writes -->
- `install.sh`: one command links `~/.claude/{commands,skills}` to the pack, installs the Vibe seat profiles, generates a consuming project's workflow copies and prints the pack version; `--check` is read-only and names each problem with its exact fix (exit 0 ok · 1 drift · 2 error). <!-- hunt:pack-install-model -->
- `scripts/wolfpack-workflows.mjs`: generates ONE stamped copy per consuming project of each named workflow (stamp = pack commit, `git describe --tags` version and the canonical's sha256) and checks freshness by content, so an unrelated pack commit never marks a copy stale. <!-- hunt:pack-install-model -->
- Run-start stamp check in `hunt-pipeline.js` and `campaign-runner.js`: the first lines name the running script's version; a stale copy, a hand-edited copy or a session-cached old copy stops the run before any state changes, with the regenerate/restart fix. <!-- hunt:pack-install-model -->
- `Worktree root` key under `## Project Identity` (`worktreeRoot` in `scripts/wolfpack-config.mjs`); both workflows build worktree paths and the main-checkout root from it and stop with the fix when it is missing. <!-- hunt:pack-install-model -->

### Changed
- The shim agent no longer re-transcribes a Vibe seat's stdout into `review-N.md` / `pointer-review-N.md` or authors `certification.md` / `pedigree.json` from it; it reads the verdict from the delivered file, records each artifact's sha256 in `metadata.seat_artifacts`, and logs `handoff_violations`. <!-- hunt:seat-handoff-writes -->
- The grounding line and the `> audit_only: true` note now go to a pipeline-written sidecar (`<plan dir>/seat-notes/<artifact>`) instead of being prepended to the seat's artifact. <!-- hunt:seat-handoff-writes -->
- `write_file` is no longer a read-only-by-role tool: a review/certify seat that reports it denied is recorded audit-only. The toolcheck now requires `write_file` and role-denies only `edit` for review seats; `GLM_REVIEW_DROP` also drops `edit`. <!-- hunt:seat-handoff-writes -->
- Watchdog's PASS-only actions (pedigree index append, lessons, commit) are performed by the pipeline after the certifier, not requested from the seat. <!-- hunt:seat-handoff-writes -->
- Host-side pipeline seats read their role skill from the pack (`$WOLFPACK_HOME/.agents/skills/<role>/SKILL.md`) instead of a consumer path that did not exist. <!-- hunt:pack-install-model -->
- One rule for generated workflow copies in every repo: they are gitignored and produced by `install.sh` (documented in SETUP.md). <!-- hunt:pack-install-model -->
- The leak grep and the seat-template test assemble the consuming-project literal at runtime, so no script spells it. <!-- hunt:pack-install-model -->

### Fixed
- The self-hosting AC2 test no longer asserts a header-only pedigree index; it checks the header, the separator and that every data row is well-formed, so certifying a wolfpack-hosted hunt no longer breaks it. <!-- hunt:seat-handoff-writes -->

### Removed
- `scripts/wolfpack-sync-runtime.sh` and its test — disposition: **deleted**; `install.sh` generates stamped copies through `scripts/wolfpack-workflows.mjs`, with no `.agents`→`.claude` namespace transform. <!-- hunt:pack-install-model -->
- `/hunt`'s step that recreated `.agents/` ↔ `.claude/` alias links in each worktree; consuming projects drop their tracked alias links. <!-- hunt:pack-install-model -->

## [v0.2.0] - 2026-10-19

### Added
- The execution layer lives in the pack: `scripts/podman-vibe.sh` (the Vibe/GLM seat shim), `scripts/run-pipeline-sandbox.sh`, `scripts/lib/wolfpack-ratelimit.sh` and the sandbox images `containers/Containerfile.wolfpack` (project-neutral base; Vibe in its own venv; the container user comes from build args) and `containers/Containerfile.wolfpack-glm`, with their tests. <!-- hunt:exec-layer-into-pack -->
- `WOLFPACK_HOME`: both workflows resolve the pack from the env, else `wolfpack-config.md` → Project Identity → `Wolfpack home`, else stop with the fix — never from the consuming repo. <!-- hunt:exec-layer-into-pack -->
- `## Execution Layer` config keys (sandbox + GLM image names, an optional project image layer, seat and sandbox extra mounts, secrets paths, Vibe agent dir, seat test env), read by `scripts/wolfpack-config.mjs` (new `--exec` mode) and documented in `wolfpack-config.example.md`; the shim refuses any mount that overlaps a configured secrets path. <!-- hunt:exec-layer-into-pack -->
- `scripts/wolfpack-build-images.sh` builds (or `--rebuild`s) a project's sandbox and GLM images from the pack Containerfiles plus its configured layer. <!-- hunt:exec-layer-into-pack -->

### Changed
- Every seat shim call in `hunt-pipeline.js` (review, implement, certify, toolcheck preflight) runs `$WOLFPACK_HOME/scripts/podman-vibe.sh`; the toolcheck checks the configured Vibe agent dir; a pack without the shim still parks `shim_missing`. <!-- hunt:exec-layer-into-pack -->
- `/run-hunt`, `/run-campaign`, `wolfpack-overnight.sh` and `wolfpack-run-local.sh` launch the pack's sandbox and shim instead of a copy in the consuming repo. <!-- hunt:exec-layer-into-pack -->
- `wolfpack-finishing-check.sh` also enforces in `.claude/worktrees/` checkouts, not only `.agents/worktrees/`. <!-- hunt:exec-layer-into-pack -->

### Removed
- The shim's read-only mount of a second wolfpack checkout (`WOLFPACK_CANONICAL_REPO`); review seats keep the read-only git-common-dir mount. <!-- hunt:exec-layer-into-pack -->

### Fixed
- A review or certify seat that lists only its read-only-by-role tools (`edit`, `write_file`, `task`, `skill`) as denied is no longer recorded audit-only, so a shell-verified Orange/Red PASS certifies instead of parking `audit_only_certification`. <!-- hunt:audit-only-role-denied-tools -->
- The self-hosting changelog test checks the hunt's entries exist under `[Unreleased]` or a version heading, so it no longer fails once a wave stamps them. <!-- hunt:wolfpack-self-hosting -->

## [v0.1.0] - 2026-10-19

### Added
- Wolfpack hosts its own hunts: its own `wolfpack-config.md`, a deterministic config reader (`scripts/wolfpack-config.mjs`) used by the router and both workflows, `.claude/workflows` wiring, and an empty public pedigree whose router falls back to the Model Pool order. <!-- hunt:wolfpack-self-hosting -->
- One test entry point, `scripts/test-all.sh` (every node and shell test plus the leak grep; podman tests print `SKIP: needs podman`). <!-- hunt:wolfpack-self-hosting -->
- GitHub-hosted CI (`.github/workflows/ci.yml`, `ubuntu-latest` only) and a public-repo leak grep with an explicit allow-list (`scripts/wolfpack-leak-grep.sh`). <!-- hunt:wolfpack-self-hosting -->

### Changed
- Both workflows read the consuming project's test command, compliance surfaces, deploy step and worktree links from `wolfpack-config.md` instead of hard-coding one consumer's values, and the wave-close commands surface the configured deploy step (or none); a missing seat shim parks `shim_missing` naming the path. <!-- hunt:wolfpack-self-hosting -->
- `scripts/wolfpack-sync-runtime.sh` has no default target: with no target it prints usage and exits 2, writing nothing. <!-- hunt:wolfpack-self-hosting -->

### Removed
- Consuming-project identifiers from commands, skills, workflows, scripts and docs. <!-- hunt:wolfpack-self-hosting -->

## [v0.0.1] - 2026-10-18

### Added
- Vibe seat profiles tracked as templates (`vibe-agents/`) with an idempotent, backing-up installer (`scripts/wolfpack-install-vibe-agents.mjs`). <!-- hunt:seat-profiles-into-pack -->
- Seat toolcheck preflight (`scripts/wolfpack-toolcheck.mjs`): a profile that denies a tool the shim enables fails the run loud before any seat. <!-- hunt:seat-profiles-into-pack -->
- `audit_only` recording for review/certify seats that ran without a working shell; Orange/Red certification on audit alone parks. <!-- hunt:seat-profiles-into-pack -->

### Changed
- Review and certify seats get `bash` inside the sandbox (edit/write stay denied), matching the shim. <!-- hunt:seat-profiles-into-pack -->

First tagged release; everything earlier (pipeline, router, chain mode, usage gate, pre-spec sweep) is untagged history in `git log v0.0.1`.
