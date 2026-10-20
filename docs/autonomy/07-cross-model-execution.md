---
status: design-only
tags:
  - docs/wolfpack
  - docs/autonomy
---

# 07 — Cross-Model Execution & Sandbox Hardening

**Goal:** make the cross-model shims (`podman-vibe.sh`, `podman-agy.sh`) actually work
**unattended**, in the Node-less sandbox container, without hanging on auth or mis-firing
the grounding check. The earlier docs were design-level; this one is the execution reality,
surfaced by Gemini's 2026-06-02 review of the set (it has direct knowledge of how `agy`
runs). Several of these are **current-script issues** that block any unattended `agy` run
*today* — fixable independent of the rest of the build, and part of Phase 0 (see README §
Build process).

Cross-refs: [03] (grounding check), [06] (tool un-boxing / diff-catch), [05] (unattended
scheduling).

---

## 1. Keyring / D-Bus → API-key passthrough (BLOCKER for headless)

`podman-agy.sh` requires an active D-Bus session + GNOME keyring:

```bash
if [ ! -S "$DBUS_SOCKET" ]; then
    echo "ERROR: D-Bus socket not found ..."; exit 1
fi
```

**Problem:** for an unattended overnight batch (cron / systemd timer / headless SSH) there's
often no active desktop session, and even an active one **locks** the keyring after
inactivity. `agy` inside the container then blocks on the D-Bus socket waiting for a GUI
passphrase → the container command hangs or fails.

> Partial mitigation already in place (`reference_workstation_power_keyring`): suspend-on-idle
> is disabled and the Agy keyring (Login, flags 0x0) survives lock/blank — only *suspend*
> kills it. So the current setup tolerates a locked screen. The API-key path below is the
> robust fix that doesn't depend on a desktop session at all, and is already on the roadmap
> (`project_wolfpack_autopipeline_state`: "Agy API-key for unattended").

**Fix:** accept a static `GEMINI_API_KEY` (env/secret) and bypass the D-Bus checks when it's
present; fall back to keyring mounting only when it's absent:

```bash
if [ -n "${GEMINI_API_KEY:-}" ]; then
    COMMON_ARGS+=( -e "GEMINI_API_KEY=${GEMINI_API_KEY}" )   # skip D-Bus entirely
else
    # existing D-Bus / keyring path (interactive / desktop-session runs)
fi
```

Per the operator's no-credentials rule, the key is read from the secret store, never echoed.

---

## 2. `~/.gemini` mount scoping → avoid MCP-config pollution (CRITICAL)

`podman-agy.sh` mounts the **entire** `~/.gemini`:

```bash
-v "${HOME}/.gemini:${HOME}/.gemini"
```

**Problem:** that drags the host's `mcp_config.json` into the container. It defines host MCP
servers (Node-based — Chrome DevTools, filesystem, git, etc.). The `wolfpack-sandbox` image
is a **Python/Debian image with no Node/NPM**, so `agy` tries to spawn those Node MCP servers
on startup and crashes or floods the log with init errors — corrupting/contaminating the run.

**Fix:** mount only what `agy` needs for token storage + conversation tracking, and keep
`mcp_config.json` out (or override with a container-safe stub):

```diff
- -v "${HOME}/.gemini:${HOME}/.gemini"
+ -v "${HOME}/.gemini/antigravity-cli/conversations:${HOME}/.gemini/antigravity-cli/conversations:rw"
+ -v "${HOME}/.gemini/antigravity-cli/brain:${HOME}/.gemini/antigravity-cli/brain:rw"
+ -v "${HOME}/.gemini/antigravity-cli/log:${HOME}/.gemini/antigravity-cli/log:rw"
```

(Confirm the exact subdir set against the installed `agy` version before pinning it.)

---

## 3. Grounding-path normalization (MEDIUM — also in [03])

The [03] grounding check runs `test -f finding.file`. A containerized reviewer mounts the
worktree at `/workspace`, so `agy` emits `"/workspace/app/models.py"` in its verdict —
but the shim runs `test -f` on the **host**, where `/workspace` doesn't exist → **every
finding wrongly dropped as ungrounded**, silently nuking a correct review.

**Fix (two halves):**
1. **Skill instruction** (`.gemini/skills/bloodhound`, `pointer`, and the Vibe equivalents):
   emit file paths **relative to the repo root** (`app/models.py`), never absolute.
2. **Shim parser:** strip a leading `/workspace/` or `/` before the existence check, and
   resolve against the actual worktree path.

This is duplicated in [03] § grounding check so neither doc is read in isolation.

---

## 4. Diff-catch as the reviewer tool boundary for `agy` (MEDIUM — confirms [06])

[06] resolves reviewer write-scope to **un-box + role + diff-catch** (no path fence). Gemini's
review independently confirms this is the *only* clean option for `agy`: it has **no
`--enabled-tools` equivalent**, so you can't tool-fence it the way Vibe was (badly) fenced.
Giving it full tools and running `git diff` after the round to detect any source edit by a
reviewer is the robust boundary. So: full tools inside the sandbox + Bash denylist, plus a
post-round diff-catch that **flags loudly** if a reviewer touched app source. See [06] §
reviewer write-scope.

