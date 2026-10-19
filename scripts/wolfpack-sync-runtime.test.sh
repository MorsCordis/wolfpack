#!/usr/bin/env bash
# scripts/wolfpack-sync-runtime.test.sh — sync-runtime has NO default target (AC7): with no
# target it prints usage, exits 2 and writes nothing — not even into a decoy consumer copy
# planted at the old default location. Run: bash scripts/wolfpack-sync-runtime.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC="$HERE/wolfpack-sync-runtime.sh"
FAILS=0
ok()   { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A temp HOME with a decoy consumer runtime copy at the OLD default location
# ($HOME/Projects/<consumer>/.claude/workflows/hunt-pipeline.js) — name assembled at runtime.
FAKE_HOME="$TMP/home"
CONSUMER="paw"; CONSUMER+="pims"
DECOY="$FAKE_HOME/Projects/$CONSUMER/.claude/workflows/hunt-pipeline.js"
mkdir -p "$(dirname "$DECOY")"
echo "// decoy — must never be rewritten by a no-target sync" > "$DECOY"
snapshot() { find "$FAKE_HOME" -type f -exec sha1sum {} + | LC_ALL=C sort; find "$FAKE_HOME" | LC_ALL=C sort; }
BEFORE="$(snapshot)"

run_sync() { OUT_STDOUT="$(cd "$TMP" && HOME="$FAKE_HOME" bash "$SYNC" "$@" 2>"$TMP/err")"; RC=$?; OUT_STDERR="$(cat "$TMP/err")"; }

# (a) no args → exit 2, usage on stderr, nothing written anywhere under HOME
run_sync
if [ "$RC" -eq 2 ] && grep -q '^usage: .*<TARGET_FILE> \[--check\]' <<<"$OUT_STDERR" && grep -q 'required (no default)' <<<"$OUT_STDERR" \
   && grep -q 'hunt-pipeline.js' <<<"$OUT_STDERR" && grep -q 'campaign-runner.js' <<<"$OUT_STDERR" \
   && [ -z "$OUT_STDOUT" ] && [ "$(snapshot)" = "$BEFORE" ]; then
  ok "(a) no target → usage (+ canonical workflow list) on stderr, exit 2, HOME untouched"
else
  fail "(a) rc=$RC stdout=[$OUT_STDOUT] stderr=[$OUT_STDERR]"
fi

# (b) --check alone (the old 'check the default' form) → exit 2, nothing written
run_sync --check
if [ "$RC" -eq 2 ] && grep -q '^usage:' <<<"$OUT_STDERR" && [ "$(snapshot)" = "$BEFORE" ]; then
  ok "(b) --check alone → usage, exit 2, nothing written"
else
  fail "(b) rc=$RC stderr=[$OUT_STDERR]"
fi

# (b2) any flag first, an unknown second argument, or three arguments → exit 2, nothing written
T="$TMP/out/.claude/workflows/hunt-pipeline.js"
for args in "-x" "$T --force" "$T --check extra"; do
  # shellcheck disable=SC2086
  run_sync $args
  if [ "$RC" -eq 2 ] && grep -q '^usage:' <<<"$OUT_STDERR" && [ ! -e "$T" ] && [ "$(snapshot)" = "$BEFORE" ]; then
    ok "(b2) '$args' → usage, exit 2, nothing written"
  else
    fail "(b2) '$args' rc=$RC stderr=[$OUT_STDERR]"
  fi
done

# (c) an explicit, not-yet-existing target → generated with the namespace swap
run_sync "$T"
if [ "$RC" -eq 0 ] && [ -f "$T" ] && head -c 17 "$T" | grep -q '^export const meta' \
   && grep -q '\.claude/worktrees' "$T" && ! grep -q '\.agents/worktrees' "$T" && ! grep -q '\.agents/skills' "$T" \
   && grep -q '^synced: ' <<<"$OUT_STDOUT"; then
  ok "(c) explicit missing target → generated, starts with export const meta, .agents → .claude"
else
  fail "(c) rc=$RC stdout=[$OUT_STDOUT] stderr=[$OUT_STDERR]"
fi
# the ONLY difference from canonical is the namespace swap
if diff <(sed -E 's#\.agents/(worktrees|skills)#.claude/\1#g' "$HERE/../.agents/workflows/hunt-pipeline.js") "$T" >/dev/null; then
  ok "(c) generated copy = canonical with the namespace swap only"
else
  fail "(c) generated copy differs from canonical beyond the namespace swap"
fi

# (d) explicit target + --check → in sync, exit 0; a hand edit → DRIFT, exit 1, file unchanged
run_sync "$T" --check
if [ "$RC" -eq 0 ] && grep -q "^in sync: $T" <<<"$OUT_STDOUT"; then
  ok "(d) explicit target + --check → in sync, exit 0"
else
  fail "(d) rc=$RC stdout=[$OUT_STDOUT]"
fi
echo "// hand edit" >> "$T"
SUM="$(sha1sum "$T")"
run_sync "$T" --check
if [ "$RC" -eq 1 ] && grep -q '^DRIFT' <<<"$OUT_STDOUT" && [ "$(sha1sum "$T")" = "$SUM" ]; then
  ok "(d) drifted target + --check → DRIFT, exit 1, nothing written"
else
  fail "(d) drift rc=$RC stdout=[$OUT_STDOUT]"
fi
# campaign-runner.js syncs from its own canonical twin (basename-selected)
CR="$TMP/out/.claude/workflows/campaign-runner.js"
run_sync "$CR"
if [ "$RC" -eq 0 ] && grep -q "name: 'campaign-runner'" "$CR"; then
  ok "(d) campaign-runner.js target → generated from canonical campaign-runner.js"
else
  fail "(d) campaign-runner sync rc=$RC stderr=[$OUT_STDERR]"
fi

# (e) a directory target → exit 2 naming the real targets
run_sync "$TMP/out"
if [ "$RC" -eq 2 ] && grep -q 'is a directory' <<<"$OUT_STDERR"; then
  ok "(e) directory target → exit 2"
else
  fail "(e) rc=$RC stderr=[$OUT_STDERR]"
fi

# (f) a target with no canonical twin → exit 2, nothing written
NOTWIN="$TMP/out/.claude/workflows/not-a-workflow.js"
run_sync "$NOTWIN"
if [ "$RC" -eq 2 ] && grep -q 'canonical not found' <<<"$OUT_STDERR" && [ ! -e "$NOTWIN" ]; then
  ok "(f) no canonical twin → exit 2, nothing written"
else
  fail "(f) rc=$RC stderr=[$OUT_STDERR]"
fi

[ "$(snapshot)" = "$BEFORE" ] && ok "decoy at the old default location never touched" || fail "the decoy HOME changed"

echo
if [ "$FAILS" -gt 0 ]; then echo "wolfpack-sync-runtime.test.sh: $FAILS FAILED"; exit 1; fi
echo "wolfpack-sync-runtime.test.sh: all passed"
