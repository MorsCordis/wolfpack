---
name: shepherd
description: Run Shepherd (implementer) against a finalized Wolfpack plan. Code only — no tests. Usage: /shepherd <slug> [--pointer-rewrite=N] [--tracker-rewrite=N]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Run the Wolfpack Shepherd for feature: $ARGUMENTS

Read the pack's `shepherd` role skill, `$PACK/.agents/skills/shepherd/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. Never run this phase without the skill. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.) It is the authoritative spec for this phase.

Hard rails:
- Do NOT push. Do NOT merge to main. Both happen via `/merge $ARGUMENTS` after Watchdog.
- Do NOT commit directly to main. Always commit on `feat/$ARGUMENTS`.
- Do NOT write or run tests — that is Tracker's job.
- The plan directory must contain `plan-final.md` AND `debrief.md` (on Green tier the skill's auto-promotion step produces `plan-final.md`). If either is missing, tell the user to run `/debrief $ARGUMENTS` first.

Begin.
