---
name: parked
description: Park / resolve / resume for Wolfpack hunts. Use when a hunt halted for a human (status needs_spec or parked:<reason>) and you need to see the work queue (/parked) or answer and re-arm a parked hunt (/resolve). Covers the hunt state model, the parked.md payload, clarify-vs-redirect, the human-notes.md override channel, the redirect-loop guard, the compliance-review sign-off, and stale-park recovery.
---

# Park / Resolve / Resume Skill

A hunt that can't safely proceed **halts cleanly, surfaces exactly what it needs from you, and resumes autonomously once you answer** — without you re-driving the pipeline.

Commands:
- **`/parked`** — your inbox: every hunt awaiting you
- **`/resolve <slug>`** — answer one parked hunt and re-arm it

Rule: **you resolve; cron resumes.** The runner only touches `ready`/in-flight hunts; you only touch human states.

## Hunt state model
One `status` field drives both cron and your work queue:

```
needs_spec            awaiting spec interview        (YOU)
ready / <in-flight>   actionable / mid-pipeline           (cron)
running               in pipeline                         (auto)
parked:<reason>       halted, needs you                   (YOU)
certified             done, in release queue             (YOU)
merged                terminal
```

`parked:<reason>` reasons (severity high → low):

| icon | reason | meaning | typical resolution |
|---|---|---|---|
| ⛔ | `open_critical` | CRITICAL survived review budget | clarify (out of scope) or redirect (re-plan) |
| 🔒 | `compliance_review` | diff touched CS/billing/records | clarify (sign off) or redirect (defect) |
| 🔁 | `non_convergence` | review loop never converged | clarify (proceed) or redirect (rework) |
| 🐛 | `repro_failed` | bug not reproducible | clarify (more detail) or redirect |
| ⏳ | `model_quota` | rate-limited | re-run later |
| 🚧 | `smoke_pending_human` | un-runnable smoke criteria | run manual criteria |
| ⚠ | `rebase_conflict` | Shepherd rebase failed | resolve conflict, then resume |
| ❓ | `needs_spec` | Spec parked low-confidence/ambiguous | answer spec questions |

`needs_spec` is shown by `/parked` but resolved by **`/spec <slug>`**, not `/resolve`.

## Where artifacts live
- **`parked.md`** — park payload: exact question + context
- **`metadata.json` `park` block** — `{ reason, parked_at, resume_phase, resolution_type, tier, human_notes_seen, redirect_count?, compliance_signed_off? }`
- **`human-notes.md`** — authoritative channel the resumed run reads. Append-only (latest dated block wins).

These live in the hunt's plan dir. The **worktree plan dir is authoritative** — pipeline writes park state there.

DISCOVERY dual-scans BOTH locations:
- `.agents/worktrees/<slug>/.wolfpack/plans/<slug>/` (worktree — authoritative)
- `.wolfpack/plans/<slug>/` (main repo — only for `--no-worktree` hunts)

When a worktree exists, it is authoritative and the **only** write target.

---

## `/parked` — the inbox
Read-only. Never modifies anything.

1. **Dual-scan** for parked hunts: glob `parked.md` under both `.wolfpack/plans/*/` and `.agents/worktrees/*/.wolfpack/plans/*/`. Also scan `metadata.json` for `status == "needs_spec"`. De-duplicate by slug.
2. For each, read `reason`, `parked_at`, `resume_phase` from parked.md (and `spec.confidence` / question count from metadata for `needs_spec`).
3. **Orphan check:** if parked.md references a worktree that no longer exists, flag it `(orphaned — worktree removed)`.
4. **Sort** by reason severity (table above), then oldest `parked_at` first.
5. Print one line per hunt:

```
PARKED HUNTS (3)
  ⛔ unfinalize-restore   open_critical      2h ago   "CRITICAL #4 unresolved after 5 rounds"
  ❓ scheduling-polish    needs_spec         9h ago   "3 questions — drag, default view, mobile"
  🔁 invoice-bundle       non_convergence    1h ago   "Pointer never approved"

Resolve with:  /resolve <slug>   (or /spec <slug> for needs_spec)
```

