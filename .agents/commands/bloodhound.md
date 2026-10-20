---
name: bloodhound
description: Run Bloodhound (adversarial plan reviewer) for one review round. Writes review-N.md. Usage: /bloodhound <slug>
allowed-tools: Bash, Read, Write, Edit, Agent, Glob, Grep
---

Run Bloodhound (adversarial plan review) for feature: $ARGUMENTS

Read the pack's `bloodhound` role skill, `$PACK/.agents/skills/bloodhound/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. Never run this phase without the skill. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.) It is the authoritative spec for this phase.

## Hard rails
- READ-ONLY — interactive: your only writes are `review-N.md` and `metadata.json` in the plan directory; headless seat: ONLY the one handoff file at the out-dir path the pipeline prompt names, never `metadata.json` (it is orchestrator-written).
- Do NOT read `docs/wolfpack*.md`, other hunts' plan dirs, or `*-raw.log` files.
- Do NOT commit.
- Do NOT auto-approve — if the plan looks perfect, probe harder before saying APPROVED.
- If the plan directory holds no `plan.md` or `plan-revised-*.md`, tell the user to run `/alpha $ARGUMENTS` first.

Begin.
