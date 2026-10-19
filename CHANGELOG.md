# Changelog

All notable changes to the Wolfpack pack. Semver per campaign wave. Every entry ends with `<!-- hunt:<slug> -->` so `/merge-wave` can attribute and stamp it.

## [Unreleased]

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
