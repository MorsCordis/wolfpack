#!/usr/bin/env bash
# Runs Vibe CLI inside a Podman container with filesystem isolation.
# Worktree mounted read-only. Auth mounted read-only with SELinux labels.
# [06] Capable, sandbox-scoped toolset (read/grep/edit/write_file/bash) — NOT a
# 2-tool cage; `task` omitted so the reviewer can't self-orchestrate. The ro
# worktree + sandbox are the guardrail; reviewer-writes-to-source are caught by
# diff-catch, not a tool fence. See VIBE_TOOLS_DEFAULT below + wolfpack-toolcheck.mjs.
# Handoff mode adds ONE read-write bind (the per-seat out dir) and fails the round on any
# write outside it — see "Seat handoff mode" below.
#
# Usage: $WOLFPACK_HOME/scripts/podman-vibe.sh <agent-name> <worktree-path> <prompt-file> [max-turns]
#        $WOLFPACK_HOME/scripts/podman-vibe.sh --implement <agent-name> <worktree-path> <prompt-file> [max-turns]
#        $WOLFPACK_HOME/scripts/podman-vibe.sh --deliver-to <plan-dir> --out-dir <plan-dir>/.seat-out/<name> \
#            --expect <artifact> [--expect <artifact>…] <agent-name> <worktree-path> <prompt-file> [max-turns]
#
# Seat handoff mode (review/certify seats; seat-handoff-writes): the seat writes its own handoff
# file(s) with `write_file` instead of returning them inline. The three options are
# all-or-nothing, any order before <agent-name>, never with --implement (exit 2). Rules:
#   - the out dir is pinned to <deliver-to>/.seat-out/<name> (name ^[A-Za-z0-9][A-Za-z0-9._-]*$),
#     the deliver-to dir lies inside the worktree, and the worktree is a git checkout (exit 2);
#   - --expect is one of review-N[-lens].md, pointer-review-N[-lens].md, certification.md,
#     pedigree.json — never metadata.json or a path (exit 2);
#   - a non-empty out dir at start is refused (exit 2: "seat out dir is not empty");
#   - podman path: that out dir is the ONLY read-write bind, mounted at
#     <container worktree>/<its worktree-relative path> (inside --workdir for both families);
#     the worktree stays :ro,z;
#   - write_file only CREATES: the seat makes ONE call per file with the complete content; each
#     retry attempt starts with an emptied out dir;
#   - after the seat exits 0 the shim compares a host-side source snapshot (HEAD + git status
#     entries + sha256, plus a sha-pinned listing of the deliver-to dir; see "Seat handoff:
#     source snapshot" below for the exclusions and the known WOLFPACK_SANDBOX=1 gap), lists the
#     out dir, and only if everything is clean renames each expected file into the deliver-to
#     dir byte for byte, printing `WOLFPACK_ARTIFACT_DELIVERED: <name> sha256=<hex> bytes=<n>`;
#   - otherwise exit 78 with `WOLFPACK_ARTIFACT_ERROR: missing <name>` / `unexpected <path>` /
#     `source-touched <path>` / `not-a-regular-file <name>` / `move-failed <name>`; nothing is
#     delivered and the out dir is quarantined as <out dir>.rejected-<epoch>-<pid>. A seat that
#     exits non-zero keeps its own exit code and its out dir is quarantined the same way.
#
# Output goes to stdout (capture in calling script).
#
# Config: the shim is the PACK's (WOLFPACK_HOME); every project specific comes from the
# consuming project's wolfpack-config.md → `## Execution Layer` (Sandbox image, GLM image,
# Sandbox project layer, Seat extra mounts, Secrets paths, Vibe agent dir, Seat test env),
# read through scripts/wolfpack-config.mjs --exec (scripts/lib/wolfpack-sandbox.sh). Which
# config: WOLFPACK_CONFIG (absolute path, operator override), else
# <git toplevel of the CALLER's CWD>/wolfpack-config.md, else exit 2. The pipeline calls the
# shim from the main checkout's root, so a hunt branch that edits its own config cannot widen
# its reviewer's sandbox. A missing or invalid key is exit 2 naming the key. With
# WOLFPACK_SANDBOX=1 (already inside the unified sandbox) no config is read.
#
# Exit codes (beyond the model's own):
#   75  rate-limited / circuit open — WOLFPACK_RATE_LIMITED:<family> on stderr (fall back)
#   76  GLM wall-clock timeout      — WOLFPACK_TIMEOUT:glm (not a quota signal)
#   77  INFRA fault in this shim's sandbox (disk full / ENOSPC …) — WOLFPACK_INFRA_ERROR:<family>.
#       NOT a rate limit and NOT the model's fault: no breaker trip, never model_quota.
#   78  seat handoff/artifact failure (handoff mode only) — WOLFPACK_ARTIFACT_ERROR: <kind> …
#       (missing / unexpected / source-touched / not-a-regular-file / move-failed)
#   2   usage / configuration error
#
# Env (usage-limit-gate):
#   WOLFPACK_VIBE_LOGS_TMPFS_SIZE     ~/.vibe/logs tmpfs size (default 256m; ^[0-9]+[kmg]?$)
#   WOLFPACK_VIBE_SCRATCH_TMPFS_SIZE  ~/.vibe/{vibehistory,cache} tmpfs size (default 64m)
#   WOLFPACK_RL_EVENTS_FILE           per-hunt rate-limit event log (AC9). Derived when the
#                                     worktree is <…>/.claude/worktrees/<slug> (or .agents/…)
#                                     and its plan dir exists; an operator-set value wins.
#
# MODEL FAMILIES. This shim fronts two Vibe-routed families on the Mistral API:
#   * mistral — the historical default (every existing agent). Behaviour below is
#               unchanged for it (byte-compatible command line, sem dir, breaker key).
#   * glm     — GLM 5.3 (Vibe alias glm-5.3 = zai-glm-5-3, provider mistral). Selected by
#               WOLFPACK_VIBE_FAMILY=glm or an agent name containing "glm"
#               (wolfpack-{bloodhound,pointer,watchdog,shepherd}-glm). GLM runs get:
#                 - a layered image with a CURRENT Vibe (wolfpack-sandbox-glm; the base
#                   image's Vibe 2.13 has no --auto-approve) — Mistral keeps the base tag;
#                 - their OWN rate-limit/circuit key ("glm") + semaphore dir, so a GLM
#                   throttle never trips Mistral's breaker and vice versa;
#                 - --auto-approve + a strict --enabled-tools allow-list. `vibe -p` HANGS
#                   FOREVER on any tool call that needs approval (off-list tools, parallel
#                   calls), so approval is automatic and the allow-list decides what exists.
#                   Review/certify seats get `bash` INSIDE the sandbox (read-only worktree +
#                   read-only git dir, no prod credentials — doc 06: the sandbox is the
#                   guardrail) so they can run `git diff` and the test command;
#                 - the worktree mounted at its HOST path (same path the dev-cortex MCP
#                   mirror on the Spark indexes), so dev_cortex_* tools resolve;
#                 - a wall-clock timeout instead of a tight turn cap (--max-turns counts
#                   the WHOLE session incl. resumed turns: reviewers >=80, implementer >=150);
#                 - transient-retry exhaustion surfaced as exit 75 + WOLFPACK_RATE_LIMITED:glm
#                   so the orchestrator falls to the next examiner / the Claude Shepherd.
#
# --implement (GLM only): the Shepherd seat. Worktree mounted READ-WRITE, tools =
#   read_file grep write_file edit dev_cortex_repo_map dev_cortex_file_outline — NO bash
#   (the implementer can't run tests or git; the calling wrapper commits; Tracker runs the
#   tests). Vibe's write_file only CREATES new files (refuses existing ones); `edit`
#   modifies existing.
#
# Review mode (both families, podman path) also mounts the worktree's git COMMON dir
# read-only when it lives outside the worktree (a `git worktree` checkout's .git is a FILE
# pointing at <repo>/.git/worktrees/<slug>), so `git diff` works in the container, and
# sets GIT_OPTIONAL_LOCKS=0 so git never tries to write index.lock on the ro mount. It
# also sets WOLFPACK_SANDBOX=1 plus the configured Seat test env in the container, so the
# test command runs on the image's runtime (never the host's tooling or the host .env), and
# mounts each configured Seat extra mount read-only. Every bind source is checked against the
# configured Secrets paths BEFORE any podman build or run.
#
# The seat profiles (the configured Vibe agent dir, installed from the tracked wolfpack
# vibe-agents/ templates) must agree with the tool lists below; scripts/wolfpack-toolcheck.mjs
# asserts it and hunt-pipeline.js runs it as a preflight.

