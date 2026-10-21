#!/usr/bin/env bash
# Tests for install.sh (pack-install-model AC1–AC3) — run: bash scripts/install.test.sh
# Every case uses a throwaway HOME and unsets WOLFPACK_VIBE_AGENTS_DIR / WOLFPACK_HOME unless the
# case sets them. Consumers are temp git repos holding a filled-in wolfpack-config.example.md.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACK=$(cd "$HERE/.." && pwd -P)
INSTALL="$PACK/install.sh"

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
SCRATCH=$(realpath "$SCRATCH")

PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "ok   - $1"; }
no()    { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else no "$3 (want '$2' got '$1')"; fi; }
has()   { if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else no "$3 (missing: $2)"; printf '%s\n' "$1" | sed 's/^/      | /' | head -30; fi; }
hasnt() { if printf '%s' "$1" | grep -qF -- "$2"; then no "$3 (unexpected: $2)"; else ok "$3"; fi; }

# A FRESH home every call (mktemp: newhome runs in a $(…) subshell, so a counter would not stick).
newhome() { mktemp -d "$SCRATCH/home.XXXXXX"; }
# run <home> <cwd> args… → sets OUT (stdout+stderr) and RC
run() {
  local h="$1" cwd="$2"; shift 2
  OUT="$(cd "$cwd" && HOME="$h" env -u WOLFPACK_VIBE_AGENTS_DIR -u WOLFPACK_HOME bash "$INSTALL" "$@" 2>&1)"; RC=$?
}
# consumer <name> [config-transform-sed] → a git repo with a reader-clean wolfpack-config.md
consumer() {
  local d="$SCRATCH/$1"; mkdir -p "$d"
  git -C "$d" init -q
  if [ -n "${2:-}" ]; then sed -e "$2" "$PACK/wolfpack-config.example.md" > "$d/wolfpack-config.md"
  else cp "$PACK/wolfpack-config.example.md" "$d/wolfpack-config.md"; fi
  echo "$(realpath "$d")"
}
listing() { find "$@" -printf '%p %l\n' 2>/dev/null | LC_ALL=C sort; }
VERSION="$(git -C "$PACK" describe --tags)"
COMMIT="$(git -C "$PACK" rev-parse HEAD)"
FIX="bash '$PACK/install.sh'"

# precondition: the example config the consumers use reads clean (rc 0) with a Worktree root
node "$PACK/scripts/wolfpack-config.mjs" --json "$PACK/wolfpack-config.example.md" >/dev/null 2>&1
check "$?" 0 "fixture: wolfpack-config.example.md reads clean"

# ── AC1 install-idempotent ──────────────────────────────────────────────
H=$(newhome); NOGIT="$SCRATCH/nogit"; mkdir -p "$NOGIT"
run "$H" "$NOGIT"
check "$RC" 0 "AC1: install from a non-git CWD exits 0"
check "$(printf '%s\n' "$OUT" | head -n1)" "Wolfpack pack: $VERSION ($COMMIT) at $PACK" "AC1: the version line is the first output line"
check "$(readlink -f "$H/.claude/commands")" "$PACK/.agents/commands" "AC1: ~/.claude/commands → <pack>/.agents/commands"
check "$(readlink -f "$H/.claude/skills")" "$PACK/.agents/skills" "AC1: ~/.claude/skills → <pack>/.agents/skills"
has "$OUT" "linked ~/.claude/commands → $PACK/.agents/commands" "AC1: first run reports 'linked'"
has "$OUT" "workflows: no consuming project (pass --consumer <dir> or run from one) — skipped" "AC1: no consumer → the workflow step says skipped"
[ -d "$H/.vibe/agents-headless" ] && ok "AC1: the Vibe seat profiles were installed" || no "AC1: no ~/.vibe/agents-headless"
BEFORE="$(listing "$H")"
run "$H" "$NOGIT"
check "$RC" 0 "AC1: second install exits 0"
check "$(listing "$H")" "$BEFORE" "AC1: second install changes nothing under HOME"
has "$OUT" "unchanged ~/.claude/commands → $PACK/.agents/commands" "AC1: second run reports 'unchanged'"
# a link pointing elsewhere is repointed (nothing lost)
OTHER="$SCRATCH/otherpack-skills"; mkdir -p "$OTHER"
ln -sfn "$OTHER" "$H/.claude/skills"
run "$H" "$NOGIT"
check "$RC" 0 "relink: install exits 0"
check "$(readlink -f "$H/.claude/skills")" "$PACK/.agents/skills" "relink: ~/.claude/skills repointed at the pack"
has "$OUT" "relinked ~/.claude/skills → $PACK/.agents/skills (was → $OTHER)" "relink: reports the old target"
[ -d "$OTHER" ] && ok "relink: the old target dir is untouched" || no "relink: old target removed"

