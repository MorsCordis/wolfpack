---
name: smoke-wave
description: Post-deploy smoke for a whole released Wolfpack WAVE, batched BY HUNT — runs each hunt's acceptance criteria as its own block with an explicit per-hunt pass/fail verdict + observed console/network anomalies, surfaces [manual] as a blocking checklist. Usage: /smoke-wave <campaign> <wave>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page, mcp__plugin_chrome-devtools-mcp_chrome-devtools__new_page, mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot, mcp__plugin_chrome-devtools-mcp_chrome-devtools__click, mcp__plugin_chrome-devtools-mcp_chrome-devtools__fill, mcp__plugin_chrome-devtools-mcp_chrome-devtools__fill_form, mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script, mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_network_requests, mcp__plugin_chrome-devtools-mcp_chrome-devtools__get_network_request, mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_console_messages, mcp__plugin_chrome-devtools-mcp_chrome-devtools__wait_for, mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot, mcp__chrome-devtools__navigate_page, mcp__chrome-devtools__new_page, mcp__chrome-devtools__take_snapshot, mcp__chrome-devtools__click, mcp__chrome-devtools__fill, mcp__chrome-devtools__fill_form, mcp__chrome-devtools__evaluate_script, mcp__chrome-devtools__list_network_requests, mcp__chrome-devtools__get_network_request, mcp__chrome-devtools__list_console_messages, mcp__chrome-devtools__wait_for, mcp__chrome-devtools__take_screenshot
---

Run the **consolidated wave smoke** for wave **$ARGUMENTS** (`<campaign> <wave>`).

The wave is already `/merge-wave`'d and deployed with the configured Dev deploy command. This is the automation-first
consolidated smoke from `docs/autonomy/04-batch-merge-smoke.md`. The keystone is
`acceptance.md`: every released hunt's acceptance criteria are run **batched by owning hunt** —
one self-contained block per hunt, each closing with an explicit pass/fail verdict — so a real
failure maps to exactly one hunt at a glance instead of drowning in a flat surface-ordered
union. (Earlier this command flattened + reordered everything by surface; that buried a couple
of genuine failures on v1-push-3 wave 2 — per-hunt batching is the fix.)

## ⚠ Mandatory behavior rules — read before anything else
0. **Batch BY HUNT, never a flat union.** Run and report one self-contained block per owning
   hunt, each ending in an explicit per-hunt verdict (`✅ HUNT PASS` / `❌ HUNT FAIL — N failed`).
   Never present a single surface-ordered list across all hunts: that is what buried real
   failures last wave. A criterion shared by two hunts is reported under **both** (run once,
   show the result in each block) — clarity beats dedupe here.
0a. **Every hunt block reports observed anomalies, not just asserted criteria.** During each
   hunt's run, capture ALL console errors (`list_console_messages`) and non-2xx network
   responses (`list_network_requests`) seen on the pages you touched, and list them in that
   hunt's block even when no criterion asserted on them. A clean criteria board with a 500 in
   the network log is a **hunt FAIL**, surfaced — this is the gap that let the dev-tool review
   miss errors before.
1. **No item is ever silently deferred.** Every criterion resolves to exactly one terminal
   state INSIDE this cycle: `auto_pass`, `auto_fail`, or `needs_human_run`. There is no
   "deferred" and no "I'll TODO it."
2. **Hard prohibition: never write an un-runnable smoke criterion into `TODO.md`.** Surface it
   and wait. A smoke item becomes a TODO ONLY if the user explicitly decides it's future
   work — never your silent fallback.
3. **Read user reports LITERALLY.** A hedged report ("kinda works", "mostly OK") is AMBIGUOUS,
   not PASS — ask one clarifying question.
4. **Smoke FIXES go back through review, never Shepherd-direct.** A failure that needs a fix
   (not a clean revert) re-enters as a mini-cycle (see § Fix-forward). Same adversarial bar as
   the original code.
5. **URL safety**: resolve host+path against the real env/router before presenting.
   Dev = the host in wolfpack-config.md → Deployment Notes → **Dev URL**; prod = **Prod URL**
   (never smoke prod); never any host listed in **Never-smoke hosts**. If the project's Dev URL
   is `none`, nothing is deployed: stop and say so. Never relay an Alpha-authored URL verbatim.
