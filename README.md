# Wolfpack

A multi-agent pipeline for AI-assisted software development. Six roles, five tiers of ceremony, adversarial cross-model review, pedigree-driven model selection.

## What It Does

Wolfpack structures AI code changes into a reviewable, certifiable pipeline:

```
/hunt → /alpha (plan) → /bloodhound (review plan) → /debrief →
/shepherd (implement) → /pointer (review code) → /tracker (write tests) →
/watchdog (certify) → /merge → deploy → /smoke
```

Each role runs in a fresh session — information flows between roles only through files. This prevents the "context window soup" problem where a single long session loses track of decisions made earlier.

### The Pack

| Role | Job | Model |
|------|-----|-------|
| **Alpha** | Write the plan, score dimensions, assign models | Always Opus |
| **Bloodhound** | Adversarial plan review | Cross-model from Alpha |
| **Shepherd** | Implement code (no tests) | Pedigree-selected |
| **Pointer** | Adversarial code review | Cross-model from Shepherd |
| **Tracker** | Write and run tests | Always Opus |
| **Watchdog** | Certify code + tests, score pedigree | Cross-model from Shepherd |

### Five Tiers

| Tier | Ceremony | When |
|------|----------|------|
| **Green** | Skip review/test phases | Typos, config, tiny fixes |
| **Blue** | One-shot review + test | Small features, polish |
| **Yellow** | Standard (can loop) | Normal features |
| **Orange** | Full (can loop) | Multi-component, API changes |
| **Red** | Full + security/compliance | High-risk, compliance, architectural |

## Quick Start

### 1. Install

Copy the `.claude/` directory into your project:

```bash
cp -r wolfpack/.claude/ /path/to/your/project/.claude/
cp -r wolfpack/.wolfpack/ /path/to/your/project/.wolfpack/
cp wolfpack/scripts/wolfpack-lessons.sh /path/to/your/project/scripts/
```

Or symlink if you want to track upstream changes:
```bash
ln -s /path/to/wolfpack/.claude/skills/wolfpack /path/to/your/project/.claude/skills/wolfpack
# (repeat for each role skill and command)
```

### 2. Configure

Copy the config template and fill in your project's details:

```bash
cp wolfpack/wolfpack-config.example.md /path/to/your/project/wolfpack-config.md
```

Edit `wolfpack-config.md` with:
- Your test command (`npm test`, `pytest`, `go test`, etc.)
- Your deploy command
- Hard rules (things agents must never do)
- Code review checklist (project conventions Pointer should enforce)
- Compliance requirements (if any)

### 3. Set up agents directory (for Mistral/Gemini)

```bash
cd /path/to/your/project
ln -s .claude/skills .agents/skills
ln -s .claude/commands .agents/commands
```

### 4. Run your first hunt

```bash
# In Claude Code:
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

### Adversarial Cross-Model

Review roles MUST use a different model family from the role they review:
- Bloodhound ≠ Alpha
- Pointer ≠ Shepherd  
- Watchdog ≠ Shepherd

This prevents blind spots — a model reviewing its own work catches less than a different model reviewing it.

### Pedigree

Every completed hunt gets scored by Watchdog on execution quality (plan adherence, code quality, test results) and process value-add (did Pointer catch real bugs? did the model selection work?). Alpha reads this history to make better model assignments on future hunts.

### Rewrite Cycles

Pointer and Tracker can each send code back to Shepherd for fixes:
- Pointer finds code issues → Shepherd rewrites → Pointer re-reviews
- Tracker finds test failures → Shepherd fixes → Tracker re-runs
- Max 2 rounds each before escalating to the user
- Blue tier: one-shot only (report, no loop)

## Directory Structure

```
your-project/
├── wolfpack-config.md           # Your project-specific configuration
├── .claude/
│   ├── skills/
│   │   ├── wolfpack/SKILL.md    # Pipeline framework
│   │   ├── alpha/SKILL.md       # Planner role
│   │   ├── bloodhound/SKILL.md  # Plan reviewer role
│   │   ├── shepherd/SKILL.md    # Implementer role
│   │   ├── pointer/SKILL.md     # Code reviewer role
│   │   ├── tracker/SKILL.md     # Tester role
│   │   └── watchdog/SKILL.md    # Certifier role
│   └── commands/
│       ├── hunt.md              # Scaffold a new hunt
│       ├── alpha.md             # Run planner
│       ├── bloodhound.md        # Run plan reviewer
│       ├── debrief.md           # Synthesize plan + model assignments
│       ├── shepherd.md          # Run implementer
│       ├── pointer.md           # Run code reviewer
│       ├── tracker.md           # Run tester
│       ├── watchdog.md          # Run certifier
│       ├── merge.md             # Merge to main
│       ├── smoke.md             # Post-deploy verification
│       └── expedition.md        # Multi-hunt campaign scouting
├── .wolfpack/
│   ├── pedigree/
│   │   ├── index.md             # Rolling scorecard (tracked in git)
│   │   └── lessons.md           # Aggregated patterns (auto-generated)
│   ├── plans/<slug>/            # Per-hunt artifacts (gitignored except pedigree.json)
│   ├── campaigns/<slug>/        # Multi-hunt campaign plans
│   ├── known-broken-tests.md    # Baseline test failures (tracked)
│   └── cross-cutting-debt.md    # Cross-hunt technical debt (tracked)
├── .agents/
│   ├── skills -> ../.claude/skills
│   └── commands -> ../.claude/commands
└── scripts/
    └── wolfpack-lessons.sh      # Pedigree aggregator
```

## Key Design Principles

1. **Fresh sessions between phases** — each role starts clean, no context carryover
2. **Files are the only channel** — roles communicate through plan directory artifacts
3. **Include by default, defer by justification** — downstream consequences are in scope
4. **Justify simplicity** — "simpler" is not a standalone justification; explain why it's correct
5. **No test shortcuts** — tests must exercise actual behavior, not work around it
6. **Actionable findings only** — every review finding must include a concrete fix
7. **Proportional ceremony** — Green is fast, Red is thorough, tiers scale automatically

## License

MIT