set -euo pipefail

VIBE_MODE="review"
HANDOFF_OUT=""; HANDOFF_DELIVER=""; HANDOFF_EXPECT=(); HANDOFF_GIVEN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --implement)  VIBE_MODE="implement"; shift ;;
        --out-dir)    [ $# -ge 2 ] || { echo "ERROR: --out-dir needs a value" >&2; exit 2; }
                      HANDOFF_OUT="$2"; HANDOFF_GIVEN=1; shift 2 ;;
        --deliver-to) [ $# -ge 2 ] || { echo "ERROR: --deliver-to needs a value" >&2; exit 2; }
                      HANDOFF_DELIVER="$2"; HANDOFF_GIVEN=1; shift 2 ;;
        --expect)     [ $# -ge 2 ] || { echo "ERROR: --expect needs a value" >&2; exit 2; }
                      HANDOFF_EXPECT+=("$2"); HANDOFF_GIVEN=1; shift 2 ;;
        --) shift; break ;;
        -*) echo "ERROR: unknown option '$1'" >&2; exit 2 ;;
        *) break ;;
    esac
done

_USAGE="Usage: podman-vibe.sh [--implement | --deliver-to <plan-dir> --out-dir <plan-dir>/.seat-out/<name> --expect <artifact>...] <agent-name> <worktree-path> <prompt-file> [max-turns]"
AGENT="${1:?$_USAGE}"
WORKTREE="${2:?$_USAGE}"
PROMPT_FILE="${3:?$_USAGE}"
# Turn cap — a U-shaped curve, tune for the middle (validated 2026-06-02):
#   * TOO FEW turns -> starvation. Vibe spends ONE turn per tool call; --output text emits
#     ONLY the final response, so hitting the cap mid-review returns EMPTY output and the
#     whole review is lost (looks like a model failure; it's starvation — prime suspect in
#     the earlier auto-hunt Mistral flameouts: "hit turn limit / never emitted a verdict").
#   * UNCAPPED (0) -> context bloat. Mistral keeps reading; context balloons past its API
#     ceiling (~190K chars observed) and the server disconnects ("Network error"). A footgun
#     for Mistral — reserve 0=uncapped for small diffs or other models.
#   * SWEET SPOT -> generous-but-bounded turns + read-discipline in the PROMPT (lead with the
#     diff, grep over full-reads, targeted line-range reads). Read-discipline, not a tight cap,
#     is what keeps context under the ceiling. Prefer --max-price/--max-tokens for a real cost
#     guard. Default 80 below; pass 0 to disable the cap (see footgun note).
if [ "$VIBE_MODE" = "implement" ]; then
    MAX_TURNS="${4:-150}"
else
    MAX_TURNS="${4:-80}"
fi
if [ "$MAX_TURNS" = "0" ] || [ -z "$MAX_TURNS" ]; then
    TURN_CLAUSE=""          # uncapped — only the caller's wall-clock timeout bounds it
else
    TURN_CLAUSE="--max-turns $MAX_TURNS"
fi

# ─── [05] AC6 / [07 §6]: --max-tokens is a session RUNAWAY guard, NOT the disconnect fix ───
# CORRECTED 2026-06-08 (supersedes the earlier "25K TPM" note here): the "Server disconnected
# without sending a response / Network error" failures are a server-side request-SIZE /
# gateway limit (~50-55K chars of TOTAL request payload), NOT a 25K-tokens/min cap and NOT a
# model-context cap — mistral-medium-3.5's context window is 200K. Evidence: a ~58K-char
# payload disconnects, a ~47K one completes; failures are intermittent (a 28K payload failed
# while a 47K one passed earlier) and loosely size-correlated. The REAL disconnect fix is the
# LEAN request config below (LEAN_KV) — it strips Vibe's ~43K default per-request overhead
# (cli system prompt + model_info + prompt_detail + project_context + tool schemas) so a given
# diff fits under the gateway ceiling. With that, --max-tokens is just a cost/runaway bound on
# the agentic session, no longer the disconnect guard. The old 20000 was set under the wrong
# TPM theory and demonstrably STRANGLED real reviews (a legit tool-read review hit 21.5K);
# raised to 60000. --max-price OFF by default. Both env-overridable; pass 0 to disable.
VIBE_MAX_TOKENS="${WOLFPACK_VIBE_MAX_TOKENS:-60000}"
VIBE_MAX_PRICE="${WOLFPACK_VIBE_MAX_PRICE:-}"
COST_CLAUSE=""
if [ -n "$VIBE_MAX_TOKENS" ] && [ "$VIBE_MAX_TOKENS" != "0" ]; then
    COST_CLAUSE="--max-tokens $VIBE_MAX_TOKENS"
fi
if [ -n "$VIBE_MAX_PRICE" ] && [ "$VIBE_MAX_PRICE" != "0" ]; then
    COST_CLAUSE="$COST_CLAUSE --max-price $VIBE_MAX_PRICE"
fi

# ─── [05] Part B: reactive rate-limit handling (shared lib) ────
# retry_with_backoff + transient allowlist + per-model circuit breaker. Sourced from
# the MAIN repo's lib (the shim is always invoked via the main-repo copy, never a
# drifted worktree copy — same rationale as the shim itself).
RL_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/wolfpack-ratelimit.sh"
# Implement runs are long + stateful (partial writes): ONE attempt only — WOLFPACK_MAX_RETRIES
# counts TOTAL attempts in retry_with_backoff, so 1 = no retry. The first transient
# surfaces as exit 75 and the pipeline falls back to the Claude Shepherd (operator env wins).
if [ "$VIBE_MODE" = "implement" ] && [ -z "${WOLFPACK_MAX_RETRIES:-}" ]; then
    WOLFPACK_MAX_RETRIES=1
fi
# shellcheck source=lib/wolfpack-ratelimit.sh
source "$RL_LIB"
SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WP_CALLER="podman-vibe"
# shellcheck source=lib/wolfpack-sandbox.sh
source "${SHIM_DIR}/lib/wolfpack-sandbox.sh"
# Per-family breaker/cooldown key: "mistral" (unchanged default) or "glm".
VIBE_FAMILY=$(rl_vibe_family "$AGENT") || exit 2
RL_MODEL="$VIBE_FAMILY"
if [ "$VIBE_MODE" = "implement" ] && [ "$VIBE_FAMILY" != "glm" ]; then
    echo "ERROR: --implement is only supported for the glm family (agent '$AGENT' resolved to '$VIBE_FAMILY')" >&2
    exit 2
fi

WORKTREE_ABS=$(realpath "$WORKTREE")

