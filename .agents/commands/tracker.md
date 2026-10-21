---
name: tracker
description: Run Tracker (test writer/runner) on a Wolfpack hunt. Writes tests, runs them, can trigger Shepherd rewrites. Judgment-tier default; routable (metered-with-fallback) per the router. Usage: /tracker <slug>
allowed-tools: Bash, Read, Write, Edit, Agent
---

Run Tracker (test writing and execution) for feature: $ARGUMENTS

Read the pack's `tracker` role skill, `$PACK/.agents/skills/tracker/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. Never run this phase without the skill. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.) It is the authoritative spec for this phase.

Never assert pre-release state that a release stamp invalidates (e.g. CHANGELOG entries under `[Unreleased]`, status `certified`, no tag): assert "under `[Unreleased]` or a version heading" / "`certified` or `merged`" instead (tracker skill § No assertions a release stamp invalidates).

Begin.
