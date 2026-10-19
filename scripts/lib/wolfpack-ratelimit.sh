#!/usr/bin/env bash
# scripts/lib/wolfpack-ratelimit.sh — [05] limits layer, Part B (B2 recipe).
#
# SHARED, SOURCED LIBRARY (not executed) for the cross-model review shims
# (podman-vibe.sh serves both Vibe families: glm and mistral). Implements doc 05 § B2:
#   1. retry_with_backoff   — exponential backoff + jitter around a CLI call,
#                             passing the CLI's stdout THROUGH untouched on success.
#   2. rl_is_transient      — the retry-only-transient allowlist (429 / disconnect /
#                             5xx / timeout / empty-output) vs permanent (auth /
#                             invalid-prompt / not-found) which must NOT be retried.
#   3. SEM_MAX auto-degrade — rl_degraded lets the shim drop concurrency to 1 while a
#                             model is flaky so retries don't fight for one throttled
#                             endpoint (the flock cap is concurrency control, not
#                             rate-limit control).
#   4. circuit breaker      — per-model touch-files (<model>.fails counter +
#                             <model>.cooldown expiry). > N transient failures within M
#                             minutes trips the breaker: the shim STOPS dispatching to
#                             that model for a cooldown window and fast-exits 75 so the
#                             orchestrator prefers the other model (sticky-away) and,
#                             when BOTH models are broken, parks model_quota — never a
#                             fail-loop that burns every hunt in the batch.
#
# WHY HERE (not the workflow JS): the workflow .js cannot read the clock or touch the
# filesystem (Date.now()/new Date() throw — they'd break resume; AC5). All of this is
# clock + fs + randomness, so it lives in bash, host-side. The orchestrator only sees
# the shim's exit code / stdout and routes on those.
#
# Empirical caveat (2026-06-07): api.mistral.ai disconnected on the FIRST call (~73K
# chars) and did NOT recover across 30s→60s manual backoff. So backoff-within-a-hunt is
# the FAST PATH; the circuit-breaker + park is the REAL fallback for a sustained
# throttle. Don't burn a hunt retrying a down endpoint — trip the breaker and let the
# host driver reschedule past the window (doc 05 § A3).
#
# Every knob is env-overridable so an operator can tighten things mid-incident without
# editing the shim.

# ─── Tunables (env-overridable) ────────────────────────────────
WOLFPACK_MAX_RETRIES="${WOLFPACK_MAX_RETRIES:-3}"   # attempts per call before giving up
WOLFPACK_RETRY_DELAY="${WOLFPACK_RETRY_DELAY:-2}"   # base backoff seconds (≥1)
# MAX_DELAY: the B2 recipe used 30, but the 2026-06-07 outage proved 30s too short to
# ride out a sustained throttle — so the breaker (not backoff) is the real fallback and
# this is bumped to 60 by default. Raise it if you want backoff to absorb longer blips.
WOLFPACK_MAX_DELAY="${WOLFPACK_MAX_DELAY:-60}"      # backoff ceiling seconds
WOLFPACK_CB_FAILS="${WOLFPACK_CB_FAILS:-3}"         # N transient fails to trip the breaker
WOLFPACK_CB_WINDOW="${WOLFPACK_CB_WINDOW:-600}"     # M seconds the fail count is measured over
WOLFPACK_COOLDOWN="${WOLFPACK_COOLDOWN:-120}"       # seconds a tripped/rate-limited model naps

# Exit code the shim uses to tell the orchestrator "this model is rate-limited / cooling
# down — don't retry it, go to the fallback." 75 = EX_TEMPFAIL (sysexits.h). Paired with
# a `WOLFPACK_RATE_LIMITED:<model>` sentinel on stderr so the signal survives even if a
# wrapper masks the code.
RL_EXIT_COOLDOWN=75

# Exit code for an INFRASTRUCTURE fault in the shim's own sandbox (disk full / ENOSPC,
# quota, read-only fs) — usage-limit-gate AC10. NOT a rate limit and NOT the model's fault:
# no retry, no breaker, no cooldown, never counted toward model_quota. Paired with a
# `WOLFPACK_INFRA_ERROR:<model>` sentinel on stderr. 77 sits beside 75 (cooldown) and 76.
RL_EXIT_INFRA=77

