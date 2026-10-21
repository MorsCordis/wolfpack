---
name: parked
description: Park / resolve / resume for Wolfpack hunts. Use when a hunt halted for a human (status needs_spec or parked:<reason>) and you need to see the work queue (/parked) or answer and re-arm a parked hunt (/resolve). Covers the hunt state model, the parked.md payload, clarify-vs-redirect, the human-notes.md override channel, the redirect-loop guard, the compliance-review sign-off, and stale-park recovery.
---

# Park / Resolve / Resume Skill

A hunt that can't safely proceed **halts cleanly, surfaces exactly what it needs from
you, and resumes autonomously once you answer** — without you re-driving the pipeline.
This skill backs the two human-checkpoint commands:

- **`/parked`** — your inbox: every hunt across all campaigns awaiting you.
- **`/resolve <slug>`** — answer one parked hunt and re-arm it for the next runner pass.

The rule the whole layer enforces: **you resolve; cron resumes.** The runner only touches
`ready`/in-flight hunts; you only touch the human states. See
`docs/autonomy/02-park-resolve-resume.md` for the full design.

## The hunt state model

One `status` field drives both the cron driver and your work queue:

```
needs_spec            awaiting your spec interview        (YOU)   [01]
ready / <in-flight>   actionable / mid-pipeline           (cron)
running               in pipeline                         (auto)
parked:<reason>       halted, needs you                   (YOU)
certified             done, in the release queue          (YOU, batched) [04]
merged_to_campaign[_pending_compliance]  chain-mode done, awaiting the campaign release
merged                terminal
```

`parked:<reason>` reasons (severity high → low, the `/parked` sort order):