---

## 5. `.gemini/skills` port-sync in the batch launcher (IMPORTANT)

Gemini maintains its own skill ports in `.gemini/skills/`, regenerated from the Claude
masters in the canonical skills (`.agents/skills/`) per `GEMINI.md`'s pre-flight sync rule
(the operator's cross-model agent notes). In manual runs a human triggers that; in an
**unattended batch** nothing does — so when Claude skills change, the Gemini reviewer runs a
**stale** skill and drifts from the canonical role definition.

**Fix:** wire the `GEMINI.md` pre-flight sync (regenerate `.gemini/skills/` from
the canonical skills when git HEAD moved past `.gemini/SYNC_BASELINE`) into the **automated batch
launcher**, so every unattended run starts from current ports. (Mirror of the worktree-skills
drift hazard in `project_worktree_skills_symlink` — same class of "the copy went stale.")

---

## 6. Mistral throughput limit (25K TPM) & review chunking (HIGH — reliability)

> **Spec added 2026-06-08** after diagnosing the "0% Mistral reviews in the pod" stall. Owner:
> whoever holds the rate-limit / routing work (`scripts/lib/wolfpack-ratelimit.sh`,
> `wolfpack-routing.mjs`). The shim-side guard (lower `--max-tokens` default) is **already
> landed** in `podman-vibe.sh`; the dispatch-side chunking below is the remaining work.

**The constraint (authoritative — Mistral admin dashboard).** `mistral-medium-3-5` has a hard
**25,000 tokens/minute** throughput limit (input+output). The request-rate ceiling (0.83 req/s
≈ 50/min) is irrelevant to us — we call serially. So the binding rule is: **any single review
call whose token throughput crosses ~25K/min gets its connection dropped** (`Server disconnected
/ Network error`). This — not a "3 calls / 30 min" count, not the pod's `pasta` network, not
concurrency — is what was failing. Empirical fit from the 2026-06-08 isolation tests:

| call | tokens | result |
|---|---|---|
| tiny (1 fn, ~30-turn floor) | ~5K | ✅ pass |
| scoped (2 files, 40 turns) | ~28K | ❌ disconnect (just over 25K) |
| **1 file, `--max-turns 20`, read/grep** | **29K** | ❌ `Token limit exceeded` (multi-turn accumulation — the FLOOR finding) |
| full layer diff + `task` | 307K | ❌ blows it outright |

So the earlier "context-bloat at ~190K chars" theory was the TPM limit misread. A small call
goes through fine even repeated; a big one fails the first time. **The pod is not the problem**
(a small call succeeds in `pasta`); the *size* of the meta-layer reviews was.

**Why this is mostly a non-issue for normal hunts.** A typical hunt review reads a small feature
diff — already under 25K. The failures were concentrated on oversized *meta-layer* reviews
(dumping a whole 178K-token layer diff + spec into one call). Normal review traffic needs only
the guard below; chunking is for the outliers.

**Guard (landed).** `podman-vibe.sh` `WOLFPACK_VIBE_MAX_TOKENS` default 150000 → **20000**.
This stops an oversized call *gracefully* (`Token limit exceeded`) instead of letting it burst
over the per-minute rate and get the connection dropped. **Necessary but NOT sufficient** — see
the floor finding below; the cap is a graceful-stop backstop, not the fix.

**⚠ The per-review token FLOOR is the real problem (2026-06-08 confirmation call).** A review of
ONE ~157-line file, `read`/`grep` only, `--max-turns 20`, consumed **29,177 tokens** — already
over both the 20K cap and the 25K TPM ceiling. The cost is **not the file content** (~6–8K);
it's **multi-turn accumulation**: each agentic turn (read → reason → read → reason …) re-sends
the growing context, so `--max-turns 20` of round-trips piles up ~29K even for a trivial task,
plus the stored `wolfpack-bloodhound` system-prompt overhead. **Consequence: no `--max-tokens`
value alone makes the current agentic review loop fit under 25K — it must consume less.** The
load-bearing levers, in order:

1. **Cut `--max-turns` hard for reviews** (try **3–5**, not 20/80). Fewer round-trips → far less
   re-sent context. The shim's 80-turn default + the U-curve "don't starve" lesson were tuned
   against a *bloat-ceiling* model that was wrong; under a TPM rate, turns are the enemy. Find
   the new sweet spot empirically (enough turns to read the scoped slice + emit a verdict, no
   more) — likely 3–5 for a 1–2 file chunk.
2. **Inline the scoped content into the `-p` prompt for a near-one-shot review** (`--max-turns
   1–2`). Hand the model the small diff/slice directly instead of making it read across turns;
   it processes prompt+content in ONE turn (input = prompt, output = verdict), sidestepping the
   re-send entirely. For a ≤~12K-token chunk this keeps the whole call well under 25K. This is
   the most robust shape and is **immune to whether Vibe self-chunks reads.**
3. **Trim the stored `wolfpack-bloodhound` system prompt** if it's large (measure it — the
   `.toml` is tiny but `system_prompt_id` points at a separate store).

