---
name: parked
description: Show the Wolfpack work queue — every hunt across all campaigns awaiting a human (parked:<reason> or needs_spec), sorted by severity then age. Read-only. Usage: /parked
allowed-tools: Bash, Read, Glob, Grep
---

Show the parked-hunt inbox.

**Read `.claude/skills/parked/SKILL.md` now — it is the canonical source.** This command
is a thin entry point; the skill's `/parked` section specifies the dual-scan, the orphan
check, the severity sort, and the output format.

## Hard rails
- READ-ONLY. Do NOT modify, create, or delete anything.
- Scan BOTH `.wolfpack/plans/*/` and `.claude/worktrees/*/.wolfpack/plans/*/`; de-dupe by slug.
- Include `needs_spec` hunts (no parked.md — read it from metadata).

Begin.
