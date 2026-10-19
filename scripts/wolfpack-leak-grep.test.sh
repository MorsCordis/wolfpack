#!/usr/bin/env bash
# scripts/wolfpack-leak-grep.test.sh — the public-repo leak guard (AC5).
# Copies this repo's TRACKED tree into a temp git repo and plants leaks there. Every leak
# string is assembled at runtime, so this file itself never matches the pattern.
# Run: bash scripts/wolfpack-leak-grep.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
LEAK_GREP="$HERE/wolfpack-leak-grep.sh"
FAILS=0
ok()   { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Runtime-assembled leak strings (never literal in this file).
P1="paw"; P1+="pims"                 # the consuming-project name
DOMAIN="${P1}.dev"
HOMEP="/ho"; HOMEP+="me/someone/x"   # a home-directory path
ORG="logcabin"; ORG+="coding"
PRINTS="pawprints"; PRINTS+="-x"

# copy_tree <name> → a fresh temp git repo holding the tracked files of REPO (index only)
copy_tree() {
  local dst="$TMP/$1"
  mkdir -p "$dst"
  git -C "$dst" init -q
  (cd "$REPO" && git ls-files -z | xargs -0 cp -P --parents -t "$dst" 2>/dev/null)
  (cd "$REPO" && git ls-files -z) | git -C "$dst" add --pathspec-from-file=- --pathspec-file-nul
  echo "$dst"
}
run_lg() { OUT="$(bash "$@" 2>&1)"; RC=$?; }

# (a) the tracked tree, copied → clean
T="$(copy_tree a)"
run_lg "$T/scripts/wolfpack-leak-grep.sh" "$T"
if [ "$RC" -eq 0 ] && grep -q '^✓ leak grep: clean' <<<"$OUT"; then
  ok "(a) copied tracked tree → clean, exit 0"
else
  fail "(a) expected a clean copy; rc=$RC"; echo "$OUT"
fi

# (b) a tracked notes.md with a leak → exit 1, named; same for each pattern alternative
for leak in "$DOMAIN" "$HOMEP" "$ORG" "${P1^^}" "$PRINTS"; do
  T="$(copy_tree "b-$RANDOM")"
  printf 'intro\nsee %s for details\n' "$leak" > "$T/notes.md"
  git -C "$T" add notes.md
  run_lg "$T/scripts/wolfpack-leak-grep.sh" "$T"
  if [ "$RC" -eq 1 ] && grep -q '^LEAK notes.md:2:' <<<"$OUT" && grep -q '✗ leak grep: 1 leak(s) in 1 file(s)' <<<"$OUT"; then
    ok "(b) planted tracked leak (${#leak}-char variant) → exit 1, names notes.md:2"
  else
    fail "(b) expected LEAK notes.md:2 for a planted variant; rc=$RC"; echo "$OUT"
  fi
done

# (b2) an UNTRACKED file is not scanned (tracked files only)
T="$(copy_tree b2)"
printf '%s\n' "$DOMAIN" > "$T/scratch.md"
run_lg "$T/scripts/wolfpack-leak-grep.sh" "$T"
if [ "$RC" -eq 0 ]; then ok "(b2) untracked file ignored"; else fail "(b2) untracked file was scanned; rc=$RC"; echo "$OUT"; fi

# (b3) a tracked SYMLINK whose target text matches is skipped (mode 120000 is not content)
T="$(copy_tree b3)"
ln -s "$HOMEP" "$T/link-out"
git -C "$T" add link-out
run_lg "$T/scripts/wolfpack-leak-grep.sh" "$T"
if [ "$RC" -eq 0 ]; then ok "(b3) tracked symlink skipped"; else fail "(b3) symlink was scanned; rc=$RC"; echo "$OUT"; fi

# (c) an allow-listed path whose hit LACKS the inline marker → still a leak
T="$(copy_tree c)"
printf '# example %s\n' "$DOMAIN" >> "$T/scripts/wolfpack-leak-grep.sh"
git -C "$T" add scripts/wolfpack-leak-grep.sh
run_lg "$T/scripts/wolfpack-leak-grep.sh" "$T"
if [ "$RC" -eq 1 ] && grep -q '^LEAK scripts/wolfpack-leak-grep.sh:' <<<"$OUT"; then
  ok "(c) allow-listed path without the marker on the hit line → exit 1"
else
  fail "(c) expected a LEAK on the unmarked line; rc=$RC"; echo "$OUT"
fi

# (c2) the marker alone is not enough: a marked hit in a NON-allow-listed path is a leak
T="$(copy_tree c2)"
printf 'x %s # leak-grep:allow\n' "$DOMAIN" > "$T/other.md"
git -C "$T" add other.md
run_lg "$T/scripts/wolfpack-leak-grep.sh" "$T"
if [ "$RC" -eq 1 ] && grep -q '^LEAK other.md:1:' <<<"$OUT"; then
  ok "(c2) marker without an allow-list entry → exit 1"
else
  fail "(c2) expected LEAK other.md:1; rc=$RC"; echo "$OUT"
fi

# (d) a STALE allow-list entry (tracked, zero marked hits / not tracked at all) → exit 1
for entry in "README.md" "scripts/no-such-file.sh"; do
  T="$(copy_tree "d-$RANDOM")"
  printf '%s\t%s\n' "$entry" "pretend justification" >> "$T/scripts/wolfpack-leak-allowlist.txt"
  git -C "$T" add scripts/wolfpack-leak-allowlist.txt
  run_lg "$T/scripts/wolfpack-leak-grep.sh" "$T"
  if [ "$RC" -eq 1 ] && grep -q "✗ stale allow-list entry: $entry" <<<"$OUT"; then
    ok "(d) stale allow-list entry $entry → exit 1"
  else
    fail "(d) expected stale entry $entry; rc=$RC"; echo "$OUT"
  fi
done

# (e) an entry with an empty justification, or no TAB at all → malformed, exit 2
for bad in $'scripts/wolfpack-leak-grep.sh\t   ' 'scripts/wolfpack-leak-grep.sh'; do
  T="$(copy_tree "e-$RANDOM")"
  printf '%s\n' "$bad" >> "$T/scripts/wolfpack-leak-allowlist.txt"
  git -C "$T" add scripts/wolfpack-leak-allowlist.txt
  run_lg "$T/scripts/wolfpack-leak-grep.sh" "$T"
  if [ "$RC" -eq 2 ] && grep -q 'malformed allow-list entry' <<<"$OUT"; then
    ok "(e) malformed allow-list entry → exit 2"
  else
    fail "(e) expected malformed exit 2; rc=$RC"; echo "$OUT"
  fi
done

# (f) the real tree, directly → clean
run_lg "$LEAK_GREP"
if [ "$RC" -eq 0 ] && grep -q '^✓ leak grep: clean' <<<"$OUT"; then
  ok "(f) real tree → clean, exit 0"
else
  fail "(f) real tree is not clean; rc=$RC"; echo "$OUT"
fi

# (g) not a git repo / too many args → exit 2
mkdir -p "$TMP/plain"
run_lg "$LEAK_GREP" "$TMP/plain"
if [ "$RC" -eq 2 ] && grep -q 'not a git work tree' <<<"$OUT"; then ok "(g) not a git repo → exit 2"; else fail "(g) expected exit 2; rc=$RC"; echo "$OUT"; fi
run_lg "$LEAK_GREP" a b
if [ "$RC" -eq 2 ] && grep -q '^usage:' <<<"$OUT"; then ok "(g2) two args → usage, exit 2"; else fail "(g2) expected usage; rc=$RC"; echo "$OUT"; fi

echo
if [ "$FAILS" -gt 0 ]; then echo "wolfpack-leak-grep.test.sh: $FAILS FAILED"; exit 1; fi
echo "wolfpack-leak-grep.test.sh: all passed"