6. **Re-login on a sign-in redirect.** After any navigation, if the page is the app's sign-in page (a login
   form where the criterion expected another page) and the criterion is not about sign-in, run the hook's
   `--check`; on `SIGNED_OUT` sign in once through the hook (same account, Step 2a), then re-navigate. A second
   redirect in the same criterion = `auto_fail`, `session lost after re-login`. Log every re-login in that
   hunt's anomalies (`kind: session`). No hook configured → `needs_human_run` with 'signed out; no smoke login hook'.
7. **Public pages run logged out.** Criteria about public (logged-out) pages open with `new_page` and
   `isolatedContext: "public"`; never sign in inside that context.

## Step 1 — Build the release queue + criteria union

0. **Resolve the pack (`PACK`).** `PACK="$WOLFPACK_HOME"`; if that is empty, read `wolfpack-config.md` → Project Identity → **Wolfpack home** (the backticked path; expand a leading `~`). If neither is set, or `"$PACK/scripts/wolfpack-config.mjs"` does not exist, STOP with the fix: "export WOLFPACK_HOME=<absolute path of your wolfpack checkout>, or add a `Wolfpack home` line (the path in backticks) under ## Project Identity in wolfpack-config.md". Pack scripts run as `"$PACK/scripts/<name>"`, never from a copy in this repo.
1. `cd "$(git rev-parse --show-toplevel)"` (main repo — the wave is merged; worktrees may be gone).
2. Read `.wolfpack/campaigns/$1/campaign.md` → hunts with `**Wave:** $2`. For each, read its
   `metadata.json`. **Released = `status: merged` (legacy: `certified`/`done`) and NOT
   `parked:compliance_review`**
   (AC4 — a compliance-held hunt was excluded from `/merge-wave`, so it is not in this smoke).
3. For each released hunt, read `.wolfpack/plans/<slug>/acceptance.md` (copied back by
   `/merge-wave`). Parse its criteria deterministically:
   ```bash
   node "$PACK/scripts/wolfpack-release.mjs" criteria .wolfpack/plans/<slug>/acceptance.md <slug>
   ```
   Each criterion carries `{slug, id, tag, text, ref}` where `ref` = `<slug>/<n>` — the
   **owning-hunt attribution** that makes a failure map to exactly one merge commit (AC3).
   - If a hunt has no `acceptance.md` (older hunt pre-[01]), do **NOT** run the parser on
     `smoke-tests.md` — the parser matches only acceptance.md's `- ACn [tag]` lines and would
     silently return `[]` on smoke-tests.md's `## ACn` step blocks. Instead **read
     `smoke-tests.md` directly**; treat each `## ` step as a criterion, defaulting to
     `needs_human_run` unless you can automate it. If neither file exists, surface the hunt as
     `needs_human_run` with a note.
4. **Group by owning hunt (AC5).** Keep each hunt's criteria together as its own batch, in
   campaign hunt order. Do **NOT** flatten into a surface-ordered union — the per-hunt block is
   the unit of review, so a failure (or a stray console/network error) is attributable to one
   hunt at a glance. Within a single hunt you may still order its own criteria by surface to
   minimize back-and-forth, but never merge criteria across hunts. Each criterion keeps its
   `ref` (`<slug>/<n>`). If the same observable check appears in two hunts, run it once but
   report the result in **both** hunts' blocks (do not silently drop the duplicate — a dropped
   shared check is an un-attributed check).

## Step 2 — Resolve the deployed URL (do this BEFORE any MCP step)

Resolve the dev URL from the router/settings, not from memory. The deployed surface is the
config's **Dev URL** host. Confirm host+path against the real env before navigating. State the URL you
resolved and how, in one line, before the first MCP call.

## Step 2a — Sign in (before any MCP navigation)

1. If wolfpack-config.md → Deployment Notes → **Smoke test access** names project smoke steps (a skill or
   doc), read them now and run their steps at the points they name (e.g. a report dir before Step 3, a
   report at close).