# ── AC2 check-clean (+ AC4 through install.sh) ───────────────────────────
H=$(newhome); C=$(consumer c-clean)
run "$H" "$SCRATCH" --consumer "$C"
check "$RC" 0 "AC2: install --consumer exits 0"
has "$OUT" "worktree root: .agents/worktrees" "AC2: install reports the consumer's worktree root"
for n in hunt-pipeline.js campaign-runner.js; do
  [ -f "$C/.claude/workflows/$n" ] && [ ! -L "$C/.claude/workflows/$n" ] && ok "AC4: generated $n (regular file)" || no "AC4: $n not generated"
  check "$(head -c 17 "$C/.claude/workflows/$n")" "export const meta" "AC4: $n begins with export const meta"
  grep -q "\"commit\":\"$COMMIT\"" "$C/.claude/workflows/$n" && ok "AC4: $n stamp names the pack HEAD" || no "AC4: $n stamp commit"
  grep -qF "\"version\":\"$VERSION\"" "$C/.claude/workflows/$n" && ok "AC4: $n stamp names git describe --tags" || no "AC4: $n stamp version"
  cp "$C/.claude/workflows/$n" "$SCRATCH/$n.first"
done
has "$OUT" "restart Claude Code" "AC2: install's last line says to restart Claude Code"
run "$H" "$SCRATCH" --consumer "$C"
check "$RC" 0 "AC4: re-install exits 0"
for n in hunt-pipeline.js campaign-runner.js; do
  cmp -s "$C/.claude/workflows/$n" "$SCRATCH/$n.first"; check "$?" 0 "AC4: re-generated $n is byte-identical (cmp)"
done
touch "$SCRATCH/marker"; sleep 1
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 0 "AC2: --check on a clean install exits 0"
has "$OUT" "$VERSION" "AC2: --check prints a line containing git describe --tags"
has "$OUT" "install.sh --check: OK" "AC2: --check summary OK"
has "$OUT" "✓ current $C/.claude/workflows/hunt-pipeline.js" "AC2: --check reports the copies current"
check "$(find "$H" "$C" -newer "$SCRATCH/marker" | LC_ALL=C sort)" "" "AC2: --check wrote nothing (find -newer marker is empty)"
# consumer resolved from the git toplevel of $PWD (subdir) when it holds wolfpack-config.md
mkdir -p "$C/sub/dir"
run "$H" "$C/sub/dir" --check
check "$RC" 0 "consumer from PWD: --check from a subdir exits 0"
has "$OUT" "consumer: $C" "consumer from PWD: resolved to the git toplevel"

# ── check-config: no Worktree root / a config the reader rejects ─────────
H=$(newhome); C=$(consumer c-noroot '/^- \*\*Worktree root:\*\*/d')
run "$H" "$SCRATCH" --consumer "$C"
check "$RC" 2 "check-config: install with no Worktree root exits 2"
[ -f "$C/.claude/workflows/hunt-pipeline.js" ] && ok "check-config: the workflows are still generated" || no "check-config: workflows not generated"
has "$OUT" "has no Worktree root — the workflows refuse to run without it — fix: add \"- **Worktree root:** \`<dir>\`\" under ## Project Identity" "check-config: install names the add-the-key fix"
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "check-config: --check with no Worktree root exits 1"
has "$OUT" "fix: add \"- **Worktree root:** \`<dir>\`\"" "check-config: --check names the add-the-key fix"
has "$OUT" "install.sh --check: 1 problem(s)" "check-config: exactly one problem counted"
H=$(newhome); C=$(consumer c-badcfg '/^- \*\*Test command:\*\*/d')
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "check-config: --check with a config the reader rejects exits 1"
has "$OUT" "wolfpack-config.md is incomplete (above) — fix: node '$PACK/scripts/wolfpack-config.mjs' '$C/wolfpack-config.md'" "check-config: names the reader command"
has "$OUT" "testCommand" "check-config: the reader's summary names the missing key"
H=$(newhome); C=$(consumer c-badroot 's#^- \*\*Worktree root:\*\* `\.agents/worktrees`#- **Worktree root:** `../escape`#')
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "check-config: a malformed Worktree root is a --check problem"
has "$OUT" "Worktree root must be a repo-relative path" "check-config: the reader's problem is shown"

