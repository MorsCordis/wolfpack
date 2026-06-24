---
name: expedition
description: Scout-only campaign — Alpha bundles TODO items into a hunt list. Stops after writing campaign.md. Usage: /expedition [--no-review] [--max-hunts=N] <campaign-slug> "<description>"
allowed-tools: Bash, Read, Write, Edit, Agent, AskUserQuestion
---

Scout and plan a multi-hunt campaign for: $ARGUMENTS

## What this does

Alpha reads TODO.md, the description, and the codebase to propose a sequence of hunts. Each hunt gets a slug, a plain-English **intent**, its **source** (ticket / deferral / TODO item), description, tier, mode, wave assignment, dependencies, and a trigger command.

## Steps

1. Parse arguments: `[--no-review] [--max-hunts=N] <campaign-slug> "<description>"`
2. Read TODO.md, CHANGELOG.md, open tickets, and relevant source files — and note each item's ORIGIN to record as the hunt's **Source**: a ticket (env-qualified, `dev#N` ≠ `prod#N`), a deferral from a prior hunt's findings, a TODO.md item, or an ad-hoc request
3. Bundle related items into hunts by shared cost:
   - Same area, low individual complexity -> bundle
   - Different areas, high complexity, compliance -> solo
   - Cap: `--max-hunts=N` (default 10)
4. Assign waves (parallel tracks within a wave, sequential between waves)
5. Write `.wolfpack/campaigns/<slug>/campaign.md` with the hunt list
6. Optional: Bloodhound reviews the campaign decomposition (`--no-review` skips)
7. Present campaign for user approval

## Campaign.md format

```markdown
# Campaign: <slug>

## Description
## Proposed Hunts

### 1. <hunt-slug>
- **Description:** ...
- **Intent:** <one plain-English sentence — what this hunt accomplishes for the user/clinic, no jargon>
- **Source:** <ticket `dev#N` / `prod#N` (env-qualified) | deferral from `<hunt-slug>` (the finding) | TODO.md item | ad-hoc request>
- **Tier:** Green|Blue|Yellow|Orange|Red
- **Mode:** update|feature
- **Wave:** N
- **Track:** A|B|C
- **Depends on:** <other slugs or "none">
- **TODO items cleared:** <list>
- **Trigger:** `/hunt --campaign=<slug> <hunt-slug> "<description>"`

### 2. ...

## Wave Diagram
```

## Finishing message

```
Campaign scouted: <slug> (<N> hunts across <M> waves)

Start with: /hunt --campaign=<slug>
```

Begin.