# ─── Seat handoff mode (seat-handoff-writes) ───────────────────
# --deliver-to/--out-dir/--expect: the seat writes its handoff file(s) with write_file into ONE
# read-write out dir pinned at <deliver-to>/.seat-out/<name>; after it exits, this shim checks
# the out dir + the source snapshot and moves exactly the expected artifact(s) into the plan dir
# byte for byte (exit 78 on any breach). Validated HERE — before the config read, image build or
# any podman/vibe call — so a bad call (exit 2) runs nothing.
HANDOFF=0
HANDOFF_EXIT_ARTIFACT=78
# The only artifact names a seat may hand off. metadata.json, any path ('/' or '..') and any
# other name are refused: metadata.json stays orchestrator-written.
HANDOFF_EXPECT_RE='^(review-[0-9]+(-[a-z0-9][a-z0-9_-]*)?\.md|pointer-review-[0-9]+(-[a-z0-9][a-z0-9_-]*)?\.md|certification\.md|pedigree\.json)$'
HANDOFF_OUT_NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
if [ "$HANDOFF_GIVEN" = 1 ]; then
    HANDOFF=1
    if [ -z "$HANDOFF_DELIVER" ] || [ -z "$HANDOFF_OUT" ] || [ "${#HANDOFF_EXPECT[@]}" -eq 0 ]; then
        echo "ERROR: handoff mode needs --deliver-to, --out-dir and at least one --expect" >&2
        exit 2
    fi
    if [ "$VIBE_MODE" = "implement" ]; then
        echo "ERROR: --implement cannot be combined with the handoff options (--deliver-to/--out-dir/--expect)" >&2
        exit 2
    fi
    _seen_expect=" "
    for _e in "${HANDOFF_EXPECT[@]}"; do
        if ! [[ "$_e" =~ $HANDOFF_EXPECT_RE ]]; then
            echo "ERROR: --expect '${_e}' is not a handoff artifact name (review-N[-lens].md, pointer-review-N[-lens].md, certification.md, pedigree.json — never metadata.json or a path)" >&2
            exit 2
        fi
        case "$_seen_expect" in
            *" $_e "*) echo "ERROR: --expect '${_e}' given twice" >&2; exit 2 ;;
        esac
        _seen_expect="${_seen_expect}${_e} "
    done
    for _p in "$HANDOFF_DELIVER" "$HANDOFF_OUT"; do
        case "$_p" in
            *:*|*$'\n'*) echo "ERROR: handoff path contains ':' or a newline — cannot be bind-mounted safely: $_p" >&2; exit 2 ;;
        esac
    done
    if ! HANDOFF_DELIVER_ABS=$(realpath -e "$HANDOFF_DELIVER" 2>/dev/null) || [ ! -d "$HANDOFF_DELIVER_ABS" ]; then
        echo "ERROR: --deliver-to is not an existing directory: $HANDOFF_DELIVER" >&2
        exit 2
    fi
    case "$HANDOFF_DELIVER_ABS" in
        "$WORKTREE_ABS"/*) : ;;
        *) echo "ERROR: --deliver-to must lie inside the worktree (${WORKTREE_ABS}): ${HANDOFF_DELIVER_ABS}" >&2; exit 2 ;;
    esac
    # Resolve the PARENT only and keep the leaf name as given, so a symlinked leaf can never
    # redirect the rw bind (it is refused below); a symlinked .seat-out resolves elsewhere and
    # fails the parent check.
    _ho_parent=$(realpath -m "$(dirname "$HANDOFF_OUT")")
    _ho_name=$(basename "$HANDOFF_OUT")
    if [ "$_ho_parent" != "$HANDOFF_DELIVER_ABS/.seat-out" ] || ! [[ "$_ho_name" =~ $HANDOFF_OUT_NAME_RE ]]; then
        echo "ERROR: --out-dir must be <deliver-to>/.seat-out/<name> (name ${HANDOFF_OUT_NAME_RE}); got: $HANDOFF_OUT" >&2
        exit 2
    fi
    HANDOFF_OUT_ABS="${_ho_parent}/${_ho_name}"
    if ! git -C "$WORKTREE_ABS" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "ERROR: handoff mode needs a git checkout (no source snapshot is possible without git): $WORKTREE_ABS" >&2
        exit 2
    fi
    # AC9: a leftover out dir is refused, never reused — every seat starts with an empty one.
    if [ -L "$HANDOFF_OUT_ABS" ] || { [ -e "$HANDOFF_OUT_ABS" ] && [ ! -d "$HANDOFF_OUT_ABS" ]; }; then
        echo "✗ podman-vibe: seat out dir is not a plain directory: ${HANDOFF_OUT_ABS} — refusing to run" >&2
        exit 2
    fi
    if [ -d "$HANDOFF_OUT_ABS" ] && [ -n "$(find "$HANDOFF_OUT_ABS" -mindepth 1 -print -quit 2>/dev/null)" ]; then
        echo "✗ podman-vibe: seat out dir is not empty: ${HANDOFF_OUT_ABS} — a previous seat left files there; refusing to run" >&2
        exit 2
    fi
    mkdir -p "$HANDOFF_OUT_ABS"
    HANDOFF_OUT_REL="${HANDOFF_OUT_ABS#"$WORKTREE_ABS"/}"
    HANDOFF_WT_TOP=$(git -C "$WORKTREE_ABS" rev-parse --show-toplevel)
    HANDOFF_DELIVER_REL="${HANDOFF_DELIVER_ABS#"$HANDOFF_WT_TOP"/}"

    # Quarantine on ANY exit that did not deliver: a non-empty out dir is renamed aside as
    # evidence (never delivered), an empty one is removed — the same path is fresh next time.
    HANDOFF_DONE=0
    _handoff_exit() {
        local rc=$?
        if [ "$HANDOFF_DONE" != 1 ] && [ -d "$HANDOFF_OUT_ABS" ]; then
            if [ -n "$(find "$HANDOFF_OUT_ABS" -mindepth 1 -print -quit 2>/dev/null)" ]; then
                local q
                q="${HANDOFF_OUT_ABS}.rejected-$(date +%s)-$$"
                mv "$HANDOFF_OUT_ABS" "$q" && echo "wolfpack: seat out dir quarantined: $q" >&2
            else
                rmdir "$HANDOFF_OUT_ABS" 2>/dev/null || true
            fi
        fi
        exit "$rc"
    }
    trap _handoff_exit EXIT
fi

# ─── tmpfs sizes (AC10) ────────────────────────────────────────
# ENOSPC root cause (2026-10): a long agentic review's vibe.log outgrew the old 10 MB logs
# tmpfs; Vibe died with `[Errno 28] No space left on device` before printing anything and
# the empty-output rule misread it as a transient → breaker → false model_quota. A tmpfs
# only consumes RAM for what is actually written, so a generous ceiling costs nothing on a
# normal run. The lib now also classifies ENOSPC as infra (exit 77) — belt and braces.
VIBE_LOGS_TMPFS_SIZE="${WOLFPACK_VIBE_LOGS_TMPFS_SIZE:-256m}"
VIBE_SCRATCH_TMPFS_SIZE="${WOLFPACK_VIBE_SCRATCH_TMPFS_SIZE:-64m}"
for _sz in "$VIBE_LOGS_TMPFS_SIZE" "$VIBE_SCRATCH_TMPFS_SIZE"; do
    if ! [[ "$_sz" =~ ^[0-9]+[kmg]?$ ]]; then
        echo "ERROR: invalid Vibe tmpfs size '${_sz}' (WOLFPACK_VIBE_LOGS_TMPFS_SIZE / WOLFPACK_VIBE_SCRATCH_TMPFS_SIZE must match ^[0-9]+[kmg]?\$)" >&2
        exit 2
    fi
done

# ─── Per-hunt rate-limit events (AC9) ──────────────────────────
# The lib appends 429 / transient / breaker_open events here (host-side — this shim runs on
# the host; the container never writes it). The plan dir is gitignored. Operator value wins.
if [ -z "${WOLFPACK_RL_EVENTS_FILE:-}" ]; then
    case "$WORKTREE_ABS" in
        */.claude/worktrees/*|*/.agents/worktrees/*)
            _slug="${WORKTREE_ABS##*/worktrees/}"; _slug="${_slug%%/*}"
            if [ -n "$_slug" ] && [ -d "${WORKTREE_ABS%%/worktrees/*}/worktrees/${_slug}/.wolfpack/plans/${_slug}" ]; then
                export WOLFPACK_RL_EVENTS_FILE="${WORKTREE_ABS%%/worktrees/*}/worktrees/${_slug}/.wolfpack/plans/${_slug}/rate-limits.jsonl"
            fi ;;
    esac
fi
PROMPT_ABS=$(realpath "$PROMPT_FILE")
# The CALLER's checkout (no fallback: outside a git checkout, set WOLFPACK_CONFIG).
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)

# When WOLFPACK_SANDBOX=1 we are ALREADY inside the unified sandbox container
# (launched by run-pipeline-sandbox.sh). podman is not installed in that image
# and nesting containers is neither possible nor wanted — the container itself
# is the sandbox. Skip every podman operation (and the config read: the container owns its
# mounts) and call Vibe directly below.
WP_SEAT_MOUNTS=() WP_SEAT_ENV=() WP_SECRETS_PATHS=()
if [ -z "${WOLFPACK_SANDBOX:-}" ]; then
    wp_load_exec_config "$REPO_ROOT" || exit 2
    if [ ! -d "$WP_VIBE_AGENT_DIR" ]; then
        echo "✗ podman-vibe: the configured Vibe agent dir does not exist: ${WP_VIBE_AGENT_DIR} (wolfpack-config.md → Execution Layer → Vibe agent dir) — install the seat profiles (scripts/wolfpack-install-vibe-agents.mjs) or fix the key" >&2
        exit 2
    fi
    IMAGE="$WP_SANDBOX_IMAGE"
else
    # Never mounted in this mode (run_vibe calls Vibe directly); no existence check.
    WP_VIBE_AGENT_DIR="${HOME}/.vibe/agents-headless"
    IMAGE="(in-sandbox)"
    WP_CFG_PATH=""
fi

# GLM seats need a CURRENT Vibe (--auto-approve + read_file/edit tool names). The base
# image's Vibe is frozen at its build date (2.13.0 lacks --auto-approve), so GLM runs on
# a thin layered tag (Containerfile.wolfpack-glm) — the Mistral path keeps the base tag
# untouched. In unified-sandbox mode there is no podman: fail loud (PERMANENT, not a rate
# limit) if the in-container Vibe can't auto-approve, rather than hang or be misgraded.
if [ "$VIBE_FAMILY" = "glm" ]; then
    if [ -z "${WOLFPACK_SANDBOX:-}" ]; then
        # Operator env override wins over the configured GLM image. Built (when absent)
        # only after the secrets guard below.
        IMAGE="${WOLFPACK_GLM_IMAGE:-$WP_GLM_IMAGE}"
    elif ! vibe --help 2>/dev/null | grep -q -- '--auto-approve'; then
        echo "ERROR: the in-sandbox vibe ($(vibe --version 2>/dev/null)) has no --auto-approve — GLM seats cannot run headless (vibe -p would hang on approval). Rebuild the sandbox image with a current mistral-vibe." >&2
        exit 2
    fi
fi

# Guard: verify critical mount sources exist as files (not directories).
# Podman auto-creates missing paths as directories, which corrupts Vibe config.
for f in "${HOME}/.vibe/.env" "${HOME}/.vibe/config.toml"; do
    if [ ! -f "$f" ]; then
        echo "ERROR: Required file not found: $f" >&2
        echo "Run 'vibe --setup' on the host first." >&2
        exit 1
    fi
done

# Where the worktree lives inside the container. Mistral keeps the historical
# /workspace; GLM mounts at the HOST path so absolute plan paths in prompts and the
# dev-cortex MCP (Spark mirror, same path) both resolve.
if [ "$VIBE_FAMILY" = "glm" ]; then
    CWORK="$WORKTREE_ABS"
else
    CWORK="/workspace"
fi
if [ "$VIBE_MODE" = "implement" ]; then
    WORK_MODE="rw,z"
else
    WORK_MODE="ro,z"
fi

# Review/certify seats run the project's test command inside the container. Tell it that
# it IS inside the sandbox image (WOLFPACK_SANDBOX=1 → the image's own runtime, never the
# host's), plus the project's configured Seat test env (TEST-ONLY, non-secret values, e.g. a
# framework key the test command needs). The host .env is never mounted: it holds real
# credentials, and the seat gets none. --implement has no shell, so it gets neither. These
# are container-side only: on the host this script still reads WOLFPACK_SANDBOX from its own
# environment.
REVIEW_ENV=()
if [ "$VIBE_MODE" != "implement" ]; then
    REVIEW_ENV=(-e WOLFPACK_SANDBOX=1)
    for _kv in ${WP_SEAT_ENV[@]+"${WP_SEAT_ENV[@]}"}; do REVIEW_ENV+=(-e "$_kv"); done
fi

MOUNT_ARGS=(
    # Worktree: READ-ONLY (review/certify) — READ-WRITE only for --implement
    -v "${WORKTREE_ABS}:${CWORK}:${WORK_MODE}"
    # Prompt file
    -v "${PROMPT_ABS}:/tmp/prompt.txt:ro,z"
    # Vibe auth + config (read-only, SELinux labeled)
    -v "${HOME}/.vibe/.env:${HOME}/.vibe/.env:ro,z"
    -v "${HOME}/.vibe/config.toml:${HOME}/.vibe/config.toml:ro,z"
    # Vibe custom agents + prompts (read-only).
    # The configured Vibe agent dir holds the pipeline seats / headless profiles; the
    # interactive Shift+Tab cycle only sees ~/.vibe/agents (task() subagents).
    -v "${WP_VIBE_AGENT_DIR}:${HOME}/.vibe/agents:ro,z"
    -v "${HOME}/.vibe/prompts:${HOME}/.vibe/prompts:ro,z"
    # Vibe needs writable scratch dirs — tmpfs so nothing persists or escapes.
    # mode=1777 is REQUIRED: podman 5.8+ mounts a tmpfs root-owned 0755 when any
    # option is specified, so the keep-id user (uid 1000) can't write and vibe
    # crashes at import opening ~/.vibe/logs/vibe.log (PermissionError). 1777
    # (sticky, world-writable) lets the mapped non-root user create files.
    # Sizes: see "tmpfs sizes (AC10)" above — logs 256m / scratch 64m by default.
    --tmpfs "${HOME}/.vibe/logs:rw,size=${VIBE_LOGS_TMPFS_SIZE},mode=1777"
    --tmpfs "${HOME}/.vibe/vibehistory:rw,size=${VIBE_SCRATCH_TMPFS_SIZE},mode=1777"
    --tmpfs "${HOME}/.vibe/cache:rw,size=${VIBE_SCRATCH_TMPFS_SIZE},mode=1777"
)

# Mount project context files if they exist (read-only). Skipped for --implement: the
# rw worktree already carries them, and a ro overlay on .wolfpack would block the
# implementer from writing shepherd-log.md into its plan dir.
#
# NEVER overlay a path the worktree already has. REPO_ROOT is the CALLER's checkout
# (git rev-parse of the CWD), so when a reviewer is launched from the main repo against a
# hunt worktree, an unconditional overlay replaced the branch's own TODO.md/CLAUDE.md/
# AGENTS.md with main's and hid the hunt's .wolfpack/plans/<slug>/ behind main's .wolfpack
# — the reviewer then reported "TODO.md not updated" and "plan directory absent" against a
# branch that had both (background-worker-starvation-fix, 2026-10-02). The overlay is only
# a fallback for a target that lacks the file.
if [ "$VIBE_MODE" != "implement" ]; then
    for f in CLAUDE.md TODO.md AGENTS.md; do
        if [ ! -e "${WORKTREE_ABS}/${f}" ] && [ -f "${REPO_ROOT}/${f}" ]; then
            MOUNT_ARGS+=(-v "${REPO_ROOT}/${f}:${CWORK}/${f}:ro,z")
        fi
    done
    if [ ! -e "${WORKTREE_ABS}/.wolfpack" ] && [ -d "${REPO_ROOT}/.wolfpack" ]; then
        MOUNT_ARGS+=(-v "${REPO_ROOT}/.wolfpack:${CWORK}/.wolfpack:ro,z")
    fi

    # Git visibility for review/certify seats. A hunt worktree's .git is a FILE
    # ("gitdir: <repo>/.git/worktrees/<slug>"); with only the worktree mounted, git in the
    # container sees a dangling gitdir and every `git diff` fails "not a git repository" —
    # the seat silently degrades to a file-reading audit. Mount the git COMMON dir
    # read-only at its host path so that absolute gitdir resolves. Skipped when it is
    # already inside the worktree (a plain checkout's own .git dir). podman path only: in
    # WOLFPACK_SANDBOX mode the unified container owns its mounts.
    if [ -z "${WOLFPACK_SANDBOX:-}" ]; then
        if GIT_COMMON_DIR=$(git -C "$WORKTREE_ABS" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && [ -n "$GIT_COMMON_DIR" ]; then
            case "$GIT_COMMON_DIR" in
                *:*|*$'\n'*)
                    echo "wolfpack: WARNING: git common dir contains ':' or a newline — not mounting it; the reviewer cannot run git diff: $GIT_COMMON_DIR" >&2 ;;
                "${WORKTREE_ABS}"|"${WORKTREE_ABS}"/*)
                    : ;;   # inside the worktree mount already
                *)
                    MOUNT_ARGS+=(-v "${GIT_COMMON_DIR}:${GIT_COMMON_DIR}:ro,z") ;;
            esac
        else
            echo "wolfpack: WARNING: ${WORKTREE_ABS} is not a git checkout — the reviewer cannot run git diff" >&2
        fi

        # Project-configured extra mounts (wolfpack-config.md → Execution Layer → Seat extra
        # mounts): review/certify seats only, ALWAYS read-only. The host path must exist —
        # podman would otherwise auto-create it as a directory.
        for _m in ${WP_SEAT_MOUNTS[@]+"${WP_SEAT_MOUNTS[@]}"}; do
            _mh="${_m%%:*}"; _mc="${_m#*:}"
            case "$_mh$_mc" in
                *:*|*$'\n'*)
                    echo "✗ podman-vibe: Seat extra mounts entry contains ':' or a newline: ${_m} (wolfpack-config.md → Execution Layer → Seat extra mounts)" >&2
                    exit 2 ;;
            esac
            if [ ! -e "$_mh" ]; then
                echo "✗ podman-vibe: Seat extra mounts host path does not exist: ${_mh} (wolfpack-config.md → Execution Layer → Seat extra mounts) — refusing to let podman create it" >&2
                exit 2
            fi
            MOUNT_ARGS+=(-v "${_mh}:${_mc}:ro,z")
        done

        # Seat handoff: exactly ONE read-write bind — the per-seat out dir — at the container
        # path matching its worktree-relative path, so it lies inside the seat's --workdir for
        # both families (GLM: host path; Mistral: /workspace/<rel>). The worktree bind above
        # stays :ro,z; the secrets guard below covers this source like every other bind.
        if [ "$HANDOFF" = 1 ]; then
            MOUNT_ARGS+=(-v "${HANDOFF_OUT_ABS}:${CWORK}/${HANDOFF_OUT_REL}:rw,z")
        fi
    fi
fi

# ─── Secrets guard, then images (podman path only) ─────────────
# Order is load-bearing: the full mount list is built above, EVERY bind source is checked
# against the configured Secrets paths, and only then may an image build or a run happen —
# a refusal therefore runs no podman build and no podman run.
if [ -z "${WOLFPACK_SANDBOX:-}" ]; then
    _srcs=()
    _next=""
    for _a in "${MOUNT_ARGS[@]}"; do
        if [ "$_next" = 1 ]; then _srcs+=("${_a%%:*}"); _next=""; continue; fi
        [ "$_a" = "-v" ] && _next=1
    done
    wp_secrets_guard "Secrets paths" "${_srcs[@]}" || exit 2
    if [ "$VIBE_FAMILY" = "glm" ]; then
        wp_ensure_glm_image "$IMAGE" || exit 2
    else
        wp_ensure_sandbox_image || exit 2
    fi
fi
echo "wolfpack: podman-vibe ${AGENT} family=${VIBE_FAMILY} mode=${VIBE_MODE} worktree=${WORKTREE_ABS} shim=${SHIM_DIR} config=${WP_CFG_PATH:-<sandbox>} image=${IMAGE}" >&2

# ─── Concurrency guard: cap concurrent Mistral calls at 1 ──────
# Multiple hunts (and review rounds) hit Mistral at once; uncapped fan-out
# trips rate limits and crashes auto-hunts. flock holds a slot for the
# duration of the call and auto-releases if the holder dies. Lives in the
# executing context's /tmp — container /tmp (unified sandbox) or host /tmp.
# 2026-06-08: Mistral's rate limit is ~3 calls per 20-30min window. With
# SEM_MAX=2, two concurrent calls can exhaust the quota instantly. Dropping to 1
# serializes all Mistral calls, guaranteeing we never exceed single-call spacing.
# Per-family semaphore dirs: mistral keeps wolfpack-sem/mistral (SEM_MAX 1). GLM reviews
# use wolfpack-sem/glm (default 2); a GLM implement holds its slot for up to an hour, so
# it gets its OWN dir (wolfpack-sem/glm-implement, 1) and never starves GLM reviews.
if [ "$VIBE_FAMILY" = "glm" ] && [ "$VIBE_MODE" = "implement" ]; then
    SEM_DIR="${TMPDIR:-/tmp}/wolfpack-sem/glm-implement"
    SEM_MAX="${WOLFPACK_SEM_MAX:-1}"
elif [ "$VIBE_FAMILY" = "glm" ]; then
    SEM_DIR="${TMPDIR:-/tmp}/wolfpack-sem/glm"
    SEM_MAX="${WOLFPACK_SEM_MAX:-2}"
else
    SEM_DIR="${TMPDIR:-/tmp}/wolfpack-sem/mistral"
    SEM_MAX="${WOLFPACK_SEM_MAX:-1}"
fi
# [05] B2.3 — auto-degrade concurrency to 1 while Mistral is flaky so retries don't
# fight for one throttled endpoint. Only when the operator hasn't pinned SEM_MAX.
if [ -z "${WOLFPACK_SEM_MAX:-}" ] && rl_degraded "$RL_MODEL"; then
    SEM_MAX=1
    echo "wolfpack: ${RL_MODEL} flaky — degrading concurrency to SEM_MAX=1" >&2
fi

sem_run() {
    mkdir -p "$SEM_DIR"
    local fd slot rc
    while :; do
        for slot in $(seq 1 "$SEM_MAX"); do
            exec {fd}>"$SEM_DIR/slot.$slot"
            if flock -n "$fd"; then
                "$@"; rc=$?
                exec {fd}>&-
                return $rc
            fi
            exec {fd}>&-
        done
        sleep 2
    done
}

# ─── [06] AC1: un-box the reviewer's toolset (capable default, not a 2-tool cage) ───
# Mistral's run-#5 failures were every one a TOOL-BOX failure, not a capability
# failure: the 2-tool `read,grep` allowlist starved the reviewer of the producer +
# git-read tools its role actually needs (read the diff, grep the code, run `git
# diff` to SEE the change). Per docs/wolfpack-autonomy/06 § "Give models their tools
# — don't box them": give each model its CAPABLE default toolset and make it safe by
# LAYERING, not boxing —
#   * the sandbox + Bash denylist is the REAL guardrail (no prod credentials, no
#     escape); tool-freedom lives INSIDE it.
#   * the worktree mounts READ-ONLY (`/workspace:ro` above), so even with write tools
#     enabled the reviewer physically cannot mutate app source — defense in depth.
#   * reviewer-writes-to-source are read-only-by-ROLE, enforced by instruction +
#     diff-catch detection in the orchestrator (it flags a review round whose
#     `git diff` touched app source), NOT by a brittle tool fence.
# So enable the capable producer + git-read set; the only deliberate OMISSION is
# `task`: cross-model CLI self-orchestration stays disabled (headless reviewers
# proved too fragile as sub-agent orchestrators — roster fan-out timed out / blew
# turn limits / never emitted a verdict on the v1-push-3 Reds). The orchestrator
# owns the one capped level of fan-out; the reviewer runs ONE comprehensive pass.
#
# CRITICAL — DO NOT RE-BOX (silent-blinding footgun): --enabled-tools uses argparse
# action="append" and MUST be repeated per tool. A comma-joined "read,grep" is parsed
# as ONE bogus tool named literally "read,grep" matching no real tool; in -p mode
# --enabled-tools "disables all other tools", so the bogus name filters EVERYTHING
# out → every tool call returns "Unknown tool" → the reviewer goes blind and
# fabricates findings (unfinalize-inventory-restore Wave-1 Red: 19 tool calls, 0
# succeeded, 15 hallucinated findings). That re-boxing is SILENT — nothing errors.
# `scripts/wolfpack-toolcheck.mjs` is the preflight regression guard that asserts
# this set stays capable + comma-free and FAILS LOUD if it ever re-boxes; keep the
# two in sync. Verified fix 2026-05-30 via Vibe 2.13.0 source (manager.py
# name_matches / format.py).
#
# TOOL NAMES (Vibe 2026-06): read (was read_file), grep, edit (was search_replace),
# write_file, bash. If a review comes back with no successful tool calls, suspect
# another rename and re-check the LIVE tool names first (vibe --help / source).
# Operator override: WOLFPACK_VIBE_TOOLS="read grep ..." (space-separated) re-scopes
# the set mid-incident without editing the shim.
#
# 2026-06-08 BLOODHOUND-SPECIFIC: The Bloodhound agent profile has [tools.task] with
# permission="always", BUT enabling `task` for Bloodhound causes catastrophic token
# bloat (T3: 307K tokens vs 178K without task). The shim MUST filter out `task` for
# this specific agent, regardless of WOLFPACK_VIBE_TOOLS override. Other agents may
# need `task` — Bloodhound never does.
VIBE_TOOLS_DEFAULT="read grep edit write_file bash"
VIBE_TOOL_FLAGS=()
for _t in ${WOLFPACK_VIBE_TOOLS:-$VIBE_TOOLS_DEFAULT}; do
    # Bloodhound must NEVER have task - it causes token bloat (T3: 307K > 300K limit)
    if [ "$AGENT" = "wolfpack-bloodhound" ] && [ "$_t" = "task" ]; then
        echo "wolfpack: WARNING: 'task' tool omitted for Bloodhound agent (token bloat risk — see T3 2026-06-08)" >&2
        continue
    fi
    VIBE_TOOL_FLAGS+=(--enabled-tools "$_t")
done

# [07 §6] LEAN REQUEST CONFIG — the real fix for the "Server disconnected without sending a
# response / Network error" failures. ROOT CAUSE (confirmed 2026-06-08): Vibe's default config
# force-injects ~43K chars of overhead into EVERY request — the `cli` system prompt +
# include_model_info + include_prompt_detail + include_project_context (auto-loads the mounted
# CLAUDE.md+AGENTS.md+TODO.md) + tool schemas. On a review that adds real content the total
# request (~80K chars) crosses Mistral's API-GATEWAY request-size limit and the connection is
# dropped BEFORE any response — proven NOT a rate limit (single cold request), NOT the pod
# (host-direct fails identically), NOT the model context cap (Medium is 200K). Trimming the
# overhead let the SAME ~36K review content complete. The agent can still READ project files
# via tools on demand (organic) — it just isn't force-fed them. Default lean;
# WOLFPACK_VIBE_FULL_CONTEXT=1 restores the fat default.
# ─── GLM seats: strict allow-list + auto-approve ───
# Live Vibe tool names (2.24): read_file, grep, write_file (NEW files only), edit
# (existing files), bash; MCP tools publish as <server>_<tool> (dev_cortex_repo_map,
# dev_cortex_file_outline). There is NO search_replace.
# Review/certify seats get bash INSIDE the sandbox (doc 06; read-only worktree + git dir,
# no prod credentials): a reviewer that cannot run `git diff` or the test command is a
# file-reading audit, not a review. They also get `write_file` (seat-handoff-writes) so they
# write their OWN handoff file: it is confined by MOUNT, not by a tool fence — the worktree is
# read-only and only the per-seat out dir (--out-dir) is bind-mounted read-write; the shim then
# moves exactly the expected artifact and fails the round (exit 78) on anything else.
# write_file only CREATES (it refuses an existing file): one call per file, complete content.
# `edit` is dropped for review/certify seats (edit-denied by role). --implement stays
# shell-free: the calling wrapper commits and the Tracker runs the tests. The DROP lists are
# enforced even against an operator override (WOLFPACK_GLM_TOOLS /
# WOLFPACK_GLM_IMPLEMENT_TOOLS); `task` is dropped in both modes (no self-orchestration).
# scripts/wolfpack-toolcheck.mjs asserts these lists against the seat profiles — keep them
# in sync.
# Space-separated, one --enabled-tools flag per tool (same rule as above).
GLM_REVIEW_TOOLS_DEFAULT="read_file grep bash write_file dev_cortex_repo_map dev_cortex_file_outline"
GLM_IMPLEMENT_TOOLS_DEFAULT="read_file grep write_file edit dev_cortex_repo_map dev_cortex_file_outline"
GLM_REVIEW_DROP="task edit"
GLM_IMPLEMENT_DROP="bash task"
APPROVE_CLAUSE=""
if [ "$VIBE_FAMILY" = "glm" ]; then
    if [ "$VIBE_MODE" = "implement" ]; then
        _glm_tools="${WOLFPACK_GLM_IMPLEMENT_TOOLS:-$GLM_IMPLEMENT_TOOLS_DEFAULT}"
        _glm_drop="$GLM_IMPLEMENT_DROP"
    else
        _glm_tools="${WOLFPACK_GLM_TOOLS:-$GLM_REVIEW_TOOLS_DEFAULT}"
        _glm_drop="$GLM_REVIEW_DROP"
    fi
    VIBE_TOOL_FLAGS=()
    for _t in $_glm_tools; do
        case " $_glm_drop " in
            *" $_t "*)
                echo "wolfpack: WARNING: '$_t' dropped from the GLM ${VIBE_MODE} allow-list (GLM ${VIBE_MODE} seats never get: ${_glm_drop})" >&2
                continue ;;
        esac
        VIBE_TOOL_FLAGS+=(--enabled-tools "$_t")
    done
    # FAIL CLOSED: with --auto-approve, an EMPTY allow-list would mean "no --enabled-tools
    # flag" = EVERY tool (bash included) auto-approved. Never run that.
    if [ "${#VIBE_TOOL_FLAGS[@]}" -eq 0 ]; then
        echo "ERROR: the GLM tool allow-list is empty after filtering ('${_glm_tools}') — refusing to run with --auto-approve and no --enabled-tools (that would enable every tool)." >&2
        exit 2
    fi
    APPROVE_CLAUSE="--auto-approve"
    # Numbers only — these become argv, never shell text, but garbage must fail loud.
    _is_uint() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
    _is_uint "$MAX_TURNS" || { echo "ERROR: max-turns must be a non-negative integer (got '${MAX_TURNS}')" >&2; exit 2; }
    GLM_TURN_ARGS=()
    [ "$MAX_TURNS" != "0" ] && GLM_TURN_ARGS=(--max-turns "$MAX_TURNS")
    # Cost/runaway guard: timeouts, not a token cap (a 60K session cap strangles an
    # implement). Opt back in with WOLFPACK_GLM_MAX_TOKENS.
    GLM_COST_ARGS=()
    if [ -n "${WOLFPACK_GLM_MAX_TOKENS:-}" ] && [ "${WOLFPACK_GLM_MAX_TOKENS}" != "0" ]; then
        _is_uint "$WOLFPACK_GLM_MAX_TOKENS" || { echo "ERROR: WOLFPACK_GLM_MAX_TOKENS must be an integer (got '${WOLFPACK_GLM_MAX_TOKENS}')" >&2; exit 2; }
        GLM_COST_ARGS=(--max-tokens "$WOLFPACK_GLM_MAX_TOKENS")
    fi
    if [ "$VIBE_MODE" = "implement" ]; then
        GLM_TIMEOUT="${WOLFPACK_VIBE_IMPLEMENT_TIMEOUT:-3600}"
    else
        GLM_TIMEOUT="${WOLFPACK_VIBE_REVIEW_TIMEOUT:-1800}"
    fi
    # Must be > 0: `timeout 0` means NO limit, which would silently drop the runaway bound
    # on an auto-approved GLM run.
    if ! _is_uint "$GLM_TIMEOUT" || [ "$GLM_TIMEOUT" -le 0 ]; then
        echo "ERROR: GLM timeout must be a POSITIVE integer number of seconds (got '${GLM_TIMEOUT}') — 0 would disable the wall-clock bound" >&2
        exit 2
    fi
    case "$WORKTREE_ABS" in *:*|*$'\n'*) echo "ERROR: worktree path contains ':' or a newline — cannot be bind-mounted safely: $WORKTREE_ABS" >&2; exit 2 ;; esac
fi

LEAN_KV=()
if [ -z "${WOLFPACK_VIBE_FULL_CONTEXT:-}" ]; then
    LEAN_KV=(VIBE_INCLUDE_MODEL_INFO=false VIBE_INCLUDE_PROMPT_DETAIL=false VIBE_INCLUDE_PROJECT_CONTEXT=false)
fi
LEAN_PODMAN=()
for _kv in ${LEAN_KV[@]+"${LEAN_KV[@]}"}; do LEAN_PODMAN+=(-e "$_kv"); done

run_vibe() {
    # vibe -p takes the prompt as an ARGUMENT, not via stdin. Piping to a stdin
    # it ignores yields "Error: No prompt provided for programmatic mode" (exit 1)
    # and no <verdict> block — the missing_verdict_block / both_clis_failed crash.
    # stdin is closed (</dev/null) so vibe never blocks waiting on it.
    if [ -n "${WOLFPACK_SANDBOX:-}" ]; then
        # Unified-container mode: call Vibe directly (no nested podman). The
        # container is the filesystem boundary; --enabled-tools is the tool-level one.
        env ${LEAN_KV[@]+"${LEAN_KV[@]}"} vibe -p "$(cat "$PROMPT_ABS")" --agent "$AGENT" "${VIBE_TOOL_FLAGS[@]}" \
             --workdir "$WORKTREE_ABS" --trust $TURN_CLAUSE $COST_CLAUSE --output text </dev/null
    else
        podman run --rm \
            --userns=keep-id \
            -e HOME="${HOME}" \
            -e GIT_OPTIONAL_LOCKS=0 \
            ${REVIEW_ENV[@]+"${REVIEW_ENV[@]}"} \
            ${LEAN_PODMAN[@]+"${LEAN_PODMAN[@]}"} \
            "${MOUNT_ARGS[@]}" \
            --network=pasta \
            "$IMAGE" \
            bash -c "vibe -p \"\$(cat /tmp/prompt.txt)\" --agent $AGENT ${VIBE_TOOL_FLAGS[*]} --workdir /workspace --trust $TURN_CLAUSE $COST_CLAUSE --output text </dev/null"
    fi
}

# GLM runner: same shape as run_vibe, plus --auto-approve, the host-path workdir and a
# wall-clock timeout. NO shell string-building: every value (agent, tools, workdir, caps)
# travels as a separate ARGV element; the in-container `bash -c` script is a CONSTANT that
# only splices the prompt file and forwards "$@" (so a path with spaces/quotes is inert).
# A timeout (rc 124, or 137 if the -k kill fired) is NOT retried (RL_NO_RETRY_RC) and is
# reported as WOLFPACK_TIMEOUT:glm / exit 76 below — distinct from a rate limit.
run_vibe_glm() {
    local vargs=(--agent "$AGENT" "${VIBE_TOOL_FLAGS[@]}" "$APPROVE_CLAUSE" --trust
                 ${GLM_TURN_ARGS[@]+"${GLM_TURN_ARGS[@]}"} ${GLM_COST_ARGS[@]+"${GLM_COST_ARGS[@]}"} --output text)
    if [ -n "${WOLFPACK_SANDBOX:-}" ]; then
        timeout -k 30 "$GLM_TIMEOUT" env ${LEAN_KV[@]+"${LEAN_KV[@]}"} vibe -p "$(cat "$PROMPT_ABS")" \
             "${vargs[@]}" --workdir "$WORKTREE_ABS" </dev/null
    else
        # shellcheck disable=SC2016  # the single-quoted script is intentionally literal
        timeout -k 30 "$GLM_TIMEOUT" podman run --rm \
            --userns=keep-id \
            -e HOME="${HOME}" \
            -e GIT_OPTIONAL_LOCKS=0 \
            ${REVIEW_ENV[@]+"${REVIEW_ENV[@]}"} \
            ${LEAN_PODMAN[@]+"${LEAN_PODMAN[@]}"} \
            "${MOUNT_ARGS[@]}" \
            --network=pasta \
            "$IMAGE" \
            bash -c 'exec vibe -p "$(cat /tmp/prompt.txt)" "$@" </dev/null' wolfpack-vibe \
            "${vargs[@]}" --workdir "$CWORK"
    fi
}

# ─── Seat handoff: source snapshot + verify/deliver (seat-handoff-writes) ───
# "Touches source" = tracked or would-be-tracked worktree state (P5): HEAD plus every
# `git status --porcelain=v1 -z --untracked-files=all` entry with the sha256 of its content,
# taken on the host before the run and compared after it. Deliberately NOT snapshotted:
#   - refs other than HEAD: they live in the git common dir shared by every worktree, so a
#     parallel hunt's commit, a fetch or operator activity would move them mid-run and
#     false-fail a compliant seat. A seat commit moves HEAD and IS caught; on the podman path
#     the common dir is mounted :ro,z, so a seat cannot touch refs at all.
#   - gitignored paths (plan dirs, test caches: in WOLFPACK_SANDBOX=1 mode a seat runs the
#     test command against a writable worktree, so __pycache__/.pytest_cache churn is legit);
#   - HANDOFF_WT_EXCLUDE (the shim agent rewrites its heartbeat while the seat runs);
#   - the deliver-to dir, which gets its own narrower check: each top-level entry + its sha256,
#     except HANDOFF_PLAN_EXEMPT (names that really change WHILE a seat runs). metadata.json and
#     every artifact name are sha-pinned. That is safe because every tier runs SINGLE_LENS, so
#     no sibling lens writes the plan dir during this seat's run. A future multi-lens tier would
#     trip source-touched (loud exit 78, never a silent pass) — the hunt enabling lenses must
#     revisit this pin.
# KNOWN GAP (WOLFPACK_SANDBOX=1 only, writable worktree + gitdir): writes INSIDE seat-notes/
# (a dir prints "dir", not a content hash) and a new/moved non-HEAD ref without a HEAD move are
# not caught. On the podman path the read-only mounts make both impossible; the orchestrator's
# diff-catch stays the second net.
HANDOFF_WT_EXCLUDE=".wolfpack/heartbeats"
HANDOFF_PLAN_EXEMPT="rate-limits.jsonl timing.jsonl seat-notes .seat-out"

_hf_sha() {
    if [ -L "$1" ]; then printf 'symlink:%s' "$(readlink "$1")"
    elif [ -f "$1" ]; then sha256sum < "$1" | cut -d' ' -f1
    elif [ -d "$1" ]; then printf 'dir'
    else printf -- '-'
    fi
}

_wt_snapshot() {
    local head entry xy path tmp name
    head=$(GIT_OPTIONAL_LOCKS=0 git -C "$WORKTREE_ABS" rev-parse -q --verify HEAD 2>/dev/null) || head=none
    printf 'HEAD\t%s\n' "$head"
    tmp=$(mktemp "${TMPDIR:-/tmp}/wolfpack-snap.XXXXXX")
    if ! GIT_OPTIONAL_LOCKS=0 git -C "$WORKTREE_ABS" status --porcelain=v1 -z --untracked-files=all >"$tmp"; then
        rm -f "$tmp"; return 1
    fi
    {
        while IFS= read -r -d '' entry; do
            xy="${entry:0:2}"; path="${entry:3}"
            # Renames/copies carry a second NUL-terminated (original) path: consume it.
            case "$xy" in *R*|*C*) IFS= read -r -d '' _ || true ;; esac
            case "$path" in
                "$HANDOFF_WT_EXCLUDE"|"$HANDOFF_WT_EXCLUDE"/*) continue ;;
                "$HANDOFF_DELIVER_REL"|"$HANDOFF_DELIVER_REL"/*) continue ;;
            esac
            printf 'ST\t%s\t%s\t%s\n' "$xy" "$path" "$(_hf_sha "$HANDOFF_WT_TOP/$path")"
        done <"$tmp"
        while IFS= read -r -d '' entry; do
            name="${entry##*/}"
            case " $HANDOFF_PLAN_EXEMPT " in *" $name "*) continue ;; esac
            printf 'PD\t%s\t%s\n' "$name" "$(_hf_sha "$entry")"
        done < <(find "$HANDOFF_DELIVER_ABS" -mindepth 1 -maxdepth 1 -print0)
    } | LC_ALL=C sort
    rm -f "$tmp"
}

