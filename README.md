# Wolfpack

A multi-agent pipeline for AI-assisted software development. Six roles, five tiers of ceremony, adversarial cross-family review, pedigree-driven model selection.

Wolfpack is **harness-agnostic** and **model-agnostic**. The roles are defined as `SKILL.md` files — an open standard understood by any skill-aware agent harness (Claude Code, Vibe, Aider, Cline, OpenCode, and others). Nothing in the pipeline is tied to one runtime or one model vendor. You map the abstract role families onto the concrete models you have via a per-project config file (`wolfpack-config.md`).

## What It Does

Wolfpack structures AI code changes into a reviewable, certifiable pipeline:

```
/hunt → /alpha (plan) → /bloodhound (review plan) → /debrief →
/shepherd (implement) → /pointer (review code) → /tracker (write tests) →
/watchdog (certify) → /merge → deploy → /smoke
```

Each role runs in a fresh session — information flows between roles only through files. This prevents the "context window soup" problem where a single long session loses track of decisions made earlier.

### The Pack

Roles are assigned by **property**, not by brand. Each role maps to a model *family* (judgment / work-horse / reviewer), and your project supplies the concrete models for those families in `wolfpack-config.md → Model Pool`. The router (`scripts/wolfpack-routing.mjs`) reads that pool and the pedigree history to pick a model per role per hunt.

| Role | Job | Model family (per Model Pool) |
|------|-----|-------------------------------|
| **Alpha** | Write the plan, score dimensions, assign models | Judgment family (fixed planner) |
| **Bloodhound** | Adversarial plan review | Reviewer family, cross-family from Alpha |
| **Shepherd** | Implement code (no tests) | Work-horse family (judgment on heavy/compliance) |
| **Pointer** | Adversarial code review | Reviewer family, cross-family from Shepherd |
| **Tracker** | Write and run tests | Judgment family (routable on light tiers) |
| **Watchdog** | Certify code + tests, score pedigree | Reviewer family, cross-family from Shepherd |

The one invariant that never relaxes: **review roles must be a different model family from the role they review** (adversarial cross-family pairing). Everything else is data-driven.

### Five Tiers

| Tier | Ceremony | When |
|------|----------|------|
| **Green** | Skip review/test phases | Typos, config, tiny fixes |
| **Blue** | One-shot review + test | Small features, polish |
| **Yellow** | Standard (can loop) | Normal features |
| **Orange** | Full (can loop) | Multi-component, API changes |
| **Red** | Full + security/compliance | High-risk, compliance, architectural |

## Quick Start

Wolfpack ships as a self-contained repo. You don't copy files into your project — you point your agent harness's skills directory at this repo's `.agents/skills`, then drop a `wolfpack-config.md` into your project so the roles know your conventions.

### 1. Clone Wolfpack

```bash
git clone <wolfpack-repo-url> ~/wolfpack
```

### 2. Point your harness at the skills

Wolfpack's canonical layout lives under `.agents/` (`skills/`, `commands/`, `workflows/`). `.agents/skills` is the open `SKILL.md` location that any skill-aware harness reads. A `.claude/` compatibility symlink → `.agents/` is included for Claude Code users.

Symlink your harness's user-level skills directory at this repo's `.agents/skills`:

```bash
# Generic, open SKILL.md location (Vibe, Aider, Cline, OpenCode, ...):
ln -s ~/wolfpack/.agents/skills ~/.agents/skills

# Claude Code reads ~/.claude/skills — point it at the same content:
ln -s ~/wolfpack/.agents/skills ~/.claude/skills
ln -s ~/wolfpack/.agents/commands ~/.claude/commands
```

(Adjust the destination to wherever your runtime discovers user-level skills/commands.)

The roles also call helper **scripts** (`scripts/wolfpack-*.mjs|sh`) from this repo. Point at them with `WOLFPACK_HOME` so they resolve from the one cloned repo — no per-project copies:

```bash
export WOLFPACK_HOME=~/wolfpack   # add to your shell profile
```

### 3. Configure your project

Copy the config template into your project root and fill it in:

```bash
cp ~/wolfpack/wolfpack-config.example.md /path/to/your/project/wolfpack-config.md
```

Edit `wolfpack-config.md` with:
- Your test command (`npm test`, `pytest`, `go test`, etc.)
- Your deploy command
- Hard rules (things agents must never do)
- Code review checklist (project conventions Pointer should enforce)
- Compliance requirements (if any)
- **Model Pool** — map the judgment / work-horse / reviewer-a / reviewer-b families onto the concrete models you have

The pipeline roles read `wolfpack-config.md` for everything project-specific.

### 4. Install hooks

Hooks enforce branch discipline, block `git add .`, and catch agent spin loops at the tool level.

```bash
mkdir -p .agents/hooks
cp ~/wolfpack/hooks/*.sh .agents/hooks/
chmod +x .agents/hooks/*.sh
cp ~/wolfpack/hooks/settings.example.json .agents/settings.json
```

See [HOOKS.md](HOOKS.md) for details and customization. (The example settings reference `.claude/hooks/…`; if your harness reads a different settings location, adjust the paths to match where you placed the scripts.)

