---
name: release-campaign
description: Release a chain-mode Wolfpack campaign — one dev deploy of campaign/<slug>, Red sign-offs, ONE aggregated version, ONE CHANGELOG stamp, then ONE --no-ff merge into main + ONE tag after you approve. Never pushes. Usage: /release-campaign <slug> [--checkpoint]
allowed-tools: Bash, Read, Edit
---

Release chain campaign **$ARGUMENTS** (`<slug> [--checkpoint]`).

This is the **only** route from a chain campaign's `campaign/<slug>` branch into `main`. A chain campaign
(`/run-campaign-local <slug> --chain`) merged its certified hunts into the local `campaign/<slug>` branch
without wave barriers; this command ships the whole branch once. `/merge-wave` and `/merge` refuse chain
campaigns, so the fail-closed Red sign-off below has no bypass.

Every step is one script call (the git logic is deterministic, temp-repo-tested code in the pack's
`$PACK/scripts/wolfpack-release.mjs` and `$PACK/scripts/wolfpack-chain.mjs`). Run each command exactly as shown, as its
own Bash call, from the main checkout (both scripts resolve the repo from the current directory). **Never pipe**
a deploy command (a pipe masks its exit code).

**Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.

## ⚠ Finishing message is MANDATORY VERBATIM
Your final response MUST end with the exact block in "## Finishing message" below. Do NOT paraphrase it.

## Args
- `$1` = campaign slug (required). `--checkpoint` (any position) = release only the hunts already
  campaign-merged and leave the campaign armed: the next `/run-campaign-local <slug> --chain` continues on
  the branch. Without `--checkpoint` every campaign hunt must be campaign-merged.
- Missing slug → STOP and print the usage line.

## Step 0 — Preflight
1. `cd` to the main repo (same as `"$PACK/.agents/commands/merge-wave.md"` § Preflight): `cd "$(dirname "$(git rev-parse --git-common-dir)")"`.
2. Read `.wolfpack/campaigns/<slug>/metadata.json`. If it has no `chain` block with `chain.mode == "chain"` →
   STOP: *"`<slug>` is not a chain campaign — use /merge-wave."*
3. Read `node "$PACK/scripts/wolfpack-config.mjs" --json` once (exit 2 → STOP with its problem line) and keep
   `devDeployCommand`, `tagPattern`, `changelogFile` and `complianceAreas`; read wolfpack-config.md →
   Deployment Notes → **Migration command** by eye (the first backticked span, or `none`).

## Step 1 — Reconcile `main`, then check
1. Merge an advanced `main` into the campaign branch first (a no-op when `main` is already an ancestor):
   ```bash
   node "$PACK/scripts/wolfpack-chain.mjs" sync-main --campaign <slug>
   ```
   `"status": "conflict"` → STOP. Print the `files`, and tell the operator to resolve the main → `campaign/<slug>`
   merge by hand (in a scratch worktree), then re-run `/release-campaign <slug>`.
2. ```bash
   node "$PACK/scripts/wolfpack-release.mjs" check --campaign <slug> [--checkpoint]
   ```
   Exit 0 = `ok`. On exit 2, read `refusals`: STOP on any refusal (`dirty_tree`, `main_not_merged`,
   `unfinished`, `no_campaign_branch`) **except** `unsigned_compliance`, which Step 2 handles.
   Keep the `hunts` array: its `bump` values feed Step 4.

## Step 2 — Summary and Red sign-offs
1. Print the summary verbatim:
   ```bash
   node "$PACK/scripts/wolfpack-release.mjs" summary --campaign <slug> [--checkpoint]
   ```
   It shows ✅/⛔ per hunt with its status and bump, the first 40 lines of each pending-compliance hunt's
   `compliance-summary.md` with its sign-off prompt, and the held / reverted / blocked lists.
