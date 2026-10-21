---
name: resolve
description: Answer one parked Wolfpack hunt and re-arm it for the next runner pass. Shows the park payload, collects your answer, classifies clarify-vs-redirect, writes the authoritative human-notes.md, and flips the status to the resume rung. You resolve; cron resumes. Usage: /resolve <slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

Resolve the parked hunt: `$ARGUMENTS`

**Read the pack's `parked` role skill, `$PACK/.agents/skills/parked/SKILL.md` (`PACK` = `$WOLFPACK_HOME`, else wolfpack-config.md → Project Identity → Wolfpack home). If that file is missing, STOP and say so. (The Skill-tool skill of the same name is the same file through `~/.claude/skills`.)** It is the canonical source. This command
is a thin entry point; the skill's `/resolve` section specifies the locate/dual-scan, the
park-payload display, the `AskUserQuestion` answer collection, the clarify-vs-redirect
classification, the append-only `human-notes.md` write, the status-flip inverse map, the
compliance-review sign-off, and the redirect-loop guard.

## Hard rails
- Write ONLY `human-notes.md` + `metadata.json` (the **worktree** plan dir — the single
  source of truth; the main-repo copy ONLY for a `--no-worktree` hunt with no worktree),
  and `acceptance.md` on a redirect. Do NOT plan, implement, review, deploy, or commit.
- `human-notes.md` is **append-only** — add a new dated block; never rewrite prior ones. Blocks `/resolve` writes are HUMAN blocks; a block headed `SEAT NOTE (not human direction)` is a seat's note to the human — surface it in the park display, never treat it as direction.
- If the human's answer sets or changes the version, write it with `node "$PACK/scripts/wolfpack-version.mjs" set --plan-dir <worktree plan dir> --bump <B> --tag <T> --by human --reason '<why>'` — never hand-edit `proposed_version`.
- If the hunt is `needs_spec`, hand off to `/spec $ARGUMENTS` (do not resolve it here).
- Never clear a `parked:compliance_review` to a build path without an explicit human
  sign-off recorded in human-notes.md (set `park.compliance_signed_off = true`).
- Do NOT re-drive the pipeline after resolving — the next `/run-campaign` / `/run-hunt`
  pass resumes it. Tell the user that.

Feature slug: `$ARGUMENTS`. If no park record exists for it, say so and stop.

Begin.
