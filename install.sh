#!/usr/bin/env bash
# install.sh — install (or check) the Wolfpack pack for this user and a consuming project.
#
# usage: bash install.sh [--check] [--consumer <dir>]
#   install (default): link ~/.claude/{commands,skills} → <pack>/.agents/{commands,skills};
#                      install the Vibe seat profiles; generate the consumer's stamped workflows.
#   --check:           read-only; report every problem with its exact fix; exit 1 if any.
#
# The pack is the directory holding this script (realpath). The consuming project is
# --consumer <dir>, else the git toplevel of $PWD when it holds wolfpack-config.md, else none
# (the workflow step is skipped, and said so).
#
# Generated workflow copies (<consumer>/.claude/workflows/{hunt-pipeline,campaign-runner}.js) are
# never tracked: they are gitignored in every consuming project, produced here through
# scripts/wolfpack-workflows.mjs, and checked at each run start (a stale copy stops the run).
#
# Never clobbers: a real (non-symlink) ~/.claude/commands or ~/.claude/skills stops the install
# (exit 2) with the mv fix. A symlink pointing elsewhere is repointed (nothing is lost).
# --check writes nothing at all (no mkdir, no temp files, no index refresh).
#
# Exit: 0 ok · 1 drift/problems (--check only) · 2 usage error or install failure.
set -euo pipefail

usage() {
  {
    echo "usage: bash install.sh [--check] [--consumer <dir>]"
    echo "  install (default): link ~/.claude/{commands,skills} → <pack>/.agents/{commands,skills};"
    echo "                     install the Vibe seat profiles; generate the consumer's stamped workflows."
    echo "  --check:           read-only; report every problem with its exact fix; exit 1 if any."
  } >&2
}

CHECK=0
CONSUMER_ARG=""
CONSUMER_SET=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --consumer)
      if [ "$#" -lt 2 ] || [ -z "$2" ] || [[ "$2" == --* ]]; then
        echo "✗ install.sh: --consumer needs a directory" >&2; usage; exit 2
      fi
      CONSUMER_ARG="$2"; CONSUMER_SET=1; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ install.sh: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

PACK="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
for need in "$PACK/.agents/commands" "$PACK/.agents/skills" "$PACK/.agents/workflows"; do
  [ -d "$need" ] || { echo "✗ install.sh: the pack is incomplete — $need is missing (is $PACK a wolfpack checkout?)" >&2; exit 2; }
done
WORKFLOWS_CLI="$PACK/scripts/wolfpack-workflows.mjs"
CONFIG_CLI="$PACK/scripts/wolfpack-config.mjs"
VIBE_CLI="$PACK/scripts/wolfpack-install-vibe-agents.mjs"
for need in "$WORKFLOWS_CLI" "$CONFIG_CLI" "$VIBE_CLI"; do
  [ -f "$need" ] || { echo "✗ install.sh: the pack is incomplete — $need is missing" >&2; exit 2; }
done
command -v node >/dev/null 2>&1 || { echo "✗ install.sh: node is not on PATH — the pack's scripts need it" >&2; exit 2; }

# ── Version line (first output line, both modes) ──
if ! VERSION="$(git -C "$PACK" describe --tags --match 'v[0-9]*' 2>/dev/null)"; then
  echo "✗ cannot read the pack version (no tags reachable) — fix: git -C '$PACK' fetch --tags" >&2
  exit 2
fi
COMMIT="$(git -C "$PACK" rev-parse HEAD)"
echo "Wolfpack pack: $VERSION ($COMMIT) at $PACK"

PROBLEMS=0     # --check: counted problems
FAILED=0       # install: a problem that must turn the final exit into 2
problem() {    # print one problem line (already carries its fix)
  echo "$1"
  PROBLEMS=$((PROBLEMS + 1))
  FAILED=1
}

# ── Pack-home consistency (the workflows resolve the pack from WOLFPACK_HOME) ──
if [ -n "${WOLFPACK_HOME:-}" ]; then
  WH_REAL="$(readlink -f "$WOLFPACK_HOME" 2>/dev/null || echo "$WOLFPACK_HOME")"
  if [ "$WH_REAL" != "$PACK" ]; then
    MSG="✗ WOLFPACK_HOME=$WOLFPACK_HOME but this install.sh belongs to $PACK — fix: run $WOLFPACK_HOME/install.sh, or export WOLFPACK_HOME=$PACK"
    if [ "$CHECK" = 1 ]; then problem "$MSG"; else echo "$MSG" >&2; exit 2; fi
  fi
