#!/usr/bin/env bash
# PreToolUse hook: detects pathological agent loops.
# Tracks repeated Bash commands and file operations per session.
# State lives in .claude/state/spin.json (gitignored, cleared on SessionStart).
#
# When an agent gets stuck, it often repeats the same command or re-reads
# the same file in a loop. This hook catches that pattern early and halts
# the tool call before the agent burns through its context window.

set -euo pipefail

# Escape hatch for debugging the detector itself
[[ "${CLAUDE_SPIN_DETECTOR_DISABLE:-0}" == "1" ]] && exit 0

STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/state"
STATE_FILE="$STATE_DIR/spin.json"
INPUT="${TOOL_INPUT:-}"

[[ -z "$INPUT" ]] && exit 0

# Extract the key: command string (Bash) or file path (Edit/Write/Read)
KEY=$(echo "$INPUT" | jq -r '.command // .file_path // empty' 2>/dev/null || true)
[[ -z "$KEY" ]] && exit 0

# Bash commands have a lower repeat threshold (3) than file operations (5)
if echo "$INPUT" | jq -e '.command' >/dev/null 2>&1; then
    THRESHOLD=3
else
    THRESHOLD=5
fi

# Initialize state if missing
if [[ ! -f "$STATE_FILE" ]]; then
    mkdir -p "$STATE_DIR"
    echo '{}' > "$STATE_FILE"
fi

# Read state; if corrupt, log and reset (do NOT block on corrupt state)
STATE=$(jq '.' "$STATE_FILE" 2>/dev/null) || {
    echo "spin-detector: corrupt state file, resetting" >&2
    echo '{}' > "$STATE_FILE"
    STATE='{}'
}

# Get current count for this key
COUNT=$(echo "$STATE" | jq -r --arg key "$KEY" '.[$key] // 0' 2>/dev/null || echo 0)
COUNT=$((COUNT + 1))

# Check threshold — halt if exceeded
if [[ $COUNT -ge $THRESHOLD ]]; then
    echo "spin-detector: SPIN DETECTED — same operation repeated $COUNT times (threshold: $THRESHOLD)" >&2
    echo "spin-detector: key: ${KEY:0:120}" >&2
    exit 1
fi

# Update state
echo "$STATE" | jq --arg key "$KEY" --argjson count "$COUNT" '.[$key] = $count' > "$STATE_FILE" 2>/dev/null || {
    echo "spin-detector: failed to update state, continuing" >&2
}

exit 0
