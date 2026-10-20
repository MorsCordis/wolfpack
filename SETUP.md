# Setting Up Wolfpack for Your Project

This guide walks through wiring Wolfpack into a new codebase. You can do this manually or ask your agent to help — either way, the result is a `wolfpack-config.md` in your project root, the user-level links that point your harness at this repo, and your project's generated workflow copies — all but the config made by one command, `install.sh`.

Wolfpack is harness-agnostic. The roles are `SKILL.md` files (an open standard) and work with any skill-aware agent runtime — Claude Code, Vibe, Aider, Cline, OpenCode, and others. Wherever this guide names Claude Code, it's only as one concrete example of "your agent harness."

## Prerequisites

- A skill-aware agent harness (Claude Code, Vibe, Aider, Cline, OpenCode, …)
- A git repository for your project
- At least one model per family in your pool (judgment / work-horse / reviewer) — see Step 3

## How distribution works

You do **not** copy the skills and commands into each project. Wolfpack lives in one cloned repo, and `install.sh` links your harness's user-level `~/.claude/commands` and `~/.claude/skills` at this repo's canonical `.agents/commands` and `.agents/skills`. The framework's real home is `.agents/` (skills, commands, workflows). Each project then only needs its own `wolfpack-config.md`, a `.wolfpack/` artifacts directory and the generated workflow copies `install.sh` writes into its `.claude/workflows/`.

## Step 1: Clone Wolfpack and run install.sh

```bash
git clone <wolfpack-repo-url> ~/wolfpack
bash ~/wolfpack/install.sh
```

`install.sh` links `~/.claude/commands` and `~/.claude/skills` to the pack, installs the Vibe seat profiles (see "Vibe seat profiles" below) and prints the pack version (`Wolfpack pack: <tag> (<commit>) at <path>`). It never replaces a real `~/.claude/commands` or `~/.claude/skills` directory — it stops and prints the `mv` that moves yours aside. Run it again any time: it is idempotent. `bash ~/wolfpack/install.sh --check` is read-only and names every problem with its exact fix.

Other harnesses (optional, manual): link the generic, open SKILL.md location yourself:

```bash
# Vibe, Aider, Cline, OpenCode, ...:
ln -s ~/wolfpack/.agents/skills ~/.agents/skills
```

Adjust the destination to wherever your runtime discovers user-level skills and commands. The slash commands (`/hunt`, `/alpha`, …) become available once the harness sees them.

## Step 2: Set up the project artifacts directory

From your project root:

```bash
# Per-hunt + pedigree artifacts live in your project's .wolfpack/
mkdir -p .wolfpack/pedigree .wolfpack/plans .wolfpack/campaigns
cp ~/wolfpack/.wolfpack/pedigree/index.md       .wolfpack/pedigree/ 2>/dev/null || : 
cp ~/wolfpack/.wolfpack/known-broken-tests.md   .wolfpack/ 2>/dev/null || :
cp ~/wolfpack/.wolfpack/cross-cutting-debt.md   .wolfpack/ 2>/dev/null || :
```

(These seed files are optional starting points — the roles create what they need on first run.)

## Step 3: Create your project configuration

```bash
cp ~/wolfpack/wolfpack-config.example.md wolfpack-config.md
```

Open `wolfpack-config.md` and fill in each section. The most important ones:

### Worktree root (required)
Where your hunt worktrees live, repo-relative and gitignored. The workflows refuse to run without it.
```markdown
- **Worktree root:** `.agents/worktrees`
```

### Test command
How do you run tests? This is what Tracker will call.
```markdown
- **Test command:** `pytest` or `npm test` or `./scripts/run_tests.sh`
```

### Model Pool
Map the abstract role families onto the concrete models you have. The router (`scripts/wolfpack-routing.mjs`) reasons about families, not brands:
```markdown
- judgment    → (your strongest reasoning model)
- work-horse  → (your cheap high-throughput model)
- reviewer-a  → (a model from a different family than your implementers)
- reviewer-b  → (a second cross-family reviewer, optional)
```
The hard rule the router enforces: reviewers must be a **different family** from the implementer (cross-family adversarial review).

### Hard rules
What must agents NEVER do? These go beyond the defaults (no `git add .`, no prod deploy).
```markdown
1. Never modify database schemas directly — always use migrations
2. Never commit secrets or API keys
3. (your rules here)
```

### Code review checklist
What project conventions should Pointer enforce? Think about the mistakes you've corrected most often.
```markdown
- All API endpoints must have authentication
- No inline styles — use CSS classes
- Every database query must have an index strategy
```

### Project commands and the no-copies guard
A consuming project tracks **no** copy of a pack command, skill or workflow. Keep only project commands, list them under Project commands, and run the guard in CI: `node "$WOLFPACK_HOME/scripts/wolfpack-no-copies.mjs" .` (exit 0 clean, 1 offending paths with fixes, 2 setup error).

```markdown
- **Project commands:** `doc-reviewer`, `structural-audit` — or none
```

