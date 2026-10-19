#!/usr/bin/env bash
# Tests for scripts/lib/wolfpack-ratelimit.sh — run: bash scripts/lib/wolfpack-ratelimit.test.sh
# No network, no podman: exercises the pure-ish helpers against an isolated TMPDIR.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Isolate ALL state (cooldown/fail touch-files, retry temp files) under a scratch dir.
export TMPDIR
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# shellcheck source=/dev/null
source "${HERE}/wolfpack-ratelimit.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
no()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else no "$3 (want '$2' got '$1')"; fi; }

# ─── rl_is_transient ───────────────────────────────────────────
rl_is_transient "Server disconnected without sending a response" 1 0 && r=0 || r=1
check "$r" 0 "Server disconnected → transient"
rl_is_transient "HTTP 429 Too Many Requests" 1 0 && r=0 || r=1
check "$r" 0 "429 → transient"
rl_is_transient "upstream returned 503" 1 0 && r=0 || r=1
check "$r" 0 "503 → transient"
rl_is_transient "request timed out after 300s" 124 0 && r=0 || r=1
check "$r" 0 "timeout → transient"
rl_is_transient "Resource has been exhausted (e.g. check quota)" 1 0 && r=0 || r=1
check "$r" 0 "Gemini quota/exhausted → transient"
rl_is_transient "429 RESOURCE_EXHAUSTED" 1 0 && r=0 || r=1
check "$r" 0 "RESOURCE_EXHAUSTED → transient"
rl_is_transient "" 1 1 && r=0 || r=1
check "$r" 0 "empty stdout + nonzero exit → transient (starvation)"
rl_is_transient "Error: not authenticated (401)" 1 0 && r=0 || r=1
check "$r" 1 "auth 401 → permanent"
rl_is_transient "Error: No prompt provided for programmatic mode" 1 0 && r=0 || r=1
check "$r" 1 "no prompt → permanent"
rl_is_transient "Unknown tool: read,grep" 1 0 && r=0 || r=1
check "$r" 1 "unknown tool → permanent"
rl_is_transient "some weird unclassified blip" 1 0 && r=0 || r=1
check "$r" 1 "unknown error (non-empty) → permanent (conservative)"
# Permanent wins even when a transient-ish word co-occurs.
rl_is_transient "401 unauthorized: rate limit note" 1 0 && r=0 || r=1
check "$r" 1 "auth+rate-limit text → permanent wins"

# ─── cooldown lifecycle ────────────────────────────────────────
rl_on_cooldown mistral && r=0 || r=1
check "$r" 1 "fresh model not on cooldown"
rl_set_cooldown mistral 100 2>/dev/null
rl_on_cooldown mistral && r=0 || r=1
check "$r" 0 "after set_cooldown → on cooldown"
rem=$(rl_cooldown_remaining mistral)
[ "$rem" -gt 0 ] && [ "$rem" -le 100 ] && r=0 || r=1
check "$r" 0 "cooldown remaining within (0,100]"
# Expired cooldown auto-clears.
echo $(( $(date +%s) - 5 )) > "$(rl_state_dir)/gemini.cooldown"
rl_on_cooldown gemini && r=0 || r=1
check "$r" 1 "expired cooldown → not on cooldown (auto-cleared)"
[ -f "$(rl_state_dir)/gemini.cooldown" ] && r=0 || r=1
check "$r" 1 "expired cooldown file removed"

# ─── circuit breaker: trips at threshold ───────────────────────
export WOLFPACK_CB_FAILS=3 WOLFPACK_CB_WINDOW=600
rl_reset vibe-cb
rl_record_failure vibe-cb && r=0 || r=1; check "$r" 1 "fail 1/3 → not tripped"
rl_record_failure vibe-cb && r=0 || r=1; check "$r" 1 "fail 2/3 → not tripped"
rl_record_failure vibe-cb 2>/dev/null && r=0 || r=1; check "$r" 0 "fail 3/3 → breaker trips"
rl_on_cooldown vibe-cb && r=0 || r=1; check "$r" 0 "tripped breaker set cooldown"
rl_reset vibe-cb
rl_on_cooldown vibe-cb && r=0 || r=1; check "$r" 1 "rl_reset clears cooldown"
[ -f "$(rl_state_dir)/vibe-cb.fails" ] && r=0 || r=1; check "$r" 1 "rl_reset clears fails"

# Old failures outside the window do NOT count toward the trip.
rl_reset win-test
sd=$(rl_state_dir)
echo $(( $(date +%s) - 5000 )) > "$sd/win-test.fails"   # ancient, out of window
rl_record_failure win-test && r=0 || r=1
check "$r" 1 "ancient failure pruned → single fresh fail doesn't trip"

