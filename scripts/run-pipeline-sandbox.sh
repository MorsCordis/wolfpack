#!/usr/bin/env bash
# Launch the Wolfpack automated pipeline inside a sandboxed Podman container.
# Both CLIs (Claude Code, Vibe) run in one container with filesystem
# access restricted to explicitly mounted paths.
#
# Usage (from the consuming repo's checkout; the launcher is the PACK's):
#   "$WOLFPACK_HOME/scripts/run-pipeline-sandbox.sh"                      # interactive shell
#   "$WOLFPACK_HOME/scripts/run-pipeline-sandbox.sh" --auto "prompt..."   # Claude auto mode (recommended)
#   "$WOLFPACK_HOME/scripts/run-pipeline-sandbox.sh" claude -p "..."      # run claude directly
#   "$WOLFPACK_HOME/scripts/run-pipeline-sandbox.sh" vibe -p "..."        # run vibe directly
#
# Config: the consuming project's wolfpack-config.md → `## Execution Layer` (Sandbox image,
# Sandbox project layer, Sandbox extra mounts, Secrets paths, Vibe agent dir), read through
# scripts/lib/wolfpack-sandbox.sh (WOLFPACK_CONFIG overrides the path). The pack itself is
# mounted read-only at its host path and exported as WOLFPACK_HOME, so the workflows inside
# the container resolve the pack's seat shim. Every bind source is checked against the
# configured Secrets paths before any image build or run.
#
# --auto mode uses Claude's --permission-mode auto which auto-approves most tools
# but still respects PreToolUse hooks (git push blocked, git add . blocked, prod
# deploy blocked). Safer than --dangerously-skip-permissions.

set -euo pipefail

