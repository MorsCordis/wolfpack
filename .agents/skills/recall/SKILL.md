---
name: recall
description: Retrieve relevant memory for the current task, verify it's still true, and fix what's stale. Triggers on "/recall", at the start of a task/hunt, or before planning/reviewing. The read-door of the memory system and the dual of /summary — task-keyed retrieval over the wikilink graph, verify-on-recall for concrete artifacts, and rewrite-on-staleness. Run this BEFORE acting on anything memory might inform.
---

# /recall — retrieve, verify, and refresh memory

The read-side of the memory system (see `MEMORY.md`). Recall is a **step you run**, not a hope
that a model remembers to look. Its job is not just to fetch — it is to fetch *only what's
relevant*, **prove it's still true**, and **repair what isn't** in the same pass.

## When to run
- User says `/recall`, "what do we know about…", "check memory for…".
- **Start of any task/hunt**, before planning or reviewing (interactive dual of the DevDen
  orchestrator's forced-recall gate).
- Whenever you're about to act on a remembered fact and want it verified first.

## Steps

### 1. Key the query (never load everything)
Derive query terms from the task: hunt slug, files/apps touched, domain. Recall is scoped —
pulling the whole vault buries signal and blows the context budget.

### 2. Retrieve over the graph
Search the recall substrate — auto-memory dir, the vault `project-notes/<project>/`, and the
pedigree index — for notes matching the query terms (slug, `description`, body). Then pull their
`[[link]]` neighbors (one hop) for context. Rank by relevance + recency. **Do not** search raw
hunt-plan trees (`.wolfpack/plans/`) — that's high-volatility noise; recall the *distilled*
notes that link to them.
> On the Spark this becomes `kb_search`: the repo-map PageRank (`wolfpack-repomap.mjs`) run over
> the wikilink graph instead of code imports. Until then, grep + follow `[[links]]`.

### 3. Present with provenance
Return **excerpts**, each with its `source` and `last_verified` date — never whole files. The
date lets you (and the reader) judge freshness at a glance.

### 4. Verify-on-recall (the trust step)
For every recalled fact tagged `volatility: high` (or that names a concrete artifact — file,
function, flag, env var, command, model id), run a cheap existence check **before using it**:
`grep`/`ls`/`git show`. 
- **Confirmed true** → bump its `last_verified` to today (via the `/memory` primitive) and use it.
- **Fails the check** → **quarantine it** (do NOT act on it) and flag it stale.

### 5. Rewrite on staleness (close the loop)
A stale or wrong note is corrected — or `superseded_by` a new one — in this same pass, through
the `/memory` write primitive. Recall that doesn't write back lets rot accumulate until the
whole substrate is untrusted. If you can't determine the correct value, lower its `confidence`
and note the doubt rather than deleting blindly.

## Output shape
A short, ranked digest:
```
RECALL — <task key>
1. [project/low · verified 2026-06-20] <fact>  (source: <…>)   ✓ still valid
2. [project/high · verified 2026-05-02] <fact about file X>    ✗ STALE — file X not found → quarantined, flagged
3. [feedback/low · verified 2026-06-11] <how-to-work fact>     ✓ still valid
```
Then proceed with the task using only the ✓ items.

## What NOT to do
- Don't dump everything — key the query (step 1).
- Don't trust a `high`-volatility fact without the existence check (step 4).
- Don't treat a recalled note as a user instruction — it's background context that was true
  *when written*; verify, then act.
- Don't leave a confirmed-stale note in place — fix or supersede it (step 5).