# ─── rl_degraded ───────────────────────────────────────────────
rl_reset deg
rl_degraded deg && r=0 || r=1; check "$r" 1 "no failures → not degraded"
rl_record_failure deg >/dev/null 2>&1
rl_degraded deg && r=0 || r=1; check "$r" 0 "one recent failure → degraded"

# ─── retry_with_backoff: success passes stdout through ─────────
export WOLFPACK_MAX_RETRIES=3 WOLFPACK_RETRY_DELAY=1
emit_ok() { echo "REVIEW OUTPUT OK"; return 0; }
out=$(retry_with_backoff rb-ok emit_ok 2>/dev/null)
check "$out" "REVIEW OUTPUT OK" "retry_with_backoff passes stdout through on success"

# Permanent failure: returns immediately, no retry (count attempts via a marker file).
CNT="$TMPDIR/cnt"; echo 0 > "$CNT"
emit_perm() { echo $(( $(cat "$CNT") + 1 )) > "$CNT"; echo "Error: not authenticated" >&2; return 1; }
rl_reset rb-perm
retry_with_backoff rb-perm emit_perm >/dev/null 2>&1; r=$?
check "$(cat "$CNT")" 1 "permanent failure → called exactly once (no retry)"
[ "$r" != 0 ] && r2=nonzero || r2=zero
check "$r2" nonzero "permanent failure → nonzero return"

# Transient failure that recovers: retries then succeeds.
echo 0 > "$CNT"
emit_flaky() {
  local n; n=$(( $(cat "$CNT") + 1 )); echo "$n" > "$CNT"
  if [ "$n" -lt 2 ]; then echo "Server disconnected" >&2; return 1; fi
  echo "RECOVERED"; return 0
}
rl_reset rb-flaky
export WOLFPACK_RETRY_DELAY=1 WOLFPACK_MAX_DELAY=1
out=$(retry_with_backoff rb-flaky emit_flaky 2>/dev/null)
check "$out" "RECOVERED" "transient-then-recover → eventual success output"
check "$(cat "$CNT")" 2 "transient-then-recover → called twice"

# Transient that trips the breaker mid-retry returns the cooldown exit code.
export WOLFPACK_CB_FAILS=2 WOLFPACK_CB_WINDOW=600 WOLFPACK_MAX_RETRIES=5
echo 0 > "$CNT"
emit_down() { echo $(( $(cat "$CNT") + 1 )) > "$CNT"; echo "Network error" >&2; return 1; }
rl_reset rb-down
retry_with_backoff rb-down emit_down >/dev/null 2>&1; r=$?
check "$r" 75 "breaker trip mid-retry → exit 75 (RL_EXIT_COOLDOWN)"

# ─── Per-family keys (GLM vs Mistral share one Mistral API account, NOT one breaker) ───
check "$(rl_vibe_family wolfpack-pointer)" mistral "legacy agent → mistral family (byte-compatible default)"
check "$(rl_vibe_family wolfpack-pointer-glm)" glm "agent suffix -glm → glm family"
check "$(rl_vibe_family review-glm53)" glm "agent containing glm → glm family"
check "$(rl_vibe_family wolfpack-shepherd-GLM)" glm "agent family match is case-insensitive"
check "$(WOLFPACK_VIBE_FAMILY=glm rl_vibe_family wolfpack-pointer)" glm "WOLFPACK_VIBE_FAMILY=glm wins over agent name"
check "$(WOLFPACK_VIBE_FAMILY=mistral rl_vibe_family wolfpack-pointer-glm)" mistral "WOLFPACK_VIBE_FAMILY=mistral wins over agent name"
WOLFPACK_VIBE_FAMILY=gemini rl_vibe_family x >/dev/null 2>&1 && r=0 || r=1
check "$r" 1 "unknown explicit family → error (fail loud)"

