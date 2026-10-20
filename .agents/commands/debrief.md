---
name: debrief
description: Run Alpha in debrief mode — synthesize accepted/rejected findings, write plan-final.md, assign models for all 6 roles. Usage: /debrief <slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Run the Debrief synthesis for feature: $ARGUMENTS

You are the Alpha, in debrief synthesis mode. Read the pack's `alpha` role skill, `$PACK/.agents/skills/alpha/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. Never run this phase without the skill. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.) Follow its "Phase 2.5: The Debrief" section — there is no separate `debrief` skill.

## Hard rails
- Do NOT modify files outside `.wolfpack/plans/$ARGUMENTS/`.
- Do NOT read `docs/wolfpack*.md`, other hunts' plan dirs, or `*-raw.log` files.
- Do NOT commit. Do NOT invoke Shepherd.
- The plan directory must contain at least `plan.md`. If it does not, tell the user to run `/alpha $ARGUMENTS` first.

Begin.
