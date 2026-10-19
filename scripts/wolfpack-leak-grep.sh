#!/usr/bin/env bash
# scripts/wolfpack-leak-grep.sh — public-repo leak guard. Fails on any TRACKED regular file
# that names a consuming project, the operator's domain/org, or a home-directory path.
#
# Usage: bash scripts/wolfpack-leak-grep.sh [<repo-root>]   (default: this script's repo)
#
# Campaign pattern: pawpims\.(dev|vet)|pawprints-|/home/[a-z]+|logcabincoding   # leak-grep:allow
# plus case-insensitive bare pawpims (which subsumes the dev/vet domains). Scanned with   # leak-grep:allow
# grep -IiE, so binaries are skipped; symlinks (mode 120000) are skipped too.
#
# Allow-list: scripts/wolfpack-leak-allowlist.txt — `#` comments and blank lines ignored;
# entries are <path><TAB><justification> (justification REQUIRED). A hit is permitted ONLY
# when its path is allow-listed AND the hit line carries the inline marker leak-grep:allow.
# An allow-listed path that is untracked or has zero marked hits is STALE (fails), so the
# list stays honest.
#
# Exit: 0 clean · 1 leak(s) or stale allow-list entry · 2 not a git repo / malformed allow-list.
set -uo pipefail

PATTERN='pawpims|pawprints-|/home/[a-z]+|logcabincoding'   # leak-grep:allow
MARKER='leak-grep:allow'

if [ "$#" -gt 1 ]; then
  echo "usage: bash scripts/wolfpack-leak-grep.sh [<repo-root>]" >&2
  exit 2
fi
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "✗ leak grep: $ROOT is not a git work tree" >&2
  exit 2
fi
ROOT="$(git -C "$ROOT" rev-parse --show-toplevel)"
ALLOW_FILE="$ROOT/scripts/wolfpack-leak-allowlist.txt"

declare -A ALLOWED=()     # path -> justification
declare -A MARKED=()      # path -> count of marked hits
if [ -f "$ALLOW_FILE" ]; then
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    path="${line%%$'\t'*}"
    just="${line#*$'\t'}"
    if [ "$path" = "$line" ] || [[ "$just" =~ ^[[:space:]]*$ ]] || [ -z "$path" ]; then
      echo "✗ leak grep: malformed allow-list entry at $ALLOW_FILE:$n — expected <path><TAB><justification> with a non-blank justification" >&2
      exit 2
    fi
    ALLOWED["$path"]="$just"
    MARKED["$path"]=0
  done < "$ALLOW_FILE"
fi

declare -A TRACKED=()
leaks=0
declare -A LEAK_FILES=()
allowed_hits=0

while IFS= read -r -d '' f; do
  TRACKED["$f"]=1
  abs="$ROOT/$f"
  [ -L "$abs" ] && continue
  [ -f "$abs" ] || continue
  hits=$(grep -nIiE -- "$PATTERN" "$abs" 2>/dev/null) || continue
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    if [ -n "${ALLOWED[$f]+x}" ] && [[ "$hit" == *"$MARKER"* ]]; then
      MARKED["$f"]=$(( ${MARKED[$f]} + 1 ))
      allowed_hits=$((allowed_hits + 1))
    else
      echo "LEAK $f:$hit"
      leaks=$((leaks + 1))
      LEAK_FILES["$f"]=1
    fi
  done <<< "$hits"
done < <(git -C "$ROOT" ls-files -z)

stale=0
for p in "${!ALLOWED[@]}"; do
  if [ -z "${TRACKED[$p]+x}" ] || [ "${MARKED[$p]}" -eq 0 ]; then
    echo "✗ stale allow-list entry: $p" >&2
    stale=$((stale + 1))
  fi
done

if [ "$leaks" -gt 0 ]; then
  echo "✗ leak grep: $leaks leak(s) in ${#LEAK_FILES[@]} file(s)" >&2
fi
if [ "$leaks" -gt 0 ] || [ "$stale" -gt 0 ]; then
  exit 1
fi
echo "✓ leak grep: clean ($allowed_hits allow-listed)"
exit 0
