#!/usr/bin/env bash
# scripts/wolfpack-cron-resume.sh — cron-driven resume for an ARMED local chain campaign.
#
#   wolfpack-cron-resume.sh [--repo <abs>] tick                 the 15-minute tick (run by cron)
#   wolfpack-cron-resume.sh [--repo <abs>] arm <slug>           arm one campaign (one per repo)
#   wolfpack-cron-resume.sh [--repo <abs>] disarm [<slug>] [--reason <code>]
#   wolfpack-cron-resume.sh [--repo <abs>] status
#   wolfpack-cron-resume.sh [--repo <abs>] note-pause --campaign <s> --reset-at <iso>
#   wolfpack-cron-resume.sh [--repo <abs>] note-exit  --campaign <s> --verdict <token>
#   wolfpack-cron-resume.sh [--repo <abs>] event <park|ready-for-release|waiting-on-you> --campaign <s>
#                                         [--hunt <h>] [--status <st>] [--reason <code>]
#   wolfpack-cron-resume.sh [--repo <abs>] notify-test
#   wolfpack-cron-resume.sh [--repo <abs>] --print-crontab      print the crontab line; changes nothing
#
# This entry only (1) reads the settings file, (2) resolves and checks the tools, (3) creates
# the log directories and (4) takes the repo's state lock; all logic lives in
# wolfpack-cron-resume.mjs. See docs/cron-resume.md.
#
# Settings: ${WOLFPACK_CRON_CONFIG:-$HOME/.config/wolfpack/cron-resume.env}, KEY=VALUE lines
# (only WOLFPACK_* keys), PARSED — never sourced. An environment variable of the same name
# overrides the file. A leading ~/ in a value is expanded to $HOME.
#
# Exit codes: 0 ok (event/note-* always 0 unless the node module cannot run at all) · 1 error ·
# 2 usage · 3 arm refused · 4 config/tool failure (logged, never a silent exit 0).
#
# The state lock is <repo>/.wolfpack/campaigns/.cron-resume.lock. `tick` takes it with
# `flock -n` (a second tick exits 0: "tick already running"); every other state writer waits
# up to WOLFPACK_CRON_LOCK_WAIT seconds. flock runs with -o, so the lock is held by flock
# itself and NOT inherited by node or by anything node starts (a tmux server started by a
# relaunch must never hold the lock).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_PACK="$(cd "$SELF_DIR/.." && pwd)"
CONFIG="${WOLFPACK_CRON_CONFIG:-$HOME/.config/wolfpack/cron-resume.env}"
LOCK_BUSY=75   # flock's exit code when the lock is not obtained (-E); distinct from node's codes

iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

usage() {
  sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

# ---------------------------------------------------------------- settings file (parsed)
declare -A CFG=()
if [ -f "$CONFIG" ]; then
  lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(WOLFPACK_[A-Z0-9_]*)=(.*)$ ]]; then
      k="${BASH_REMATCH[2]}"; v="${BASH_REMATCH[3]}"
      v="${v%"${v##*[![:space:]]}"}"   # trailing whitespace
      if [[ "$v" =~ ^\"(.*)\"$ ]] || [[ "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
      CFG["$k"]="$v"
    else
      echo "WARNING: $CONFIG:$lineno is not a WOLFPACK_KEY=VALUE line — ignored" >&2
    fi
  done < "$CONFIG"
fi

# cfg <KEY> [default]: environment, else the settings file, else the default. ~/ expanded.
cfg() {
  local k="$1" d="${2-}" v
  if [ -n "${!k:-}" ]; then v="${!k}"
  elif [ -n "${CFG[$k]+x}" ] && [ -n "${CFG[$k]}" ]; then v="${CFG[$k]}"
  else v="$d"
  fi
  case "$v" in "~/"*) v="$HOME/${v#\~/}" ;; "~") v="$HOME" ;; esac
  printf '%s' "$v"
}

# ---------------------------------------------------------------- arguments
REPO=""
if [ "${1:-}" = "--repo" ]; then
  if [ $# -lt 2 ] || [ -z "${2:-}" ]; then echo "ERROR: --repo needs an absolute path" >&2; exit 2; fi
  REPO="$2"; shift 2
fi
CMD="${1:-}"
case "$CMD" in
  tick|arm|disarm|status|note-pause|note-exit|event|notify-test|--print-crontab) ;;
  ''|-h|--help) usage; exit 2 ;;
  *) echo "ERROR: unknown command '$CMD'" >&2; usage; exit 2 ;;
