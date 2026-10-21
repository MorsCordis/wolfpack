---
name: merge
description: Merge a certified Wolfpack hunt to main and push to origin. Only runs if Watchdog verdict is PASS. Usage: /merge <slug>
allowed-tools: Bash, Read
---

Merge a certified Wolfpack hunt for feature: $ARGUMENTS

## ⚠ Finishing message is MANDATORY VERBATIM
Your final response MUST end with the exact block in "## Finishing message" below. Do NOT paraphrase, reformat, or drop `/clear`. It's the user's copy-paste handoff — dropping steps forces them to reconstruct the cadence themselves.

## Preflight: locate metadata.json

Before reading any plan files:

**Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.

**Worktree root (`WT_ROOT`).** In the main checkout run `node "$PACK/scripts/wolfpack-config.mjs" --json` and take `worktreeRoot` (wolfpack-config.md → Project Identity → Worktree root, repo-relative). If the reader exits 2 or `worktreeRoot` is null, STOP with the fix: "add ``- **Worktree root:** `<repo-relative dir, e.g. .agents/worktrees>` `` under ## Project Identity in wolfpack-config.md". Never assume a default location.

1. **Find `metadata.json`** for the slug. Check these paths, first hit wins:
   - `$WT_ROOT/$ARGUMENTS/.wolfpack/plans/$ARGUMENTS/metadata.json` (worktree — check first)
   - `./.wolfpack/plans/$ARGUMENTS/metadata.json`
   - `$(git rev-parse --show-toplevel)/.wolfpack/plans/$ARGUMENTS/metadata.json`
   - Fallback: `git worktree list` and grep for `feat/$ARGUMENTS`, then check `<that-path>/.wolfpack/plans/$ARGUMENTS/metadata.json`
2. **If no hit:** stop. Emit "No metadata.json for `$ARGUMENTS` — was `/hunt` run?"
3. **If hit:** read `is_worktree` and `worktree_path`. Then:
   - If `is_worktree: true` and `worktree_path` set:
     - Compute main repo: `MAIN_REPO="$(cd "$worktree_path" && dirname "$(git rev-parse --git-common-dir)")"`
     - `cd "$MAIN_REPO"`
   - Otherwise → `cd "$(git rev-parse --show-toplevel)"`.
4. **Verify** `.wolfpack/plans/$ARGUMENTS/` exists. For worktree hunts, the plan dir lives in the worktree — use the `worktree_path` to read plan files even though CWD is the main repo. Store `PLAN_DIR="$worktree_path/.wolfpack/plans/$ARGUMENTS"` for subsequent reads.
5. **Chain-mode refusal.** If `metadata.base_branch` is set, **or** `metadata.campaign` is set and
   `.wolfpack/campaigns/<metadata.campaign>/metadata.json` has `chain.mode == "chain"` (the same campaign-level key
   `/merge-wave` uses; it also catches a barrier-era hunt certified before its campaign switched to chain, which has
   no `base_branch`) → STOP: "chain-mode campaign hunt — it ships with `/release-campaign <campaign>`."

## Setup
1. Feature slug: `$ARGUMENTS`
2. Plan directory: `$PLAN_DIR` (set by Preflight above).
3. Verify the plan directory exists and contains `certification.md`.
4. Read `metadata.json`. Check status:
   - If `status: "merged"`, STOP — this hunt is already merged (its `merge_commit` is recorded in metadata). Nothing to do.
   - Confirm `status: "certified"` and `phase: "done"`. If status is `rework_needed` or `flawed_plan_restarting`, STOP — tell the user the hunt needs rework, not a merge.
5. Read `certification.md` to confirm the verdict is PASS. If REWORK or FLAWED_PLAN, STOP.
6. Read the project's `wolfpack-config.md` — `## Hard Rules` carries the authoritative git conventions (merge message format, which remotes to push, `--no-ff` requirement), and `## Deployment Notes` carries the deploy/migration/changelog fields this command reads below.

