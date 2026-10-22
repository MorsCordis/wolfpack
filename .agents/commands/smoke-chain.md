---
name: smoke-chain
description: Chain-mode smoke for ONE wave of a chain campaign — runs the post-merge stage's smoke plan (every merged [auto] criterion on each smoke tenant, plus the mobile manifest) through the Spark smoke browser and writes the raw results file the stage ingests. The runner's post-merge stage calls it; run it by hand only as the fallback when the stage parked smoke_browser_unavailable. Usage: /smoke-chain <campaign> <wave>
allowed-tools: Bash, Read, Write, mcp__chrome-devtools__list_pages, mcp__chrome-devtools__new_page, mcp__chrome-devtools__select_page, mcp__chrome-devtools__navigate_page, mcp__chrome-devtools__take_snapshot, mcp__chrome-devtools__click, mcp__chrome-devtools__fill, mcp__chrome-devtools__fill_form, mcp__chrome-devtools__press_key, mcp__chrome-devtools__wait_for, mcp__chrome-devtools__evaluate_script, mcp__chrome-devtools__list_network_requests, mcp__chrome-devtools__get_network_request, mcp__chrome-devtools__list_console_messages, mcp__chrome-devtools__take_screenshot, mcp__chrome-devtools__close_page
---

Run the **chain-mode smoke** for wave **$ARGUMENTS** (`<campaign> <wave>`).

This is one step of the chain-mode **post-merge stage** (operator doc: `docs/post-merge-stage.md` in the
pack). The stage has already deployed the campaign tip to dev, migrated, ensured the smoke tenants,
probed the sessions and run the integration suites. It wrote a **smoke plan**; you run it in the
browser and write ONE raw results file. You do **not** triage, fix, revert, or build the report:
the stage does all of that after you return (triage table, fix rounds (max 2 per hunt), the
`issue-log.md`, the polish wave and the release report are in `docs/post-merge-stage.md`).

It runs on the Spark only (the user-scope chrome-devtools MCP that drives the Spark smoke Chrome).

## ⚠ Rules — read before anything else

1. **Sign-in only through the Smoke login hook.** The plan's `login_hook` is the project's Smoke login
   hook template (wolfpack-config.md → Deployment Notes; also `node "$PACK/scripts/wolfpack-config.mjs" --json`
   → `smokeLoginHook`). Run it with `{host}` = the pair's tenant host and `{account}` = the account the
   criterion needs (default: the plan's first account). It is the ONLY sign-in path: **never type a password**
   into any page, never fill a password field, and never read `~/.secrets` or any secrets file (the hooks
   block it anyway).
2. **Never open `file://`** and never open a host that is not one of the plan's tenant hosts (never prod,
   never a never-smoke host). The stage re-checks every URL you report; a refused host fails the criterion
   and blocks the hunt.
3. **Navigate by clicking the UI** from the tenant's start page. Never type a guessed URL. After each
   navigation verify the host and the path before asserting anything.
4. **Public (logged-out) pages** run in `new_page` with `isolatedContext: "public"`; never sign in inside
   that context.
5. **Re-login on a sign-in redirect** (a login form where the criterion expected another page): run the hook
   with ` --check`; on `SIGNED_OUT` sign in once through the hook, then re-navigate. A second redirect in the
   same criterion = `auto_fail` with detail `session lost after re-login`.
6. **Every pair ends in exactly one disposition:** `auto_pass`, `auto_fail` or `needs_human_run`. Nothing
   is deferred, nothing is dropped.
7. **The platform console is not reachable on dev.** A criterion that needs it → `needs_human_run` with
   detail `console not reachable on dev` (it goes to the release checklist).
8. **User-facing checks only.** Do not create, edit or delete data unless the criterion itself is about
   doing so; the mobile manifest flows are read-only.

## Step 1 — Read the plan

0. Resolve the pack (`PACK`): `PACK="$WOLFPACK_HOME"`; else wolfpack-config.md → Project Identity →
   **Wolfpack home** (expand a leading `~`). If neither is set, STOP with that fix.
