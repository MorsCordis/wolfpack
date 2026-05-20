#!/usr/bin/env bash
# SessionStart hook: clears spin detector state from previous sessions.
# Prevents stale counters from false-triggering in a new session.

set -euo pipefail

STATE_FILE="${CLAUDE_PROJECT_DIR:-.}/.claude/state/spin.json"

if [[ -f "$STATE_FILE" ]]; then
    rm "$STATE_FILE" && echo "reset-spin-state: cleared spin detector state" >&2 || {
        echo "reset-spin-state: failed to clear $STATE_FILE" >&2
        exit 1
    }
fi

exit 0