rl_reset glm; rl_reset mistral
rl_set_cooldown glm 100 2>/dev/null
rl_on_cooldown glm && r=0 || r=1
check "$r" 0 "glm cooldown set → glm on cooldown"
rl_on_cooldown mistral && r=0 || r=1
check "$r" 1 "glm cooldown does NOT cool mistral (separate breaker keys)"
[ -f "$(rl_state_dir)/glm.cooldown" ] && [ ! -f "$(rl_state_dir)/mistral.cooldown" ] && r=0 || r=1
check "$r" 0 "cooldown touch-files are per family (glm.cooldown only)"
( rl_guard_or_exit glm ) 2>"$TMPDIR/guard.err"; r=$?
check "$r" 75 "rl_guard_or_exit glm while cooling → exit 75"
grep -q '^WOLFPACK_RATE_LIMITED:glm' "$TMPDIR/guard.err" && r=0 || r=1
check "$r" 0 "guard prints WOLFPACK_RATE_LIMITED:glm sentinel"
( rl_guard_or_exit mistral ) 2>/dev/null; r=$?
check "$r" 0 "rl_guard_or_exit mistral unaffected by the glm cooldown"
rl_reset glm

# RL_LAST_TRANSIENT: set only when retries were exhausted on TRANSIENT failures.
export WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=2
emit_429() { echo "HTTP 429 Too Many Requests" >&2; return 1; }
rl_reset rb-429
retry_with_backoff rb-429 emit_429 >/dev/null 2>&1; r=$?
check "$r" 1 "transient exhaustion → the command's rc (unchanged contract)"
check "${RL_LAST_TRANSIENT:-unset}" 1 "transient exhaustion → RL_LAST_TRANSIENT=1"
emit_auth() { echo "Error: not authenticated (401)" >&2; return 1; }
retry_with_backoff rb-auth emit_auth >/dev/null 2>&1
check "${RL_LAST_TRANSIENT:-unset}" 0 "permanent failure → RL_LAST_TRANSIENT=0"
emit_ok() { echo fine; }
retry_with_backoff rb-ok emit_ok >/dev/null 2>&1
check "${RL_LAST_TRANSIENT:-unset}" 0 "success → RL_LAST_TRANSIENT=0"

# RL_NO_RETRY_RC: caller-declared exit codes surface immediately — no retry, no breaker.
export WOLFPACK_CB_FAILS=1 WOLFPACK_MAX_RETRIES=5
echo 0 > "$CNT"
emit_timeout() { echo $(( $(cat "$CNT") + 1 )) > "$CNT"; return 124; }
rl_reset rb-to
RL_NO_RETRY_RC="124 137" retry_with_backoff rb-to emit_timeout >/dev/null 2>&1; r=$?
check "$r" 124 "RL_NO_RETRY_RC → raw rc surfaced"
check "$(cat "$CNT")" 1 "RL_NO_RETRY_RC → not retried"
rl_on_cooldown rb-to && r=0 || r=1
check "$r" 1 "RL_NO_RETRY_RC → breaker NOT tripped"
echo 0 > "$CNT"
retry_with_backoff rb-to2 emit_timeout >/dev/null 2>&1; r=$?
check "$r" 75 "without RL_NO_RETRY_RC a 124 stays transient (unchanged: breaker at CB_FAILS=1)"

# ─── usage-limit-gate AC10: infra (ENOSPC) is NOT a rate limit ──────────────
check "$RL_EXIT_INFRA" 77 "RL_EXIT_INFRA = 77 (distinct from 75 cooldown / 76 timeout)"
for t in "OSError: [Errno 28] No space left on device" "NO SPACE LEFT ON DEVICE" "write failed: ENOSPC" \
         "Disk quota exceeded" "OSError: [Errno 30] Read-only file system"; do
  rl_is_infra "$t" && r=0 || r=1
  check "$r" 0 "rl_is_infra: '$t' → infra"
done
for t in "HTTP 429 Too Many Requests" "" "Server disconnected" "space left on the page"; do
  rl_is_infra "$t" && r=0 || r=1
  check "$r" 1 "rl_is_infra: '$t' → not infra"
done
# The root cause the hunt fixes: with EMPTY stdout the starvation rule calls ENOSPC transient.
rl_is_transient "OSError: [Errno 28] No space left on device" 1 1 && r=0 || r=1
check "$r" 0 "(root cause) rl_is_transient alone still calls empty-stdout ENOSPC transient — infra must be checked first"

