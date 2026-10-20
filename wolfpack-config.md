# Wolfpack Project Configuration — wolfpack (the pack itself)

Pipeline-facing rules for hunts hosted in this repo. Public repository: everything tracked is world-readable.

## Project Identity
- **Name:** wolfpack (multi-agent hunt pipeline; public)
- **Language/Framework:** Node.js ESM scripts (no dependencies), Bash, Markdown commands/skills, Claude Code Workflow scripts
- **Repo root:** auto-detected from git
- **Test command:** `bash scripts/test-all.sh` — the single entry point: every `scripts/**/*.test.mjs`, every `scripts/**/*.test.sh`, and the leak grep. Narrow while iterating with `node --test scripts/<file>.test.mjs`. Podman-dependent tests print `SKIP: needs podman` when podman is absent or `WOLFPACK_TEST_NO_PODMAN=1`.
- **Worktree links:** none
- **Worktree root:** `.agents/worktrees` — where /hunt and the pipeline create hunt worktrees (repo-relative).
- **Project commands:** none — the pack itself (its .claude/commands is the link to .agents/commands).
- **Deploy command (dev):** none — the pack is not deployed; consumers install it.
- **Deploy command (prod):** none.
- **Vault root:** `~/Vault`
- **Wolfpack home:** `~/Projects/wolfpack` — this checkout; `WOLFPACK_HOME` overrides. The workflows, the sandbox launcher and the seat shim resolve the execution layer from it.

## Hard Rules (agents will be fired for violating these)
1. No private identifiers in any tracked file — no consuming-project names, private domains, home-directory paths, operator emails or org names. `scripts/wolfpack-leak-grep.sh` enforces it in CI; a deliberate leak-assertion needs an allow-list entry (path + justification) AND an inline `leak-grep:allow` marker.
2. Conventional commits (`feat|fix|test|docs|chore(scope): …`).
3. Merge with `--no-ff`; never commit to `main` directly — branch first.
4. Push to `origin` only.
5. Stage files by name — never `git add .` / `-A` / `--all`.
6. Fail loud: a missing config key, shim, script or seat is a visible error/park, never a silent default or a Claude substitution.
7. Byte-identical cores stay byte-identical (e.g. the `wolfpack-chain core` block in `scripts/wolfpack-chain.mjs` ⇄ `.agents/workflows/campaign-runner.js`).

## Compliance Requirements
- **Compliance areas:** none — tooling repo; no regulated data. (Public-repo hygiene is Hard Rule 1, not a compliance area.)
- **Risk-surface paths:** none

## Code Review Checklist (Pointer uses this)
- Every behaviour change ships with a test in `scripts/*.test.mjs` / `*.test.sh`, runnable from `scripts/test-all.sh`.
- Workflow scripts (`.agents/workflows/*.js`) have no filesystem access: any file-derived value comes through a probe agent and is validated (fail closed).
- No new hard-coded consuming-project value (paths, commands, domains, compliance surfaces) — it becomes a `wolfpack-config.md` key read via `scripts/wolfpack-config.mjs`.
- Generated consumer workflow copies are never hand-edited: `bash install.sh --consumer <repo>` regenerates them, and the run start refuses a stale or edited copy.
- Leak grep clean (`bash scripts/wolfpack-leak-grep.sh`).

## Plan Review Checklist (Bloodhound uses this)
- Cross-repo effects named: which consumer copies regenerate, which consumer config keys a change requires.
- The running session caches named workflows: a workflow change takes effect only for the NEXT run. The run start logs the running script's stamped version; a mismatch stops the run with "restart Claude Code".
- Review seats may lack `node` in their sandbox image: plans must not depend on a review seat running node suites.

## Multi-Tenancy
- Not applicable.

