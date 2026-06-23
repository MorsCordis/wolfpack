#!/usr/bin/env bash
# scripts/wolfpack-overnight.sh — [05] limits layer, Part A (A2/A3) host driver.
#
# The loop wrapper that turns the rate-limit GATE (wolfpack-window-gate.mjs) into a
# reset-aware overnight batch. It does what the workflow JS structurally cannot (read
# the clock, sleep, decide between launches — AC5):
#
#   loop:
#     1. ask the gate "is there enough agent rate-limit window to start the next segment?"
#     2. DEFER  → don't launch. Either sleep until the window frees (reset_at) and
#                 retry — the A3 self-resume: a batch that exhausts the 5h window at
#                 01:00 picks back up ~when it resets — or, with --exit-on-defer, print
#                 reset_at and exit 10 so a systemd timer / cron re-runs us then.
#     3. PROCEED → launch one campaign segment (run-pipeline-sandbox.sh --campaign),
#                 which itself runs a wave and stops at the wave barrier (campaign-runner
#                 owns the per-hunt budget breaker, AC1). Inspect the verdict:
#                   - CAMPAIGN_COMPLETE                → done.
#                   - WAVE_* (awaiting release/human/  → needs a human (merge/smoke/
#                     failed) / PAUSED_BUDGET            resolve/new budget) → stop, report.
#                   - launch crashed (nonzero)         → loop: the NEXT gate check defers
#                                                        if a rate-limit caused it, so a
#                                                        mid-run window exhaustion resumes
#                                                        past reset on the next cycle.
#
# SCOPE / HONEST LIMIT: the gate is checked BETWEEN launches, never mid-pipeline (halting
# mid-Shepherd leaves a half-built worktree; the wave barrier is the clean boundary). For
# FINER between-hunt gating, run smaller segments so each launch re-checks the gate. A
# window exhausted DEEP inside one campaign run is caught on the NEXT cycle (the failed
# run returns, the gate now reads the drained window and defers to reset).
#
# ── How A3's ScheduleWakeup maps here ──
# When the agent harness itself is the driver (a /loop or a scheduled agent rather than this
# bash script), the same decision flows through ScheduleWakeup instead of `sleep`: read
# the gate's reset_at, set ScheduleWakeup delaySeconds = (reset_at - now). This script is
# the host-side equivalent for cron/systemd/terminal runs; `sleep` is its ScheduleWakeup.
#
# Usage:
#   ./scripts/wolfpack-overnight.sh --campaign <slug> [max-parallel]
# Options (env):
#   WOLFPACK_AGENT_WINDOW_LIMIT    REQUIRED to enable gating (else the gate proceeds with
#                                  a loud warning — see wolfpack-window-gate.mjs).
#   WOLFPACK_WINDOW_HEADROOM_PCT   reserve % (default 15, passed through to the gate).
#   WOLFPACK_OVERNIGHT_MAX_CYCLES  loop guard (default 12).
#   WOLFPACK_OVERNIGHT_MAX_SLEEP   cap a single defer sleep, seconds (default 21600 = 6h).
#   WOLFPACK_OVERNIGHT_EXIT_ON_DEFER=1  print reset_at and exit 10 instead of sleeping
#                                  (for systemd-timer / cron re-entry).
#   WOLFPACK_OVERNIGHT_FAIL_BACKOFF  seconds to wait after a crashed launch (default 60).
set -uo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")
GATE="${REPO_ROOT}/scripts/wolfpack-window-gate.mjs"
SANDBOX="${REPO_ROOT}/scripts/run-pipeline-sandbox.sh"

MAX_CYCLES="${WOLFPACK_OVERNIGHT_MAX_CYCLES:-12}"
MAX_SLEEP="${WOLFPACK_OVERNIGHT_MAX_SLEEP:-21600}"
FAIL_BACKOFF="${WOLFPACK_OVERNIGHT_FAIL_BACKOFF:-60}"
EXIT_ON_DEFER="${WOLFPACK_OVERNIGHT_EXIT_ON_DEFER:-0}"

# ─── Parse mode ────────────────────────────────────────────────
MODE="${1:-}"
if [ "$MODE" != "--campaign" ]; then
    echo "Usage: $0 --campaign <slug> [max-parallel]" >&2
    exit 2
fi
SLUG="${2:?Usage: $0 --campaign <slug> [max-parallel]}"
MAX_PARALLEL="${3:-2}"

log() { echo "[overnight $(date -Iseconds)] $*" >&2; }

# Extract a JSON string field from the gate's --json output without a JSON parser
# dependency (the gate already emitted compact JSON). Field values here are simple.
json_field() { # json_field <key> <<<"$json"
    sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"
}
json_field_raw() { # unquoted value (numbers, words): json_field_raw <key>
    sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p"
}