export WOLFPACK_CB_FAILS=2 WOLFPACK_CB_WINDOW=600 WOLFPACK_MAX_RETRIES=2 WOLFPACK_RETRY_DELAY=1 WOLFPACK_MAX_DELAY=1
EVF="$TMPDIR/events.jsonl"
# [Errno 28] on stderr, EMPTY stdout, rc 1 (Vibe crashes before printing anything).
echo 0 > "$CNT"
emit_enospc() { echo $(( $(cat "$CNT") + 1 )) > "$CNT"; echo "OSError: [Errno 28] No space left on device: '/tmp/x/.vibe/logs/vibe.log'" >&2; return 1; }
rl_reset rb-enospc
WOLFPACK_RL_EVENTS_FILE="$EVF" retry_with_backoff rb-enospc emit_enospc >"$TMPDIR/en.out" 2>"$TMPDIR/en.err"; r=$?
check "$r" 77 "ENOSPC (empty stdout, rc 1) → exit 77"
check "$(cat "$CNT")" 1 "ENOSPC → called exactly once (no retry)"
grep -q '^WOLFPACK_INFRA_ERROR:rb-enospc ' "$TMPDIR/en.err" && r=0 || r=1
check "$r" 0 "ENOSPC → WOLFPACK_INFRA_ERROR:<model> sentinel on stderr"
grep -q 'Errno 28' "$TMPDIR/en.err" && r=0 || r=1
check "$r" 0 "ENOSPC → the original stderr is surfaced too"
grep -q 'WOLFPACK_RATE_LIMITED' "$TMPDIR/en.err" && r=0 || r=1
check "$r" 1 "ENOSPC → never prints the rate-limit sentinel"
[ ! -e "$(rl_state_dir)/rb-enospc.fails" ] && [ ! -e "$(rl_state_dir)/rb-enospc.cooldown" ] && r=0 || r=1
check "$r" 0 "ENOSPC → no <model>.fails / .cooldown files (breaker untouched)"
check "${RL_LAST_TRANSIENT:-unset}" 0 "ENOSPC → RL_LAST_TRANSIENT=0 (never folded into exit 75 by the GLM path)"
[ ! -s "$EVF" ] && r=0 || r=1
check "$r" 0 "ENOSPC → no rate-limit event recorded (not a 429/transient)"
ls "$TMPDIR"/wolfpack-rl.* >/dev/null 2>&1 && r=1 || r=0
check "$r" 0 "ENOSPC → retry temp files cleaned up"

# Same fixture with NON-EMPTY stdout → still 77.
echo 0 > "$CNT"
emit_enospc_out() { echo $(( $(cat "$CNT") + 1 )) > "$CNT"; echo "partial review output"; echo "OSError: [Errno 28] No space left on device" >&2; return 1; }
rl_reset rb-enospc2
retry_with_backoff rb-enospc2 emit_enospc_out >"$TMPDIR/en2.out" 2>"$TMPDIR/en2.err"; r=$?
check "$r" 77 "ENOSPC with non-empty stdout → exit 77"
check "$(cat "$CNT")" 1 "ENOSPC with non-empty stdout → no retry"
grep -q 'partial review output' "$TMPDIR/en2.out" && r=0 || r=1
check "$r" 0 "ENOSPC with non-empty stdout → stdout passed through"
[ ! -e "$(rl_state_dir)/rb-enospc2.fails" ] && r=0 || r=1
check "$r" 0 "ENOSPC with non-empty stdout → breaker untouched"

# Many consecutive ENOSPC failures never trip the breaker (the old false model_quota path).
for i in 1 2 3 4; do retry_with_backoff rb-enospc3 emit_enospc >/dev/null 2>&1; done
rl_on_cooldown rb-enospc3 && r=0 || r=1
check "$r" 1 "4× ENOSPC at CB_FAILS=2 → breaker never trips"

# Infra beats a co-occurring rate-limit word (infra is checked FIRST).
emit_mixed() { echo "429 Too Many Requests; then OSError: [Errno 28] No space left on device" >&2; return 1; }
rl_reset rb-mixed
retry_with_backoff rb-mixed emit_mixed >/dev/null 2>&1; r=$?
check "$r" 77 "429 + ENOSPC text → infra wins (77)"

# A plain 429 is still transient: retried, recorded, breaker trips as before.
echo 0 > "$CNT"
emit_429c() { echo $(( $(cat "$CNT") + 1 )) > "$CNT"; echo "HTTP 429 Too Many Requests" >&2; return 1; }
rl_reset rb-429b
retry_with_backoff rb-429b emit_429c >/dev/null 2>&1; r=$?
check "$r" 75 "plain 429 at CB_FAILS=2 → breaker trips → exit 75 (unchanged)"
check "$(cat "$CNT")" 2 "plain 429 → retried until the breaker trips"
rl_on_cooldown rb-429b && r=0 || r=1
check "$r" 0 "plain 429 → cooldown set (unchanged)"
rl_reset rb-429b

