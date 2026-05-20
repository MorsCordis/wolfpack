#!/usr/bin/env bash
# PreToolUse hook for Edit/Write: blocks source-file edits when on the main branch.
# Prevents agents from accidentally committing fixes directly to main instead of
# a feature or fix branch. Allowlisted paths pass through.
#
# CUSTOMIZE: Edit the allowlist (case blocks) and source-file extensions to match
# your project. The defaults cover common web/backend projects.

set -u

file=$(echo "$TOOL_INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[[ -z "$file" ]] && exit 0

branch=$(git branch --show-current 2>/dev/null)
[[ "$branch" != "main" && "$branch" != "master" ]] && exit 0

# Allowlist: non-source files that are legitimately edited on main
case "$file" in
  */CLAUDE.md|*/AGENTS.md|*/TODO.md|*/CHANGELOG.md|*/README.md)  exit 0 ;;
  */.claude/*)           exit 0 ;;
  */.wolfpack/*)         exit 0 ;;
  */docs/*)              exit 0 ;;
  */.gitignore)          exit 0 ;;
  */.claudeignore)       exit 0 ;;
  */scripts/*)           exit 0 ;;
esac

# Block source files — add/remove extensions for your stack
case "$file" in
  *.py|*.js|*.ts|*.jsx|*.tsx|*.html|*.css|*.scss|*.json|*.go|*.rs|*.rb|*.java|*.kt|*.swift)
    echo "BLOCKED: Editing source file on main branch. Create a branch first (git checkout -b fix/<name>)." >&2
    echo "  File: $file" >&2
    exit 1
    ;;
esac

exit 0