If nothing is parked: `No parked hunts — the queue is clear.`

---

## `/resolve <slug>` — answer and re-arm
1. **Locate** the hunt (dual-scan). If `needs_spec`, stop and tell user to run `/spec <slug>`. If no park record exists, say so and stop.
2. **Orphaned worktree?** If parked.md exists but worktree is gone, offer to re-scaffold (`/hunt <slug>`) before resolving.
3. **Show the park payload** — print parked.md verbatim (reason, question, context, Options).
4. **Collect the answer** via `AskUserQuestion`. If parked.md has `## Options` block, use them as choices (always include "Other").
5. **Classify the resolution** — infer `clarify` vs `redirect` from the answer, CONFIRM with user if ambiguous (payload's `resolution_type_expected` is default):
   - **`clarify`** — your answer resolves the local issue WITHOUT invalidating the plan (e.g. "out of scope", "sign off", "proceed"). Resume **in place**, at or just past `resume_phase`.
   - **`redirect`** — your answer changes intent / invalidates the plan (e.g. "fix it", "actually I wanted X"). Rewind to **Plan** with corrected `acceptance.md`.
6. **Write `human-notes.md`** (append-only) to BOTH plan dirs. New dated block each time:

   ```markdown
   ## <ISO8601> — resolution: <clarify|redirect>
   Park reason: <reason>
   Question: <the payload question>
   Human answer: <verbatim>
   Direction for the resumed run: <one or two sentences the resumed agent must honor>
   ```

   This is the channel the resumed phase reads FIRST. Be concrete and imperative ("Treat finding #4 as out of scope — do not re-raise it").
7. **Flip the status** in the **worktree** `metadata.json` (single source of truth; main copy only for `--no-worktree` hunt):
   - Clear `park.reason`, set `park.resolution_type`, set `park.human_notes_seen = false`
   - Set top-level `status` using this map:

   | resume target | set `status` to |
   |---|---|
   | Plan | `ready_for_alpha` |
   | Review | `reviewing` |
   | Debrief | `reviewed` |
   | Implement | `ready` (or `rework_needed`) |
   | Code Review | `implementing_done` |
   | Test | `code_reviewed` |
   | Certify | `tested` |
   | Verify | `certified` |

   - **clarify (proceed):** set status to the rung JUST PAST the contested gate (e.g. `open_critical` "out of scope" → `reviewed`; `non_convergence` "proceed" → `code_reviewed`).
   - **clarify (rework, no re-plan):** send back one rung (e.g. `non_convergence` "fix it" → `rework_needed`).
   - **redirect:** increment `park.redirect_count` by 1, set `status = ready_for_alpha` (resume at **Plan**), update `acceptance.md`. If count reaches **3**, apply redirect-loop guard instead.

### Compliance-review sign-off (`parked:compliance_review`)
This park resumes at **Verify**. On **clarify (sign off):** set `status = certified`, set `park.compliance_signed_off = true`, record sign-off in human-notes.md. On **redirect (defect found):** treat as normal redirect → Plan with corrected acceptance.md, do NOT set `compliance_signed_off`.

### Redirect-loop guard
A `redirect` increments `park.redirect_count`. If this is the **third** redirect to Plan for the same hunt, do NOT redirect again — the ticket is the problem. Set `status = needs_spec` and tell user the hunt needs a fresh `/spec` (re-interview).

### Finish
Tell the user: "`<slug>` re-armed (`<resolution_type>` → resume at `<phase>`). The next `/run-campaign` (or `/run-hunt <slug>`) pass picks it up." Do NOT run the pipeline yourself.

---

## Hard rails
- `/parked` is **read-only** — it never writes
- `/resolve` writes ONLY `human-notes.md` and `metadata.json` (worktree plan dir — single source of truth; main copy only for `--no-worktree` hunt), and `acceptance.md` on a redirect. It does NOT plan, implement, review, deploy, or commit.
- `human-notes.md` is **append-only** — never rewrite or truncate prior blocks
- Never flip a `parked:compliance_review` to a build path without explicit human sign-off recorded in human-notes.md
- Always `date -u` for timestamps — never guess a time
