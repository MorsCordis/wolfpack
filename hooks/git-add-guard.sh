#!/usr/bin/env bash
# PreToolUse hook for Bash: blocks `git add .`, `git add -A`, and `git add --all`.
# Agents must stage files by name to avoid accidentally committing secrets,
# build artifacts, or unrelated changes.

set -u

CMD=$(echo "$TOOL_INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[[ -z "$CMD" ]] && exit 0

if echo "$CMD" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+add[[:space:]]+(\.($|[[:space:]])|-A($|[[:space:]])|--all($|[[:space:]]))'; then
    echo "BLOCKED: git add . / -A / --all is forbidden. Stage files by name." >&2
    exit 1
fi

exit 0