# State dir: SAME parent as the flock semaphore (container /tmp in the unified sandbox,
# host /tmp otherwise) so cooldown state and concurrency state live together.
rl_state_dir() {
    local d="${TMPDIR:-/tmp}/wolfpack-sem"
    mkdir -p "$d"
    printf '%s' "$d"
}

rl_now() { date +%s; }

# ─── Infra classifier (checked FIRST) ──────────────────────────
# Usage: rl_is_infra "<combined stderr/stdout text>" → 0 if the text shows the shim's own
# sandbox broke (disk full etc.), else 1. Root cause it exists for (2026-10, confirmed in
# planning): a long agentic Vibe review filled the 10 MB ~/.vibe/logs tmpfs, Vibe crashed
# with `OSError: [Errno 28] No space left on device` BEFORE printing anything, and the
# empty-output starvation rule below classified that as TRANSIENT — the retries tripped
# the breaker → exit 75 → a false `parked:model_quota`. Matching infra first stops that.
rl_is_infra() {
    local lc
    lc=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
    case "$lc" in
        *"errno 28"*|*"no space left on device"*|*enospc*|*"disk quota exceeded"*|\
        *"read-only file system"*) return 0 ;;
    esac
    return 1
}

# ─── Per-hunt rate-limit events (AC9) ──────────────────────────
# rl_record_event <model> <kind> → append {"ts","family","kind"} to $WOLFPACK_RL_EVENTS_FILE
# (podman-vibe.sh derives it as <worktree>/.wolfpack/plans/<slug>/rate-limits.jsonl).
# kind ∈ 429 | transient | breaker_open. Unset file ⇒ no-op. Telemetry: a write failure
# NEVER changes the caller's exit code (always returns 0, safe under set -e).
rl_record_event() {
    local model="$1" kind="$2" f="${WOLFPACK_RL_EVENTS_FILE:-}" fd
    [ -n "$f" ] || return 0
    {
        exec {fd}>>"$f" || return 0
        if flock -w 2 "$fd" 2>/dev/null; then
            printf '{"ts":%s,"family":"%s","kind":"%s"}\n' "$(rl_now)" "$model" "$kind" >&"$fd"
        fi
        exec {fd}>&-
    } 2>/dev/null || true
    return 0
}

# rl_event_kind_for "<text>" → "429" when the transient text is a throttle, else "transient".
rl_event_kind_for() {
    local lc
    lc=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
    case "$lc" in
        *"429"*|*"too many requests"*|*"rate limit"*|*"rate-limit"*) printf '429' ;;
        *) printf 'transient' ;;
    esac
}

# ─── Transient classifier (retry-only allowlist) ───────────────
# Usage: rl_is_transient "<combined stderr/stdout text>" <exit_code> <stdout_empty:0|1>
# Returns 0 (TRANSIENT — retry) / 1 (PERMANENT — do NOT retry).
#
# Order matters: a PERMANENT signal wins even if the text also contains a transient-ish
# word, so an auth failure is never retried into the window. Unknown errors default to
# PERMANENT (conservative: retrying an unclassified error just wastes the window) —
# EXCEPT the empty-output case, which is the starvation signal (B1: --output text emits
# nothing when the turn cap is hit mid-review) and IS retried.
rl_is_transient() {
    local text="$1" rc="${2:-1}" empty="${3:-0}"
    local lc
    lc=$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')

    # PERMANENT — never retry (auth, bad request, missing file, unknown tool).
    case "$lc" in
        *"not authenticated"*|*unauthorized*|*"401"*|*"403"*|*forbidden*|\
        *"invalid prompt"*|*"no prompt provided"*|*"unknown tool"*|\
        *"no such file"*|*"not found"*|*"permission denied"*|*"invalid api key"*|\
        *"authentication"*) return 1 ;;
    esac

    # TRANSIENT — retry (network / throttle / overload / quota / timeout). Includes
    # Gemini's quota dialect ("resource has been exhausted", "quota", "RESOURCE_EXHAUSTED")
    # alongside Mistral's 429/disconnect — both are "model is napping," not broken.
    case "$lc" in
        *"server disconnected"*|*"network error"*|*"rate limit"*|*"rate-limit"*|\
        *"429"*|*"500"*|*"502"*|*"503"*|*"504"*|*"overloaded"*|*"timed out"*|\
        *timeout*|*"connection reset"*|*econnreset*|*"temporarily unavailable"*|\
        *"too many requests"*|*quota*|*exhausted*|*"resource_exhausted"*) return 0 ;;
    esac

    # Empty stdout with a non-zero exit = starvation / silent drop → transient.
    [ "$empty" = "1" ] && [ "$rc" != "0" ] && return 0

    return 1
}

