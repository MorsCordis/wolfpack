# Setting Up Wolfpack for Your Project

This guide walks through wiring Wolfpack into a new codebase. You can do this manually or ask your agent to help — either way, the result is a `wolfpack-config.md` in your project root plus a skills symlink that points your harness at this repo.

Wolfpack is harness-agnostic. The roles are `SKILL.md` files (an open standard) and work with any skill-aware agent runtime — Claude Code, Vibe, Aider, Cline, OpenCode, and others. Wherever this guide names Claude Code, it's only as one concrete example of "your agent harness."

## Prerequisites

- A skill-aware agent harness (Claude Code, Vibe, Aider, Cline, OpenCode, …)
- A git repository for your project
- At least one model per family in your pool (judgment / work-horse / reviewer) — see Step 3

## How distribution works

You do **not** copy the skills and commands into each project. Wolfpack lives in one cloned repo; you point your harness's user-level skills directory at this repo's canonical `.agents/skills`. The framework's real home is `.agents/` (skills, commands, workflows); `.claude/` is a compatibility symlink → `.agents/` for Claude Code users. Each project then only needs its own `wolfpack-config.md` and a `.wolfpack/` artifacts directory.

## Step 1: Clone Wolfpack and link the skills

```bash
git clone <wolfpack-repo-url> ~/wolfpack
```

Point your harness's user-level skills/commands directories at this repo's `.agents/` tree:

```bash
# Generic, open SKILL.md location (Vibe, Aider, Cline, OpenCode, ...):
ln -s ~/wolfpack/.agents/skills ~/.agents/skills

# Claude Code reads ~/.claude/skills — link the same content:
ln -s ~/wolfpack/.agents/skills ~/.claude/skills
ln -s ~/wolfpack/.agents/commands ~/.claude/commands
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

# Wolfpack — worktrees
.agents/worktrees/

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

## Asking your agent to set it up

If you'd rather have your agent configure everything:

```
I want to set up the Wolfpack pipeline for this project.
The framework is cloned at ~/wolfpack/.
Link the skills, create wolfpack-config.md with my project's
conventions (including the Model Pool), and update .gitignore.
```

The agent will read your codebase, infer conventions, and fill in the config. Review the config before running your first hunt — it's the foundation everything else builds on, especially the Model Pool mapping.

## Updating Wolfpack

When the upstream framework updates (new role features, tier adjustments, scoring changes), just pull — your symlink picks up the new content automatically:

```bash
cd ~/wolfpack && git pull
```

Because your harness reads the skills through a symlink to this repo, there's nothing to re-copy. Your `wolfpack-config.md` is your project's file (not the framework's) and is never touched by an update.