# ── AC3 check-bad-link / check-real-dir ─────────────────────────────────
H=$(newhome); C=$(consumer c-links)
run "$H" "$SCRATCH" --consumer "$C"; check "$RC" 0 "AC3 setup: install"
rm "$H/.claude/commands"
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "AC3 check-bad-link (missing): --check exits 1"
has "$OUT" "✗ ~/.claude/commands is missing — fix: $FIX" "AC3 check-bad-link (missing): exact fix"
[ -e "$H/.claude/commands" ] && no "AC3: --check recreated the link" || ok "AC3: --check did not repair (read-only)"
ln -s "$SCRATCH/nogit" "$H/.claude/commands"
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "AC3 check-bad-link (elsewhere): --check exits 1"
has "$OUT" "✗ ~/.claude/commands points at $SCRATCH/nogit, not $PACK/.agents/commands — fix: $FIX" "AC3 check-bad-link (elsewhere): exact fix"
check "$(readlink "$H/.claude/commands")" "$SCRATCH/nogit" "AC3: --check left the foreign link alone"

H=$(newhome); [ ! -e "$H/.claude" ] || { no "fixture: fresh home already has ~/.claude"; exit 1; }
mkdir -p "$H/.claude/skills"; echo keep > "$H/.claude/skills/mine.md"
BEFORE="$(listing "$H")"
run "$H" "$NOGIT"
check "$RC" 2 "AC3 check-real-dir: install over a real ~/.claude/skills exits 2"
has "$OUT" "✗ ~/.claude/skills is a real directory/file; install will not replace it — fix: mv ~/.claude/skills ~/.claude/skills.pre-wolfpack && $FIX" "AC3 check-real-dir: the mv fix"
check "$(listing "$H")" "$BEFORE" "AC3 check-real-dir: nothing written (stops BEFORE any write)"
check "$(cat "$H/.claude/skills/mine.md")" "keep" "AC3 check-real-dir: the real dir is untouched"
run "$H" "$NOGIT" --check
check "$RC" 1 "AC3 check-real-dir: --check exits 1"
has "$OUT" "~/.claude/skills is a real directory/file" "AC3 check-real-dir: --check names it"

# ── AC3 check-vibe-drift ────────────────────────────────────────────────
H=$(newhome); C=$(consumer c-vibe)
run "$H" "$SCRATCH" --consumer "$C"; check "$RC" 0 "AC3 setup: install (vibe)"
PROFILE="$(find "$H/.vibe/agents-headless" -name 'wolfpack-*.toml' | LC_ALL=C sort | head -n1)"
[ -n "$PROFILE" ] && ok "AC3: an installed Vibe profile exists" || no "AC3: no installed Vibe profile"
echo '# hand edit' >> "$PROFILE"
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "AC3 check-vibe-drift: --check exits 1"
has "$OUT" "✗ Vibe seat profiles drifted/missing (above) — fix: node '$PACK/scripts/wolfpack-install-vibe-agents.mjs'" "AC3 check-vibe-drift: exact fix"
has "$OUT" "drift" "AC3 check-vibe-drift: the installer's drift line is shown"
rm "$PROFILE"
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "AC3 check-vibe-drift (missing profile): --check exits 1"