fi

# ── Consumer ──
CONSUMER=""
if [ "$CONSUMER_SET" = 1 ]; then
  [ -d "$CONSUMER_ARG" ] || { echo "✗ install.sh: --consumer $CONSUMER_ARG is not a directory" >&2; exit 2; }
  CONSUMER="$(readlink -f "$CONSUMER_ARG")"
else
  TOP="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$TOP" ] && [ -f "$TOP/wolfpack-config.md" ]; then CONSUMER="$(readlink -f "$TOP")"; fi
fi

# ── Links: ~/.claude/{commands,skills} → <pack>/.agents/{commands,skills} ──
NAMES=(commands skills)
# ~/.claude as a regular file can hold no links: refuse loudly (never replace it) instead of letting
# `mkdir -p` / `ln` fail with an opaque error half way through. Install mode exits before ANY link or
# Vibe profile write; --check reports it and skips the link checks (they would all fail the same way).
SKIP_LINKS=0
if [ -e "$HOME/.claude" ] && [ ! -d "$HOME/.claude" ]; then
  MSG="✗ ~/.claude ($HOME/.claude) is a regular file, not a directory; install will not replace it — fix: mv ~/.claude ~/.claude.pre-wolfpack && bash '$PACK/install.sh'"
  if [ "$CHECK" = 1 ]; then problem "$MSG"; else echo "$MSG" >&2; exit 2; fi
  SKIP_LINKS=1
fi
# A real directory/file is never replaced: in install mode stop BEFORE touching anything.
for n in "${NAMES[@]}"; do
  [ "$SKIP_LINKS" = 1 ] && break
  L="$HOME/.claude/$n"
  if [ -e "$L" ] && [ ! -L "$L" ]; then
    MSG="✗ ~/.claude/$n is a real directory/file; install will not replace it — fix: mv ~/.claude/$n ~/.claude/$n.pre-wolfpack && bash '$PACK/install.sh'"
    if [ "$CHECK" = 1 ]; then problem "$MSG"; else echo "$MSG" >&2; exit 2; fi
  fi
done
for n in "${NAMES[@]}"; do
  [ "$SKIP_LINKS" = 1 ] && break
  L="$HOME/.claude/$n"
  T="$PACK/.agents/$n"
  if [ -e "$L" ] && [ ! -L "$L" ]; then continue; fi   # already reported (check mode)
  if [ -L "$L" ]; then
    if [ "$(readlink -f "$L" 2>/dev/null || true)" = "$(readlink -f "$T")" ]; then
      echo "unchanged ~/.claude/$n → $T"
    else
      OLD="$(readlink "$L")"
      if [ "$CHECK" = 1 ]; then
        problem "✗ ~/.claude/$n points at $OLD, not $T — fix: bash '$PACK/install.sh'"
      else
        ln -sfn "$T" "$L"
        echo "relinked ~/.claude/$n → $T (was → $OLD)"
      fi
    fi
  else
    if [ "$CHECK" = 1 ]; then
      problem "✗ ~/.claude/$n is missing — fix: bash '$PACK/install.sh'"
    else
      mkdir -p "$HOME/.claude"
      ln -s "$T" "$L"
      echo "linked ~/.claude/$n → $T"
    fi
  fi
done

# ── Vibe seat profiles ──
if [ "$CHECK" = 1 ]; then
  set +e; VOUT="$(node "$VIBE_CLI" --check 2>&1)"; VRC=$?; set -e
  [ -n "$VOUT" ] && echo "$VOUT"
  if [ "$VRC" = 1 ]; then
    problem "✗ Vibe seat profiles drifted/missing (above) — fix: node '$VIBE_CLI'"
  elif [ "$VRC" != 0 ]; then
    problem "✗ Vibe seat profile check failed (exit $VRC, above) — fix: resolve what it names, then node '$VIBE_CLI'"
  fi
else
  set +e; node "$VIBE_CLI"; VRC=$?; set -e
  if [ "$VRC" != 0 ]; then echo "✗ Vibe seat profile install failed (exit $VRC, above)" >&2; exit 2; fi
fi