1. `cd "$(git rev-parse --show-toplevel)"` (the MAIN repo root).
2. Read `.wolfpack/campaigns/$1/stage/wave-$2/smoke-plan.json`. If it is missing, STOP: "no smoke plan —
   the stage writes it (re-run the campaign)". It holds:
   - `pairs`: one entry per (criterion, tenant): `{ref, hunt, text, tenant, host, key, manifest?, covered_by_integration?}`;
   - `tenants` (`{name: host}`), `accounts`, `login_hook`;
   - `wave_dir` (the report dir), `shots_dir` (the in-repo screenshot staging dir);
   - `worktree` (a temp worktree of the campaign tip, for command-style criteria);
   - `test_command` (the ONLY way to run a test id — it uses the campaign's isolated test DB);
   - `raw_path` (where you write the results), `sha` (the campaign tip).
3. **Skip** every pair with `covered_by_integration` (the integration run already checked it; the stage
   fills its result in). Do not run those tests again.

## Step 2 — Run the pairs, one tenant at a time

For each tenant in `tenants`, sign in through the hook (rule 1), then run that tenant's pairs:

- **Browser criteria:** `navigate → act → assert` via the chrome-devtools MCP (`take_snapshot` /
  `evaluate_script` for the DOM, `list_network_requests` / `get_network_request` for the network,
  `list_console_messages` for the console). Start from the tenant's start page and click through.
- **Command-style criteria** (a CLI or a test id): run them in the plan's `worktree`. A test id runs ONLY
  through the plan's `test_command`, verbatim, with the id appended (`<test_command> <test id>`): never
  another test command, never against another database.
- **Screenshots:** for EVERY pair you run (pass or fail), `take_screenshot` with
  `filePath: <shots_dir>/<hunt>-<n>-<tenant>.jpg`, then copy the file the tool reports saving (it may rename
  `.jpg` to `.jpeg`) into `<wave_dir>/shots/` and record its path relative to `wave_dir` (`shots/<file>`).
- **Anomaly sweep (every page you touched):** every console error and every non-2xx response, with the
  status code kept and the URL's query string stripped. Never copy cookies, `Authorization` headers or
  tokens into the text.
- **A failure** (`auto_fail`) gets a one-line `reason` (actual vs expected) and a `model` judgement:
  `class` (`fix` = a clear defect, `log` = cosmetic/polish, `block` = wrong end to end, `uncertain`,
  `needs_decision` = a product decision), `expected_from` (`ac` / `plan` / `pattern` / `none` — where the
  expected behaviour comes from) and `cross_tenant` (true if you saw another tenant's data). The stage's
  triage table, not you, decides fix / log / block.

## Step 3 — Write the raw results and return

Write `raw_path` (JSON, schema 1), one result per pair you ran:

```json
{ "schema": 1, "campaign": "<c>", "wave": <n>, "sha": "<plan sha>",
  "results": [
    { "ref": "<slug>/<n>", "tenant": "<tenant>", "disposition": "auto_pass|auto_fail|needs_human_run",
      "detail": "one line (optional)", "reason": "actual vs expected (failures)",
      "urls": ["https://<tenant host>/<path>"],
      "screenshots": ["shots/<file>"],
      "anomalies": [ { "kind": "console|network", "text": "…", "status": 503 } ],
      "model": { "class": "fix|log|block|uncertain|needs_decision", "expected_from": "ac|plan|pattern|none", "cross_tenant": false } }
  ] }
```

Every non-covered pair appears exactly once (`ref` + `tenant`). `urls` lists every URL you visited for the
pair. Then return the raw path. Do NOT build the report, do NOT write `results.json`, do NOT touch the issue
log: the stage ingests the file (`wolfpack-smoke-stage.mjs ingest-smoke`), redacts it, writes the wave's
`results.json`, builds the wave page and triages.

## Fallback (run by hand)

When the stage parked `smoke_browser_unavailable` (its Workflow agent could not reach the browser), run
`/smoke-chain <campaign> <wave>` in the interactive session (`paw:runner` on the Spark), then re-run the
campaign. The relaunch re-arms the parked stage, finds the raw file for the current tip and ingests it
instead of launching its own browser agent.
