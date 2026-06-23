---
name: merge
description: Merge a certified Wolfpack hunt to main and push to origin. Only runs if Watchdog verdict is PASS. Usage: /merge <slug>
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

Merge a certified Wolfpack hunt for feature: $ARGUMENTS

## Preflight

1. Find `metadata.json` for the slug (worktree-aware path resolution)
2. Read metadata — confirm `status: "certified"` and `phase: "done"`
3. Read `certification.md` — confirm verdict is PASS
4. Read git-workflow conventions from project docs

## Merge work

1. Determine feature branch from metadata (`branch` field)
2. Check for dirty state
3. **`.wolfpack/` auto-commit sweep** — if only `.wolfpack/` files are dirty, auto-commit them
4. **Worktree navigation** — if worktree, navigate there for the merge
5. **Version tagging** — read `proposed_version` from metadata, create annotated tag
6. **CHANGELOG stamping** — move `[Unreleased]` hunt-attributed items to version heading
7. **Merge** — `git checkout main && git merge --no-ff feat/<slug>`
8. **Push** — `git push origin main && git push origin --tags`
9. **Plan-copy-back (worktree only)** — copy plan artifacts to main repo. **Stamp metadata as done** — update the main-repo copy's metadata.json to `status: "certified"`, `phase: "done"`.
10. **Worktree cleanup prompt** — ask user to remove worktree

## Finishing message

```
Merged: feat/<slug> -> main
  Tag: <version>
  Commit: <hash>

Next: deploy to dev/staging, then /clear -> /smoke <slug>
```

Begin.
