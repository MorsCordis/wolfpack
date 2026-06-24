---
name: release-notes
description: Generate an audience-facing (non-technical) release note from the engineering CHANGELOG, for an email or announcement. Triggers on "/release-notes", "release note for the customers/clients", "what shipped since prod", "draft an update email". Reads the prod→dev CHANGELOG range, deterministically suppresses internal/compliance/security entries, then translates the safe remainder into the project's audience voice. Built so a small local model produces it as cleanly as a frontier model — the risky parts are code, the model only rewrites.
---

# /release-notes — audience-facing release notes from the CHANGELOG

Turn the engineering CHANGELOG into a paste-ready, non-technical update for the project's
audience (e.g. a clinic-staff email). The pipeline already maintains the CHANGELOG at merge
(version headings + `<!-- hunt:slug -->`); this skill is a pure **downstream reader** — it
never writes to CHANGELOG or TODO.

**Design:** the parts a (small/local) model is unreliable at — parsing, and the
safety-critical decision of what to **suppress** — are done in **code**
(`scripts/wolfpack-release-notes.mjs`). The model's only job is rewriting the pre-filtered
safe bullets in the project's voice. A final code post-check fails loud if any suppressed
term leaked. This is what lets a 12B match a frontier model here.

```
extract+filter (code)  →  translate to voice (model)  →  post-check (code, fail-loud)
```

## Inputs from the project's `wolfpack-config.md` → `## Release Notes`
- **Audience** — who reads it (e.g. "veterinary clinic staff").
- **Denylist** — terms that must never reach the audience (compliance/security/domain).
- **Template** — the email/announcement skeleton.
- **Exemplars** — 2–3 engineering→audience rewrite examples (how a small model learns the voice).

If that section is missing, STOP and tell the user to add it — do not guess the voice or the
denylist (guessing the denylist risks leaking compliance/security detail).

## Steps

### 1. Determine the range
- `from` = the version currently on **prod** (ask the user, or infer from the deploy record /
  the prod tag — never assume). `to` = dev / `HEAD` (default).

### 2. Extract + filter (code — do NOT eyeball the changelog yourself)
```bash
node scripts/wolfpack-release-notes.mjs \
  --changelog CHANGELOG.md --from <prod-version> \
  --denylist <comma-list from wolfpack-config> --json
```
This returns `{ included, suppressed }`. Use **only `included`**. The `suppressed` list (with
reasons) is for transparency — show the user the count so they know what was held back.
- If `included` is empty, say so plainly: "No customer-facing changes since vX — this release
  was internal (refactors/fixes)." Do **not** invent items. (This is the correct, common
  outcome for a refactor/compliance release.)

### 3. Translate to the audience voice (model)
Rewrite each `included` bullet into the audience's language using the project's **template**
and **exemplars**. Feature-first, plain words, no jargon, no internal/file/endpoint names.
Group related items. Keep it short.

### 4. Post-check (code — the safety net)
Write the draft to a temp file and run:
```bash
node scripts/wolfpack-release-notes.mjs --check <draft.md> --denylist <same list>
```
Exit 1 = a suppressed term leaked into your prose → fix and re-check. Do **not** present a
draft that hasn't passed this check.

### 5. Present
Show the paste-ready note, plus a one-line footer for the user: "(N changes summarized; M
internal/compliance entries held back)."

## What NOT to do
- Don't parse the changelog by reading it yourself and deciding what's user-facing — that's the
  model-judgment failure this skill exists to prevent. Run the engine.
- Don't ship a draft that didn't pass `--check`.
- Don't include internal/compliance/security detail, file names, endpoints, or version numbers
  the audience doesn't need.
- Don't invent changes when `included` is empty.