# ─── Circuit-breaker state ─────────────────────────────────────
# rl_on_cooldown <model> → 0 if the model is currently cooling down (circuit open),
# else 1. Cleans up an expired cooldown file as a side effect.
rl_on_cooldown() {
    local model="$1" f now exp
    f="$(rl_state_dir)/${model}.cooldown"
    [ -f "$f" ] || return 1
    now=$(rl_now); exp=$(cat "$f" 2>/dev/null || echo 0)
    if [ "${exp:-0}" -gt "$now" ] 2>/dev/null; then
        return 0
    fi
    rm -f "$f"          # expired — circuit closes
    return 1
}

# rl_cooldown_remaining <model> → seconds left on the cooldown (0 if none).
rl_cooldown_remaining() {
    local model="$1" f now exp
    f="$(rl_state_dir)/${model}.cooldown"
    [ -f "$f" ] || { echo 0; return; }
    now=$(rl_now); exp=$(cat "$f" 2>/dev/null || echo 0)
    if [ "${exp:-0}" -gt "$now" ] 2>/dev/null; then echo $((exp - now)); else echo 0; fi
}

# rl_set_cooldown <model> [seconds] → open the circuit for `seconds` (default COOLDOWN).
rl_set_cooldown() {
    local model="$1" secs="${2:-$WOLFPACK_COOLDOWN}" f
    f="$(rl_state_dir)/${model}.cooldown"
    echo $(( $(rl_now) + secs )) > "$f"
    echo "WOLFPACK_RATE_LIMITED:${model} cooldown=${secs}s" >&2
}

# rl_record_failure <model> → log a transient failure (epoch line, pruned to the
# window) and trip the breaker if the in-window count reached the threshold. Returns 0
# if the breaker TRIPPED on this failure (circuit now open), else 1.
rl_record_failure() {
    local model="$1" f lock now cutoff count fd
    f="$(rl_state_dir)/${model}.fails"
    lock="${f}.lock"
    now=$(rl_now); cutoff=$(( now - WOLFPACK_CB_WINDOW ))
    # Serialize the append+prune+count read-modify-write: concurrent shims (SEM_MAX=2)
    # would otherwise race on the rewrite and drop each other's freshly-appended failures,
    # tripping the breaker LATE. flock holds for just this critical section.
    count=0
    exec {fd}>"$lock"
    if flock -w 5 "$fd"; then
        echo "$now" >> "$f"
        local tmp; tmp=$(mktemp "${f}.XXXXXX")
        awk -v c="$cutoff" '$1 >= c' "$f" > "$tmp" 2>/dev/null && mv "$tmp" "$f" || rm -f "$tmp"
        count=$(wc -l < "$f" 2>/dev/null | tr -d ' ')
    else
        # Couldn't get the lock in time — append unguarded rather than lose the signal.
        echo "$now" >> "$f"
        count=$(awk -v c="$cutoff" '$1 >= c' "$f" 2>/dev/null | wc -l | tr -d ' ')
    fi
    exec {fd}>&-
    if [ "${count:-0}" -ge "$WOLFPACK_CB_FAILS" ]; then
        rl_set_cooldown "$model"
        rl_record_event "$model" breaker_open
        return 0
    fi
    return 1
}