# Snapshot line → the path it names (HEAD / worktree path / deliver-dir entry).
_snap_paths() {
    awk -F'\t' -v pd="$HANDOFF_DELIVER_REL" '
        $1 == "HEAD" { print "HEAD"; next }
        $1 == "ST"   { print $3; next }
        $1 == "PD"   { print pd "/" $2; next }'
}

_in_expect() {
    local e
    for e in "${HANDOFF_EXPECT[@]}"; do [ "$e" = "$1" ] && return 0; done
    return 1
}

# Each retry_with_backoff attempt starts with an EMPTY out dir: write_file refuses to overwrite,
# so a retried attempt would otherwise fail on the previous attempt's partial artifact. Without
# handoff it is a pure pass-through.
_seat_attempt() {
    if [ "$HANDOFF" = 1 ]; then
        find "$HANDOFF_OUT_ABS" -mindepth 1 -delete || return 1
    fi
    "$@"
}

# All checks first, then the moves. Every failure prints its marker; any failure returns 1
# with nothing (more) delivered, and the EXIT trap quarantines the out dir.
_handoff_deliver() {
    local errs=0 snap_after p f name sub e
    if ! snap_after=$(_wt_snapshot); then
        echo "WOLFPACK_ARTIFACT_ERROR: source-touched <git status failed after the seat run>" >&2
        errs=1
    elif [ "$snap_after" != "$SNAP_BEFORE" ]; then
        while IFS= read -r p; do
            [ -n "$p" ] && echo "WOLFPACK_ARTIFACT_ERROR: source-touched $p" >&2
        done < <(diff <(printf '%s\n' "$SNAP_BEFORE") <(printf '%s\n' "$snap_after") \
                    | sed -n 's/^[<>] //p' | _snap_paths | LC_ALL=C sort -u)
        errs=1
    fi
    local seen=" "
    while IFS= read -r -d '' f; do
        name="${f##*/}"
        if _in_expect "$name"; then
            seen="${seen}${name} "
            if [ -L "$f" ] || [ ! -f "$f" ]; then
                echo "WOLFPACK_ARTIFACT_ERROR: not-a-regular-file $name" >&2
                errs=1
            fi
        else
            echo "WOLFPACK_ARTIFACT_ERROR: unexpected ${HANDOFF_OUT_REL}/${name}" >&2
            errs=1
            if [ -d "$f" ] && [ ! -L "$f" ]; then
                while IFS= read -r -d '' sub; do
                    echo "WOLFPACK_ARTIFACT_ERROR: unexpected ${HANDOFF_OUT_REL}/${sub#"$HANDOFF_OUT_ABS"/}" >&2
                done < <(find "$f" -mindepth 1 -print0)
            fi
        fi
    done < <(find "$HANDOFF_OUT_ABS" -mindepth 1 -maxdepth 1 -print0)
    for e in "${HANDOFF_EXPECT[@]}"; do
        case "$seen" in *" $e "*) : ;; *) echo "WOLFPACK_ARTIFACT_ERROR: missing $e" >&2; errs=1 ;; esac
    done
    [ "$errs" = 0 ] || return 1

    # Moves: same-filesystem rename (the out dir is pinned under the deliver-to dir) — atomic
    # and byte-identical; the sha is recomputed on the destination to prove it.
    local -A sha=() size=()
    for e in "${HANDOFF_EXPECT[@]}"; do
        sha[$e]=$(sha256sum < "$HANDOFF_OUT_ABS/$e" | cut -d' ' -f1)
        size[$e]=$(stat -c %s "$HANDOFF_OUT_ABS/$e")
    done
    for e in "${HANDOFF_EXPECT[@]}"; do
        if ! mv -f "$HANDOFF_OUT_ABS/$e" "$HANDOFF_DELIVER_ABS/$e" \
           || [ "$(sha256sum < "$HANDOFF_DELIVER_ABS/$e" | cut -d' ' -f1)" != "${sha[$e]}" ]; then
            echo "WOLFPACK_ARTIFACT_ERROR: move-failed $e" >&2
            return 1
        fi
        echo "WOLFPACK_ARTIFACT_DELIVERED: $e sha256=${sha[$e]} bytes=${size[$e]}" >&2
    done
    if ! rmdir "$HANDOFF_OUT_ABS" 2>/dev/null; then
        echo "WOLFPACK_ARTIFACT_ERROR: unexpected ${HANDOFF_OUT_REL}/ (out dir not empty after delivery)" >&2
        return 1
    fi
    HANDOFF_DONE=1
    return 0
}

