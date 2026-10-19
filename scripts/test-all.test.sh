#!/usr/bin/env bash
# scripts/test-all.test.sh — the single test entry point (AC4), exercised against fixture
# trees via WOLFPACK_TEST_ROOT. Each fixture carries a stub scripts/wolfpack-leak-grep.sh
# (exit 0) unless the case is about the leak grep itself. Fixtures never contain this file
# (no recursion). Run: bash scripts/test-all.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ALL="$HERE/test-all.sh"
BASH_BIN="$(type -P bash)"
FAILS=0
ok()   { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# fixture <name> → creates $TMP/<name>/scripts with a passing leak-grep stub; echoes the root
fixture() {
  local root="$TMP/$1"
  mkdir -p "$root/scripts"
  printf '#!/usr/bin/env bash\necho "stub leak grep"\nexit 0\n' > "$root/scripts/wolfpack-leak-grep.sh"
  echo "$root"
}
pass_mjs() { printf "import { test } from 'node:test'\ntest('ok', () => {})\n" > "$1"; }
fail_mjs() { printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('boom', () => assert.equal(1, 2))\n" > "$1"; }
pass_sh()  { printf '#!/usr/bin/env bash\necho fixture-sh-ran\nexit 0\n' > "$1"; }
podman_sh() { printf '#!/usr/bin/env bash\n# wolfpack-test: needs podman\necho podman-test-ran\nexit 0\n' > "$1"; }

# run_ta <root> [env assignments…] — runs test-all.sh against <root>; sets OUT and RC
run_ta() {
  local root="$1"; shift
  OUT="$(env "$@" WOLFPACK_TEST_ROOT="$root" "$BASH_BIN" "$TEST_ALL" 2>&1)"
  RC=$?
}

# A minimal PATH: symlinks to exactly the tools test-all.sh and node need — NO podman.
MINBIN="$TMP/minbin"
mkdir -p "$MINBIN"
for t in bash node git env find sort head grep dirname cat mkdir rm ls sed tr wc; do
  p="$(type -P "$t")" && ln -sf "$p" "$MINBIN/$t"
done

# (a) passing .test.mjs + passing .test.sh → exit 0, both PASS, summary line
R="$(fixture a)"; pass_mjs "$R/scripts/one.test.mjs"; mkdir -p "$R/scripts/sub"; pass_sh "$R/scripts/sub/two.test.sh"
run_ta "$R" WOLFPACK_TEST_NO_PODMAN=1
if [ "$RC" -eq 0 ] && grep -q '^PASS scripts/one.test.mjs$' <<<"$OUT" && grep -q '^PASS scripts/sub/two.test.sh$' <<<"$OUT" \
   && grep -q 'fixture-sh-ran' <<<"$OUT" && grep -q '^PASS scripts/wolfpack-leak-grep.sh$' <<<"$OUT" \
   && grep -q '^test-all: 3 passed, 0 failed, 0 skipped (needs podman)$' <<<"$OUT"; then
  ok "(a) passing node + shell tests (nested dirs discovered) → exit 0"
else
  fail "(a) expected exit 0 with 3 PASS; rc=$RC"; echo "$OUT"
fi

# (b) a planted failing .test.mjs → exit 1, FAIL line, the other test still runs
R="$(fixture b)"; fail_mjs "$R/scripts/bad.test.mjs"; pass_mjs "$R/scripts/good.test.mjs"
run_ta "$R" WOLFPACK_TEST_NO_PODMAN=1
if [ "$RC" -eq 1 ] && grep -q '^FAIL scripts/bad.test.mjs (exit 1)$' <<<"$OUT" && grep -q '^PASS scripts/good.test.mjs$' <<<"$OUT" \
   && grep -q '^  failed: scripts/bad.test.mjs$' <<<"$OUT" && grep -q '^test-all: 2 passed, 1 failed, 0 skipped' <<<"$OUT"; then
  ok "(b) failing test → exit 1, FAIL line, keeps going"
else
  fail "(b) expected exit 1 + FAIL line; rc=$RC"; echo "$OUT"
fi

# a failing .test.sh is a failure too (exit code passes through)
R="$(fixture b2)"; printf '#!/usr/bin/env bash\nexit 3\n' > "$R/scripts/bad.test.sh"
run_ta "$R" WOLFPACK_TEST_NO_PODMAN=1
if [ "$RC" -eq 1 ] && grep -q '^FAIL scripts/bad.test.sh (exit 3)$' <<<"$OUT"; then
  ok "(b2) failing shell test → exit 1 with its exit code named"
else
  fail "(b2) expected FAIL scripts/bad.test.sh (exit 3); rc=$RC"; echo "$OUT"
fi

# (c) marked podman test, PATH without podman → SKIP line, exit 0
R="$(fixture c)"; podman_sh "$R/scripts/pod.test.sh"; pass_mjs "$R/scripts/one.test.mjs"
if PATH="$MINBIN" command -v podman >/dev/null 2>&1; then
  fail "(c) setup: the minimal PATH still resolves podman"
fi
run_ta "$R" PATH="$MINBIN"
if [ "$RC" -eq 0 ] && grep -q '^SKIP: needs podman scripts/pod.test.sh$' <<<"$OUT" && ! grep -q 'podman-test-ran' <<<"$OUT" \
   && grep -q '^test-all: 2 passed, 0 failed, 1 skipped (needs podman)$' <<<"$OUT"; then
  ok "(c) no podman on PATH → SKIP: needs podman, exit 0"
else
  fail "(c) expected SKIP + exit 0; rc=$RC"; echo "$OUT"
fi

# (d) WOLFPACK_TEST_NO_PODMAN=1 with podman AVAILABLE (a fake on PATH) → still SKIP
FAKEBIN="$TMP/fakebin"; mkdir -p "$FAKEBIN"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/podman"; chmod +x "$FAKEBIN/podman"
run_ta "$R" PATH="$FAKEBIN:$PATH" WOLFPACK_TEST_NO_PODMAN=1
if [ "$RC" -eq 0 ] && grep -q '^SKIP: needs podman scripts/pod.test.sh$' <<<"$OUT" && ! grep -q 'podman-test-ran' <<<"$OUT"; then
  ok "(d) WOLFPACK_TEST_NO_PODMAN=1 → SKIP even with podman on PATH"
else
  fail "(d) expected SKIP; rc=$RC"; echo "$OUT"
fi

# (d2) podman present and no opt-out → the marked test RUNS (the marker is not a blanket skip)
run_ta "$R" PATH="$FAKEBIN:$MINBIN" WOLFPACK_TEST_NO_PODMAN=
if [ "$RC" -eq 0 ] && grep -q 'podman-test-ran' <<<"$OUT" && grep -q '^PASS scripts/pod.test.sh$' <<<"$OUT" \
   && grep -q ', 0 skipped (needs podman)$' <<<"$OUT"; then
  ok "(d2) podman on PATH → the marked test runs"
else
  fail "(d2) expected the podman test to run; rc=$RC"; echo "$OUT"
fi

# (d3) the marker only counts in the first 15 lines
R="$(fixture d3)"
{ printf '#!/usr/bin/env bash\n'; for _ in $(seq 1 15); do echo '# filler'; done; echo '# wolfpack-test: needs podman'; echo 'echo late-marker-ran'; } > "$R/scripts/late.test.sh"
run_ta "$R" PATH="$MINBIN"
if [ "$RC" -eq 0 ] && grep -q 'late-marker-ran' <<<"$OUT" && ! grep -q '^SKIP' <<<"$OUT"; then
  ok "(d3) a marker past line 15 is ignored"
else
  fail "(d3) expected the late-marker test to run; rc=$RC"; echo "$OUT"
fi

# (e) an empty tree → exit 1 "no tests discovered"
R="$(fixture e)"
run_ta "$R" WOLFPACK_TEST_NO_PODMAN=1
if [ "$RC" -eq 1 ] && grep -q 'no tests discovered' <<<"$OUT"; then
  ok "(e) empty tree → exit 1, no tests discovered"
else
  fail "(e) expected exit 1 'no tests discovered'; rc=$RC"; echo "$OUT"
fi

# (f) a missing leak grep is a FAIL, never a skip
R="$(fixture f)"; rm -f "$R/scripts/wolfpack-leak-grep.sh"; pass_mjs "$R/scripts/one.test.mjs"
run_ta "$R" WOLFPACK_TEST_NO_PODMAN=1
if [ "$RC" -eq 1 ] && grep -q '✗ leak grep missing' <<<"$OUT" && grep -q '^FAIL scripts/wolfpack-leak-grep.sh (missing)$' <<<"$OUT"; then
  ok "(f) missing leak grep → FAIL, exit 1"
else
  fail "(f) expected missing leak grep FAIL; rc=$RC"; echo "$OUT"
fi

# (f2) a leak grep that finds leaks fails the run
R="$(fixture f2)"; pass_mjs "$R/scripts/one.test.mjs"; printf '#!/usr/bin/env bash\necho "LEAK x"\nexit 1\n' > "$R/scripts/wolfpack-leak-grep.sh"
run_ta "$R" WOLFPACK_TEST_NO_PODMAN=1
if [ "$RC" -eq 1 ] && grep -q '^FAIL scripts/wolfpack-leak-grep.sh (exit 1)$' <<<"$OUT"; then
  ok "(f2) a failing leak grep → exit 1"
else
  fail "(f2) expected leak-grep FAIL; rc=$RC"; echo "$OUT"
fi

# (g) node_modules is pruned from discovery
R="$(fixture g)"; pass_mjs "$R/scripts/one.test.mjs"; mkdir -p "$R/scripts/node_modules/x"; fail_mjs "$R/scripts/node_modules/x/dep.test.mjs"
run_ta "$R" WOLFPACK_TEST_NO_PODMAN=1
if [ "$RC" -eq 0 ] && ! grep -q 'node_modules' <<<"$OUT"; then
  ok "(g) node_modules tests are not discovered"
else
  fail "(g) node_modules leaked into discovery; rc=$RC"; echo "$OUT"
fi

# (h) any argument → usage, exit 2
OUT="$("$BASH_BIN" "$TEST_ALL" --bogus 2>&1)"; RC=$?
if [ "$RC" -eq 2 ] && grep -q '^usage: bash scripts/test-all.sh' <<<"$OUT"; then
  ok "(h) an argument → usage, exit 2"
else
  fail "(h) expected usage exit 2; rc=$RC"; echo "$OUT"
fi

echo
if [ "$FAILS" -gt 0 ]; then echo "test-all.test.sh: $FAILS FAILED"; exit 1; fi
echo "test-all.test.sh: all passed"
