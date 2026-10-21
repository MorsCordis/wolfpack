---
name: merge-wave
description: Batch-merge a whole certified Wolfpack WAVE to main — sequential --no-ff merges, ONE aggregated version tag, ONE deploy. Usage: /merge-wave <campaign> <wave>
allowed-tools: Bash, Read, Edit
---

Batch-merge wave **$ARGUMENTS** (`<campaign> <wave>`).

This is the **autonomous/batch release path** from `docs/autonomy/04-batch-merge-smoke.md`.
On the batch path **the wave — not the individual hunt — owns the version tag.** A manually
run single hunt is a wave-of-one and should still use plain `/merge` (tags as today).

## ⚠ Finishing message is MANDATORY VERBATIM
Your final response MUST end with the exact block in "## Finishing message" below. Do NOT
paraphrase, reformat, or drop `/clear`. It is the user's copy-paste handoff.

## Args
- `$1` = campaign slug, `$2` = wave number. If either is missing, STOP and emit usage.

## Preflight: CWD + campaign
**Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.

**Worktree root (`WT_ROOT`).** In the main checkout run `node "$PACK/scripts/wolfpack-config.mjs" --json` and take `worktreeRoot` (wolfpack-config.md → Project Identity → Worktree root, repo-relative). If the reader exits 2 or `worktreeRoot` is null, STOP with the fix: "add ``- **Worktree root:** `<repo-relative dir, e.g. .agents/worktrees>` `` under ## Project Identity in wolfpack-config.md". Never assume a default location.

1. `cd "$(git rev-parse --show-toplevel)"` — wave merges run from the main repo. If you're in
   a worktree (the cwd is inside `$WT_ROOT`), the `--show-toplevel` of the *common*
   dir is the main repo: `cd "$(dirname "$(git rev-parse --git-common-dir)")"`.
2. Verify `.wolfpack/campaigns/$1/campaign.md` exists. If not: STOP — "No campaign `$1` (run /expedition first)."
3. If `.wolfpack/campaigns/$1/metadata.json` has `chain.mode == "chain"` → STOP: *"`$1` is a
   chain campaign — release it with `/release-campaign $1` (one merge, one tag). `/merge-wave` never merges a chain campaign."*

## Step 1 — Build the release queue (AC4)