# Seconds to sleep until an ISO8601 reset_at (plus a small buffer), clamped to
# [0, MAX_SLEEP]. Uses `date -d` (the host clock — this is a host script, not the
# workflow JS).
sleep_until() { # sleep_until <iso8601>
    local iso="$1" target now secs
    target=$(date -d "$iso" +%s 2>/dev/null || echo "")
    if [ -z "$target" ]; then
        log "could not parse reset_at '$iso' — using FAIL_BACKOFF ${FAIL_BACKOFF}s"
        secs="$FAIL_BACKOFF"
    else
        now=$(date +%s)
        secs=$(( target - now + 30 ))   # +30s buffer so we resume just AFTER reset
        [ "$secs" -lt 0 ] && secs=0
        [ "$secs" -gt "$MAX_SLEEP" ] && { log "defer ${secs}s exceeds cap — clamping to ${MAX_SLEEP}s"; secs="$MAX_SLEEP"; }
    fi
    log "deferring ${secs}s (until ~${iso}) for the agent window to free"
    sleep "$secs"
}

# ─── The loop ──────────────────────────────────────────────────
cycle=0
while [ "$cycle" -lt "$MAX_CYCLES" ]; do
    cycle=$((cycle+1))
    log "cycle ${cycle}/${MAX_CYCLES} — checking the agent window gate"

    GATE_JSON=$(WOLFPACK_WINDOW_HEADROOM_PCT="${WOLFPACK_WINDOW_HEADROOM_PCT:-15}" \
                node "$GATE" --json 2>/dev/null)
    GATE_EXIT=$?
    DECISION=$(printf '%s' "$GATE_JSON" | json_field_raw decision)
    REASON=$(printf '%s' "$GATE_JSON" | json_field reason)
    log "gate: ${DECISION:-?} (exit ${GATE_EXIT}) — ${REASON:-no reason}"

    if [ "$DECISION" = "defer" ]; then
        RESET_AT=$(printf '%s' "$GATE_JSON" | json_field reset_at)
        if [ "$EXIT_ON_DEFER" = "1" ]; then
            log "EXIT_ON_DEFER set — resume after ${RESET_AT}. Re-run this script then (cron/systemd)."
            echo "$GATE_JSON"
            exit 10
        fi
        sleep_until "$RESET_AT"
        continue
    fi

    if [ "$DECISION" != "proceed" ]; then
        log "gate returned neither proceed nor defer — failing closed, stopping. Raw: ${GATE_JSON}"
        exit 1
    fi

    # PROCEED — launch one campaign segment (runs a wave, stops at the barrier).
    log "launching campaign segment: ${SLUG} (max-parallel ${MAX_PARALLEL})"
    RUN_OUT=$("$SANDBOX" --campaign "$SLUG" "$MAX_PARALLEL" 2>&1)
    RUN_EXIT=$?
    printf '%s\n' "$RUN_OUT"

    if [ "$RUN_EXIT" -ne 0 ]; then
        log "campaign launch exited ${RUN_EXIT} — may be a mid-run rate-limit; backing off ${FAIL_BACKOFF}s then re-gating"
        sleep "$FAIL_BACKOFF"
        continue
    fi

    # Best-effort verdict scrape from the run output (the campaign-runner logs/returns a
    # verdict token).
    if printf '%s' "$RUN_OUT" | grep -q "CAMPAIGN_COMPLETE"; then
        log "CAMPAIGN_COMPLETE — done."
        exit 0
    fi
    # [05] AC3 — WAVE_PAUSED_QUOTA is the ONE verdict we LOOP on rather than stop: both
    # cross-models were rate-limited, the hunt parked model_quota (auto-resumable), and
    # re-running resumes it. Back off first so the shims' per-model cooldown windows
    # expire (and the agent window gate re-checks) before the next attempt.
    if printf '%s' "$RUN_OUT" | grep -q "WAVE_PAUSED_QUOTA"; then
        log "WAVE_PAUSED_QUOTA — cross-models rate-limited; backing off ${FAIL_BACKOFF}s then re-gating to auto-resume."
        sleep "$FAIL_BACKOFF"
        continue
    fi
    # Everything else that needs a human ends the autonomous loop.
    for v in WAVE_PAUSED_BUDGET WAVE_COMPLETE_AWAITING_RELEASE WAVE_PARTIAL_AWAITING_RELEASE WAVE_AWAITING_HUMAN WAVE_FAILED; do
        if printf '%s' "$RUN_OUT" | grep -q "$v"; then
            log "${v} — this segment needs a human (merge/smoke/resolve/new budget). Stopping autonomous loop."
            exit 0
        fi
    done

    log "campaign segment returned no terminal verdict token — stopping to avoid a blind re-launch loop."
    exit 0
done

log "reached MAX_CYCLES (${MAX_CYCLES}) without completing — stopping. Re-run to continue."
exit 0
