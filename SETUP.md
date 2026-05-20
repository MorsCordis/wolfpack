# Setting Up Wolfpack for Your Project

This guide walks through configuring Wolfpack for a new codebase. You can do this manually or ask Claude to help — either way, the result is a `wolfpack-config.md` in your project root.

## Prerequisites

- [Claude Code](https://claude.ai/code) installed
- A git repository for your project
- At least one AI model available (Opus recommended for Alpha and Tracker)

## Step 1: Copy the Wolfpack files

From your project root:

```bash
# Copy skills
cp -r /path/to/wolfpack/.claude/skills/alpha /path/to/wolfpack/.claude/skills/bloodhound \
      /path/to/wolfpack/.claude/skills/shepherd /path/to/wolfpack/.claude/skills/pointer \
      /path/to/wolfpack/.claude/skills/tracker /path/to/wolfpack/.claude/skills/watchdog \
      /path/to/wolfpack/.claude/skills/wolfpack \
      .claude/skills/

# Copy commands
cp /path/to/wolfpack/.claude/commands/hunt.md \
   /path/to/wolfpack/.claude/commands/alpha.md \
   /path/to/wolfpack/.claude/commands/bloodhound.md \
   /path/to/wolfpack/.claude/commands/debrief.md \
   /path/to/wolfpack/.claude/commands/shepherd.md \
   /path/to/wolfpack/.claude/commands/pointer.md \
   /path/to/wolfpack/.claude/commands/tracker.md \
   /path/to/wolfpack/.claude/commands/watchdog.md \
   /path/to/wolfpack/.claude/commands/merge.md \
   /path/to/wolfpack/.claude/commands/smoke.md \
   /path/to/wolfpack/.claude/commands/expedition.md \
   .claude/commands/

# Copy infrastructure
cp -r /path/to/wolfpack/.wolfpack/ .wolfpack/
cp /path/to/wolfpack/scripts/wolfpack-lessons.sh scripts/

# Set up agent symlinks (for Mistral/Gemini)
mkdir -p .agents
ln -s ../.claude/skills .agents/skills
ln -s ../.claude/commands .agents/commands
```

## Step 2: Create your project configuration

```bash
cp /path/to/wolfpack/wolfpack-config.example.md wolfpack-config.md
```

Open `wolfpack-config.md` and fill in each section. The most important ones:

### Test command
How do you run tests? This is what Tracker will call.
```markdown
- **Test command:** `pytest` or `npm test` or `./scripts/run_tests.sh`
```

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

## Step 3: Install hooks (recommended)

Hooks enforce pipeline discipline at the tool level — preventing agents from committing to main, `git add .`-ing secrets, or spinning in loops.

```bash
# Copy hook scripts
mkdir -p .claude/hooks
cp /path/to/wolfpack/hooks/*.sh .claude/hooks/
chmod +x .claude/hooks/*.sh

# Add hook config to settings.json
# If you don't have one yet:
cp /path/to/wolfpack/hooks/settings.example.json .claude/settings.json

# If you already have a settings.json, merge the "hooks" section from
# hooks/settings.example.json into your existing file.
```

See [HOOKS.md](HOOKS.md) for details on each hook, customization options, and how to add project-specific hooks (prod deploy blocker, linter on save, test runner on stop).

## Step 4: Update your .gitignore

Add the Wolfpack artifacts that should be local-only:

```gitignore
# Wolfpack — hunt artifacts (local, copied back by /merge)
.wolfpack/plans/*/
!.wolfpack/plans/*/pedigree.json

# Wolfpack — worktrees
.claude/worktrees/
```

```gitignore
# Wolfpack — spin detector state
.claude/state/
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

## Step 5: Add to your CLAUDE.md

Add a Wolfpack section to your project's `CLAUDE.md`:

```markdown
## Wolfpack Pipeline

Multi-agent workflow: plan → review → implement → code review → test → certify.
Six roles, five tiers. Slash commands only; `/clear` between phases.
See `.claude/skills/wolfpack/SKILL.md` for full detail.

Project configuration: `wolfpack-config.md`
```

## Step 6: Run your first hunt

```
/hunt my-first-feature "Brief description of what you're building"
```

The hunt will:
1. Ask scope-envelope questions (target area, mode guess, version tag)
2. Create a worktree and plan directory
3. Tell you the exact next command to run

Follow the finishing messages — each phase tells you what to do next.

## Asking Claude to Set It Up

If you'd rather have Claude configure everything:

```
I want to set up the Wolfpack pipeline for this project. 
The framework is at ~/Projects/wolfpack/. 
Copy the skills and commands, create wolfpack-config.md 
with my project's conventions, and update .gitignore.
```

Claude will read your codebase, infer conventions, and fill in the config. Review the config before running your first hunt — it's the foundation everything else builds on.

## Updating Wolfpack

When the upstream framework updates (new role features, tier adjustments, scoring changes):

```bash
# Pull updates
cd /path/to/wolfpack && git pull

# Re-copy skills and commands to your project
cp -r /path/to/wolfpack/.claude/skills/{alpha,bloodhound,shepherd,pointer,tracker,watchdog,wolfpack} \
      /path/to/your/project/.claude/skills/
cp /path/to/wolfpack/.claude/commands/{hunt,alpha,bloodhound,debrief,shepherd,pointer,tracker,watchdog,merge,smoke,expedition}.md \
      /path/to/your/project/.claude/commands/
```

Your `wolfpack-config.md` is never overwritten — it's your project's file, not the framework's.