1. Read `.wolfpack/campaigns/$1/campaign.md`. Extract every hunt whose `**Wave:** $2` matches.
2. For each such hunt slug, locate its `metadata.json` (worktree first, then main repo — same
   path search as `/merge` Preflight) and read `status`, `proposed_version`,
   `park.compliance_signed_off` (the human compliance gate, set by `/resolve` sign-off),
   and `spec.compliance_review_required` (the Spec phase's compliance-critical flag).
3. Classify into the **release queue**. The compliance gate is `park.compliance_signed_off`,
   **NOT** the raw status — a hunt signed off via `/resolve` may still read
   `status: "parked:compliance_review"` until a re-cert pass runs, but the human has already
   cleared it and it must be releasable (this was the gap on v1-push-3 wave 2: merge-wave
   would have dropped a signed-off `invoice-detail-enhancements`):
   - **Ready** — `certification.md` verdict is PASS **and** either `status: "certified"` **or**
     `park.compliance_signed_off == true` — **AND** the hunt is not an un-signed compliance hold
     (see below). A signed-off compliance hunt is Ready even if its status still reads
     `parked:compliance_review`. Render it distinctly in the queue:
     `✅ <slug>  certified (compliance signed off)`.
   - **Held for compliance** — `park.compliance_signed_off` is falsy (absent/false) **AND**
     EITHER `status: "parked:compliance_review"` **OR** `spec.compliance_review_required == true`.
     **EXCLUDE from the queue** (AC4); surface it, tell the user to `/resolve <slug>` to sign off
     (or redirect) first. Never merge an un-signed compliance hold here. The `spec` clause is the
     belt-and-suspenders for the v1-push-3 wave-3 gap: a Spec-flagged compliance hunt
     (`email-invoice-to-client`, `clinic-automated-messaging-switch`) that certified to
     `status: "certified"` — because its diff missed the narrow Verify-gate path allowlist —
     would otherwise read as plain Ready and merge with no human sign-off. (`hunt-pipeline.js`'s
     compliance gate now also parks on the Spec flag, so new hunts arrive as
     `parked:compliance_review`; this clause catches any that slip through.)
   - **Already released** — `status: "merged"` → skip silently; it shipped in a prior
     `/merge-wave` run (its `merge_commit`/`released_version` are recorded). Makes a re-run idempotent.
     (exactly `merged` — `merged_to_campaign*` is NOT released; it can only appear on a chain campaign,
     which Preflight already stopped)
   - **Not ready** — any other status (rework_needed, other parked:*, failed, in-progress).
     Surface and skip.
4. Display the queue, then STOP for confirmation before merging anything:
   ```
   RELEASE QUEUE — <campaign> wave <wave> (<N> ready, <M> held)
     ✅ <slug-1>   certified   (bump: <minor|patch|none>)
     ✅ <slug-2>   certified (compliance signed off)   (bump: <patch>)
     ⏸ <slug-3>   compliance_review — run /resolve first (EXCLUDED)
   Merge these <N> hunts sequentially, then lay ONE wave tag? [Y/n]
   ```
   If `n`, stop. If no Ready hunts, stop — nothing to release.

## Step 2 — Per-hunt merge (NO tag, NO version heading)

For each Ready hunt **in order**, run the same merge mechanics as `/merge` (read the project's
`wolfpack-config.md` → `## Hard Rules` once up front for the authoritative git rules) with two
deliberate omissions — **do not lay a tag and do not stamp a version heading per hunt**:

1. `.wolfpack/` auto-commit sweep (same rule as `/merge` step 3a — only `.wolfpack/` paths
   auto-commit; anything else dirty and not from the hunt → STOP and ask).
2. `git checkout main`, then **auto-rebase** the feature branch onto main if main moved
   (same rebase+abort-on-conflict handling as `/merge` step 6). Sequential merges mean main
   moves under each subsequent hunt — the rebase is load-bearing here.
2a. **Test-record gate** (run-observability). The merge requires a PASSING full-suite record at the exact tip
   being merged (the gate re-runs once when the tip moved since the record, e.g. after the rebase above):
   ```bash
   node "$PACK/scripts/wolfpack-test-record.mjs" gate --stage final --record-dir "<that hunt's plan dir>" --rev "<branch>" ${worktree_path:+--repo "$worktree_path"}
   ```
   On refusal (exit ≠ 0) STOP the wave at this hunt: the earlier hunts stay merged. Report the fix line it
   printed and say that re-running `/merge-wave` resumes (released hunts are skipped). Never hand-edit
   `test-record-*.json`.
3. `git merge --no-ff <branch> -m "Merge branch '<branch>'"` then `git push origin main`.
   `--no-ff` keeps each hunt a single cleanly-revertible merge commit — this is what makes a
   smoke failure revert exactly one hunt (AC3).
4. **Plan copy-back + stamp MERGED** (only if `worktree_path` set) — same as `/merge` step 7:
   copy `.wolfpack/plans/<slug>/` back to the main repo, collision-archive, then stamp the
   main-repo metadata as the authoritative done-log: `status: "merged"`, `phase: "done"`,
   `merged_at` (`date -Iseconds`), `merge_commit` (this hunt's `--no-ff` merge SHA). Leave
   `released_version` to be backfilled in Step 3 (the wave tag isn't laid until all merges
   finish). Do NOT leave it at `certified` — a shipped hunt reading `certified` is exactly the
   divergence that makes the kickoff re-run merged work.
5. **CHANGELOG: fold under `[Unreleased]` only.** Confirm the hunt's entries carry
   `<!-- hunt:<slug> -->` under `## [Unreleased]`. Do **NOT** create a `## [version]` heading
   yet — that happens once, in Step 3. If a hunt has no attributed entries and is not
   tooling-only, warn (don't block).
6. **Record** this hunt's `proposed_version.bump` (from metadata) and its merge commit SHA
   (`git rev-parse HEAD`) for Step 3 / attribution.

Do NOT remove worktrees yet — defer all worktree cleanup to the end (Step 4) so a mid-wave
abort leaves them recoverable.

## Step 3 — Wave finalization (ONCE, after ALL merges)

1. **Aggregate the bump** across the merged hunts' recorded bumps and compute the wave version:
   ```bash
   LAST_TAG=$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || echo "v0.0.0")
   eval "$(node "$PACK/scripts/wolfpack-release.mjs" version "$LAST_TAG" <bump1> <bump2> ...)"
   # exports BUMP=<level|none> and VERSION=<next|"">
   ```
   - Highest step wins (minor beats patch); tooling-only hunts contribute nothing
     (`feedback_tooling_only_no_version_bump`).
   - If `BUMP=major`: STOP and confirm with the user — MAJOR is reserved for prod launch and
     should not auto-apply on a dev wave.
   - If `BUMP=none` (every hunt tooling-only): skip tagging entirely (jump to Step 4). Tell the
     user "Tooling-only wave — no version tag."
2. **Stamp the CHANGELOG ONCE.** Create a single `## [$VERSION] — <YYYY-MM-DD>` heading
   immediately after `## [Unreleased]`, and move **every** wave hunt's `<!-- hunt:<slug> -->`
   entries (across all merged hunts) under it, grouped by category (### Added / ### Fixed /
   ### Changed). Leave any unmatched `[Unreleased]` items in place and warn if they're
   unattributed. Commit on a `fix/changelog-wave-$1-$2` branch, merge `--no-ff` to main, push.
3. **Lay ONE annotated tag** on the final merge commit (current `main` HEAD):
   ```bash
   git tag -a "$VERSION" -m "$VERSION — <campaign> wave <wave>: <slug list>"
   git push origin "$VERSION"
   ```
   APP_VERSION bakes from this tag via `git describe` at deploy — satisfies tag-before-deploy
   and the image invariant (one image, one tag for the wave).
   **Backfill `released_version`:** write `released_version: "$VERSION"` into each merged
   hunt's main-repo `metadata.json` (the Step 2.4 stamp left it pending). Now each hunt's
   on-disk log carries `status: merged` + `merge_commit` + `released_version` — the full
   authoritative done-record the kickoff reads without touching git.
4. **Migration detection + graph-collision gate (do NOT run migrations).**
   Skip this step entirely if wolfpack-config.md → Deployment Notes → **Migration file pattern**
   is `none` (the project has no migrations; `HAS_MIGRATIONS` stays false).
   ```bash
   MIGS=$(git diff <wave-base>..HEAD --name-only | grep -E '<Migration file pattern>')
   ```
   where `<wave-base>` is the commit before the first hunt's merge and `<Migration file pattern>`
   is the config's Migration file pattern (e.g. `/migrations/[0-9]`). If any, set
   `HAS_MIGRATIONS=true`, list them, and note they run AFTER the configured Dev deploy command
   (when Deploy-before-migrate is `yes`).

   **Collision check — parallel hunts that forked from the same base can EACH add a migration
   with the same number in the same app → two leaf nodes → the migration command fails with
   "Conflicting migrations / multiple leaf nodes."** `/merge-wave` only lists files today; detect the
   collision so it can't reach the migrate job silently:
   ```bash
   echo "$MIGS" | sed -E 's#^(.+)/migrations/([0-9]+)_.*#\1 \2#' | sort | uniq -d
   ```
   - **If any `<app> <NNNN>` row prints (duplicate leaf number in one app):** STOP — do NOT tag,
     do NOT hand off. This wave will break the migration command. Emit the fix and wait:
     ```
     ⚠ MIGRATION GRAPH COLLISION — <app> has two leaf migrations at <NNNN>:
       <fileA>
       <fileB>
     Resolve BEFORE deploy/migrate (needs the project's database/runtime env — merge-wave can't):
       the project's migration-merge procedure (e.g. a framework's `makemigrations --merge`)
     Commit the merge migration on fix/migration-merge-<app> → --no-ff main, then re-run /merge-wave.
     ```
     merge-wave **detects only** — it does not run the migration-merge procedure (no database/runtime env here).
     (A migration merge is typically a no-op if the leaves turn out linear, so a false positive is harmless.)
   - **If nothing prints:** no collision — continue to Step 4 worktree cleanup.

## Step 4 — Worktree cleanup

For each merged hunt that ran in a worktree (`$WT_ROOT/<slug>`), present the cleanup prompt (same verbatim block
as `/merge` step 8, `"$PACK/.agents/commands/merge.md"`) and wait for `y` before `git worktree remove "$WT_ROOT/<slug>"`. Plans are already copied
back, so declining is safe.

## Tag reversion note (for the smoke step)

If `/smoke-wave` later reverts a hunt's merge, the wave tag must be **moved/re-laid** onto the
post-revert commit so it always points at exactly-what-shipped:
`git tag -d $VERSION && git tag -a $VERSION -m "..." <post-revert-HEAD> && git push -f origin $VERSION`.
`/smoke-wave` owns that; it's noted here so the contract is visible from both ends.

## What NOT to do
- Do NOT merge a hunt that is not `certified` (rework/parked/compliance_review).
- Do NOT lay a per-hunt tag or stamp a per-hunt version heading — the wave owns ONE tag.
- Do NOT fast-forward (always `--no-ff`), force-push main, or delete feature branches.
- Do NOT deploy — that is the user's single configured Dev deploy command after this command (if the project has one).
- Do NOT push to any remote other than `origin`.

## Finishing message (mandatory last line)

Pick the variant from wolfpack-config.md → Deployment Notes. `<Dev deploy command>` and
`<Migration command>` are filled verbatim from the config.

If the Dev deploy command is present and `HAS_MIGRATIONS` is true:
```
✓ Wave released: <N> hunts merged --no-ff → main, tagged <VERSION>
  origin (GitHub)

Next: <Dev deploy command> → <Migration command> → /smoke-wave <campaign> <wave>
```

If the Dev deploy command is present and there are no migrations:
```
✓ Wave released: <N> hunts merged --no-ff → main, tagged <VERSION>
  origin (GitHub)

Next: <Dev deploy command> → /smoke-wave <campaign> <wave>
```

If the Dev deploy command is `none`:
```
✓ Wave released: <N> hunts merged --no-ff → main, tagged <VERSION>
  origin (GitHub)

Next: nothing to deploy — the wave is released at the tag; /smoke-wave does not apply.
```

(If tooling-only — no tag — replace "tagged <VERSION>" with "no version tag (tooling-only wave)".)

Begin.
