#!/usr/bin/env bash
# wolfpack-sync-runtime.sh — regenerate a consuming project's RUNTIME copy of the
# reference orchestrator from wolfpack canonical.
#
# WHY THIS EXISTS
#   The reference workflow `hunt-pipeline.js` lives canonically in this repo at
#   .agents/workflows/. A consuming project (e.g. PawPIMS) runs hunts from its OWN
#   copy under .claude/workflows/. The ONLY legitimate difference between the two is
#   a deterministic path-namespace swap: canonical uses `.agents/worktrees` and
#   `.agents/skills`; the consumer uses `.claude/worktrees` and `.claude/skills`.
#   (Verified 2026-06-26: after that swap the two files are identical modulo a
#   provenance comment.) Hand-maintaining two copies let them DRIFT (~47 line-groups,
#   a real hazard). This script makes the consumer copy a GENERATED artifact so the
#   drift class is impossible: edit canonical, run this, done.
#
# USAGE
#   scripts/wolfpack-sync-runtime.sh [TARGET_FILE] [--check]
#     TARGET_FILE  consumer runtime copy to (re)generate
#                  default: $HOME/Projects/pawpims/.claude/workflows/hunt-pipeline.js
#     --check      dry-run: print the diff that WOULD be applied; write nothing.
#                  Exit 0 = already in sync, 1 = drift, 2 = error.
#
# The transform is the single source of truth for the namespace mapping. If a future
# consumer uses a different namespace, parameterize SRC_NS/DST_NS rather than forking.

set -euo pipefail

SRC_NS='.agents'
DST_NS='.claude'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANONICAL="$REPO_ROOT/.agents/workflows/hunt-pipeline.js"

TARGET="${1:-$HOME/Projects/pawpims/.claude/workflows/hunt-pipeline.js}"
CHECK=0
[ "${1:-}" = "--check" ] && { CHECK=1; TARGET="$HOME/Projects/pawpims/.claude/workflows/hunt-pipeline.js"; }
[ "${2:-}" = "--check" ] && CHECK=1

[ -f "$CANONICAL" ] || { echo "ERROR: canonical not found: $CANONICAL" >&2; exit 2; }
# TARGET may legitimately NOT exist yet — a fresh clone, or after the runtime copy was
# gitignored/removed. We CREATE it in that case (this is exactly the fresh-clone bootstrap
# the README points people at), so do NOT hard-fail on a missing target here.

# The deterministic namespace swap (worktrees + skills). This is the ENTIRE legitimate
# difference between canonical and a consumer runtime copy.
generate() {
  sed -E "s#${SRC_NS}/(worktrees|skills)#${DST_NS}/\1#g" "$CANONICAL"
}

GENERATED="$(generate)"

# Safety: the harness requires the script to BEGIN with `export const meta` — never let a
# bad transform ship a file that won't load.
case "$GENERATED" in
  "export const meta"*) : ;;
  *) echo "ERROR: generated output does not start with 'export const meta' — refusing to write." >&2; exit 2 ;;
esac

if [ "$CHECK" = "1" ]; then
  if [ ! -f "$TARGET" ]; then
    echo "DRIFT — $TARGET does not exist yet; run without --check to generate it."
    exit 1
  fi
  if diff -q <(printf '%s' "$GENERATED") "$TARGET" >/dev/null; then
    echo "in sync: $TARGET"
    exit 0
  fi
  echo "DRIFT — $TARGET differs from generate($CANONICAL):"
  diff <(printf '%s\n' "$GENERATED") "$TARGET" || true
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
printf '%s\n' "$GENERATED" > "$TARGET"
echo "synced: $TARGET  ←  generate($CANONICAL)  [${SRC_NS}→${DST_NS}]"