if [ "$HANDOFF" = 1 ]; then
    if ! SNAP_BEFORE=$(_wt_snapshot); then
        echo "ERROR: handoff mode could not snapshot the worktree (git status failed): $WORKTREE_ABS" >&2
        exit 2
    fi
fi

# ─── [05] Part B dispatch ──────────────────────────────────────
# 1. Circuit-breaker pre-check: if Mistral is cooling down (tripped earlier in this
#    batch), fast-exit 75 with the WOLFPACK_RATE_LIMITED sentinel WITHOUT taking a sem
#    slot — the orchestrator then prefers the other model (sticky-away) instead of
#    waiting on a known-throttled endpoint. Both models cooling down → the orchestrator
#    parks model_quota (never a dead pipeline).
rl_guard_or_exit "$RL_MODEL"
# 2. retry_with_backoff wraps the actual call (exponential backoff + jitter on transient
#    errors only; permanent errors bail immediately; ≥N transient fails trips the breaker
#    and returns 75). sem_run holds the flock slot for the whole retry sequence.
# Both families end in ONE place so a handoff seat's artifact is verified + delivered only
# when the seat itself exited 0; a non-zero seat keeps its own exit code (75/76/77/rc) and
# the EXIT trap quarantines its out dir.
SEAT_RC=0
if [ "$VIBE_FAMILY" = "glm" ]; then
    # GLM: a transient failure that exhausted its attempts (without tripping the breaker)
    # is still "GLM is napping" — surface it as exit 75 + sentinel so the orchestrator
    # moves to the next examiner / the Claude Shepherd instead of grading GLM down.
    rc=0
    RL_NO_RETRY_RC="124 137"
    sem_run retry_with_backoff "$RL_MODEL" _seat_attempt run_vibe_glm || rc=$?
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
        # Wall clock ran out: NOT a quota signal (no breaker trip, no cooldown). The
        # orchestrator moves on to the next family and logs reason "timeout".
        echo "WOLFPACK_TIMEOUT:glm wall-clock limit ${GLM_TIMEOUT}s hit (rc=${rc})" >&2
        SEAT_RC=76
    elif [ "$rc" -eq "$RL_EXIT_INFRA" ]; then
        # INFRA (exit 77): the sandbox broke (e.g. disk full). Keep it DISTINCT from 75/76 —
        # never fold it into the rate-limit branch below, or ENOSPC becomes model_quota again.
        SEAT_RC="$RL_EXIT_INFRA"
    elif [ "$rc" -ne 0 ] && [ "$rc" -ne "$RL_EXIT_COOLDOWN" ] && [ "${RL_LAST_TRANSIENT:-0}" = "1" ]; then
        echo "WOLFPACK_RATE_LIMITED:glm transient failures exhausted attempts (rc=${rc})" >&2
        SEAT_RC="$RL_EXIT_COOLDOWN"
    else
        SEAT_RC="$rc"
    fi
else
    sem_run retry_with_backoff "$RL_MODEL" _seat_attempt run_vibe || SEAT_RC=$?
fi
if [ "$HANDOFF" = 1 ] && [ "$SEAT_RC" -eq 0 ]; then
    _handoff_deliver || exit "$HANDOFF_EXIT_ARTIFACT"
fi
exit "$SEAT_RC"