# ── AC3 check-stale-workflow ────────────────────────────────────────────
H=$(newhome); C=$(consumer c-stale)
run "$H" "$SCRATCH" --consumer "$C"; check "$RC" 0 "AC3 setup: install (workflows)"
WFIX="bash '$PACK/install.sh' --consumer '$C'"
echo '// hand edit' >> "$C/.claude/workflows/hunt-pipeline.js"
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "AC3 check-stale-workflow (modified): --check exits 1"
has "$OUT" "✗ modified $C/.claude/workflows/hunt-pipeline.js" "AC3 check-stale-workflow: names the modified copy"
has "$OUT" "— fix: $WFIX" "AC3 check-stale-workflow: exact regenerate fix"
rm "$C/.claude/workflows/campaign-runner.js"
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 1 "AC3 check-stale-workflow (missing): --check exits 1"
has "$OUT" "✗ missing $C/.claude/workflows/campaign-runner.js — fix: $WFIX" "AC3 check-stale-workflow: missing copy + fix"
has "$OUT" "install.sh --check: 2 problem(s)" "AC3: each ✗ workflow line counts as a problem"
sed -i '/^const WOLFPACK_STAMP = /d' "$C/.claude/workflows/hunt-pipeline.js"
run "$H" "$SCRATCH" --check --consumer "$C"
has "$OUT" "✗ unstamped $C/.claude/workflows/hunt-pipeline.js" "AC3: a stamp-less copy is unstamped"
run "$H" "$SCRATCH" --consumer "$C"
check "$RC" 0 "AC3: install repairs every workflow state"
run "$H" "$SCRATCH" --check --consumer "$C"
check "$RC" 0 "AC3: --check clean after the repair"

# ── wolfpack-home-mismatch ──────────────────────────────────────────────
H=$(newhome); run "$H" "$NOGIT"
OUT="$(cd "$NOGIT" && HOME="$H" env -u WOLFPACK_VIBE_AGENTS_DIR WOLFPACK_HOME=/elsewhere bash "$INSTALL" --check 2>&1)"; RC=$?
check "$RC" 1 "WOLFPACK_HOME mismatch: --check exits 1"
has "$OUT" "✗ WOLFPACK_HOME=/elsewhere but this install.sh belongs to $PACK — fix: run /elsewhere/install.sh, or export WOLFPACK_HOME=$PACK" "WOLFPACK_HOME mismatch: names both paths"
OUT="$(cd "$NOGIT" && HOME="$H" env -u WOLFPACK_VIBE_AGENTS_DIR WOLFPACK_HOME=/elsewhere bash "$INSTALL" 2>&1)"; RC=$?
check "$RC" 2 "WOLFPACK_HOME mismatch: install exits 2"
OUT="$(cd "$NOGIT" && HOME="$H" env -u WOLFPACK_VIBE_AGENTS_DIR WOLFPACK_HOME="$PACK/" bash "$INSTALL" --check 2>&1)"; RC=$?
check "$RC" 0 "WOLFPACK_HOME = the pack (trailing /) is consistent"

# ── usage ───────────────────────────────────────────────────────────────
for args in "--bogus" "--consumer" "--consumer --check" "--consumer $SCRATCH/does-not-exist"; do
  H=$(newhome)
  # shellcheck disable=SC2086
  run "$H" "$NOGIT" $args
  check "$RC" 2 "usage: '$args' exits 2"
  check "$(listing "$H")" "$H " "usage: '$args' writes nothing"
done
H=$(newhome); run "$H" "$NOGIT" --help
check "$RC" 0 "usage: --help exits 0"
has "$OUT" "usage: bash install.sh [--check] [--consumer <dir>]" "usage: --help prints usage"

# ── the pack itself as the consumer: canonical, nothing generated ───────
H=$(newhome)
run "$H" "$SCRATCH" --consumer "$PACK"
check "$RC" 0 "pack-as-consumer: install exits 0"
has "$OUT" "canonical (pack itself) — nothing to generate" "pack-as-consumer: nothing generated"
check "$(git -C "$PACK" status --porcelain -- .claude .agents/workflows)" "" "pack-as-consumer: no change in the pack's .claude / canonical workflows"

