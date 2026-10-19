#!/usr/bin/env bash
# scripts/test-all.sh — the ONE test entry point (CI + local + the wolfpack-config.md Test command).
# Runs every scripts/**/*.test.mjs (node --test), every scripts/**/*.test.sh (bash), then the leak grep.
# Podman marker: a test whose first 15 lines contain "wolfpack-test: needs podman" is SKIPPED —
# printed as "SKIP: needs podman <file>" and counted — when podman is not on PATH or
# WOLFPACK_TEST_NO_PODMAN=1. Exit 0 = no failures; 1 = any failure, or no tests discovered; 2 = usage.
# WOLFPACK_TEST_ROOT=<dir> runs against another tree (used by scripts/test-all.test.sh only).
set -uo pipefail

if [ "$#" -gt 0 ]; then
  echo "usage: bash scripts/test-all.sh   (no arguments; WOLFPACK_TEST_NO_PODMAN=1 skips podman tests, WOLFPACK_TEST_ROOT=<dir> runs another tree)" >&2
  exit 2
fi

ROOT="${WOLFPACK_TEST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || { echo "✗ test-all: cannot cd to $ROOT" >&2; exit 1; }

have_podman() {
  [ "${WOLFPACK_TEST_NO_PODMAN:-}" != 1 ] && command -v podman >/dev/null 2>&1
}

needs_podman() {
  head -n 15 "$1" 2>/dev/null | grep -q 'wolfpack-test: needs podman'
}

discover() {
  # $1 = name glob. Sorted, node_modules pruned.
  find scripts -name node_modules -prune -o -type f -name "$1" -print 2>/dev/null | LC_ALL=C sort
}

mapfile -t MJS < <(discover '*.test.mjs')
mapfile -t SH < <(discover '*.test.sh')

if [ "${#MJS[@]}" -eq 0 ] && [ "${#SH[@]}" -eq 0 ]; then
  echo "✗ test-all: no tests discovered under $ROOT/scripts" >&2
  exit 1
fi

passed=0
failed=0
skipped=0
FAILED_FILES=()

run_one() {
  local f="$1" rc
  if needs_podman "$f" && ! have_podman; then
    echo "SKIP: needs podman $f"
    skipped=$((skipped + 1))
    return
  fi
  echo "── $f"
  case "$f" in
    *.test.mjs) node --test "$f" ;;
    *.test.sh)  bash "$f" ;;
  esac
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "PASS $f"
    passed=$((passed + 1))
  else
    echo "FAIL $f (exit $rc)"
    failed=$((failed + 1))
    FAILED_FILES+=("$f")
  fi
}

for f in "${MJS[@]}" "${SH[@]}"; do
  [ -n "$f" ] && run_one "$f"
done

LEAK=scripts/wolfpack-leak-grep.sh
echo "── leak grep"
if [ ! -f "$LEAK" ]; then
  echo "✗ leak grep missing ($LEAK)" >&2
  echo "FAIL $LEAK (missing)"
  failed=$((failed + 1))
  FAILED_FILES+=("$LEAK")
else
  bash "$LEAK" "$ROOT"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "PASS $LEAK"
    passed=$((passed + 1))
  else
    echo "FAIL $LEAK (exit $rc)"
    failed=$((failed + 1))
    FAILED_FILES+=("$LEAK")
  fi
fi

echo
if [ "$failed" -gt 0 ]; then
  for f in "${FAILED_FILES[@]}"; do echo "  failed: $f"; done
fi
echo "test-all: $passed passed, $failed failed, $skipped skipped (needs podman)"
[ "$failed" -eq 0 ] || exit 1
exit 0