| icon | reason | meaning | typical resolution |
|---|---|---|---|
| ⛔ | `open_critical` | a CRITICAL survived its review budget | clarify (out of scope) or redirect (re-plan) |
| 🔒 | `compliance_review` | diff touched a declared risk surface (wolfpack-config.md → Risk-surface paths) | clarify (sign off) or redirect (defect) |
| 🔁 | `non_convergence` | a review loop never converged | clarify (proceed) or redirect (rework) |
| 🐛 | `repro_failed` | bug not reproducible [01] | clarify (more repro detail) or redirect |
| 🩹 | `human_patch` | the plan changes a protected agent-config file (`.claude/hooks/`, `.claude/settings*.json`) that agents cannot edit; the Shepherd staged it in `human-patches/` | apply + commit the patches (commands in parked.md), then clarify → resume at **Code Review** (`implementing_done`) |
| 🧩 | `shim_missing` | a cross-family seat shim (e.g. `podman-vibe.sh`) does not exist at the resolved path; no non-Claude seat can run, and Claude is never substituted | provide the shim (the pack's execution layer), or disable the Vibe families (`WOLFPACK_ENABLE_GLM=0 WOLFPACK_ENABLE_MISTRAL_AUTO=0`), then `/resolve` (redirect, as the park expects) → resumes at the parked phase |
| ⏳ | `model_quota` | both cross-model CLIs rate-limited [05] — also parked at a phase boundary when the usage window is near exhaustion (auto-resumes at that phase) | usually just re-run later |
| 📉 | `usage_gate_error` | the boundary usage gate itself failed before a phase (an invalid `WOLFPACK_*` threshold env, or a gate crash) | fix the env/gate, then `/resolve` (redirect) → resumes at that phase |
| 🧪 | `test_record_error` | the pipeline could not trust its SHA-stamped test record (record-script infra error, SHA or test-command mismatch) | fix the cause, then `/resolve` (redirect) → resumes at Test / Verify, which re-takes the record |
| 🧯 | `final_test_record_failed` | the full suite fails at the final HEAD after the certify commit; the hunt is NOT mergeable | fix the break on `feat/<slug>`, then `/resolve` (redirect) → resumes at **Verify** (the record is re-taken) |
| 📋 | `pedigree_incomplete` | the certifier PASSED but its `pedigree.json` lacks the Watchdog scores or `certifier_verdict`, so `wolfpack-pedigree.mjs index-row` refused to write the index row (no dashed row is ever written) | clarify → re-run Certify (the seat rewrites a complete `pedigree.json`) |
| 🧩 | `cert_shim_probe_failed` | Certify could not determine which seat shim to use (whether the hunt's own diff changes the shim) | clarify → re-run Certify (`tested`) |
| 🚧 | `smoke_pending_human` | wave smoke has un-runnable criteria [04] | run the manual criteria |
| ⚠ | `rebase_conflict` | Shepherd rebase failed | resolve the conflict, then resume |
| 🔀 | campaign_merge_conflict | chain auto-merge into campaign/<slug> conflicted | resolve: rebase feat/<slug> onto the campaign branch in its worktree, then clarify (resumes at Code Review) |
| ↩ | reverted_from_campaign | reverted out of campaign/<slug> (smoke/review) | redirect or clarify with the fix; resumes at Implement on the rebuilt branch |
| ❓ | `needs_spec` | Spec parked a low-confidence/ambiguous hunt [01] | answer the spec questions |

`needs_spec` is shown by `/parked` but is resolved by re-running **`/spec <slug>`** (the
interview command), not `/resolve` — `/resolve` will hand you off to `/spec` if you point
it at a `needs_spec` hunt.

## Where the artifacts live

- **`parked.md`** — the park payload, written by the pipeline when it halts. Quotes the
  exact question + context so you can decide without opening the worktree.
- **`metadata.json` `park` block** — `{ reason, parked_at, resume_phase, resolution_type,
  tier, human_notes_seen, redirect_count?, compliance_signed_off? }`.
- **`human-notes.md`** — the authoritative channel the resumed run reads. `/resolve`
  writes it; it is **append-only** (latest dated block wins, history preserved).

These live in the hunt's plan dir. The **worktree plan dir is the single source of
truth** — the pipeline writes park state there and nowhere else (no main-repo mirror).
DISCOVERY still **dual-scans** BOTH locations, because a `--no-worktree` hunt (and any
legacy pre-worktree-canonical park) lives only in the main repo:

- `.agents/worktrees/<slug>/.wolfpack/plans/<slug>/` (the live worktree copy — authoritative)
- `.wolfpack/plans/<slug>/` (main repo — only for `--no-worktree` hunts, or legacy parks)

When a worktree exists, it is authoritative and is the **only** write target. `/resolve`
writes human-notes.md and the status flip to the **worktree** plan dir; it writes the
main copy ONLY for a `--no-worktree` hunt (one with no worktree dir). It never writes
both — writing a main mirror when a worktree exists is exactly the split this avoids.

---

## `/parked` — the inbox surface

Read-only. Never modifies anything.

1. **Dual-scan** for parked hunts: glob `parked.md` under both `.wolfpack/plans/*/` and
   `.agents/worktrees/*/.wolfpack/plans/*/`. Also scan `metadata.json` for
   `status == "needs_spec"` (those have no parked.md — they parked in Spec).
   De-duplicate by slug (a hunt present in both locations is ONE entry).
2. For each, read `reason`, `parked_at`, `resume_phase` from parked.md (and
   `spec.confidence` / question count from metadata for `needs_spec`).
3. **Orphan check:** if parked.md references a worktree that no longer exists
   (`.agents/worktrees/<slug>/` is gone), flag it `(orphaned — worktree removed)`.
4. **Sort** by reason severity (table order above), then oldest `parked_at` first.
5. Print one line per hunt:

```
PARKED HUNTS (3)
  ⛔ unfinalize-restore   open_critical      2h ago   "CRITICAL #4 (CS disposition) unresolved after 5 rounds"
  ❓ scheduling-polish    needs_spec         9h ago   "3 questions — drag behavior, default view, mobile"
  🔁 invoice-bundle       non_convergence    1h ago   "Pointer never approved — tax-rounding finding"

Resolve with:  /resolve <slug>   (or /spec <slug> for needs_spec)
```

If nothing is parked: `No parked hunts — the queue is clear.`

---

## `/resolve <slug>` — answer and re-arm

**Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.

1. **Locate** the hunt (dual-scan). If it's `needs_spec`, stop and tell the user to run
   `/spec <slug>` instead (the spec interview is the right channel). If no park record
   exists at all, say so and stop.
2. **Orphaned worktree?** If parked.md exists but the worktree is gone, offer to
   re-scaffold (`/hunt <slug>` re-creates the worktree from the branch) before resolving;
   resume needs the worktree.
3. **Show the park payload** — print parked.md verbatim (reason, the question, the quoted
   context, and any Options). Also surface any `SEAT NOTE (not human direction)` blocks in
   `human-notes.md` (a seat disagreeing with a human-set version): they are notes TO the human,
   never direction — the human decides whether to act on one.
4. **Collect the answer** via `AskUserQuestion`. If parked.md has an `## Options` block,
   use them as the choices (always include the implicit "Other" for free text). Frame the
   question from the payload's "What I need from you".
5. **Classify the resolution** — infer `clarify` vs `redirect` from the answer, and CONFIRM
   with the user (a second quick `AskUserQuestion` if it's ambiguous; the payload's
   `resolution_type_expected` is the default):
   - **`clarify`** — your answer resolves the local issue WITHOUT invalidating the plan
     (e.g. "that finding is out of scope", "sign off — it's compliant", "proceed"). Resume
     **in place**, at or just past `resume_phase`.
   - **`redirect`** — your answer changes intent / invalidates the plan (e.g. "the finding
     is real, fix it", "actually I wanted X not Y"). Rewind to **Plan** (or Spec) with a
     corrected `acceptance.md`.
6. **Write `human-notes.md`** (append-only) to BOTH plan dirs. New dated block each time:

   ```markdown
   ## <ISO8601 — run `date -u +%Y-%m-%dT%H:%M:%SZ`> — resolution: <clarify|redirect>
   Park reason: <reason>
   Question: <the payload question>
   Human answer: <verbatim — what the user chose / typed>
   Direction for the resumed run: <one or two sentences the resumed agent must honor>
   ```

   Blocks written by `/resolve` are HUMAN blocks. If the answer sets or changes the version,
   also write it with `node "$PACK/scripts/wolfpack-version.mjs" set --plan-dir <worktree plan dir> --bump <B> --tag <T> --by human --reason '<why>'`
   (never hand-edit `proposed_version`; `--by human` records `set_by: "human"`, which seats
   cannot override).

   This is the channel the resumed phase reads FIRST and treats as overriding prior
   assumptions. Be concrete and imperative ("Treat finding #4 as out of scope — do not
   re-raise it"; "The intent is X; re-plan accordingly").
7. **Flip the status** in the **worktree** `metadata.json` (the single source of truth;
   for a `--no-worktree` hunt, the main copy) — clear `park.reason`, set
   `park.resolution_type`, set `park.human_notes_seen = false` (the resumed agent reads
   notes then can set it true), and set the top-level `status` to the resume rung using
   this inverse map (status that the resume probe maps to the target phase):

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

   - **clarify (proceed):** set status to the rung that resumes JUST PAST the contested
     gate so the resumed run doesn't simply re-hit it. E.g. `open_critical` "out of scope"
     → resume at **Debrief** (`reviewed`); `non_convergence` (Pointer) "proceed" → resume
     at **Test** (`code_reviewed`). The human-notes.md tells the next agent why.
   - **clarify (rework, no re-plan):** send back one rung — `non_convergence` "fix it" →
     **Implement** (`rework_needed`).
     A Tracker-cap `non_convergence` park (parked at Test, `resume_phase: Implement`) → `rework_needed`;
     "environmental, re-run tests" → `code_reviewed`. Leave `tracker_round` / `tracker_cap_park_round`
     untouched — the pipeline derives the fresh bounce budget from them.
   - **redirect:** **increment `park.redirect_count` by 1** (treat a missing field as 0)
     in the worktree metadata (or the main copy for a `--no-worktree` hunt), then set
     `status = ready_for_alpha` (resume at **Plan**) AND
     update `acceptance.md` to reflect the corrected intent (this is what makes the re-plan
     measure against the new contract). If the increment reaches **3**, apply the
     redirect-loop guard below INSTEAD of redirecting again.

### Compliance-review sign-off (`parked:compliance_review`)

This park resumes at **Verify**. On **clarify (sign off)**: set `status = certified`,
set `park.compliance_signed_off = true` (this is what stops the post-resume compliance
gate from re-parking forever), and record the sign-off in human-notes.md (who signed,
against which `[compliance]` criteria). On **redirect (defect found)**: treat as a normal
redirect → Plan with corrected acceptance.md, and do NOT set `compliance_signed_off`.

### Redirect-loop guard

A `redirect` increments `park.redirect_count`. If this is the **third** redirect to Plan
for the same hunt, do NOT redirect again — the ticket itself is the problem, not the plan.
Set `status = needs_spec` instead and tell the user the hunt needs a fresh `/spec`
(re-interview), not another re-plan.

### Finish

Tell the user plainly: *"`<slug>` re-armed (`<resolution_type>` → resume at
`<phase>`). The next `/run-campaign` (or `/run-hunt <slug>`) pass picks it up; you don't
re-drive the pipeline."* Do NOT run the pipeline yourself — resuming is the runner's job.

## Hard rails

- `/parked` is **read-only** — it never writes.
- `/resolve` writes ONLY `human-notes.md` and `metadata.json` (the **worktree** plan dir
  — the single source of truth; the main copy only for a `--no-worktree` hunt), and
  `acceptance.md` on a redirect. It does NOT plan, implement, review, deploy, or commit.
- `human-notes.md` is **append-only** — never rewrite or truncate prior blocks.
- Never flip a `parked:compliance_review` to a build path without an explicit human
  sign-off recorded in human-notes.md.
- Always `date -u` for `parked_at`/timestamps — never guess a time.
