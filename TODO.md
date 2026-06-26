# Wolfpack — Tooling Backlog

Open framework/tooling items. Project-specific debt lives in each consumer's own `TODO.md`;
this file holds work on the **generic** pipeline (orchestration layer, router, role skills,
hunt artifacts). Items migrated from `pawpims/TODO.md` during the consumer cutover (2026-06-23)
keep their original filing dates.

## Orchestration layer

- [ ] **Heartbeat: write to an absolute mount path so the host can observe post-Scaffold phases**
  (Low, 2026-05-29; from pawpims): the per-hunt heartbeat in `hunt-pipeline.js` writes a *relative*
  `.wolfpack/heartbeats/<slug>.json`. Every phase after Scaffold runs inside the worktree, so those
  writes land in `<worktree>/.wolfpack/heartbeats/` and the host-watched main-workspace files freeze
  at `Scaffold` forever (confirmed live on the first `v1-push-3` autonomous run). **Fix:** write the
  absolute container mount path (`/workspace/.wolfpack/heartbeats/<slug>.json`) so every phase is
  visible from one host-side glob regardless of cwd. Applies to the reference `hunt-pipeline.js` AND
  the DevDen Python orchestrator reimplementation.

- [ ] **Handoff validation + retry-before-park (stop spurious parks on malformed phase output)**
  (Medium, 2026-06-26; from Spark bench): a malformed Bloodhound output parked a hunt that should
  have just retried. Add to the orchestration loop: (1) a **per-phase output validator** (schema/
  format check on `review-N.md` verdict, `plan.md` predicted_dimensions, `metadata.json` fields);
  (2) a **pre-handoff gate** — if `validate(P.output)` fails, **re-run P with a corrective nudge**
  (the required format) up to N≈2, and **park only after retries exhaust**; (3) **next-phase
  kick-back** — downstream preflight validates its input and emits `kickback:<phase>` to re-trigger
  upstream if malformed. Fits the DevDen §1 deterministic-control-plane gates. **DEFERRED until the
  model benchmarks complete** (2026-06-26 decision — individual benchmarks first). Applies to
  `hunt-pipeline.js` AND the DevDen Python orchestrator.

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

## Hunt artifacts / retrospectives

- [ ] **Hunt notes must reproduce full reviewer findings, not just counts**
  (Low, 2026-05-13; from pawpims): a hunt retrospective must include the full Bloodhound/Pointer review
  content — severity, issue, and accepted/rejected verdict **per finding, per round** — not a summary
  count. Add an explicit gate to the retrospective/`summary` step: "for each `review-N.md`, include a
  per-finding table (severity, issue summary, verdict)." (The summarizing skill is project/harness-
  specific, but the requirement is a wolfpack-wide standard.)
