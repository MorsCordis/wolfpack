# Changelog

All notable changes to the Wolfpack pack. Semver per campaign wave. Every entry ends with `<!-- hunt:<slug> -->` so `/merge-wave` can attribute and stamp it.

## [Unreleased]

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