## Model Pool
### Family → model mapping
- judgment    → claude:opus:high     # planner (fixed) + heavy/Orange/Red implementer + Tracker default
- work-horse  → claude:opus:high     # light-tier implementer (Sonnet stays off until enabled — see TODO.md "Sonnet re-entry")
- reviewer-a  → glm:5.3 gate=WOLFPACK_ENABLE_GLM          # first examiner-chain link (WOLFPACK_ENABLE_GLM=0 disables)
- reviewer-b  → mistral:large-4 gate=WOLFPACK_ENABLE_MISTRAL_AUTO  # second link (WOLFPACK_ENABLE_MISTRAL_AUTO=0 disables)
- coder-alt   → glm:5.3 gate=WOLFPACK_ENABLE_GLM          # optional Shepherd on Green/Blue/Yellow non-compliance hunts
### Hard constraints (enforced by the router — never relax)
- Alpha is ALWAYS the judgment family (load-bearing planner).
- Reviewers (Bloodhound, Pointer, Watchdog) are NEVER an implementer family —
  adversarial review must be CROSS-FAMILY from the implementer.
- Pointer/Watchdog family ≠ Shepherd family.
- CHAIN RULE: each review seat walks the ordered examiner chain (reviewer-a → reviewer-c →
  reviewer-b, filtered by what is enabled) with the WRITER's family removed, falling to the
  next link on a rate limit; chain exhausted → park. A coder-alt Shepherd therefore removes
  its own family from the Pointer/Watchdog chains. A seat never reviews its own family's work.
- Claude is the last-resort link that hunt-pipeline appends to a chain, never a pool reviewer.

## Module Map
- `.agents/workflows` ← "hunt-pipeline", "campaign-runner", "workflow", "orchestrator"
- `.agents/commands` ← "command", "slash command", "/hunt", "/merge", "/smoke"
- `.agents/skills` ← "skill", "role skill", "alpha", "bloodhound", "shepherd", "pointer", "tracker", "watchdog", "spec"
- `scripts` ← "router", "routing", "toolcheck", "usage gate", "window gate", "pedigree", "chain", "release", "leak grep", "test-all", "config reader"
- `vibe-agents` ← "seat profile", "Vibe agent"
- `hooks` ← "hook", "guard"
- `.github/workflows` ← "CI"
- `.wolfpack` ← "pedigree", "baseline", "known-broken", "cross-cutting debt"

## Deployment Notes
- Dev deploy command: none
- Migration command: none
- Migration file pattern: none
- Deploy-before-migrate: no
- Changelog file: `CHANGELOG.md`
- Backlog file: `TODO.md`
- Tag pattern: `v[0-9]*` (semver per campaign wave; `/merge-wave` stamps `## [Unreleased]` → `## [vX.Y.Z]`)
- Dev URL: none · Prod URL: none · Never-smoke hosts: none — nothing is deployed; `/smoke-wave` does not apply.
- Smoke login hook: none — nothing is deployed.

## Execution Layer
- **Sandbox image:** `wolfpack-pack-sandbox:latest` — the pack's own seat image (project-neutral base, no layer), named apart from any consuming project's image because podman tags are host-global.
- **GLM image:** `wolfpack-pack-sandbox-glm:latest`
- **Sandbox project layer:** none — the pack needs only the base image.
- **Seat extra mounts:** none
- **Sandbox extra mounts:** none
- **Secrets paths:** `~/.secrets`
- **Vibe agent dir:** `~/.vibe/agents-headless`
- **Seat test env:** none

## Existing Patterns
- Workflow harness tests: `scripts/wolfpack-hunt-pipeline.test.mjs` (`runHunt` + label-prefix answer table; real CLIs run against temp fixtures, e.g. `realToolcheck`).
- Temp-repo CLI tests: `scripts/wolfpack-chain.test.mjs`.
- Probe-agent + fail-closed preflight: `hunt-pipeline.js` seat toolcheck preflight.
- Config reader: `scripts/wolfpack-config.mjs` (`node scripts/wolfpack-config.mjs --json` validates this file).