# ─── usage-limit-gate AC9: per-hunt rate-limit events ─────────────────────────
check "$(rl_event_kind_for 'HTTP 429')" 429 "event kind: 429"
check "$(rl_event_kind_for 'Too Many Requests')" 429 "event kind: too many requests → 429"
check "$(rl_event_kind_for 'Rate limit reached')" 429 "event kind: rate limit → 429"
check "$(rl_event_kind_for 'rate-limited by upstream')" 429 "event kind: rate-limit → 429"
check "$(rl_event_kind_for 'Server disconnected')" transient "event kind: other transient → transient"

export WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=3
EV2="$TMPDIR/events2.jsonl"; rm -f "$EV2"
echo 0 > "$CNT"
emit_2x429_then_blip() {
  local n; n=$(( $(cat "$CNT") + 1 )); echo "$n" > "$CNT"
  if [ "$n" -le 2 ]; then echo "HTTP 429 Too Many Requests" >&2; else echo "Server disconnected" >&2; fi
  return 1
}
rl_reset rb-ev
WOLFPACK_RL_EVENTS_FILE="$EV2" retry_with_backoff glm emit_2x429_then_blip >/dev/null 2>&1
check "$(wc -l < "$EV2" | tr -d ' ')" 3 "events: two 429s + one other transient → 3 jsonl lines"
check "$(grep -c '"kind":"429"' "$EV2")" 2 "events: two lines with kind 429"
check "$(grep -c '"kind":"transient"' "$EV2")" 1 "events: one line with kind transient"
check "$(grep -c '"family":"glm"' "$EV2")" 3 "events: family recorded"
ok_json=1
while IFS= read -r line; do
  printf '%s' "$line" | grep -Eq '^\{"ts":[0-9]+,"family":"[a-z0-9-]+","kind":"(429|transient|breaker_open)"\}$' || ok_json=0
done < "$EV2"
check "$ok_json" 1 "events: every line is the documented {ts,family,kind} shape"
rl_reset glm

# Unset events file → no file created.
unset WOLFPACK_RL_EVENTS_FILE
EV3="$TMPDIR/should-not-exist.jsonl"
echo 0 > "$CNT"
retry_with_backoff rb-ev3 emit_2x429_then_blip >/dev/null 2>&1
[ ! -e "$EV3" ] && [ -z "$(ls "$TMPDIR"/*.jsonl 2>/dev/null | grep -v events)" ] && r=0 || r=1
check "$r" 0 "events: WOLFPACK_RL_EVENTS_FILE unset → no file created"

# Breaker trip and the guard fast-exit both record breaker_open.
export WOLFPACK_CB_FAILS=1 WOLFPACK_MAX_RETRIES=3
EV4="$TMPDIR/events4.jsonl"; rm -f "$EV4"
rl_reset mistral
WOLFPACK_RL_EVENTS_FILE="$EV4" retry_with_backoff mistral emit_429c >/dev/null 2>&1; r=$?
check "$r" 75 "breaker trip → 75"
check "$(grep -c '"kind":"breaker_open"' "$EV4")" 1 "breaker trip → one breaker_open event"
check "$(grep -c '"kind":"429"' "$EV4")" 1 "breaker trip → the triggering 429 recorded first"
( WOLFPACK_RL_EVENTS_FILE="$EV4" rl_guard_or_exit mistral ) 2>/dev/null; r=$?
check "$r" 75 "guard fast-exit while cooling → 75"
check "$(grep -c '"kind":"breaker_open"' "$EV4")" 2 "guard fast-exit → another breaker_open event"
rl_reset mistral

# An unwritable events file never changes the exit code.
mkdir -p "$TMPDIR/evdir"
rl_record_event glm 429; r=$?
check "$r" 0 "rl_record_event with no file configured → 0"
WOLFPACK_RL_EVENTS_FILE="$TMPDIR/evdir" rl_record_event glm 429; r=$?
check "$r" 0 "rl_record_event to an unwritable path (a dir) → still 0"
WOLFPACK_RL_EVENTS_FILE="$TMPDIR/no/such/dir/ev.jsonl" rl_record_event glm 429; r=$?
check "$r" 0 "rl_record_event to a missing dir → still 0"
emit_ok2() { echo fine; }
WOLFPACK_RL_EVENTS_FILE="$TMPDIR/evdir" retry_with_backoff rb-okev emit_ok2 >/dev/null 2>&1; r=$?
check "$r" 0 "success with an unwritable events file → 0"
( set -e; WOLFPACK_RL_EVENTS_FILE="$TMPDIR/evdir" rl_record_event glm 429; echo survived ) > "$TMPDIR/sete.out" 2>/dev/null
check "$(cat "$TMPDIR/sete.out")" survived "rl_record_event is safe under set -e"

echo
echo "──────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
