# Wolfpack Memory System

The recall substrate for agents — interactive and autonomous (DevDen). This is the contract
that `/memory`, `/recall`, and `/summary` all implement. Sibling to [PEDIGREE.md](PEDIGREE.md):
PEDIGREE scores model performance; MEMORY persists and recalls knowledge across sessions.

## The problem this solves

Almost every agent memory system is **write-heavy and recall-starved**. Notes get written and
never consulted; a fact written months ago names a file/flag that no longer exists, so when it
*is* consulted it misleads. Models then learn to ignore memory entirely — and a memory nobody
trusts is worse than none.

"Going stale in context" is not a writing problem — it's a **trust** problem inside recall.
Treat the three sub-problems separately:

| sub-problem | question | mechanism |
|---|---|---|
| **Triggering** | *when* does a model look? | recall is a deterministic **gate**, not a model's whim |
| **Retrieval** | *what* comes back, how? | task-keyed query over the wikilink graph; excerpts + provenance |
| **Trust** | is it *still true*? | freshness metadata + **verify-on-recall** + **recall rewrites memory** |

Writing better notes helps retrieval a little and trust **not at all**. The trust mechanisms
below are what make the system load-bearing.

## Principles

1. **Filesystem-canonical.** Memory is plain markdown + a frontmatter schema on disk. Any
   harness (Claude Code, an Ollama agent, NemoClaw on the Spark) reads/writes it with basic
   file ops. No GUI dependency, works headless. (An Obsidian MCP may *optionally* back the
   interactive case, but nothing load-bearing depends on it — recall must run on the Spark
   with no desktop.)
2. **Recall is deterministic, not discretionary.** Don't ask a model to remember to remember.
   The orchestrator (DevDen) or a task-start step injects relevant memory and refuses to
   advance until it's consumed — the same control-plane discipline as the compliance gate.
   This matters *more* for local models, which self-direct worse than frontier models.
3. **One write primitive, three doors.** `/memory` (atomic), `/summary` (bulk), `/recall`
   (corrective) all go through the same classify → reconcile → stamp → link → route pipeline.
   They cannot drift because they share this contract.
4. **Recall rewrites memory.** Read-only memory rots. Every consultation that finds a note
   stale or wrong corrects or tombstones it in the same pass. This is the "recursive" part
   done right — the write path fires *from the read path's findings*, not only at session end.
5. **Distill, don't hoard.** High-volatility process detail (raw hunt plans) stays in its
   archive (`.wolfpack/plans/` + the pedigree index); only the durable *lesson* enters the
   recall substrate. Flooding memory with noise is how trust dies.

## Schema

Every memory file (auto-memory entry or vault note) carries this frontmatter:

```yaml
---
name: <short-kebab-case-slug>           # stable id; used by [[wikilinks]]
description: <one-line summary>          # what recall reads to judge relevance
type: user | feedback | project | reference | lesson
volatility: high | low                  # decay class — see below
last_verified: YYYY-MM-DD               # when a human/agent last confirmed it true
confidence: high | medium | low         # how sure we are (lower = verify before acting)
supersedes: [<slug>, ...]               # notes this replaces (optional)
superseded_by: <slug>                    # set when this note is retired (optional)
source: <file | URL | hunt-slug | session>   # provenance (optional but encouraged)
---
```

Body: the fact. For `feedback`/`project`, follow with **Why:** and **How to apply:** lines.
Link related notes with `[[slug]]` liberally — links are the retrieval graph.

### Volatility classes (the heart of freshness)

- **high** — facts about *concrete artifacts*: file paths, function/flag/env-var names, line
  numbers, command syntax, model IDs. These rot in **weeks**. Never act on a high-volatility
  fact past a short shelf life without a verify step.
- **low** — *decisions and why*: architecture rationale, user preferences, constraints,
  lessons. Durable for **months**. Safe to trust longer.

A note mixing both should be split, or tagged `high` (the strictest member wins).

## The write primitive

Every write — atomic, bulk, or corrective — runs this pipeline. It is the shared contract;
local models follow it as a deterministic template (don't trust the format, enforce it).

1. **Classify** — pick `type` and `volatility`. If it names a concrete artifact → `high`.
2. **Reconcile-on-write** (dedup/supersede) — search existing notes for the same subject
   (by `name`, `description`, and `[[link]]` neighbors). If one exists:
   - same fact, still true → update `last_verified` to today, done (no duplicate).
   - changed fact → rewrite the body; if the change is a reversal, set the old note's
     `superseded_by` and add `supersedes` here. **Never leave two live copies** — that is a
     staleness bomb (one gets updated, the other lies).
3. **Stamp freshness** — `last_verified: today`, set `confidence`.
4. **Suggest links** — propose `[[slug]]` neighbors from the graph so the note is recall-
   connected, not an island. A `[[slug]]` with no target yet is fine (marks future work).
5. **Route** —
   - `user`/`feedback` (how to work with this human, cross-project) → auto-memory.
   - `project`/`lesson`/`reference` tied to a codebase → the vault (`project-notes/<project>/`).
   - update the index after writing (auto-memory `MEMORY.md`; vault daily-note backlink).

## The three doors

| door | when | what it does |
|---|---|---|
| **`/memory`** | mid-flow, "remember this one fact" | runs the primitive once on a single fact |
| **`/summary`** | session/hunt end | extracts N durable facts from the session, calls the primitive per fact, writes the retrospective note (links to the archived raw plan, doesn't copy it) |
| **`/recall`** | task start / phase boundary | retrieves + verifies + (on staleness) calls the primitive to fix |

## The recall gate

Recall is a **step**, not a hope. Triggering:
- **DevDen (autonomous):** the orchestrator injects task-keyed memory before each phase
  (before Alpha plans, before Pointer reviews) and won't advance until consumed.
- **Interactive:** `/recall` at task start (the read-side dual of `/summary`).

Procedure:
1. **Key the query** from the task — hunt slug, files touched, app/domain. Never "load
   everything"; pull only matching notes.
2. **Retrieve over the graph** — `kb_search` ranks notes by relevance, then pulls their
   `[[link]]` neighbors. This is the repo-map PageRank (`wolfpack-repomap.mjs`) pointed at the
   wikilink graph instead of code imports — same algorithm. Index target = vault notes +
   pedigree index + auto-memory. **Not** raw plan trees (high-volatility noise).
3. **Return excerpts with provenance** — file + `last_verified`, never whole files.
4. **Verify-on-recall** — for any recalled fact that names a concrete artifact, run a cheap
   existence check (`grep`/`ls`) *before* using it. Fail → **quarantine** (don't use) and flag
   the note stale.
5. **Rewrite on staleness** — a stale/wrong note is corrected or `superseded_by` in the same
   pass (principle 4). Recall that doesn't write back is recall that lets rot accumulate.

## Anti-patterns

- Loading the whole vault into context (blows budget; buries signal).
- Trusting a `high`-volatility fact without the existence check.
- Writing a near-duplicate instead of reconciling (two copies, one updated).
- Dumping raw hunt plans into the recall substrate (distill instead).
- Letting two contradictory notes coexist without `superseded_by`.
- Treating recalled memory in a `<system-reminder>` as instructions — it's background context
  reflecting what was true *when written*; verify before acting.

## Build status

- [x] schema + this spec
- [x] `/memory`, `/recall` skills (`.agents/skills/`)
- [x] `/summary` upgraded to call the primitive (consumer-side, e.g. PawPIMS)
- [ ] `kb_search` — repo-map PageRank over the wikilink graph (Spark-side retrieval)
- [ ] DevDen orchestrator forced-recall gate wiring