# ── Consumer: config (Worktree root) + stamped workflows ──
if [ -z "$CONSUMER" ]; then
  echo "workflows: no consuming project (pass --consumer <dir> or run from one) — skipped"
else
  echo "consumer: $CONSUMER"
  # The PACK's reader is the one that knows worktreeRoot; it writes nothing.
  set +e; CJSON="$(node "$CONFIG_CLI" --json "$CONSUMER/wolfpack-config.md" 2>/dev/null)"; CRC=$?; set -e
  if [ "$CRC" != 0 ]; then
    # Re-run in summary mode to show what is missing (still read-only; no temp files).
    node "$CONFIG_CLI" "$CONSUMER/wolfpack-config.md" 2>&1 || true
    problem "✗ $CONSUMER/wolfpack-config.md is incomplete (above) — fix: node '$CONFIG_CLI' '$CONSUMER/wolfpack-config.md' and add what it names"
  else
    WT_ROOT="$(printf '%s' "$CJSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).worktreeRoot;process.stdout.write(typeof v==="string"?v:"")}catch{process.exit(3)}})' || echo "")"
    if [ -z "$WT_ROOT" ]; then
      problem "✗ $CONSUMER/wolfpack-config.md has no Worktree root — the workflows refuse to run without it — fix: add \"- **Worktree root:** \`<dir>\`\" under ## Project Identity, where <dir> is the repo-relative, gitignored directory this project's hunt worktrees live in (e.g. \`.agents/worktrees\` or \`.claude/worktrees\`)"
    else
      echo "worktree root: $WT_ROOT"
    fi
  fi

  # The derived per-model meter is rebuilt by the pack and must never be tracked: gitignore it in the
  # consumer (the pack ignores it in its own .gitignore).
  MS_PATH=".wolfpack/pedigree/model-stats.json"
  if git -C "$CONSUMER" rev-parse --git-dir >/dev/null 2>&1; then
    set +e; git -C "$CONSUMER" check-ignore -q "$MS_PATH"; IGN=$?; set -e
    if [ "$IGN" = 1 ]; then
      if [ "$CHECK" = 1 ]; then
        problem "✗ $CONSUMER does not gitignore $MS_PATH (a derived file the pack rewrites) — fix: bash '$PACK/install.sh' --consumer '$CONSUMER'"
      else
        GI="$CONSUMER/.gitignore"
        if [ -s "$GI" ] && [ -n "$(tail -c1 "$GI")" ]; then printf '\n' >> "$GI"; fi
        {
          echo "# Wolfpack — derived per-model meter (rebuilt by the pack's model-stats; never tracked)"
          echo "$MS_PATH"
        } >> "$GI"
        echo "gitignore: added $MS_PATH to $GI — commit it"
      fi
    fi
  fi

  if [ "$CHECK" = 1 ]; then
    set +e; WOUT="$(node "$WORKFLOWS_CLI" check --pack "$PACK" --consumer "$CONSUMER" 2>&1)"; WRC=$?; set -e
    [ -n "$WOUT" ] && echo "$WOUT"
    if [ "$WRC" = 1 ]; then
      N="$(printf '%s\n' "$WOUT" | grep -c '^✗' || true)"
      [ "$N" -gt 0 ] || N=1
      PROBLEMS=$((PROBLEMS + N))
    elif [ "$WRC" != 0 ]; then
      echo "✗ workflow check failed (exit $WRC, above)" >&2
      exit 2
    fi
  else
    set +e; node "$WORKFLOWS_CLI" generate --pack "$PACK" --consumer "$CONSUMER"; WRC=$?; set -e
    if [ "$WRC" != 0 ]; then echo "✗ workflow generation failed (exit $WRC, above)" >&2; exit 2; fi
  fi
fi

if [ "$CHECK" = 1 ]; then
  if [ "$PROBLEMS" = 0 ]; then echo "install.sh --check: OK"; exit 0; fi
  echo "install.sh --check: $PROBLEMS problem(s)"
  exit 1
fi
if [ "$FAILED" = 1 ]; then
  echo "install.sh: installed, but the problem(s) above remain — fix them, then bash '$PACK/install.sh' --check" >&2
  exit 2
fi
echo "install.sh: done — restart Claude Code so it loads the regenerated workflows; verify with bash '$PACK/install.sh' --check"
