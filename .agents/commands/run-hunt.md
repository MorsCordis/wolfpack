---
name: run-hunt
description: "Launch a single Wolfpack hunt inside the sandboxed Podman container. Full pipeline: scaffold through certification. Usage: /run-hunt <slug> \"<description>\""
allowed-tools: Bash
---

Launch a single automated Wolfpack hunt inside a sandboxed Podman container.

Parse `$ARGUMENTS` as: `<slug> "<description>"`. The description should be in quotes.

## Steps

1. Verify the slug doesn't already have an active hunt: check `.wolfpack/plans/$SLUG/metadata.json`. If it exists and `status` is not `certified`, warn the user and stop.

2. Show what's about to run:
   - Display: "Hunt: $SLUG"
   - Display the description
   - Note: "Full pipeline — scaffold through certification with adversarial review"

3. Run the sandboxed pipeline. **First surface the live watcher** so the user can paste it into a
   separate terminal — print the label and the command on its OWN line (no prefix on the command
   line, so it copies cleanly), then exec. Do NOT auto-run the watcher (an in-process `--loop`
   just creates an endless scroll):

   **Resolve the pack home first** (the launcher is the PACK's, never a copy in this repo):
   `PACK="$WOLFPACK_HOME"`; if that is empty, use the `Wolfpack home` value from
   `node <any pack checkout>/scripts/wolfpack-config.mjs --json` (its `wolfpackHome`
   field), or read it by eye from `wolfpack-config.md` → Project Identity →
   Wolfpack home if the reader is not at hand (expand a leading `~`). If neither is set, or
   `"$PACK/scripts/run-pipeline-sandbox.sh"` does not exist, STOP and give the user the fix:
   "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add
   a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md".
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
