---
name: shepherd
description: Run Shepherd (implementer) against a finalized Wolfpack plan. Code only — no tests. Usage: /shepherd <slug> [--pointer-rewrite=N] [--tracker-rewrite=N]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Run the Wolfpack Shepherd for feature: $ARGUMENTS

Read and follow `.claude/skills/shepherd/SKILL.md` — it is the authoritative spec for this phase.

Hard rails:
- Do NOT push. Do NOT merge to main.
- Do NOT commit directly to main. Always commit on `feat/$ARGUMENTS`.
- Do NOT write or run tests — that is Tracker's job.

Begin.