# rl_degraded <model> → 0 if there is ANY recent in-window failure (so the shim should
# drop concurrency to 1), else 1. Softer than rl_on_cooldown (which fast-exits).
rl_degraded() {
    local model="$1" f now cutoff count
    f="$(rl_state_dir)/${model}.fails"
    [ -f "$f" ] || return 1
    now=$(rl_now); cutoff=$(( now - WOLFPACK_CB_WINDOW ))
    count=$(awk -v c="$cutoff" '$1 >= c' "$f" 2>/dev/null | wc -l | tr -d ' ')
    [ "${count:-0}" -gt 0 ]
}

# rl_reset <model> → clear all breaker state on a clean success (circuit closes).
rl_reset() {
    local model="$1" d
    d="$(rl_state_dir)"
    rm -f "${d}/${model}.fails" "${d}/${model}.cooldown"
}

# ─── retry_with_backoff <model> <cmd...> ───────────────────────
# Runs <cmd...>, passing its stdout THROUGH to our stdout on success (the review output
# the orchestrator captures). On a TRANSIENT failure: record it (may trip the breaker),
# sleep with exponential backoff + jitter, retry up to MAX_RETRIES. On a PERMANENT
# failure: surface stderr and return immediately (no retry). Returns the last command's
# exit code (0 on success).
retry_with_backoff() {
    local model="$1"; shift
    local attempt=0 delay="$WOLFPACK_RETRY_DELAY" rc empty jitter sleep_time
    # RL_LAST_TRANSIENT=1 after a return caused by exhausting retries on TRANSIENT failures
    # (429/disconnect/timeout) without tripping the breaker. Callers that want a clean
    # rate-limit signal (the GLM paths in podman-vibe.sh) turn that into exit 75 + the
    # WOLFPACK_RATE_LIMITED sentinel; existing callers ignore it (behaviour unchanged).
    RL_LAST_TRANSIENT=0
    local outf errf
    outf=$(mktemp "${TMPDIR:-/tmp}/wolfpack-rl.out.XXXXXX")
    errf=$(mktemp "${TMPDIR:-/tmp}/wolfpack-rl.err.XXXXXX")
    [ "$delay" -lt 1 ] 2>/dev/null && delay=1

    while :; do
        # Capture rc from the command DIRECTLY. Two traps avoided:
        #  - Do NOT wrap in `if "$@"; then`: after a false `if … fi` with no else, `$?`
        #    is 0 (the if "succeeds"), masking the real failure code.
        #  - Use `&& rc=0 || rc=$?` (not a bare `"$@"; rc=$?`): the shim sources this lib
        #    under `set -e`, where a bare failing command exits the script before `rc=$?`
        #    runs. The `||` makes it a tolerated compound.
        rc=0
        "$@" >"$outf" 2>"$errf" || rc=$?
        if [ "$rc" -eq 0 ]; then
            cat "$outf"
            rl_reset "$model"
            rm -f "$outf" "$errf"
            return 0
        fi
        # Caller-declared NO-RETRY exit codes (e.g. the GLM shim's timeout rc 124/137): not a
        # transient, not a breaker event — surface immediately with the raw rc. Unset for
        # every existing caller, so their behaviour is unchanged.
        case " ${RL_NO_RETRY_RC:-} " in
            *" $rc "*)
                cat "$outf"; cat "$errf" >&2
                rm -f "$outf" "$errf"
                return "$rc" ;;
        esac
        empty=0; [ -s "$outf" ] || empty=1
        local text; text="$(cat "$errf" "$outf" 2>/dev/null)"

        # INFRA (AC10) — checked BEFORE permanent/transient: the shim's sandbox broke (e.g.
        # the log tmpfs filled). No retry, no rl_record_failure, no cooldown — the breaker
        # is untouched, so this can never become a false model_quota.
        if rl_is_infra "$text"; then
            cat "$outf"; cat "$errf" >&2
            echo "WOLFPACK_INFRA_ERROR:${model} $(printf '%s' "$text" | { grep -ioE "errno 28|no space left on device|enospc|disk quota exceeded|read-only file system" || echo infra; } | head -n1) — sandbox/host fault, not a rate limit" >&2
            rm -f "$outf" "$errf"
            return "$RL_EXIT_INFRA"
        fi

        if ! rl_is_transient "$text" "$rc" "$empty"; then
            # Permanent — surface and bail, no retry (don't waste the window).
            cat "$outf"; cat "$errf" >&2
            rm -f "$outf" "$errf"
            return "$rc"
        fi

        # Transient: record (may trip the breaker). If the breaker tripped, stop
        # retrying THIS model now — the orchestrator should fall over to the other one.
        rl_record_event "$model" "$(rl_event_kind_for "$text")"
        if rl_record_failure "$model"; then
            cat "$outf"; cat "$errf" >&2
            echo "wolfpack: ${model} circuit OPEN (≥${WOLFPACK_CB_FAILS} fails/${WOLFPACK_CB_WINDOW}s) — stop retrying, fail over" >&2
            rm -f "$outf" "$errf"
            return "$RL_EXIT_COOLDOWN"
        fi

        attempt=$((attempt+1))
        if [ "$attempt" -ge "$WOLFPACK_MAX_RETRIES" ]; then
            cat "$outf"; cat "$errf" >&2
            echo "wolfpack: ${model} exhausted ${WOLFPACK_MAX_RETRIES} attempt(s) (transient)" >&2
            rm -f "$outf" "$errf"
            RL_LAST_TRANSIENT=1
            return "$rc"
        fi

        jitter=$(( RANDOM % delay ))
        sleep_time=$(( delay + jitter ))
        echo "wolfpack: ${model} transient failure (rc=${rc}), retry ${attempt}/${WOLFPACK_MAX_RETRIES} in ${sleep_time}s..." >&2
        sleep "$sleep_time"
        delay=$(( delay * 2 )); [ "$delay" -gt "$WOLFPACK_MAX_DELAY" ] && delay="$WOLFPACK_MAX_DELAY"
    done
}