esac

if [ -z "$REPO" ]; then
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
  if [ -z "$common" ]; then
    echo "ERROR: not inside a git repo — pass --repo <absolute path of the consumer repo>" >&2
    exit 2
  fi
  REPO="$(dirname "$common")"
fi
case "$REPO" in /*) ;; *) echo "ERROR: --repo must be absolute (got '$REPO')" >&2; exit 2 ;; esac
REPO="${REPO%/}"
[ -d "$REPO" ] || { echo "ERROR: --repo $REPO is not a directory" >&2; exit 2; }

LOG="$(cfg WOLFPACK_CRON_LOG "$HOME/.cache/wolfpack/cron-resume.log")"

# ---------------------------------------------------------------- --print-crontab (AC9: invokes nothing)
if [ "$CMD" = "--print-crontab" ]; then
  [ $# -eq 1 ] || { echo "ERROR: --print-crontab takes no arguments" >&2; exit 2; }
  pack="$(cfg WOLFPACK_HOME "$SELF_PACK")"
  pack="${pack%/}"
  printf '*/15 * * * * /bin/bash %s/scripts/wolfpack-cron-resume.sh --repo %s tick >> %s/.cache/wolfpack/cron-resume.cron.log 2>&1\n' \
    "$pack" "$REPO" "$HOME"
  exit 0
fi

# Every other subcommand writes the log: create its directory (and the crontab redirect's).
LOG_DIR="$(dirname "$LOG")"
for d in "$LOG_DIR" "$HOME/.cache/wolfpack"; do
  if ! mkdir -p -m 700 "$d" 2>/dev/null; then
    echo "ERROR: cannot create log dir $d" >&2
    exit 4
  fi
done

log_line() {   # log_line <campaign|-> <event> <detail>
  printf '%s %s %s %s\n' "$(iso_now)" "$1" "$2" "$3" >> "$LOG" 2>/dev/null || true
}

config_fail() {   # config_fail <message>
  echo "ERROR: $1" >&2
  log_line - config_error "$1"
  exit 4
}

