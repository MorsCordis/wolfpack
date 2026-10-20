---
name: run-hunt
description: "Launch a single Wolfpack hunt inside the sandboxed Podman container. Full pipeline: scaffold through certification. Usage: /run-hunt <slug> \"<description>\""
allowed-tools: Bash
---

Launch a single automated Wolfpack hunt inside a sandboxed Podman container.

Parse `$ARGUMENTS` as: `<slug> "<description>"`. The description should be in quotes.

## Steps

0. **Resolve the pack and the worktree root first** (from the main checkout):

   **Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.

   **Worktree root (`WT_ROOT`).** In the main checkout run `node "$PACK/scripts/wolfpack-config.mjs" --json` and take `worktreeRoot` (wolfpack-config.md → Project Identity → Worktree root, repo-relative). If the reader exits 2 or `worktreeRoot` is null, STOP with the fix: "add ``- **Worktree root:** `<repo-relative dir, e.g. .agents/worktrees>` `` under ## Project Identity in wolfpack-config.md". Never assume a default location.

1. Resolve the hunt worktree-first: `$WT_ROOT/$SLUG/.wolfpack/plans/$SLUG/metadata.json`, else `.wolfpack/plans/$SLUG/metadata.json`.
   - Not found → a fresh hunt; `$DESCRIPTION` is required.
   - Found with `status` `certified`/`done`/`merged`, or human-gated `parked:*` (other than `parked:model_quota`) / `needs_spec` → stop and say why (`/merge` or `/resolve`).
   - Found otherwise (e.g. scaffolded by `/hunt`, `ready_for_alpha`) → **resume it**: the workflow's resume probe adopts the existing worktree. Use `metadata.description` verbatim as `$DESCRIPTION` (ignore any argument). For an interactive pre-spec first, prefer `/run-hunt-local` — this container path is headless.

2. Show what's about to run:
   - Display: "Hunt: $SLUG"
   - Display the description
   - Note: "Full pipeline — scaffold through certification with adversarial review"

3. Run the sandboxed pipeline. **First surface the live watcher** so the user can paste it into a
   separate terminal — print the label and the command on its OWN line (no prefix on the command
   line, so it copies cleanly), then exec. Do NOT auto-run the watcher (an in-process `--loop`
   just creates an endless scroll):

   The launcher is the PACK's (`PACK` from Step 0), never a copy in this repo. If
   `"$PACK/scripts/run-pipeline-sandbox.sh"` does not exist, STOP with Step 0's fix.
   Never run a `./scripts/run-pipeline-sandbox.sh` from the consuming repo.

   ```bash
   echo "Live progress — paste into a separate terminal:"
   echo "./scripts/wolfpack-watch.sh --loop 5"
   exec "$PACK/scripts/run-pipeline-sandbox.sh" --hunt $SLUG "$DESCRIPTION"
   ```

   The `exec` replaces this Claude process with the containerized one. The container runs Claude in `--permission-mode auto` with sandboxed filesystem access.

4. When the pipeline completes with `CERTIFIED_AWAITING_DEPLOY`:
   - The user deploys the worktree to dev
   - Smoke tests on dev
   - `/merge` the hunt

## What NOT to do

- Do NOT run the workflow directly (without the container). Always use the sandbox script.
- Do NOT attempt to deploy or push from inside the pipeline.