## Merge work
1. Determine the feature branch from metadata.json (`branch` field, typically `feat/<slug>`).
2. Verify you're in a git repo and the branch exists.
3. Run `git status` — check for dirty state.
3a. **`.wolfpack/` auto-commit sweep.** Read `worktree_path` from metadata.json. Determine the working directory (worktree if set, else repo root). Run `git status --porcelain` in that directory:
   - **If the ONLY dirty files are `.wolfpack/` paths** (pedigree/index.md, pedigree/lessons.md, cross-cutting-debt.md, plans/*/pedigree.json, known-broken-tests.md): auto-commit them with `chore(wolfpack): <slug> certification artifacts`. Stage by name only. Tell the user: "Auto-committed straggling `.wolfpack/` artifacts from Watchdog."
   - **If there are dirty files OUTSIDE `.wolfpack/`** that are NOT from this hunt (not in the plan's "Files to Modify" / "Files to Create"): STOP and ask the user to commit/stash first — these are unexpected changes.
   - **If there are NO dirty files**: continue normally.
4. **Worktree detection + self-navigation (do NOT ask the user to `cd`):**
   - Read `worktree_path` from metadata.json.
   - If null/missing: hunt was branched in-place. Standard merge flow (step 6 below) runs from current CWD.
   - If set: the merge MUST happen from the main repo, not the worktree (you can't `git checkout main` while another worktree owns the feature branch from inside it). Compute the main repo path and `cd` into it yourself — do NOT stop and ask the user. The main repo path is the parent of `git rev-parse --git-common-dir`:
     ```bash
     MAIN_REPO=$(cd "$worktree_path" && dirname "$(git rev-parse --git-common-dir)")
     cd "$MAIN_REPO"
     ```
     Verify with `pwd` that you landed in the main repo, then continue with step 6. Tell the user in one sentence: "Auto-navigated from worktree to main repo: `<MAIN_REPO>`."
6. Execute (in order, stopping on any failure):
   ```bash
   # Pre-merge: version tag collision check
   TAG=$(jq -r '.proposed_version.tag // empty' "$PLAN_DIR/metadata.json")
   if [ -n "$TAG" ]; then
     if git rev-parse "$TAG" >/dev/null 2>&1; then
       echo "⚠ Tag $TAG already exists (from a parallel hunt?)."
       echo "Fix the version on the feature branch before merging."
       echo "  git checkout $BRANCH"
       echo "  # edit the changelog and metadata.json proposed_version"
       echo "  # then re-run /merge $SLUG"
       exit 1
     fi
   fi

   git checkout main

   # Auto-rebase when main has moved
   MERGE_BASE=$(git merge-base main $BRANCH)
   MAIN_HEAD=$(git rev-parse main)
   if [ "$MERGE_BASE" != "$MAIN_HEAD" ]; then
     echo "main has moved — rebasing $BRANCH onto main..."
     git checkout $BRANCH
     if ! git rebase main; then
       git rebase --abort
       echo "⚠ Rebase conflict. Aborting rebase to restore branch state."
       echo ""
       echo "Resolve manually:"
       echo "  git checkout $BRANCH"
       echo "  git rebase main"
       echo "  # fix conflicts, then: git rebase --continue"
       echo "  # when clean, re-run: /merge $SLUG"
       git checkout main
       exit 1
     fi
     git checkout main
   fi

   # run-observability: the merge requires a PASSING full-suite record at the exact tip being merged.
   # gate re-runs once when the tip moved since the record (e.g. the auto-rebase above); missing/failing → refuse.
   node "$PACK/scripts/wolfpack-test-record.mjs" gate --stage final --record-dir "$PLAN_DIR" --rev "$BRANCH" ${worktree_path:+--repo "$worktree_path"} \
     || { echo "⛔ No passing test record at $BRANCH's tip — not merging. Run the fix line printed above, then re-run /merge $SLUG."; git checkout main; exit 1; }

   git merge --no-ff $BRANCH -m "Merge branch '$BRANCH'"
   MERGE_SHA=$(git rev-parse HEAD)
   git push origin main
   ```

   **Note on shared append-only files:** No merge driver is configured for the shared append-only files (`pedigree/index.md`, `known-broken-tests.md`, `cross-cutting-debt.md`): git's default text merge applies, so two branches that each append after the same last line conflict, and the conflict is resolved by hand keeping both entries.
7. **Plan copy-back (only if `worktree_path` was set):** Before removing the worktree, preserve the plan artifacts locally for post-hoc traceability. Plans are gitignored and ride the worktree filesystem — without this step they die with the worktree. Run, from the main checkout:
   ```bash
   node "$PACK/scripts/wolfpack-merge-state.mjs" copy-back --slug "$SLUG" --from "$worktree_path/.wolfpack/plans/$SLUG"
   ```
   It copies the worktree plan dir's CONTENTS into the main checkout's `.wolfpack/plans/<slug>/` (created if missing; the worktree's files win; never a nested `<slug>/<slug>/`; a `pedigree.json` tracked in the TARGET is overwritten in place, never archived or deleted; files the hunt branch tracks are skipped and listed in `skipped_tracked`, since they arrived with the merge; files only the target has are left alone). Print its `overwritten` and `skipped_tracked` lists to the user. Do NOT copy the directory yourself with a recursive shell copy and do NOT archive an existing target.
   - The pedigree scorecard rides the merge (tracked on the feature branch); this step handles the gitignored artifacts only (plan.md, review-N.md, debrief.md, shepherd-log.md, certification.md, observations.md, pointer-review-N.md, tracker-log.md).
7a. **Stamp MERGED (ALWAYS — worktree hunt or `--no-worktree` hunt; not conditioned on `worktree_path`).** Run, from the main checkout:
   ```bash
   node "$PACK/scripts/wolfpack-merge-state.mjs" stamp-merged --slug "$SLUG" --merge-commit "$MERGE_SHA"
   ```
   It sets `status: "merged"`, `phase: "done"`, `merge_commit` and `merged_at` on every metadata copy (the main checkout's, and the worktree's while it still exists), and refuses a SHA that is not on `main`. `status: "merged"` is the durable, unambiguous done-marker that `/run-campaign`'s RESUME PLAN and `campaign-runner.js` read **directly** — so a shipped hunt is never re-derived from git and never reads as a re-runnable `certified`. Do NOT leave it at `certified` (that means "awaiting merge"). This also prevents `/hunt` from flagging completed hunts as in-progress.
8. **Worktree cleanup (only if `worktree_path` was set):** After plan-copy-back, present the cleanup prompt as its OWN message block with visual separators so it cannot be missed in scroll. Output EXACTLY this format (substituting the real path):
   ```
   ──────────────────────────────────────
   ⚠ WORKTREE CLEANUP
   ──────────────────────────────────────
   Hunt ran in worktree: <worktree_path>
   Plans already copied back. Branch stays on main.

   Remove the worktree now? [y/N]:
   ──────────────────────────────────────
   ```
   **Wait for the user's answer before continuing.** If `y`, run `git worktree remove <worktree_path>`. If anything other than `y`, leave it — the user can clean up later. Plan artifacts are safe either way. Do NOT bury this prompt inside a paragraph of other output — it must be the last thing the user sees before the finishing message.
8a. **Changelog version stamping.** Read the changelog filename from `wolfpack-config.md` → `## Deployment Notes` → "Changelog file". **If that field is blank, skip this entire step** — the project keeps no changelog. Otherwise read `proposed_version` from metadata.json.
   - **Attribute untagged items (run this BEFORE the version-heading move below, so an item it attributes to this hunt moves with it):** `node "$PACK/scripts/wolfpack-merge-state.mjs" attribute-changelog --file "<changelog file>" --apply`. Print its stderr verbatim. It tags each untagged `[Unreleased]` item with the hunt whose merge carried it and places it with that hunt's other items; it never deletes an item, and an item it cannot attribute stays under `[Unreleased]`, listed loudly as `⚠ unattributed [Unreleased] item (left in place)`. It is informational — it doesn't block the merge.
   - **If `proposed_version.tag` is non-null (versioned hunt):**
     1. Grep the changelog for `<!-- hunt:$SLUG -->` under `## [Unreleased]`. These are the items Shepherd wrote for this hunt.
     2. If items found: create a new version section `## [<version>] — <YYYY-MM-DD>` immediately after `## [Unreleased]` (and its remaining content), and move the matching items there. Group by category (### Fixed, ### Added, ### Changed) preserving the original order. Leave unmatched items under `[Unreleased]`.
     3. If NO `<!-- hunt:$SLUG -->` items found under `[Unreleased]`: check whether a `## [<version>]` heading already exists (Shepherd may have created it). If neither exists, STOP — tell the user "No changelog entries found for hunt `$SLUG`. Was the changelog updated during Shepherd?" The user decides.
   - **If `proposed_version` is null (tooling-only):** verify entries exist under `[Unreleased]` with `<!-- hunt:$SLUG -->` tags. If missing, warn but don't block.
   - **Backlog file:** read the backlog filename from `## Deployment Notes` → "Backlog file" (skip if blank). For each backlog line the plan listed for removal, run `grep -F "<exact text>" <backlog-file>`. If found, capture the matching line and warn: "Plan expected this backlog line to be removed: `<matched line>`. Still present — was it addressed?" The user decides.
   Neither check blocks the merge — they're warnings. But surfacing them here prevents housekeeping from accumulating across hunts.
   **Commit the changelog change** on a `fix/changelog-<slug>` branch, merge `--no-ff` to main, before proceeding to tagging.
9. **Release tagging (ALWAYS — before deploy).** Skip entirely when `node "$PACK/scripts/wolfpack-config.mjs" --json` → `releaseTags` is `false` (wolfpack-config.md → Deployment Notes → Tag pattern: `none`); say so visibly and stamp `--released-version ""` (below). Otherwise read `proposed_version` from metadata.json and present a confirmation:
   ```
   Tag release version?
   Last tag: <git describe --tags --abbrev=0 --match 'v[0-9]*'>
   Hunt proposed: <proposed_version.tag> (<proposed_version.bump>)
   Apply this tag? [Y/n/other version]:
   ```
   - If `Y` or empty: use `proposed_version.tag`. If the user provides a different version, use that. If `n` or `skip`, defer.
   - If `proposed_version` is null (tooling-only hunt or user skipped): ask the user for a version string or "skip". If skip, no tag — tooling hunts often have no version bump.
   - Before tagging: confirm the changelog has a `## [<version>]` heading (step 8a should have created it). Then `git tag -a <ver> -m "<ver>"` on HEAD (the merge commit on `main`), and push: `git push origin <ver>`.
   - Tell the user: "Tag `<ver>` created and pushed to origin."
   - Record it: re-run `node "$PACK/scripts/wolfpack-merge-state.mjs" stamp-merged --slug "$SLUG" --merge-commit "$MERGE_SHA" --released-version "<ver>"`. When the tag was deferred, skipped or not applicable (`releaseTags` false), re-run it with `--released-version ""` (records `released_version: null`).
10. **Migration detection (do NOT run yet).** Read "Migration file pattern" and "Deploy-before-migrate" from `wolfpack-config.md` → `## Deployment Notes`. **If no migration pattern is configured, skip this step.** Otherwise run `git diff HEAD~1..HEAD --name-only | grep '<migration-pattern>'`. If any migration files appear in the merged diff, set `HAS_MIGRATIONS=true` and note the files, but do NOT run them now.
   - If **Deploy-before-migrate is `yes`**, migrations must not run before the deploy: the migration runner is pinned to the deployed artifact, so migrating first applies the *previous* build's schema. Display:
     ```
     ⚠ Migration files detected in merge:
     <list of migration file paths>

     Migrations will run AFTER the deploy (the migration runner uses the deployed build).
     ```
   - If **Deploy-before-migrate is `no`**, just list the detected migration files and note that they still need to be run.
11. Tell the user the merge + push (and tag, if applicable) completed.
12. **Ticket close-out reminder.** Read `ticket_ids` from metadata.json. If non-empty, surface it — the shipped work resolves those source tickets, but `/merge` cannot flip them (they live outside git), so the flip is manual:
    ```
    ✎ This hunt closes: <ticket_ids joined>
      Flip these closed in the tracker (they don't auto-close on merge).
    ```
    If `ticket_ids` is empty, skip this step silently. (This is the guard against the recurring miss where ticket-driven campaigns shipped without the source ticket ever being flipped.)

## Finishing message (mandatory last line)

Build the `Next:` line by composing the applicable steps in this order, omitting any whose
config field is blank or whose condition is false:

1. the **dev deploy command** (`## Deployment Notes` → "Dev deploy command")
2. the **migration command** (only if `HAS_MIGRATIONS` is true)
3. `/smoke <slug>` (only if `smoke-tests.md` exists for this hunt)

If "Deploy-before-migrate" is `no`, swap steps 1 and 2.

End with EXACTLY this block, with `<next-steps>` replaced by those steps joined with ` → `:
```
✓ Merged and pushed: feat/<slug> → main (--no-ff)
  origin

Next: <next-steps>
```

If the composed list is empty (no deploy command configured, no migrations, no smoke tests),
end with EXACTLY:
```
✓ Merged and pushed: feat/<slug> → main (--no-ff)
  origin

Next: /clear → /hunt <new-slug> "<next task>"
```

## What NOT to do
- Do NOT merge if Watchdog verdict is REWORK or FLAWED_PLAN.
- Do NOT fast-forward (always `--no-ff`).
- Do NOT force push.
- Do NOT delete the feature branch.
- Do NOT run prod-targeted commands.
- Do NOT push to any remote the project's `## Hard Rules` does not name.
- Never merge past a refused test-record gate or hand-edit `test-record-*.json`.

Begin.