**Dispatch-side chunking (the remaining work).** File-count chunking is the SECONDARY lever
(turns/inlining above is primary). When a review payload is estimated above ~12K tokens of
content, the orchestrator splits it into scoped sub-reviews and recombines:

1. **Estimate** the payload before dispatch (cheap heuristic: `(files × ~6000) + (turns ×
   ~1500) + prompt overhead`; full 200-line file ≈ 6–8K tokens). Under ~18K → one call as today.
2. **Split by file/concern** into chunks of **≤2–3 files / ≤~18K tokens each** — group related
   files so context compresses (rate-limit logic together, tool config together, etc.). Prefer
   **scoping the call**, not relying on Vibe to self-limit reads: keep each prompt pointed at a
   named small file set + line ranges, and lead with `grep`-to-locate then targeted
   `read(limit/offset)` over whole-file reads.
3. **Recombine by fingerprint.** Each chunk emits its own `<verdict>` + findings; merge them
   with the **existing `mergeFindings` dedup-by-fingerprint** from [03] — that machinery already
   exists for the multi-lens path and is the natural home for chunk recombination. The hunt's
   round verdict is APPROVED iff every chunk approved.
4. **Space serially.** With `SEM_MAX=1` calls already serialize; a small inter-chunk `sleep`
   keeps well under 50 req/min. Each chunk under 20K means none approaches the per-minute rate.

**Interaction with the rate-limit lib.** On a TPM limit, a *small* call doesn't disconnect in
the first place, so the retry-storm concern is moot for in-budget calls. For the rare genuine
throttle, the existing `model_quota` park + `wolfpack-overnight.sh` reset-aware resume is the
correct primitive (park and amortize across wall-clock), **not** a blanket Gemini fallback —
Gemini's quota is smaller, so routing all volume to it just moves the limit. Keep Mistral
load-bearing; make its calls fit.

**Open question to verify:** whether Vibe internally chunks/streams a large `read` into
rate-safe pieces, or whether the agent must do it via `read(limit/offset)`. The dispatch-level
chunking above is robust **either way** (it bounds the call's total scope), so it doesn't block
on resolving this — but resolving it may let chunk sizes grow.

---

## Threading into existing code

- **`podman-agy.sh`:** §1 (API-key branch + D-Bus bypass), §2 (scoped `~/.gemini` mounts).
- **shim parsers (`hunt-pipeline.js` review steps) + `.gemini`/`.vibe` skill prompts:** §3
  (relative paths + `/workspace` strip).
- **review shim / Watchdog step:** §4 (post-round diff-catch flag).
- **batch launcher (host driver, [05]):** §5 (port-sync preflight), and it's the natural home
  for the §1 `GEMINI_API_KEY` injection.
- **`podman-vibe.sh` (landed) + orchestrator review dispatch (`hunt-pipeline.js`
  `runReviewFanout` / `mergeFindings`):** §6 (20K `--max-tokens` guard + estimate→split→
  merge-by-fingerprint chunking).
  - **Highest-impact dispatch change (turns):** `hunt-pipeline.js:726` passes `80` turns to the
    review shim and `:1963` passes `80` to the Vibe certify shim. At 20 turns one small file
    already hits 29K (> 25K TPM), so **80 makes every Mistral review/cert overrun**. Lower the
    Mistral review/cert turn arg to ~**3–5** (re-measure), keeping the 80 only for Agy/Gemini
    (which has no token/turn limit and no equivalent TPM ceiling here). This is the change that
    actually moves "0% Mistral reviews" → working — the `--max-tokens` guard alone only makes
    the overrun fail *gracefully*.

---

## Acceptance criteria for THIS feature

- AC1 [auto] With `GEMINI_API_KEY` set, `podman-agy.sh` runs with **no active desktop
  session** (D-Bus checks bypassed) and completes a review.
- AC2 [auto] `agy` starts in the container with **no Node-MCP spawn errors** — host
  `mcp_config.json` is not mounted.
- AC3 [auto] A reviewer finding citing `/workspace/<path>` grounds correctly against the host
  worktree (path normalized) instead of being dropped as ungrounded.
- AC4 [auto] A reviewer that edits app source is **flagged** by the post-round diff-catch
  (the boundary holds without a tool fence).
- AC5 [auto] The batch launcher regenerates `.gemini/skills/` from the Claude masters before
  the run when HEAD has moved past `SYNC_BASELINE`.
- AC6 [auto] (§6) A scoped Mistral review completes UNDER 25K total tokens and emits a
  `<verdict>` (no `Server disconnected`, no `Token limit exceeded`) — achieved primarily by a
  low review `--max-turns` (3–5) and/or inlining the scoped slice into the prompt, NOT by file
  count alone. Oversized reviews split into ≤~12K-content chunks recombined via `mergeFindings`
  fingerprint-dedup. `podman-vibe.sh` defaults `--max-tokens` to 20000 as a graceful-stop
  backstop. (Validated lever: 1 file @ `--max-turns 20` = 29K = FAIL; the fix is fewer turns /
  inlining, re-measured to land a single scoped review under ~20K.)
