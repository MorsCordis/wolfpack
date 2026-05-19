---
name: smoke
description: Post-deploy smoke test cycle. Steps through tests one at a time, collects issues, fixes in one batch, deploys ONCE. Usage: /smoke <slug>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Run the smoke test cycle for feature: $ARGUMENTS

## Mandatory behavior rules

1. Do NOT fix issues as reported — listen, acknowledge, log.
2. Do NOT deploy after each fix — all fixes in one batch.
3. Step through tests ONE AT A TIME.
4. If a report is ambiguous, ask ONE clarifying question before classifying.

## Setup

1. Locate `smoke-tests.md` in `.wolfpack/plans/$ARGUMENTS/`
2. Display overview table of all tests
3. Present Test 1 in full detail

## During the cycle

After each result: acknowledge (pass/fail/ambiguous), present next test. Keep running tally.

## When all tests reported

Show tally. If failures exist:

a. **Branch:** `git checkout -b fix/smoke-<slug>`
b. **Root-cause analysis** before writing code
c. **Self-review gate:** present analysis table, ask user to confirm
d. **Fix** all issues in one pass. Fix what you find — don't defer feature bugs.
e. **Commit** with named files only
f. **Code review gate:** Present change summary:
   ```
   Smoke fix review:
   | File | Change | Lines |
   ```
   Ask: "Review these changes before deploy? [Y/deploy/pointer]"
   - **Y or deploy** — proceed
   - **pointer** — scaffold smoke-fix metadata for Pointer review:
     ```json
     { "feature": "smoke-<slug>", "smoke_fix": true, "parent_hunt": "<slug>", "tier": "Blue", ... }
     ```
     at `.wolfpack/plans/smoke-<slug>/metadata.json`, then direct to `/pointer smoke-<slug>`
g. **Deploy** using your project's deploy command
h. **Re-verify** only previously-failed tests
i. **Merge** to main with `--no-ff` when all pass

## Finishing message

```
Smoke cycle complete — all tests passed (or: Fixed N issues | Deployed)

Next: /clear -> /summary
```

Begin.
