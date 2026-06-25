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
   ```bash
   echo "Live progress — paste into a separate terminal:"
   echo "watch -c -n5 'WOLFPACK_WATCH_COLOR=1 \${WOLFPACK_HOME:-.}/scripts/wolfpack-watch.sh'"
   exec ./scripts/run-pipeline-sandbox.sh --hunt $SLUG "$DESCRIPTION"
   ```

   The `exec` replaces this Claude process with the containerized one. The container runs Claude in `--permission-mode auto` with sandboxed filesystem access.

4. When the pipeline completes with `CERTIFIED_AWAITING_DEPLOY`:
   - The user deploys the worktree to dev
   - Smoke tests on dev
   - `/merge` the hunt

## What NOT to do

- Do NOT run the workflow directly (without the container). Always use the sandbox script.
- Do NOT attempt to deploy or push from inside the pipeline.