check "$(git -C "$PACK" status --porcelain -- .gitignore)" "" "pack-as-consumer: the pack's .gitignore is not touched (it already ignores model-stats.json)"

# ── merge-and-state-hygiene AC21: ~/.claude as a regular FILE → loud refusal, nothing written ──
H=$(newhome); printf 'not a dir\n' > "$H/.claude"; SUM_BEFORE=$(sha256sum "$H/.claude")
run "$H" "$NOGIT"
[ "$RC" -ne 0 ] && ok "AC21: install exits non-zero when ~/.claude is a regular file (rc $RC)" || no "AC21: install exit 0 with ~/.claude a regular file"
has "$OUT" "~/.claude ($H/.claude) is a regular file, not a directory; install will not replace it" "AC21: the refusal names ~/.claude and 'regular file'"
has "$OUT" "fix: mv ~/.claude ~/.claude.pre-wolfpack && bash '$PACK/install.sh'" "AC21: the refusal prints the fix"
check "$(sha256sum "$H/.claude")" "$SUM_BEFORE" "AC21: the ~/.claude file is byte-identical"
check "$(listing "$H")" "$(printf '%s \n%s \n' "$H" "$H/.claude")" "AC21: nothing else under HOME (no links, no Vibe profiles)"
run "$H" "$NOGIT" --check
check "$RC" 1 "AC21: --check exits 1 with the problem"
has "$OUT" "is a regular file, not a directory" "AC21: --check reports the regular-file problem"
hasnt "$OUT" "~/.claude/commands" "AC21: --check skips the per-link checks (they would all fail the same way)"
check "$(sha256sum "$H/.claude")" "$SUM_BEFORE" "AC21: --check leaves the file untouched"

# ── merge-and-state-hygiene AC23: the derived model-stats meter is gitignored in the consumer ──
MS=.wolfpack/pedigree/model-stats.json
git -C "$PACK" check-ignore -q "$MS"; check "$?" 0 "AC23: the pack ignores $MS"
check "$(grep -c 'model-stats\.json' "$PACK/.gitignore")" 1 "AC23: the pack .gitignore names it exactly once (the comment does not)"
H=$(newhome); C=$(consumer c-gitignore)
printf 'node_modules/' > "$C/.gitignore"   # no trailing newline: the append must not glue onto it
run "$H" "$SCRATCH" --check --consumer "$C"
[ "$RC" -ne 0 ] && ok "AC23: --check on an un-ignoring consumer reports a problem" || no "AC23: --check passed although $MS is not ignored"
has "$OUT" "does not gitignore $MS" "AC23: --check names the path"
check "$(cat "$C/.gitignore")" "node_modules/" "AC23: --check writes nothing"
run "$H" "$SCRATCH" --consumer "$C"
check "$RC" 0 "AC23: install --consumer exits 0"
has "$OUT" "gitignore: added $MS to $C/.gitignore — commit it" "AC23: install says it added the ignore"
git -C "$C" check-ignore -q "$MS"; check "$?" 0 "AC23: after install the consumer ignores $MS"
check "$(head -n1 "$C/.gitignore")" "node_modules/" "AC23: the existing last line is kept intact (newline added first)"
check "$(grep -c 'model-stats\.json' "$C/.gitignore")" 1 "AC23: one ignore line"
run "$H" "$SCRATCH" --consumer "$C"
check "$(grep -c 'model-stats\.json' "$C/.gitignore")" 1 "AC23: a second install adds nothing (idempotent)"
hasnt "$OUT" "gitignore: added" "AC23: a second install does not report an add"
run "$H" "$SCRATCH" --check --consumer "$C"
hasnt "$OUT" "does not gitignore" "AC23: --check is clean after install"
# a consumer that already ignores it another way (a broader pattern) is left alone
H=$(newhome); C=$(consumer c-gitignore-broad); printf '.wolfpack/pedigree/*.json\n' > "$C/.gitignore"
run "$H" "$SCRATCH" --consumer "$C"
check "$(cat "$C/.gitignore")" ".wolfpack/pedigree/*.json" "AC23: an existing broader ignore is respected (no duplicate line)"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
