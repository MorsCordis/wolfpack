# Wolfpack — Tooling Backlog

Open framework/tooling items. Project-specific debt lives in each consumer's own `TODO.md`;
this file holds work on the **generic** pipeline (orchestration layer, router, role skills,
hunt artifacts). Items migrated from `pawpims/TODO.md` during the consumer cutover (2026-06-23)
keep their original filing dates.

## Follow-ups from 2026-09-28 (platform-console-shell / GLM wiring)

- [ ] **Rebuild the base sandbox image with a current Vibe** — it ships Vibe 2.13 (no `--auto-approve`), so GLM seats exit 2 inside `/run-campaign` container runs; only `/run-campaign-local` works today. Then retire the separate `wolfpack-sandbox-glm` image.
- [ ] **Certify seat can write + commit product code** — PawPIMS Watchdog (Gemini, `podman-agy.sh --certify`) committed a code fix (`cdaba412`) despite a read-only worktree mount (the git dir / plan dir mounts are writable). Restrict certify to writing `certification.md` + `pedigree.json` only, and have the pipeline reject/park any non-artifact commit authored during certification. Workaround used: re-certify via `--review` (read-only) and write certification.md from its output.
- [ ] **Sonnet re-entry** (when Cecil enables the new Sonnet — model ID from him): Model Pool + routing so Sonnet is the default Shepherd ≤ Orange and default Tracker; never a reviewer of Claude-written work; staged rollout compared on Pointer/Tracker bounce rates (see PawPIMS memory `project_sonnet_reentry_plan`).
- [ ] **Vendor-family rule for local models** — Gemma is Google, so Gemini must not review Gemma-written code; encode `gemma → google` (same family as gemini) in `providerFamily`/routing so the examiner chain excludes Gemini for Gemma writers.
- [ ] **Promote the UI render/content checker into a reusable hunt harness** — `verify_ui.py` (PawPIMS `platform-console-shell` plan dir `h2h/`) caught what 9 review rounds missed (namespace bug, empty page, missing include). Generalise: render every template with realistic context built from the hunt's dataclass contract, assert content (not just "renders"), no content outside blocks, namespaced `{% url %}`, CSP/design-token rules. Lessons baked in: supply `csrf_token` in context; plain static storage.
- [ ] **Local-model harness lessons → shim + docs**: always `vibe -p … < /dev/null` (open stdin blocks forever — podman-vibe.sh already does; the "hangs on approval" comment there is partly this); `edit` (not `search_replace`) is Vibe's modify tool and `write_file` refuses existing files; `--max-turns` counts the whole resumed session; feed checker output back by resuming the same session.
- [ ] **Nemotron Lightning re-trial** after its serving config is checked (reasoning parser / streaming after tool calls → Vibe `Completed public history entry is frozen`), with `< /dev/null` + `--auto-approve`.

## Orchestration layer

- [ ] **Heartbeat: write to an absolute mount path so the host can observe post-Scaffold phases**
  (Low, 2026-05-29; from pawpims): the per-hunt heartbeat in `hunt-pipeline.js` writes a *relative*
  `.wolfpack/heartbeats/<slug>.json`. Every phase after Scaffold runs inside the worktree, so those
  writes land in `<worktree>/.wolfpack/heartbeats/` and the host-watched main-workspace files freeze
  at `Scaffold` forever (confirmed live on the first `v1-push-3` autonomous run). **Fix:** write the
  absolute container mount path (`/workspace/.wolfpack/heartbeats/<slug>.json`) so every phase is
  visible from one host-side glob regardless of cwd. Applies to the reference `hunt-pipeline.js` AND
  the DevDen Python orchestrator reimplementation.

