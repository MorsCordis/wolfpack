---
name: memory
description: Persist one durable fact to the recall substrate (auto-memory or the vault). Triggers on "/memory", "remember this", "make a note that...", or when you learn a fact worth recalling in a future session. The atomic write-door of the memory system — runs the shared write primitive on a single fact (classify, reconcile, stamp freshness, link, route). Use whenever a non-obvious fact, decision, preference, or gotcha surfaces mid-session.
---

# /memory — atomic memory write

Persist **one** fact through the shared write primitive defined in `MEMORY.md`. This is the
atomic door; `/summary` calls the same primitive in bulk, `/recall` calls it to fix staleness.
Don't trust the format — follow these steps exactly (this is what lets a local model produce a
recall-ready note as reliably as a frontier model does ad hoc).

## When to run
- User says `/memory`, "remember that…", "make a note…", "don't forget…".
- You discover a durable fact: a decision + its why, a user preference, a project constraint, a
  non-obvious gotcha, a reference (URL/dashboard/ticket).
- **Not** for: transient task state, anything the repo/git already records, or something only
  relevant to the current conversation.

## Steps (the write primitive, single fact)

### 1. Classify
- `type`: `user` (who they are) · `feedback` (how to work with them) · `project` (ongoing work
  not derivable from code) · `reference` (external pointer) · `lesson` (durable learning).
- `volatility`: **high** if it names a concrete artifact (file path, function/flag/env name,
  command, model id, line number) — these rot in weeks. **low** for decisions/why/preferences.
- `confidence`: high/medium/low.

### 2. Reconcile (never duplicate)
Search existing memory for the same subject — by slug, description, and `[[link]]` neighbors
(use `/recall` or grep the memory dir + `project-notes/`). Then:
- **exists & still true** → just bump `last_verified` to today. Stop. Do not create a copy.
- **exists & changed** → rewrite the body. If it's a reversal, set the old note's
  `superseded_by:` and add `supersedes:` here.
- **doesn't exist** → create it.

### 3. Stamp + link
Fill the schema: `name`, `description`, `type`, `volatility`, `last_verified: <today>`,
`confidence`, and `source`. Add `[[slug]]` links to related notes (liberally — a link to a
not-yet-written note is fine).

### 4. Route + index
- `user` / `feedback` → auto-memory dir; add a one-line pointer to its `MEMORY.md` index.
- `project` / `lesson` / `reference` tied to a codebase → the vault under
  `project-notes/<project>/` (per `wolfpack-config.md`'s vault location).

## Frontmatter template
```yaml
---
name: <kebab-slug>
description: <one line — what recall reads to judge relevance>
type: user | feedback | project | reference | lesson
volatility: high | low
last_verified: <YYYY-MM-DD>
confidence: high | medium | low
source: <file | URL | hunt-slug | session>
# supersedes: [<slug>]        # if replacing notes
# superseded_by: <slug>       # if this note is being retired
---
```
Body: the fact. For `feedback`/`project`, add **Why:** and **How to apply:** lines.

## What NOT to do
- Don't write a near-duplicate — reconcile (step 2). Two live copies = a staleness bomb.
- Don't omit `volatility`/`last_verified` — they're what `/recall` uses to decide trust.
- Don't store secrets/credentials.
- Don't record what code or git history already captures — store what was *non-obvious*.