2. For **each** hunt awaiting compliance sign-off, ask the operator in-session, one question per hunt; state the
   project's compliance areas from wolfpack-config.md → Compliance Requirements → Compliance areas:
   - **Sign off** →
     ```bash
     node "$PACK/scripts/wolfpack-release.mjs" sign-off --campaign <slug> --hunt <hunt> --by "<name>"
     ```
   - **Reject** → revert it (and its campaign-merged dependents, newest first) out of the branch; the hunt
     re-arms for a fix:
     ```bash
     node "$PACK/scripts/wolfpack-release.mjs" revert --campaign <slug> --hunt <hunt> --reason "<why>"
     ```
     then go back to Step 1 (a rejected hunt is now unfinished — a final release needs `--checkpoint`, or
     the fix cycle first).
3. Re-run `check`. It must now exit 0 (`ok`); otherwise STOP and show the refusals.

## Step 3 — Deploy the campaign branch to dev (once)
If the Dev deploy command (`devDeployCommand`) is `none`, skip this step and say: "No dev deploy step
configured — smoke the campaign branch however your project allows, or skip." Otherwise:
- If the Dev deploy command contains a single quote, STOP: it cannot be wrapped in `bash -ic '…'` safely —
  ask the operator to wrap it in a script or shell function.
- The interactive shell (`bash -ic`) is there so a shell function from the operator's rc file resolves.
- With a Migration command:
  ```bash
  node "$PACK/scripts/wolfpack-release.mjs" deploy --campaign <slug> --deploy-cmd "timeout 1800 bash -ic '<Dev deploy command>'" --migrate-cmd "timeout 900 <Migration command>"
  ```
- With Migration command `none`:
  ```bash
  node "$PACK/scripts/wolfpack-release.mjs" deploy --campaign <slug> --deploy-cmd "timeout 1800 bash -ic '<Dev deploy command>'" --no-migrate
  ```
