#!/usr/bin/env bash
# Tests for scripts/wolfpack-finishing-check.sh — run: bash scripts/wolfpack-finishing-check.test.sh
# The Stop hook must enforce the `Next:` handoff line in BOTH harness worktree layouts
# (.agents/worktrees/<x> and .claude/worktrees/<x>) and in a repo with a .wolfpack/ dir, and
# stay silent everywhere else. Fixture transcripts are JSONL like the harness writes.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOOK="${HERE}/wolfpack-finishing-check.sh"

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
SCRATCH=$(realpath "$SCRATCH")

PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "ok   - $1"; }
no()    { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else no "$3 (want '$2' got '$1')"; fi; }

command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required by the hook"; exit 1; }

# transcript <file> <last assistant text>
transcript() {
  jq -cn --arg t "earlier" '{type:"assistant", message:{content:[{type:"text", text:$t}]}}' > "$1"
  jq -cn '{type:"user", message:{content:"go"}}' >> "$1"
  jq -cn --arg t "$2" '{type:"assistant", message:{content:[{type:"text", text:$t}]}}' >> "$1"
}
NO_NEXT=$'Done planning.\n\n✓ Plan written: .wolfpack/plans/x/plan.md\n  Tier: Yellow'
WITH_NEXT=$'Done planning.\n\n✓ Plan written: .wolfpack/plans/x/plan.md\n  Tier: Yellow\n\nNext: /clear → /bloodhound x'
transcript "$SCRATCH/no-next.jsonl" "$NO_NEXT"
transcript "$SCRATCH/with-next.jsonl" "$WITH_NEXT"
transcript "$SCRATCH/plain.jsonl" "Just a normal answer, no phase marker."

# hook <cwd> <transcript>: run the hook from <cwd> with the harness's stdin JSON.
hook() { ( cd "$1" && jq -cn --arg p "$2" '{transcript_path:$p, session_id:"s"}' | bash "$HOOK" >/dev/null 2>"$SCRATCH/err" ); }

mkdir -p "$SCRATCH/repo/.claude/worktrees/x" "$SCRATCH/repo/.agents/worktrees/x" "$SCRATCH/plain" "$SCRATCH/wp/.wolfpack" "$SCRATCH/repo/.claude/worktrees-not/x"
for layout in .claude/worktrees .agents/worktrees; do
  d="$SCRATCH/repo/$layout/x"
  [ -d "$d/.wolfpack" ] && no "fixture: $layout has a .wolfpack dir" || ok "fixture: $layout/x has no .wolfpack dir (the path alone must trigger)"
  hook "$d" "$SCRATCH/no-next.jsonl"; rc=$?
  check "$rc" 2 "$layout/x: phase marker without Next: → exit 2 (blocks the stop)"
  grep -q "Next:" "$SCRATCH/err" && ok "$layout/x: stderr explains the missing Next: line" || no "$layout/x: stderr ($(cat "$SCRATCH/err"))"
  hook "$d" "$SCRATCH/with-next.jsonl"; rc=$?
  check "$rc" 0 "$layout/x: with a Next: line → exit 0"
  hook "$d" "$SCRATCH/plain.jsonl"; rc=$?
  check "$rc" 0 "$layout/x: no phase marker → exit 0"
done
hook "$SCRATCH/wp" "$SCRATCH/no-next.jsonl"; rc=$?
check "$rc" 2 "a repo with .wolfpack/: phase marker without Next: → exit 2"
hook "$SCRATCH/plain" "$SCRATCH/no-next.jsonl"; rc=$?
check "$rc" 0 "a plain dir (no worktree layout, no .wolfpack) → exit 0 (never nags)"
hook "$SCRATCH/repo/.claude/worktrees-not/x" "$SCRATCH/no-next.jsonl"; rc=$?
check "$rc" 0 "a look-alike path (.claude/worktrees-not/) → exit 0"
hook "$SCRATCH/repo/.claude/worktrees/x" "$SCRATCH/absent.jsonl"; rc=$?
check "$rc" 0 "a missing transcript → exit 0"
( cd "$SCRATCH/repo/.claude/worktrees/x" && echo '{}' | bash "$HOOK" >/dev/null 2>&1 ); rc=$?
check "$rc" 0 "'{}' on stdin (no transcript_path) → exit 0"

echo
echo "──────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