# The launcher's own pack (this script's ../) — the launcher locating ITSELF, never a
# fallback to the consuming repo. WOLFPACK_HOME, when set, is what the container is told.
PACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_HOME="${WOLFPACK_HOME:-$PACK_DIR}"
case "$PACK_HOME" in
    /*) ;;
    *) echo "✗ run-pipeline-sandbox: WOLFPACK_HOME must be an absolute path (got '$PACK_HOME')" >&2; exit 2 ;;
esac
if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || [ -z "$REPO_ROOT" ]; then
    echo "✗ run-pipeline-sandbox: not inside a git checkout — run from the consuming repo's checkout" >&2
    exit 1
fi
DBUS_SOCKET="${WOLFPACK_DBUS_SOCKET:-/run/user/$(id -u)/bus}"

WP_CALLER="run-pipeline-sandbox"
# shellcheck source=lib/wolfpack-sandbox.sh
source "${PACK_DIR}/scripts/lib/wolfpack-sandbox.sh"
wp_load_exec_config "$REPO_ROOT" || exit 2
IMAGE="$WP_SANDBOX_IMAGE"
if [ ! -d "$WP_VIBE_AGENT_DIR" ]; then
    echo "✗ run-pipeline-sandbox: the configured Vibe agent dir does not exist: ${WP_VIBE_AGENT_DIR} (wolfpack-config.md → Execution Layer → Vibe agent dir)" >&2
    exit 2
fi

# ─── Preflight checks ──────────────────────────────────────────
if [ ! -S "$DBUS_SOCKET" ]; then
    echo "ERROR: D-Bus socket not found at $DBUS_SOCKET" >&2
    echo "GNOME Keyring requires an active desktop session for CLI credential storage." >&2
    exit 1
fi

# (No ADC preflight — the Tracker phase runs the project's local test command against its
# own local database, so no cloud credentials are needed.)

for f in "${HOME}/.vibe/.env" "${HOME}/.vibe/config.toml"; do
    if [ ! -f "$f" ]; then
        echo "ERROR: Required file not found: $f" >&2
        echo "Run 'vibe --setup' on the host first." >&2
        exit 1
    fi
done

if [ ! -f "${HOME}/.claude/.credentials.json" ]; then
    echo "ERROR: Claude credentials not found at ~/.claude/.credentials.json" >&2
    echo "Run 'claude' on the host first to authenticate." >&2
    exit 1
fi

# Claude Code reads its top-level config from ~/.claude.json, which lives OUTSIDE
# the ~/.claude directory. Without it the container's Claude exits immediately with
# "configuration file not found". Mount an ISOLATED COPY (not the live host file) so
# the sandboxed Claude is fully configured but cannot corrupt the host's live config
# while a host session is running concurrently.
if [ ! -f "${HOME}/.claude.json" ]; then
    echo "ERROR: Claude config not found at ~/.claude.json" >&2
    echo "Run 'claude' on the host first to complete onboarding." >&2
    exit 1
fi
CLAUDE_JSON_COPY=$(mktemp -t wolfpack-claude-json.XXXXXX)
cp "${HOME}/.claude.json" "$CLAUDE_JSON_COPY"
trap 'rm -f "$CLAUDE_JSON_COPY"' EXIT

# ─── Shared Claude auto-mode args ──────────────────────────────
CLAUDE_AUTO_ARGS=(
    claude
    --permission-mode auto
    --allowedTools
    "Bash(git *) Bash(./scripts/*) Bash(vibe *) Bash(timeout *) Bash(cat *) Bash(rm -f *) Bash(mkdir *) Bash(cp *) Bash(chmod *) Bash(gcloud auth *) Bash(echo *) Bash(wc *) Bash(grep *) Bash(head *) Bash(tail *) Bash(ls *) Bash(pwd) Bash(sleep *) Read Edit Write Agent Workflow"
    --disallowedTools
    "Bash(curl *) Bash(wget *) Bash(ssh *) Bash(scp *) Bash(rm -rf *)"
)

# ─── Parse mode ────────────────────────────────────────────────
CONTAINER_CMD=("${@:-bash}")
HEADLESS=0   # set to 1 by the headless (claude -p) modes below; gates the auto-monitor

# Allocate a TTY (-t) only for the interactive shell. The --auto/--hunt/--campaign
# modes run headless via `claude -p`, where a TTY triggers podman's "input device is
# not a TTY" warning and can corrupt output with terminal control sequences.
PODMAN_TTY=(-i -t)

case "${1:-}" in
    --auto)
        # Run a single prompt in Claude auto mode
        # Usage: ./scripts/run-pipeline-sandbox.sh --auto "your prompt"
        shift
        CONTAINER_CMD=("${CLAUDE_AUTO_ARGS[@]}" -p "$*")
        PODMAN_TTY=(-i)
        HEADLESS=1
        ;;

    --hunt)
        # Run a single hunt through the pipeline
        # Usage: ./scripts/run-pipeline-sandbox.sh --hunt <slug> "<description>"
        shift
        SLUG="${1:?Usage: --hunt <slug> \"<description>\"}"
        shift
        DESC="$*"
        CONTAINER_CMD=("${CLAUDE_AUTO_ARGS[@]}" -p "Run the hunt-pipeline workflow with args: {\"slug\": \"${SLUG}\", \"description\": \"${DESC}\", \"campaign\": null}")
        PODMAN_TTY=(-i)
        HEADLESS=1
        ;;

    --campaign)
        # Run an entire campaign wave by wave
        # Usage: ./scripts/run-pipeline-sandbox.sh --campaign <slug> [max-parallel]
        # Pipeline pauses between waves for user deploy+smoke+merge.
        # Re-run the same command to resume from where it left off.
        shift
        CAMPAIGN="${1:?Usage: --campaign <slug> [max-parallel]}"
        MAX_PARALLEL="${2:-2}"
        CONTAINER_CMD=("${CLAUDE_AUTO_ARGS[@]}" -p "Run the campaign-runner workflow with args: {\"campaignSlug\": \"${CAMPAIGN}\", \"maxParallel\": ${MAX_PARALLEL}}")
        PODMAN_TTY=(-i)
        HEADLESS=1
        ;;
esac

# ─── Mounts (built once, guarded, then the image) ──────────────
# Sandbox extra mounts (wolfpack-config.md → Execution Layer): always read-only; the host
# path must exist (podman would otherwise create it).
EXTRA_MOUNTS=()
for _m in ${WP_SANDBOX_MOUNTS[@]+"${WP_SANDBOX_MOUNTS[@]}"}; do
    _mh="${_m%%:*}"; _mc="${_m#*:}"
    case "$_mh$_mc" in
        *:*|*$'\n'*)
            echo "✗ run-pipeline-sandbox: Sandbox extra mounts entry contains ':' or a newline: ${_m}" >&2
            exit 2 ;;
    esac
    if [ ! -e "$_mh" ]; then
        echo "✗ run-pipeline-sandbox: Sandbox extra mounts host path does not exist: ${_mh} (wolfpack-config.md → Execution Layer → Sandbox extra mounts)" >&2
        exit 2
    fi
    EXTRA_MOUNTS+=(-v "${_mh}:${_mc}:ro")
done

MOUNT_ARGS=(
    -v "${REPO_ROOT}:/workspace:rw"
    -v "${HOME}/.claude:${HOME}/.claude:rw"
    -v "${CLAUDE_JSON_COPY}:${HOME}/.claude.json:rw"
    -v "${HOME}/.cache/wolfpack:${HOME}/.cache/wolfpack:ro"
    -v "${HOME}/.vibe/.env:${HOME}/.vibe/.env:ro"
    -v "${HOME}/.vibe/config.toml:${HOME}/.vibe/config.toml:ro"
    -v "${WP_VIBE_AGENT_DIR}:${HOME}/.vibe/agents:ro"
    -v "${HOME}/.vibe/prompts:${HOME}/.vibe/prompts:ro"
    # The pack, read-only at its host path: the workflows resolve the seat shim from it.
    -v "${PACK_HOME}:${PACK_HOME}:ro"
    ${EXTRA_MOUNTS[@]+"${EXTRA_MOUNTS[@]}"}
    -v "${DBUS_SOCKET}:${DBUS_SOCKET}"
    -v "${HOME}/.local/share/claude:${HOME}/.local/share/claude:ro"
    -v "${HOME}/.local/bin/claude:${HOME}/.local/bin/claude:ro"
)

# Secrets guard over EVERY bind source, BEFORE any build or run.
_srcs=()
_next=""
for _a in "${MOUNT_ARGS[@]}"; do
    if [ "$_next" = 1 ]; then _srcs+=("${_a%%:*}"); _next=""; continue; fi
    [ "$_a" = "-v" ] && _next=1
done
wp_secrets_guard "Secrets paths" "${_srcs[@]}" || exit 2
wp_ensure_sandbox_image || exit 2

# ─── Container launch ──────────────────────────────────────────
run_container() {
  # usage-limit-gate (AC5 container path): the window gate reads the live Claude usage
  # snapshot the HOST status-line wrapper writes. The container only READS it (ro mount);
  # mkdir so the bind source exists even before the first status-line render.
  mkdir -p "${HOME}/.cache/wolfpack"
  podman run "${PODMAN_TTY[@]}" --rm \
    --name wolfpack-pipeline \
    --userns=keep-id \
    --security-opt label=disable \
    \
    -e "HOME=${HOME}" \
    -e "DBUS_SESSION_BUS_ADDRESS=unix:path=${DBUS_SOCKET}" \
    -e "WOLFPACK_SANDBOX=1" \
    -e "WOLFPACK_HOME=${PACK_HOME}" \
    \
    "${MOUNT_ARGS[@]}" \
    \
    -e "PATH=${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    \
    --network=pasta \
    \
    -w /workspace \
    "$IMAGE" \
    "${CONTAINER_CMD[@]}"
}

# ─── Launch + (headless) auto-monitor ──────────────────────────
if [ "${HEADLESS}" = 1 ] && [ -t 1 ]; then
    # Interactive terminal driving a headless pipeline: own the screen with the
    # live monitor, run the container in the foreground tee'd to a host log, then
    # surface the wave summary. `claude -p` stays silent until exit, so the
    # backgrounded monitor has the terminal to itself during the run. No string
    # to remember — the monitor just appears.
    mkdir -p "${REPO_ROOT}/.wolfpack"
    LOG="${REPO_ROOT}/.wolfpack/run.log"; : > "$LOG"
    PODMAN_TTY=(-i)   # no -t when piping the container's stdout to tee
    printf '\n▶ Pipeline launching — live monitor below. Full transcript: .wolfpack/run.log\n  (Ctrl-C stops the run.)\n\n' >&2
    "${PACK_DIR}/scripts/wolfpack-watch.sh" --loop & MON_PID=$!
    trap 'kill "$MON_PID" 2>/dev/null; rm -f "$CLAUDE_JSON_COPY"' EXIT INT TERM
    run_container 2>&1 | tee "$LOG" || true
    kill "$MON_PID" 2>/dev/null; wait "$MON_PID" 2>/dev/null || true
    printf '\n═══ run complete — wave summary (full log: .wolfpack/run.log) ═══\n'
    tail -n 30 "$LOG"
elif [ "${HEADLESS}" = 1 ]; then
    # Headless without a TTY (automated/background launch): no live monitor, but
    # still capture the full transcript to the host log for later inspection.
    mkdir -p "${REPO_ROOT}/.wolfpack"
    LOG="${REPO_ROOT}/.wolfpack/run.log"
    run_container 2>&1 | tee "$LOG"
else
    # Interactive shell (no pipeline) — run as-is.
    run_container
fi