It refuses a dirty main-repo tree or any command mentioning prod, checks out `campaign/<slug>` (detached) in
the main repo, runs the deploy then the migration (unless `--no-migrate`), and **always** checks out again
whatever the main repo had checked out before (`restored_to` in the JSON: normally `main`) — even when the
deploy fails. A non-zero exit → STOP (the checkout is already restored; `restored: false` in the JSON means it
was NOT — say so loudly and stop). If `restored_to` is not `main`, `git checkout main` before Step 6. Tell the
operator to smoke the deployed branch before continuing (`/smoke-wave`, or the project's smoke route); a
failing hunt → the `revert` command in Step 2, then re-run from Step 1.

## Step 4 — One version
```bash
LAST_TAG=$(git describe --tags --abbrev=0 --match '<Tag pattern>')
eval "$(node "$PACK/scripts/wolfpack-release.mjs" version "$LAST_TAG" <bump of each included hunt…>)"
# exports BUMP=<level|none> and VERSION=<next|"">
```
`<Tag pattern>` is wolfpack-config.md → Deployment Notes → **Tag pattern** (`tagPattern`); when the key is
absent, use `v[0-9]*` and say so. Use the `bump` of every `included` hunt from the `check` output.
`BUMP=major` → STOP and confirm with the operator (MAJOR is reserved for a production launch — same rule as
`/merge-wave`). `BUMP=none` → tooling-only: no tag.

## Step 5 — One CHANGELOG stamp
Read the changelog file from wolfpack-config.md → Deployment Notes → **Changelog file** (`changelogFile`). If it
is `none` (or absent), skip this step with the note "No changelog configured — nothing to stamp." The script
stamps `CHANGELOG.md`; if the configured file is any other name, STOP and say so (never stamp the wrong file).
```bash
node "$PACK/scripts/wolfpack-release.mjs" changelog --campaign <slug> --version "$VERSION" --apply
```
It moves every included hunt's `<!-- hunt:<slug> -->` lines under one `## [$VERSION] — <date>` heading and
commits that on `campaign/<slug>` (nothing moves for a tooling-only release). Print its `unattributed`
warnings verbatim.

## Step 6 — Merge into `main` + one tag (after the operator approves)
1. Re-sync immediately before merging — `main` may have advanced during the deploy and sign-offs:
   ```bash
   node "$PACK/scripts/wolfpack-chain.mjs" sync-main --campaign <slug>
   ```
   `conflict` → STOP as in Step 1. `merged` → re-run `check` (it must be `ok`; any refusal → STOP and re-run
   `/release-campaign <slug>` from Step 1).
1b. **Release test record** (run-observability). The tip is now final (Step 5's CHANGELOG commit included), so take
   the SHA-stamped full-suite record AT the branch that merges into `main`:
   ```bash
   node "$PACK/scripts/wolfpack-test-record.mjs" ensure --stage release --record-dir ".wolfpack/campaigns/<slug>" --rev "campaign/<slug>"
   ```
   No `--repo`: it runs in a scratch worktree at the campaign tip (the main checkout stays on `main`). Exit ≠ 0 →
   STOP: print the record's `summary` and `log` path, and do NOT print or run the merge commands. A campaign
   that does not pass its full suite at the tip never reaches `main`.
2. Print the commands:
   ```bash
   node "$PACK/scripts/wolfpack-release.mjs" merge-commands --campaign <slug> --version "$VERSION"
   ```
   It refuses (exit 2) while any hunt still owes a compliance sign-off (`unsigned_compliance`) or while `main`
   is not an ancestor of `campaign/<slug>` (`main_not_merged`). Otherwise it prints
   `git merge --no-ff campaign/<slug> -m "Merge branch 'campaign/<slug>'"` and, when `$VERSION` is set,
   `git tag -a <VERSION> -m "<VERSION> — campaign <slug>: <slugs>"`.
3. Show them and ask: **"Merge campaign/<slug> into main and tag <VERSION>? [y/N]"**. Only on `y`, first re-check
   the release record — `node "$PACK/scripts/wolfpack-test-record.mjs" check --stage release --record-dir ".wolfpack/campaigns/<slug>" --rev "campaign/<slug>"`
   must exit 0 immediately before the merge (exit 2 → STOP and run the fix line it prints); then run them
   as **two plain Bash calls**, from the main repo on `main`.
   - If the merge **conflicts** (`main` moved after the re-sync): capture
     `git diff --name-only --diff-filter=U`, then `git merge --abort`, print the conflicted files and STOP —
     tell the operator to re-run `/release-campaign <slug>` from Step 1. Never resolve it in-session.
   - If the merge is **refused** (hook, permission classifier, or error): print both lines verbatim for the
     operator to run and STOP before Step 7; tell them to run Step 7 afterwards.

## Step 7 — Stamp released; print the push lines
```bash
node "$PACK/scripts/wolfpack-release.mjs" stamp-released --campaign <slug> --version "$VERSION"
```
It refuses until `campaign/<slug>` is merged into `main`, then stamps each included hunt `status: "merged"`
with `merge_commit`, `release_merge_commit`, `released_version` (`null` when tooling-only) and `merged_at`.
Print its `push` lines for the operator, verbatim. Never run them yourself.
- Final release (no `--checkpoint`): also print `git branch -d campaign/<slug>` and, for each hunt worktree,
  the worktree-cleanup prompt from `"$PACK/.agents/commands/merge.md"` step 8.
- `--checkpoint`: only the included hunts were stamped; every other hunt's chain state is untouched and the
  next `/run-campaign-local <slug> --chain` continues on the branch.

## Do NOT
- Do NOT push anything (the release is the operator's to push).
- Do NOT deploy anything but dev; do NOT run prod commands.
- Do NOT merge `campaign/<slug>` into `main` while any hunt owes a compliance sign-off.
- Do NOT merge `campaign/<slug>` into `main` without a passing `release` test record at its tip, and never hand-edit `test-record-*.json`.
- Do NOT fast-forward, force-push, or rebase `main`.

## Finishing message
```
✓ Campaign released: <N> hunts → main (--no-ff), tagged <V>
  campaign/<slug>

Next: push main and <V> to origin yourself — the exact lines are the `push` lines Step 7 printed.
```
(Tooling-only: replace `tagged <V>` with `no version tag (tooling-only)` and `main and <V>` with `main`. If the
merge was refused and printed for the operator, say so above the block and make the Next line the two printed
commands, then Step 7.)

Begin.