# rl_guard_or_exit <model> → call BEFORE dispatching to <model>. If the model's circuit
# is open (cooling down), print the sentinel and exit RL_EXIT_COOLDOWN so the
# orchestrator skips straight to the fallback instead of waiting on a known-throttled
# endpoint. No-op (returns) if the model is available.
rl_guard_or_exit() {
    local model="$1" remain
    if rl_on_cooldown "$model"; then
        remain=$(rl_cooldown_remaining "$model")
        echo "WOLFPACK_RATE_LIMITED:${model} cooling down (${remain}s left) — skipping dispatch, use fallback" >&2
        rl_record_event "$model" breaker_open
        exit "$RL_EXIT_COOLDOWN"
    fi
}

# ─── rl_vibe_family <agent-name> → the Vibe-routed model family ─────
# podman-vibe.sh fronts TWO model families on the same Mistral API account: Mistral
# itself and GLM (zai-glm-5-3, alias glm-5.3). Each family needs its OWN rate-limit /
# circuit-breaker key and semaphore dir, so a throttled GLM never trips Mistral's
# breaker (or vice versa). Resolution: WOLFPACK_VIBE_FAMILY (explicit) wins; else an
# agent name containing "glm" (wolfpack-pointer-glm, review-glm53, …) → glm; else
# mistral (the historical default — byte-compatible for every existing agent).
# Prints the family; returns 1 (and prints nothing) on an unknown explicit family.
rl_vibe_family() {
    local agent="${1:-}" fam
    fam=$(printf '%s' "${WOLFPACK_VIBE_FAMILY:-}" | tr '[:upper:]' '[:lower:]')
    if [ -z "$fam" ]; then
        case "$(printf '%s' "$agent" | tr '[:upper:]' '[:lower:]')" in
            *glm*) fam=glm ;;
            *)     fam=mistral ;;
        esac
    fi
    case "$fam" in
        glm|mistral) printf '%s' "$fam" ;;
        *) echo "wolfpack: unknown WOLFPACK_VIBE_FAMILY '${fam}' (expected glm|mistral)" >&2; return 1 ;;
    esac
}
