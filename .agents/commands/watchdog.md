---
name: watchdog
description: Run Watchdog certification against a feature's plan directory. Usage: /watchdog <slug>
allowed-tools: Bash, Read, Write, Edit, Agent, Glob, Grep
---

Run the Wolfpack Watchdog for feature: $ARGUMENTS

Read the pack's `watchdog` role skill, `$PACK/.agents/skills/watchdog/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. Never run this phase without the skill. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.) It is the authoritative spec for this phase.

## Hard rails
- Do NOT re-score `predicted_dimensions` — copy them verbatim from `metadata.json` to `pedigree.json`.
- Do NOT certify PASS while transient infra failures (auth, network) mask real test results — PAUSE and tell the user.
- Do NOT handle version tagging (`/merge` owns the tag).
- Test evidence is the pipeline's SHA-stamped record `<plan dir>/test-record-tracker.json`. When its `commit` equals `git rev-parse HEAD`, cite it and audit its log; do NOT re-run the full suite. Re-run the project's test command only when the record is missing or its commit differs from HEAD.
- The pedigree index lives at the main checkout root (`$(dirname "$(git rev-parse --git-common-dir)")/.wolfpack/pedigree/index.md`), even from a worktree.

Begin.
