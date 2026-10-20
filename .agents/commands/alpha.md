---
name: alpha
description: Run Alpha (planner) on a Wolfpack hunt. Writes plan.md (initial) or plan-revised-N.md (revision after a Bloodhound review). Usage: /alpha <slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
---

Run the Wolfpack Alpha for feature: $ARGUMENTS

Read the pack's `alpha` role skill, `$PACK/.agents/skills/alpha/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. Never run this phase without the skill. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.) It is the authoritative spec for this phase.

## Hard rails
- Do NOT modify files outside `.wolfpack/plans/$ARGUMENTS/` except `metadata.json`.
- Do NOT read `docs/wolfpack*.md`, other hunts' plan dirs, or `*-raw.log` files.
- Do NOT commit. Do NOT invoke other seats (Bloodhound / Shepherd / Watchdog are separate slash commands).
- If the plan directory does not exist, tell the user to run `/hunt $ARGUMENTS "<description>"` first.

Begin.