# need_tool <KEY> <tool>: an absolute, executable path (AC8). Never a PATH lookup.
need_tool() {
  local key="$1" tool="$2" v
  v="$(cfg "$key")"
  [ -n "$v" ] || config_fail "$key not set in $CONFIG — cron cannot find $tool"
  case "$v" in /*) ;; *) config_fail "$key=$v in $CONFIG is not an absolute path — cron cannot find $tool" ;; esac
  [ -x "$v" ] && [ ! -d "$v" ] || config_fail "$key=$v in $CONFIG is not executable — cron cannot find $tool"
  printf -v "$key" '%s' "$v"
  export "${key?}"
}

WOLFPACK_HOME="$(cfg WOLFPACK_HOME)"
[ -n "$WOLFPACK_HOME" ] || config_fail "WOLFPACK_HOME not set in $CONFIG — cron cannot find the pack"
WOLFPACK_HOME="${WOLFPACK_HOME%/}"
case "$WOLFPACK_HOME" in /*) ;; *) config_fail "WOLFPACK_HOME=$WOLFPACK_HOME in $CONFIG is not an absolute path — cron cannot find the pack" ;; esac
MJS="$WOLFPACK_HOME/scripts/wolfpack-cron-resume.mjs"
[ -f "$MJS" ] || config_fail "WOLFPACK_HOME=$WOLFPACK_HOME in $CONFIG has no scripts/wolfpack-cron-resume.mjs — cron cannot find the pack"
export WOLFPACK_HOME

need_tool WOLFPACK_CRON_NODE node
if [ "$CMD" = "tick" ]; then
  need_tool WOLFPACK_CRON_TMUX tmux
  need_tool WOLFPACK_CRON_CLAUDE claude
  WOLFPACK_CRON_PS="$(cfg WOLFPACK_CRON_PS /bin/ps)"
  export WOLFPACK_CRON_PS
  need_tool WOLFPACK_CRON_PS ps
fi

# Resolved settings for the node module (it reads only these, never the file).
export WOLFPACK_CRON_REPO="$REPO"
export WOLFPACK_CRON_CONFIG="$CONFIG"
export WOLFPACK_CRON_LOG="$LOG"
export WOLFPACK_CRON_GATE="$(cfg WOLFPACK_CRON_GATE "$WOLFPACK_HOME/scripts/wolfpack-window-gate.mjs")"
export WOLFPACK_CRON_TMUX_SESSION="$(cfg WOLFPACK_CRON_TMUX_SESSION paw)"
export WOLFPACK_CRON_TMUX_WINDOW="$(cfg WOLFPACK_CRON_TMUX_WINDOW runner)"
export WOLFPACK_CRON_STALE_MINUTES="$(cfg WOLFPACK_CRON_STALE_MINUTES 45)"
export WOLFPACK_CRON_STALL_TICKS="$(cfg WOLFPACK_CRON_STALL_TICKS 4)"
export WOLFPACK_CRON_PERMISSION_MODE="$(cfg WOLFPACK_CRON_PERMISSION_MODE auto)"
export WOLFPACK_CRON_LIMIT_RE="$(cfg WOLFPACK_CRON_LIMIT_RE '(usage limit|limit reached|resets [0-9])')"
export WOLFPACK_CRON_LIMIT_LINES="$(cfg WOLFPACK_CRON_LIMIT_LINES 12)"
export WOLFPACK_CRON_PROC_RE="$(cfg WOLFPACK_CRON_PROC_RE '^(claude|node)$')"
export WOLFPACK_CRON_SESSION_PATH="$(cfg WOLFPACK_CRON_SESSION_PATH "$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin")"
export WOLFPACK_NTFY_SERVER="$(cfg WOLFPACK_NTFY_SERVER https://ntfy.sh)"
export WOLFPACK_NTFY_TOPIC_FILE="$(cfg WOLFPACK_NTFY_TOPIC_FILE "$HOME/.secrets/wolfpack/ntfy-topic")"
# Optional pass-throughs the usage meter reads (statusline snapshot path, estimate knobs).
for k in "${!CFG[@]}"; do
  case "$k" in
    WOLFPACK_USAGE_*|WOLFPACK_WINDOW_*|WOLFPACK_AGENT_WINDOW_*|WOLFPACK_GATE_*)
      [ -n "${!k:-}" ] || export "$k=$(cfg "$k")" ;;
  esac
done
LOCK_WAIT="$(cfg WOLFPACK_CRON_LOCK_WAIT 30)"
[[ "$LOCK_WAIT" =~ ^[0-9]+$ ]] || config_fail "WOLFPACK_CRON_LOCK_WAIT=$LOCK_WAIT in $CONFIG is not a whole number of seconds"

NODE_CMD=("$WOLFPACK_CRON_NODE" "$MJS" "$@")
CAMPAIGNS="$REPO/.wolfpack/campaigns"

# status reads only; without a campaigns dir nothing can be armed (AC1: no lock, no tools).
if [ "$CMD" = "status" ] || [ ! -d "$CAMPAIGNS" ]; then
  if [ "$CMD" = "tick" ]; then
    log_line - "not armed" "(no $CAMPAIGNS)"
    exit 0
  fi
  exec "${NODE_CMD[@]}"
fi

FLOCK="$(command -v flock 2>/dev/null || true)"
[ -n "$FLOCK" ] || FLOCK=/usr/bin/flock
[ -x "$FLOCK" ] || config_fail "flock not found (util-linux) — the state lock cannot be taken"
LOCK="$CAMPAIGNS/.cron-resume.lock"

if [ "$CMD" = "tick" ]; then
  "$FLOCK" -n -o -E "$LOCK_BUSY" "$LOCK" "${NODE_CMD[@]}"
  rc=$?
  if [ "$rc" -eq "$LOCK_BUSY" ]; then
    log_line - tick "tick already running"
    exit 0
  fi
  exit "$rc"
fi

"$FLOCK" -w "$LOCK_WAIT" -o -E "$LOCK_BUSY" "$LOCK" "${NODE_CMD[@]}"
rc=$?
if [ "$rc" -eq "$LOCK_BUSY" ]; then
  log_line - WARNING "state lock busy: $CMD dropped"
  echo "WARNING state lock busy: $CMD dropped" >&2
  case "$CMD" in
    event|note-pause|note-exit|notify-test) exit 0 ;;
    *) exit 1 ;;
  esac
fi
exit "$rc"
