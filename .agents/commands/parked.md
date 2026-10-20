---
name: parked
description: Show the Wolfpack work queue — every hunt across all campaigns awaiting a human (parked:<reason> or needs_spec), sorted by severity then age. Read-only. Usage: /parked
allowed-tools: Bash, Read, Glob, Grep
---

Show the parked-hunt inbox.

**Read the pack's `parked` role skill, `$PACK/.agents/skills/parked/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.)** It is the canonical source. This command
is a thin entry point; the skill's `/parked` section specifies the dual-scan, the orphan
check, the severity sort, and the output format.

## Hard rails
- READ-ONLY. Do NOT modify, create, or delete anything.
- Scan BOTH `.wolfpack/plans/*/` and `$WT_ROOT/*/.wolfpack/plans/*/`; de-dupe by slug.
- **Worktree root (`WT_ROOT`).** In the main checkout run `node "$PACK/scripts/wolfpack-config.mjs" --json` and take `worktreeRoot` (wolfpack-config.md → Project Identity → Worktree root, repo-relative). If the reader exits 2 or `worktreeRoot` is null, STOP with the fix: "add ``- **Worktree root:** `<repo-relative dir, e.g. .agents/worktrees>` `` under ## Project Identity in wolfpack-config.md". Never assume a default location.
- Include `needs_spec` hunts (no parked.md — read it from metadata).

Begin.
