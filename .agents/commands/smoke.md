---
name: smoke
description: Post-deploy smoke test cycle for a Wolfpack hunt. Steps through tests one at a time with full detail, collects all issues, makes fixes in one batch, then deploys ONCE. Usage: /smoke <slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Run the smoke test cycle for feature: $ARGUMENTS

You are running the post-deploy smoke test cycle. Order is **deploy/migrate → smoke → merge**: the feature branch has been deployed to dev (with the Feature-branch deploy commands from wolfpack-config.md when present — a main-repo deploy command may ship main from a worktree); verify the deployed version matches the branch's `git describe` when the project exposes one. Smoke must pass BEFORE `/merge`.

## ⚠ Mandatory behavior rules — read before anything else

1. **Do NOT fix issues as they are reported.** Listen, acknowledge, log. Nothing else.
2. **Do NOT deploy after each fix.** All fixes happen in one batch after ALL tests are reported.
3. **Do NOT ask "should I fix that?" after each report.** Just acknowledge and present the next test.
4. **Step through tests ONE AT A TIME.** Do not dump the full list and wait.
5. **Read user reports LITERALLY.** If a smoke-item report is ambiguous ("kinda works", "mostly OK", "no visible issue but something feels off"), classify it as **AMBIGUOUS** and ask a clarifying question. Do NOT classify AMBIGUOUS as PASS — a hedged report misread as PASS is how a bug ships.
6. **Anti-waffling guard.** If your first fix attempt doesn't resolve the issue on re-verify, STOP. Do not try a second fix without user approval. Present: what you tried, why it didn't work, and alternative approaches with tradeoffs. A second failed fix means the root cause analysis was wrong — going faster won't help.
7. **Re-login on a sign-in redirect** (only when you drive the browser for a step). After any navigation, if the page is the app's sign-in page (a login form where the step expected another page) and the step is not about sign-in, run the hook's `--check`; on `SIGNED_OUT` sign in once through the hook (same account, Setup 7), then re-navigate. A second redirect in the same step = that step FAILS with `session lost after re-login`. No hook configured → hand the step to the operator with 'signed out; no smoke login hook'.

## Setup
1. **Locate the criteria spine.** The hunt is deployed but not yet merged, so its plan files live in the hunt's worktree plan dir (`metadata.worktree_path` + `/.wolfpack/plans/$ARGUMENTS/`); for an in-place hunt, or after `/merge` copied them back, in the main repo at `.wolfpack/plans/$ARGUMENTS/`.
   - **Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.
   - **`acceptance.md` is the spine:** if it exists, read it — its `[auto]`/`[manual]`/`[compliance]` criteria (parse with `node "$PACK/scripts/wolfpack-release.mjs" criteria <plan dir>/acceptance.md $ARGUMENTS`) are the authoritative test list. Each criterion carries its `ACn` id.
   - **`smoke-tests.md` is the step-detail companion:** read it for the concrete URL/selector/expected detail per criterion. Watchdog derives it FROM `acceptance.md`, so the two align (titles carry `ACn` ids). If only `smoke-tests.md` exists (older hunt, pre-spec), use it standalone as the test list.
   - Stop if neither exists.
2. The combined list (criteria + step detail) is what you step through below.
3. Read the hunt's `metadata.json` — you need `proposed_version` for tagging at the end.
4. **Branch immediately.** Create a smoke-fix branch before presenting any tests. This ensures all edits during the cycle land on a branch, never on main.
   ```bash
   git checkout -b fix/smoke-$ARGUMENTS
   ```
   If no fixes are needed at the end, the branch is deleted during cleanup.
5. **Display the overview table** — show a compact summary of ALL tests so the user knows the full scope:
   ```
   Smoke tests for <slug> (<N> tests):
   1. <one-line summary of test 1>
   2. <one-line summary of test 2>
   ...
   ```
6. **Then immediately present Test 1 in full detail** — show the complete test with URL, setup, steps, expected outcome, and what failure looks like. Tell the user: "Run this test and report the result. I'll present the next one after."
7. **Sign-in (only if the agent drives the browser for a step).** If wolfpack-config.md → Deployment Notes → **Smoke test access** names project smoke steps (a skill or doc), read them first and run their steps at the points they name. Then:
   - Read `smokeLoginHook` / `smokeLoginAccounts` from `node "$PACK/scripts/wolfpack-config.mjs" --json`. If `smokeLoginHook` is null → print `No smoke login hook configured — using your own browser session` and continue in the operator's session.
   - **Post-deploy session probe first:** run the template with `{host}` = the Dev URL host and `{account}` = the default account (the first of `smokeLoginAccounts`), with ` --check` appended. Record its first word as `session_after_deploy` (`SIGNED_IN` / `SIGNED_OUT`). Any other result → STOP with its line. (Run it before the sign-in. A probe after the sign-in always says SIGNED_IN.)
   - **Sign in:** run the template (`{host}` = the Dev URL host, `{account}` = the default). Exit 0 is required. Otherwise STOP and print the hook's line verbatim. Use another listed account for steps that need that role.
   - Never type a password into a page, and never read the hook's secrets. The hook is the only sign-in path.