A tracked copy is shadowed by the user-level link `install.sh` makes, so it never runs and silently drifts from the pack. The guard fails on any tracked `.claude/commands/` or `.agents/commands/` file not on that list, any `.claude/skills/<name>/` (or `.agents/skills/<name>/`) whose name is a pack skill, and any tracked `.claude/workflows/` file other than `README.md`. A project skill with its own name is fine. The guard is the installed pack's, never a vendored copy: a CI runner needs the pack checkout (`WOLFPACK_HOME`, or the `Wolfpack home` key) and the job must fail loud when it is missing. Run against the pack itself, the guard checks that `.claude/{commands,skills,workflows}` are the tracked links to `.agents/`.

### Smoke login hook
If `/smoke` and `/smoke-wave` should sign a smoke browser in to your dev host, set `Smoke login hook` under `## Deployment Notes` to a backticked command template with `{host}` (and optional `{account}`) plus its account names. The contract (exit codes, the `--check` probe printing `SIGNED_IN`/`SIGNED_OUT`, `none`) is in `wolfpack-config.example.md` → "Smoke login hook". With `none`, both commands say so and use your own browser session.

## Step 3b: Generate the workflows

From your project root, run the installer again — inside a project that has a `wolfpack-config.md` it also generates the project's workflow copies:

```bash
cd <project> && bash ~/wolfpack/install.sh      # or: bash ~/wolfpack/install.sh --consumer <project>
bash ~/wolfpack/install.sh --check              # must print: install.sh --check: OK
```

This writes `.claude/workflows/hunt-pipeline.js` and `.claude/workflows/campaign-runner.js`: copies of the pack's canonical workflows, each stamped with the pack commit, version and a hash of its source. Each run starts by logging the running script's version and checking that stamp against the pack.

**The track-or-ignore rule:** A generated workflow copy is never tracked. `.claude/workflows/hunt-pipeline.js` and `.claude/workflows/campaign-runner.js` are gitignored in every consuming project and produced by `install.sh`; the run start refuses a stale one. (Step 5 adds the ignore lines.)

**The stale-workflow fix:** a run that stops with STALE WORKFLOW: run the printed `install.sh --consumer …` command, restart Claude Code, relaunch. (Claude Code caches named workflows per session, so a regenerated copy only runs after a restart.) A copy that was hand-edited stops the run the same way — never edit a generated copy; change the pack and regenerate.

## Step 4: Install hooks (recommended)

Hooks enforce pipeline discipline at the tool level — preventing agents from committing to main, `git add .`-ing secrets, or spinning in loops.

```bash
# Copy hook scripts into your harness's hooks directory
mkdir -p .agents/hooks
cp ~/wolfpack/hooks/*.sh .agents/hooks/
chmod +x .agents/hooks/*.sh

# Add hook config to your harness's settings file.
# If you don't have one yet:
cp ~/wolfpack/hooks/settings.example.json .agents/settings.json

# If you already have settings, merge the "hooks" section from
# hooks/settings.example.json into your existing file.
```

The example settings reference the scripts by relative path (`.claude/hooks/…` for the Claude Code compat layout). Adjust those paths to wherever your harness reads its settings and where you placed the scripts. See [HOOKS.md](HOOKS.md) for details on each hook, customization, and how to add project-specific hooks (prod deploy blocker, linter on save, test runner on stop).

## Step 5: Update your .gitignore

Add the Wolfpack artifacts that should be local-only:

```gitignore
# Wolfpack — hunt artifacts (local, copied back by /merge)
.wolfpack/plans/*/
!.wolfpack/plans/*/pedigree.json

# Wolfpack — worktrees (the directory your Worktree root names)
.agents/worktrees/

# Wolfpack — generated workflow copies (install.sh writes them; never tracked)
.claude/workflows/hunt-pipeline.js
.claude/workflows/campaign-runner.js

# Wolfpack — spin detector state
.agents/state/
```

And the files that SHOULD be tracked:
```
# These are tracked (don't ignore them):
# .wolfpack/pedigree/index.md
# .wolfpack/pedigree/lessons.md
# .wolfpack/known-broken-tests.md
# .wolfpack/cross-cutting-debt.md
# .wolfpack/plans/*/pedigree.json
```

## Step 6: Add to your agent instructions

Add a Wolfpack section to your project's agent instructions file (`CLAUDE.md`, `AGENTS.md`, or whatever your harness reads):

```markdown
## Wolfpack Pipeline

Multi-agent workflow: plan → review → implement → code review → test → certify.
Six roles, five tiers. Slash commands only; `/clear` between phases.
See the `wolfpack` skill for full detail.
Pack docs: the wolfpack repo's docs/user-guide.md and docs/autonomy/.

Project configuration: `wolfpack-config.md`
```

## Step 7: Run your first hunt

```
/hunt my-first-feature "Brief description of what you're building"
```

The hunt will:
1. Ask scope-envelope questions (target area, mode guess, version tag)
2. Create a worktree and plan directory
3. Tell you the exact next command to run

Follow the finishing messages — each phase tells you what to do next.

## Vibe seat profiles

If your project runs cross-model review seats through Vibe (the pack's shim,
`$WOLFPACK_HOME/scripts/podman-vibe.sh`), the seat profiles are part of the pack, not hand-made
local files:

- The templates live in `vibe-agents/` (`wolfpack-*.toml`, one per seat).
- Install or update them with `node scripts/wolfpack-install-vibe-agents.mjs` (default
  destination `~/.vibe/agents-headless/`; `--dest DIR` or `WOLFPACK_VIBE_AGENTS_DIR` overrides).
  It reports each file as installed / unchanged / replaced, backs up any file it replaces
  (`<name>.bak-<timestamp>`), and leaves every other profile alone.
  `--check` writes nothing and exits 1 on drift.
- `node scripts/wolfpack-toolcheck.mjs --shim "$WOLFPACK_HOME/scripts/podman-vibe.sh"` (or omit
  `--shim`: it defaults to `WOLFPACK_HOME`'s shim) checks that every
  pipeline seat profile agrees with the tools the shim enables (review/certify seats need a shell
  to run `git diff` and the tests; implementers stay shell-free). It exits non-zero on any
  mismatch, and `hunt-pipeline.js` runs it as a preflight before the first review seat.
- Never hand-edit `~/.vibe/agents-headless/`: change the template, re-run the installer.
  `install.sh` runs this installer for you; `install.sh --check` reports drift.

## Execution layer

The cross-family seat shim (`scripts/podman-vibe.sh`), the unified pipeline sandbox
(`scripts/run-pipeline-sandbox.sh`), the rate-limit lib and the sandbox images
(`containers/Containerfile.wolfpack`, `containers/Containerfile.wolfpack-glm`) live in the pack.
A consuming project never copies them; the pipeline finds them through the pack home:

1. Set the pack home: `export WOLFPACK_HOME=<absolute path of this checkout>`, or add
   a `Wolfpack home` line (`- **Wolfpack home:** ` then the path in backticks) under
   `## Project Identity` in your `wolfpack-config.md`
   (env wins). Both workflows stop with the fix when neither is set — they never look for the
   shim in your repo.
2. Fill `## Execution Layer` in `wolfpack-config.md` (see `wolfpack-config.example.md`): the
   image names, an optional project layer, extra mounts, secrets paths, the Vibe agent dir and
   an optional seat test env. Check it with `node "$WOLFPACK_HOME/scripts/wolfpack-config.mjs" --exec`.
3. Build the images from your repo root: `bash "$WOLFPACK_HOME/scripts/wolfpack-build-images.sh"`
   (`--rebuild` rebuilds and prints the rollback command first). The shim also builds a missing
   image on first use.

Image names are host-global podman tags: give every project that builds a different layer its
OWN `Sandbox image` / `GLM image` names, or one project's build replaces the other's.

The project layer contract: a Containerfile that starts `ARG BASE_IMAGE` then
`FROM ${BASE_IMAGE}` (the pack base), may switch to `USER root` for its installs, ends with
`USER ${WOLFPACK_USER}`, and is built with your repo root as its context. The pack base carries
only the tooling (git, jq, dbus/libsecret, curl) and Vibe in its own venv; your language
runtime, dependencies and any local test database belong in the layer.

## Optional: usage snapshot (Claude Code)

The window gate (`scripts/wolfpack-window-gate.mjs`) decides on Claude Code's **real** 5-hour /
7-day usage when it can see it. Only the status line receives those figures, so install the
wrapper in front of your status line (a user step — agents never edit `~/.claude/settings.json`):

```json
"statusLine": { "type": "command", "command": "/usr/bin/node <path-to-wolfpack>/scripts/wolfpack-statusline.mjs" }
```

The wrapper passes the status JSON through to claude-hud unchanged (it auto-discovers the newest
installed claude-hud; to keep an existing command verbatim, append `-- bash -c '<old command>'`)
and snapshots only `rate_limits` + a timestamp to `~/.cache/wolfpack/claude-usage.json`. Check it
with `scripts/wolfpack-usage`. Without a fresh snapshot (no interactive session rendering the
status line for > 10 min) the gate falls back to the transcript estimate, labelled `degraded`.
Revert by restoring the old command.

## Asking your agent to set it up

If you'd rather have your agent configure everything:

```
I want to set up the Wolfpack pipeline for this project.
The framework is cloned at ~/wolfpack/.
Run ~/wolfpack/install.sh, create wolfpack-config.md with my project's
conventions (including the Model Pool and the Worktree root), run
install.sh again from the project root, and update .gitignore.
Finish with: bash ~/wolfpack/install.sh --check
```

The agent will read your codebase, infer conventions, and fill in the config. Review the config before running your first hunt — it's the foundation everything else builds on, especially the Model Pool mapping.

## Updating Wolfpack

When the upstream framework updates (new role features, tier adjustments, scoring changes), pull, then re-run the installer in each consuming project and restart Claude Code:

```bash
cd ~/wolfpack && git pull
cd <project> && bash ~/wolfpack/install.sh      # regenerates the stamped workflow copies
bash ~/wolfpack/install.sh --check
```

The skills and commands are read through the user-level links, so they update with the pull. The workflow copies do not: a run started on an old copy stops with STALE WORKFLOW until you regenerate and restart. Your `wolfpack-config.md` is your project's file (not the framework's) and is never touched by an update.
