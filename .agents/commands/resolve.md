---
name: resolve
description: Answer one parked Wolfpack hunt and re-arm it for the next runner pass. Shows the park payload, collects your answer, classifies clarify-vs-redirect, writes the authoritative human-notes.md, and flips the status to the resume rung. You resolve; cron resumes. Usage: /resolve <slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

Resolve the parked hunt: `$ARGUMENTS`

**Read `.claude/skills/parked/SKILL.md` now — it is the canonical source.** This command
is a thin entry point; the skill's `/resolve` section specifies the locate/dual-scan, the
park-payload display, the `AskUserQuestion` answer collection, the clarify-vs-redirect
classification, the append-only `human-notes.md` write, the status-flip inverse map, the
compliance-review sign-off, and the redirect-loop guard.

## Hard rails
- Write ONLY `human-notes.md` + `metadata.json` (the **worktree** plan dir — the single
  source of truth; the main-repo copy ONLY for a `--no-worktree` hunt with no worktree),
  and `acceptance.md` on a redirect. Do NOT plan, implement, review, deploy, or commit.
- `human-notes.md` is **append-only** — add a new dated block; never rewrite prior ones.
- If the hunt is `needs_spec`, hand off to `/spec $ARGUMENTS` (do not resolve it here).
- Never clear a `parked:compliance_review` to a build path without an explicit human
  sign-off recorded in human-notes.md (set `park.compliance_signed_off = true`).
- Do NOT re-drive the pipeline after resolving — the next `/run-campaign` / `/run-hunt`
  pass resumes it. Tell the user that.

Feature slug: `$ARGUMENTS`. If no park record exists for it, say so and stop.

Begin.