2. Read `smokeLoginHook` / `smokeLoginAccounts` from `node "$PACK/scripts/wolfpack-config.mjs" --json`. If
   `smokeLoginHook` is null → print `No smoke login hook configured — using your own browser session` and skip
   to Step 3 (the operator's own signed-in browser is used; record `session_after_deploy: not_checked`).
3. **Post-deploy session probe first:** run the template with `{host}` = the Step 2 host and `{account}` = the
   default account (the first of `smokeLoginAccounts`), with ` --check` appended. Record its first word as
   `session_after_deploy` (`SIGNED_IN` / `SIGNED_OUT`). Any other result (another first word, or an exit other
   than 0/1) → STOP with its line. (Run it before the sign-in. A probe after the sign-in always says SIGNED_IN.)
4. **Sign in:** run the template (`{host}` = the Step 2 host, `{account}` = the default). Exit 0 is required.
   Otherwise STOP and print the hook's line verbatim. Use another listed account for criteria that need that
   role.
5. Never type a password into a page, and never read the hook's secrets. The hook is the only sign-in path.
6. Record a sign-in block in the report: the hook command run (template with substitutions), the
   `session_after_deploy` value, the hook exit code, and the first navigated page URL.

## Step 3 — Run every `[auto]` criterion via Chrome DevTools MCP, ONE HUNT AT A TIME

Walk the hunts in order. For **each hunt**, run all its `[auto]` (and
`[compliance]`-that-is-auto-checkable) criteria, then close that hunt before moving to the next.
Per criterion, drive an MCP sequence **navigate → act → assert** (DOM via
`take_snapshot`/`evaluate_script`, network via `list_network_requests`/`get_network_request`,
console via `list_console_messages`).

Disposition each criterion:
- **`auto_pass`** — MCP ran it, the assertion held.
- **`auto_fail`** — MCP ran it, the assertion failed. Capture the actual vs expected.
- **`needs_human_run`** — you **cannot** execute it: it's genuinely `[manual]` (visual/judgment),
  OR an `[auto]` that won't actually automate. **Spec-feedback loop:** an `[auto]` that won't
  run is a `/spec` mis-tag — re-tag it `[manual]` in that hunt's `acceptance.md`, note it as a
  spec-validation miss (so the aim tightens), and surface it. Do NOT silently swallow it.

**Anomaly sweep per hunt (rule 0a).** Before closing a hunt's block, pull
`list_console_messages` and `list_network_requests` for the pages you touched and surface EVERY
console error and non-2xx response — even ones no criterion checked. Any such anomaly makes the
hunt block **FAIL** regardless of how the explicit criteria scored.

**Per-hunt verdict.** A hunt is `✅ HUNT PASS` only if every one of its criteria is `auto_pass`
or manual-pass AND its anomaly sweep is clean. Any `auto_fail`, any anomaly, or any open
`needs_human_run` → `❌ HUNT FAIL` (or `⏳ HUNT PENDING` if the only opens are `needs_human_run`).

Present the board **batched by hunt** — each hunt self-contained, verdict on its own line:
```
WAVE SMOKE — <campaign> wave <wave> @ <dev URL>
ROLLUP:  invoice-bundle ❌ FAIL(1)   scheduling ✅ PASS   address-audit ⏳ PENDING

━━ invoice-bundle ━━  (feat/invoice-bundle)
  [auto]   AC invoice-bundle/1   bundle default applies        ✅ auto_pass
  [auto]   AC invoice-bundle/2   tax rounds to cents           ❌ auto_fail (got 12.005, exp 12.01)
  [manual] AC invoice-bundle/3   PDF layout looks right        ⏳ needs_human_run
  anomalies: ⚠ console TypeError in invoice_detail.js:212; POST /api/invoices/ → 500
  ❌ HUNT FAIL — 1 auto_fail, 1 anomaly, 1 pending

━━ scheduling ━━  (feat/scheduling)
  [auto]   AC scheduling/1       drag creates appt             ✅ auto_pass
  [manual] AC scheduling/2       mobile drag feels right       ⏳ needs_human_run
  anomalies: none
  ✅ HUNT PASS (auto) — 1 pending manual

━━ address-audit ━━  (feat/address-audit)   backend-only, no smoke-tests
  (no [auto] UI criteria; see manual checklist)
  ⏳ HUNT PENDING
```
The top `ROLLUP:` line is mandatory — it's the one-glance "which hunt has a problem" the flat
board never gave.

## Step 4 — Manual checklist (the only part you run by hand)

For every `needs_human_run` item, present a blocking checklist with EXACT steps
(`feedback_smoke_test_authoring`: URL, action, expected — copy-pasteable, never just an
outcome). **Keep the checklist grouped under its owning hunt** (same per-hunt batching as
Step 3) so each manual pass/fail flips that hunt's verdict, not a wave-wide blob. Step through
them ONE AT A TIME; collect pass/fail, then restate the affected hunt's updated verdict.

**The wave does not close with un-run criteria.** If any `needs_human_run` is still unanswered,
the wave **parks** `smoke_pending_human` (see [02]) — surface what remains and stop. It does
NOT silently shelve them. If the project smoke steps (Step 2a.1) define a report step, run it before parking
too (pending items show as `needs_human_run`) and print its `Report:` line.

## Step 5 — Disposition the failures

Tally `auto_pass` / `auto_fail` / manual-pass / manual-fail. For each FAILURE, decide with the
user **per owning hunt** (attribution from `ref`):

- **Chain campaign:** never revert on `main`; revert from the campaign branch
  with `node "$PACK/scripts/wolfpack-release.mjs" revert --campaign <c> --hunt <slug> --reason "<smoke failure>"`
  (it also reverts dependents and re-arms the hunt for a fix).
  In chain mode the runner's post-merge stage already ran this; use `/smoke-chain` to re-run one wave.
- **Clean revert** — the hunt is wrong end-to-end / not salvageable in-cycle. **main is
  merge-only** (`git-workflow` SKILL — never commit directly to main, hook-enforced), so the
  revert + CHANGELOG fixup happen on a branch and merge back `--no-ff`:
  1. **Find the merge commit** (the fresh session doesn't know it — derive from the hunt's branch):
     ```bash
     BRANCH=$(jq -r .branch .wolfpack/plans/<slug>/metadata.json)        # e.g. feat/<slug>
     MERGE_SHA=$(git log main --grep="Merge branch '$BRANCH'" -n 1 --format=%H)
     ```
  2. **Branch, then revert on the branch.** A `--no-ff` merge commit has two parents, so
     `git revert` REQUIRES `-m 1` (mainline = pre-merge main); `--no-edit` keeps it from opening
     an editor and hanging (anti-hang rule):
     ```bash
     git checkout -b revert/<slug>-smoke main
     git revert --no-edit -m 1 "$MERGE_SHA"
     ```
  3. **CHANGELOG fixup (same branch).** `git revert` undoes the code but NOT the CHANGELOG
     consolidation `/merge-wave` already did. Move this hunt's `<!-- hunt:<slug> -->` entries
     from the wave's `## [<version>]` heading back under `## [Unreleased]` so the shipped
     version no longer claims reverted work. Stage by name, commit on the branch.
  4. **Merge the revert branch back** `--no-ff` (keeps main merge-only), push:
     ```bash
     git checkout main && git merge --no-ff revert/<slug>-smoke -m "Merge branch 'revert/<slug>-smoke'" && git push origin main
     ```
  5. **Re-lay the wave tag** on the post-revert HEAD so the tag never sits ahead of what shipped:
     ```bash
     git tag -d <wave-tag> && git tag -a <wave-tag> -m "<msg>" HEAD && git push -f origin <wave-tag>
     ```
  6. Redeploy (the configured Dev deploy command), re-smoke that hunt's criteria only. The rest of the wave stays
     intact + deployable (AC3).
- **Fix-forward** — the failure is a fixable bug in an otherwise-good hunt: § Fix-forward.

## Fix-forward — through review, never Shepherd-direct

A smoke failure that needs a *fix* re-enters as a mini-cycle on a **fresh short-lived branch+
worktree off main** (the originating worktree may be cleaned up — this is the defined git home
from doc 04):

**Worktree root (`WT_ROOT`).** In the main checkout run `node "$PACK/scripts/wolfpack-config.mjs" --json` and take `worktreeRoot` (wolfpack-config.md → Project Identity → Worktree root, repo-relative). If the reader exits 2 or `worktreeRoot` is null, STOP with the fix: "add ``- **Worktree root:** `<repo-relative dir, e.g. .agents/worktrees>` `` under ## Project Identity in wolfpack-config.md". Never assume a default location.

```
git worktree add "$WT_ROOT/fix-<slug>-smoke-<N>" -b fix/<slug>-smoke-<N> main
```

Then:
1. **Fingerprint + attribute** the failure, and look it up in the originating hunt's
   `review_fingerprints` ledger ([03]): *never raised* → a miss, debit the stage/model that
   should have caught it; *raised then rejected* → a wrong-rejection. This is the retrospective
   grader — it's what turns "5/5 but N smoke findings" into real movement on those scores.
   Append the finding + ledger lookup to `.wolfpack/plans/<slug>/smoke-findings.md`.
2. **Review/plan the fix → Shepherd implements → Pointer/Tracker verify** — same mini-cycle as
   `/smoke` step 3e's `pointer` path. Scaffold the plan metadata at
   `<worktree>/.wolfpack/plans/fix-<slug>-smoke-<N>/metadata.json` — **the plan-dir slug MUST
   match the branch/worktree name** (`fix-<slug>-smoke-<N>`) so Pointer's preflight resolves it.
   Because this runs in a worktree, the metadata MUST set
   `"is_worktree": true` and `"worktree_path": "<absolute path of $WT_ROOT/fix-<slug>-smoke-<N>>"`
   — without them the downstream roles' preflight reads `is_worktree:false` and writes to the
   main repo root instead of the isolated worktree. No unreviewed patch lands post-merge.
3. **Merge the fix branch** `--no-ff` to main, push. Then **re-lay the wave tag** on the new
   merge commit — the tag must point at what actually shipped, exactly like the revert path, or
   it stays pinned to the pre-fix (buggy) commit:
   ```bash
   git tag -d <wave-tag> && git tag -a <wave-tag> -m "<msg> (with smoke fixes)" HEAD && git push -f origin <wave-tag>
   ```
   Redeploy (the configured Dev deploy command), **re-smoke that hunt's criteria only**.

The anti-waffling guard applies: if a re-smoke fails again, STOP and present options — do not
auto-start a second fix round.

## Step 6 — Close

If the project smoke steps (Step 2a.1) define a close/report step, run it and add its `Report:` line to the close block.

Only when **every** criterion is `auto_pass` or manual-pass (no open `needs_human_run`, no open
failure):
```
✓ Wave smoke complete — <campaign> wave <wave>
  per hunt:  invoice-bundle ✅   scheduling ✅   address-audit ✅
  auto: <P> pass / <F> fail (fixed)   manual: <P> pass / <F> fail (fixed)
  reverted: <list or none>   fix-forward: <list or none>
  Report: <url, when the project smoke steps produce one>

Next: /clear → /summary
```

The `per hunt:` line is mandatory — every released hunt named with its final ✅, so the close
mirrors the per-hunt batching and nothing is implicitly "fine."

`/summary` writes the wave retrospective to the vault.

## What NOT to do
- Do NOT present a flat / surface-ordered board across hunts — batch by hunt with a per-hunt
  verdict + anomaly line and a top ROLLUP (rules 0 / 0a). The flat union is what missed failures.
- Do NOT mark a hunt PASS with a console error or non-2xx response in its anomaly sweep, even if
  every explicit criterion is green.
- Do NOT close the wave with any `needs_human_run` unresolved — park `smoke_pending_human`.
- Do NOT route a smoke fix straight to Shepherd unreviewed.
- Do NOT write un-runnable criteria into `TODO.md`.
- Do NOT leave the wave tag ahead of a reverted state — always re-lay it.
- Do NOT relay an unverified URL.
- Do NOT sign in except through the configured smoke login hook.
- Do NOT read the hook's secrets.

Begin. Build the release queue + criteria union, resolve the dev URL, then run the `[auto]` set.
