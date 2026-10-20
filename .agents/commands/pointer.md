---
name: pointer
description: Run Pointer (adversarial code reviewer) on a Wolfpack hunt. Reviews the implementation diff. Usage: /pointer <slug>
allowed-tools: Bash, Read, Write, Edit, Agent
---

Run Pointer (adversarial code review) for feature: $ARGUMENTS

Read the pack's `pointer` role skill, `$PACK/.agents/skills/pointer/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. Never run this phase without the skill. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.) It is the authoritative spec for this phase.

Begin.