- [~] **Handoff validation + retry-before-park (stop spurious parks on malformed phase output)**
  (Medium, 2026-06-26; from Spark bench): a malformed Bloodhound output parked a hunt that should
  have just retried. (1) **per-phase output validator** ✅ and (2) **pre-handoff retry-before-park
  with corrective nudge** ✅ — DONE 2026-06-26 (`feat/handoff-validation-retry`): `isFormatFailureStatus`
  classifies the retryable format-failure class (malformed_verdict / missing_verdict_block /
  empty_findings_contradiction) distinct from quota/ungrounded; `runReviewFanout` re-runs a
  format-failed lens with `verdictCorrectiveNudge` (N=2, same concurrency) **before** any
  `review_error` park. Triggered on `inventory-flexible-tracking` (parked twice on Gemini's XML
  verdict). (3) **next-phase kick-back** (`kickback:<phase>` — downstream preflight validates its
  input and re-triggers upstream) **STILL OPEN** → build as a focused follow-up.
  Deferral LIFTED: it was a sequencing wait for the other session's in-flight hunt, not a benchmark
  gate. Applies to `hunt-pipeline.js` (1+2 done) AND the DevDen Python orchestrator (pending).
  NOTE: the pawpims runtime copy is now GENERATED from canonical via
  `scripts/wolfpack-sync-runtime.sh` (deterministic `.agents`→`.claude` path transform) — this
  ends the hand-sync drift (~47 line-groups) between canonical and the pawpims runtime copy.

- [ ] **Make router output BINDING, not advisory — close the model-attribution gap**
  (Medium, 2026-06-11; from pawpims): `scripts/wolfpack-routing.mjs` assigns roles per tier/pedigree,
  but adoption is advisory — `hunt-pipeline.js` tells Alpha to "adopt UNLESS you have a documented
  reason to override," and a judgment-family Alpha overrides back to itself most of the time
  (empirically: 1 of 4 non-heavy hunts actually used the cheaper implementer). Tell-tale: freehand,
  inconsistent `model_assignments` tokens (`claude:opus`, `claude:opus:high`, `claude-opus-4-8`).
  **Fix:** pipeline writes `model_assignments` directly from the router before Alpha, removing Alpha's
  discretion over the implementer and normalizing the token format. **Now higher priority** — advisory
  routing also corrupts the pedigree-v2 → bandit reward loop, since reward is attributed per
  `(model × role × domain)` cell and freehand tokens don't map to cells cleanly.

## Roles / skills

- [ ] **Shepherd: surface test-backend / auth failures with actionable guidance**
  (Medium, 2026-05-13; from pawpims): when Shepherd can't reach the project's test backend (expired
  credentials, a proxy/daemon not running — e.g. Cloud SQL proxy + `gcloud` ADC in pawpims), surface a
  clear "re-authenticate with X" message instead of failing opaquely. Detect common auth/connection
  failure patterns from the project's `wolfpack-config.md` test command and emit the project's
  documented re-auth step.

- [ ] **Tracker/Watchdog: gate on `makemigrations --check --dry-run`, not just the test suite**
  (Medium, 2026-07-01; from pawpims): Tracker runs `run_tests.sh` with `--keepdb`, which never regenerates
  the migration graph, so a model change shipped without its matching migration passes certification and
  then fails at deploy on the Dockerfile's `makemigrations --check --dry-run` build gate. Concretely: the
  `inventory-noncs-adjustment-waste` hunt (v1-preflight wave 1) created `InventoryAdjustment`/
  `InventoryAdjustmentAudit` with `AutoField` ids but not the `BigAutoField` alter; it certified green,
  then broke the v0.38.0 `deploy-dev`. Add a `makemigrations --check --dry-run` step to the Tracker (or
  Watchdog) gate for any hunt whose diff touches a `models.py`, so incomplete/missing migrations fail
  in-pipeline. The check needs no DB connection (it works from model + migration state), so it's cheap
  and hermetic.

## Hunt artifacts / retrospectives

- [ ] **Hunt notes must reproduce full reviewer findings, not just counts**
  (Low, 2026-05-13; from pawpims): a hunt retrospective must include the full Bloodhound/Pointer review
  content — severity, issue, and accepted/rejected verdict **per finding, per round** — not a summary
  count. Add an explicit gate to the retrospective/`summary` step: "for each `review-N.md`, include a
  per-finding table (severity, issue summary, verdict)." (The summarizing skill is project/harness-
  specific, but the requirement is a wolfpack-wide standard.)
