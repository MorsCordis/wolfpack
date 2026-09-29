#!/usr/bin/env bash
# Agent-harness Stop hook — enforces verbatim Wolfpack finishing messages.
#
# When a Wolfpack phase command (/alpha, /bloodhound, /shepherd, /watchdog,
# /debrief, /merge, /hunt, /expedition) completes, the final assistant
# message MUST end with a "Next:" handoff line. Agents frequently drop the
# line when they focus on substantive work — this hook catches that and
# emits stderr back into the session so the agent re-emits the block.
#
# Fires on Stop. Exit 2 -> stderr fed back as system message. Exit 0 allows
# the stop to proceed.
set -euo pipefail

# Hook input is JSON on stdin with transcript_path + session_id.
INPUT="$(cat)"
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)

[[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 0

# Only run in Wolfpack context — either inside a worktree or a repo with
# a .wolfpack/ dir. Skip otherwise so non-Wolfpack projects aren't nagged.
CWD="$(pwd)"
if [[ "$CWD" != *".agents/worktrees/"* ]] && [[ ! -d ".wolfpack" ]]; then
    exit 0
fi

# Grab the last assistant message's text content. Assistant turns have
# type=assistant; message.content is an array of blocks, some of which
# are {type:"text", text:"..."}. Walk the transcript from the end to
# find the most recent assistant turn and concatenate its text blocks.
# One streaming jq pass over the transcript tail. The previous `tac | while … break`
# loop died with SIGPIPE (exit 141) under `set -o pipefail` once transcripts grew past a
# pipe buffer, surfacing as a "Stop hook error" every turn; it also spawned two jq
# processes per line. `fromjson?` skips a partially-written final line instead of failing.
LAST_TEXT=$(tail -n 4000 "$TRANSCRIPT" | jq -nrR '
    [inputs | fromjson? | select(type == "object" and .type == "assistant")] | last
    | if . == null then "" else
        (.message.content | if type == "array" then map(select(.type == "text") | .text) | join("\n") else (. // "") end)
      end' 2>/dev/null || true)

[[ -z "$LAST_TEXT" ]] && exit 0

# Only inspect the tail — real completion blocks live at the end of the
# message. This also avoids false positives when the agent quoted a
# finishing-message template mid-response (as in code review).
TAIL=$(tail -n 25 <<<"$LAST_TEXT")

# Phase-completion signatures. If any match in the tail, a Next: line must
# also appear there.
SIGNATURES='^(✓ Plan written|✓ Revised plan|✓ Review round|✓ Shepherd phase|✓ PASS|✗ REWORK|✗ FLAWED_PLAN|✓ Debrief ready|✓ Merged and pushed|✓ Hunt scaffolded|✓ Campaign scouted|✓ Smoke cycle complete|✓ Smoke tests: all pass)'

if grep -qE "$SIGNATURES" <<<"$TAIL"; then
    if ! grep -qE '^Next:' <<<"$TAIL"; then
        cat >&2 <<'MSG'
⚠ Wolfpack handoff check: phase-completion marker detected but the `Next:`
line is missing from the tail of your response.

Re-emit the command's full "Finishing message" block VERBATIM. That block
is the user's copy-paste handoff — dropping `/clear` / `/model` / the next
`/<command>` forces them to reconstruct the cadence from memory.

Open the command file (`.agents/commands/<name>.md`), copy the block under
"## Finishing message" exactly, and resend it as a plain text message.
MSG
        exit 2
    fi
fi

exit 0