## During the cycle (step-by-step)

After the user reports a result for the current test:
- If it's a **pass**: acknowledge briefly ("✓ Test N passed").
- If it's a **fail or tweak needed**: acknowledge and log the issue ("✗ Test N — noted: <issue summary>").
- If it's **ambiguous**: ask ONE clarifying question before classifying.

Then **immediately present the next test in full detail** — URL, setup, steps, expected outcome. Do NOT wait for the user to ask for it. If there are no more tests, proceed to the "done" phase.

Keep a running tally: passed / failed / remaining.

## When all tests are reported

After the last test result is reported, show the tally in ONE response:

1. Show the full tally:
   ```
   Smoke test results:
   ✓ <N> passed
   ✗ <N> failed: <brief list of issues>
   ```
2. **If no failures:** clean up the empty branch and show the finishing message:
   ```bash
   git checkout main
   git branch -d fix/smoke-<slug>
   ```
   Done.
3. **If failures exist:** (you're already on `fix/smoke-<slug>` from Setup step 4)

   **a. Root-cause analysis (BEFORE writing any code).** For each failed test, analyze the failure:
   - What is the symptom? (what the user saw)
   - What is the root cause? (why it happened — read the relevant code)
   - What is the fix? (one sentence)

   Present the analysis as a table:
   ```
   Smoke fix analysis:
   | Test | Symptom | Root cause | Proposed fix |
   |------|---------|------------|--------------|
   | #N   | ...     | ...        | ...          |
   ```

   **b. Self-review gate.** After presenting the analysis, ask: "Proceed with these fixes? [Y/n]"
   Do NOT start writing code until the user confirms. This prevents wasted deploys from misdiagnosed root causes.

   **c. Fix.** Make ALL fixes in one pass on the fix branch. Fix what you find — do NOT log smoke failures as "follow-up TODOs" or "future hunts" unless they are genuinely unrelated to the feature that was just deployed. If the smoke test exposed a bug in the feature, that bug is this hunt's responsibility.

   **d. Commit.**
   ```bash
   git add <named-files-only>
   git commit -m "fix(<scope>): smoke test fixes — <slug>"
   ```

   **e. Code review gate.** Before deploying, present a summary of all code changes for user review:
   ```
   Smoke fix review:
   | File | Change | Lines |
   |------|--------|-------|
   ```
   Ask: "Review these changes before deploy? [Y/deploy/pointer]"
   - **Y or deploy** — proceed to deploy
   - **pointer** — user wants a formal Pointer review. Before telling them to run `/pointer`, scaffold a smoke-fix metadata file so Pointer can find the review context:
     ```bash
     mkdir -p .wolfpack/plans/smoke-<slug>
     ```
     Write `.wolfpack/plans/smoke-<slug>/metadata.json`:
     ```json
     {
       "feature": "smoke-<slug>",
       "description": "Smoke test fixes for <slug>",
       "created": "<ISO8601 now>",
       "status": "code_reviewing",
       "phase": "code-review",
       "pointer_round": 0,
       "pointer_rounds": 2,
       "branch": "fix/smoke-<slug>",
       "is_worktree": false,
       "worktree_path": null,
       "tier": "Blue",
       "mode": "update",
       "smoke_fix": true,
       "parent_hunt": "<slug>",
       "models": {
         "code_reviewer": "<the parent hunt's Pointer model, else the Model Pool's reviewer-a>"
       },
       "model_assignments": {
         "pointer": null
       }
     }
     ```
     Then tell the user: `/clear → /model <pointer-model> → /pointer smoke-<slug>`
     Smoke resumes after Pointer approves.

   This gate catches scope creep in smoke fixes — changes that go beyond fixing the reported symptom.

   **f. Deploy:** the configured Dev deploy command (or the Feature-branch deploy commands) from the fix branch. Tell the user the fixes are deploying.

   **g. Re-verify.** Present ONLY the previously-failed tests again, one at a time (same step-by-step flow as the initial cycle). Do NOT re-test passing tests.

   **h. Merge to main (only when ALL re-verified tests pass).**
   ```bash
   git checkout main
   git merge --no-ff fix/smoke-<slug> -m "Merge branch 'fix/smoke-<slug>'"
   git push origin main
   ```
   Tell the user: "Smoke fixes merged to main and pushed."

   **If re-verify reveals NEW failures:** do NOT start a second fix cycle automatically. Present the failures and ask the user how to proceed. The anti-waffling guard applies — a second round of fixes after a failed first round means the diagnosis was wrong.

## Finishing message (mandatory last line)

If no fixes were needed:
```
✓ Smoke cycle complete — all tests passed
  No fixes required

Next: /clear → /summary
```

If fixes were deployed:
```
✓ Smoke cycle complete
  Fixed: <count> issues | Deployed to dev
  Re-verify: <list of previously-failed tests>

Next: /clear → /summary
```

Begin. Read the criteria spine (acceptance.md, with smoke-tests.md for step detail), show the overview table, then present Test 1 in full detail.