### 5. Run your first hunt

```
/hunt my-feature "Add user profile editing"
/clear → /alpha my-feature
# ... follow the handoff messages
```

## How It Works

### Metadata-Driven

Every hunt creates a `.wolfpack/plans/<slug>/metadata.json` that tracks:
- Current phase and status
- Which model runs each role
- Predicted task dimensions (7 scores, 1-5)
- Tier and review strategy
- Round counts and caps

Each role's preflight reads metadata to self-navigate (find the worktree, check the phase, determine the next handoff). No manual `cd` or copy-paste needed beyond the finishing message.

### Adversarial Cross-Family

Review roles MUST use a different model family from the role they review:
- Bloodhound ≠ Alpha
- Pointer ≠ Shepherd
- Watchdog ≠ Shepherd

This prevents blind spots — a model reviewing its own work catches less than a different model reviewing it. The router enforces this as a fail-loud invariant (`scripts/wolfpack-routing.mjs`).

### Pedigree

Every completed hunt gets scored by Watchdog on execution quality (plan adherence, code quality, test results) and process value-add (did Pointer catch real bugs? did the model selection work?). Alpha and the router read this history to make better model assignments on future hunts.

### Rewrite Cycles

Pointer and Tracker can each send code back to Shepherd for fixes:
- Pointer finds code issues → Shepherd rewrites → Pointer re-reviews
- Tracker finds test failures → Shepherd fixes → Tracker re-runs
- Max 2 rounds each before escalating to the user
- Blue tier: one-shot only (report, no loop)

## Directory Structure

Wolfpack's own layout (this repo):

```
wolfpack/
├── README.md                       # This file
├── SETUP.md                        # Per-project setup guide
├── HOOKS.md                        # Hook reference
├── wolfpack-config.example.md      # Config template (copy into your project)
├── .agents/                        # CANONICAL home for the framework
│   ├── skills/
│   │   ├── wolfpack/SKILL.md       # Pipeline framework
│   │   ├── alpha/SKILL.md          # Planner role
│   │   ├── bloodhound/SKILL.md     # Plan reviewer role
│   │   ├── shepherd/SKILL.md       # Implementer role
│   │   ├── pointer/SKILL.md        # Code reviewer role
│   │   ├── tracker/SKILL.md        # Tester role
│   │   └── watchdog/SKILL.md       # Certifier role
│   ├── commands/
│   │   ├── hunt.md                 # Scaffold a new hunt
│   │   ├── alpha.md                # Run planner
│   │   ├── bloodhound.md           # Run plan reviewer
│   │   ├── debrief.md              # Synthesize plan + model assignments
│   │   ├── shepherd.md             # Run implementer
│   │   ├── pointer.md              # Run code reviewer
│   │   ├── tracker.md              # Run tester
│   │   ├── watchdog.md             # Run certifier
│   │   ├── merge.md                # Merge to main
│   │   ├── smoke.md                # Post-deploy verification
│   │   └── expedition.md           # Multi-hunt campaign scouting
│   └── workflows/                  # Headless campaign/hunt runners
├── .claude/                        # COMPAT SYMLINK → .agents/ (Claude Code users)
│   ├── skills -> ../.agents/skills
│   └── commands -> ../.agents/commands
├── .wolfpack/
│   ├── pedigree/
│   │   ├── index.md                # Rolling scorecard (tracked in git)
│   │   └── lessons.md              # Aggregated patterns (auto-generated)
│   ├── plans/<slug>/               # Per-hunt artifacts (gitignored except pedigree.json)
│   ├── campaigns/<slug>/           # Multi-hunt campaign plans
│   ├── known-broken-tests.md       # Baseline test failures (tracked)
│   └── cross-cutting-debt.md       # Cross-hunt technical debt (tracked)
├── hooks/                          # Distributable hook scripts
│   ├── main-branch-guard.sh        # Blocks source edits on main
│   ├── git-add-guard.sh            # Blocks git add . / -A / --all
│   ├── spin-detector.sh            # Catches agent loops
│   ├── reset-spin-state.sh         # Clears spin state on session start
│   └── settings.example.json       # Hook wiring + permissions
└── scripts/
    ├── wolfpack-routing.mjs        # Model→role router (family-based, data-driven)
    └── wolfpack-lessons.sh         # Pedigree aggregator
```

In **your** project you only add `wolfpack-config.md` (project root) and a `.wolfpack/` artifacts directory; the skills/commands are discovered through the symlink to this repo's `.agents/skills`.

## Key Design Principles

1. **Fresh sessions between phases** — each role starts clean, no context carryover
2. **Files are the only channel** — roles communicate through plan directory artifacts
3. **Harness- and model-agnostic** — roles are `SKILL.md` files; models are mapped by family in `wolfpack-config.md`
4. **Include by default, defer by justification** — downstream consequences are in scope
5. **Justify simplicity** — "simpler" is not a standalone justification; explain why it's correct
6. **No test shortcuts** — tests must exercise actual behavior, not work around it
7. **Actionable findings only** — every review finding must include a concrete fix
8. **Proportional ceremony** — Green is fast, Red is thorough, tiers scale automatically

## License

MIT
