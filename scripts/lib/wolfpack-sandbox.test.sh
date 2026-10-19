#!/usr/bin/env bash
# Tests for scripts/lib/wolfpack-sandbox.sh — run: bash scripts/lib/wolfpack-sandbox.test.sh
# Sources the lib in a subshell per case: the secrets guard (equal / under / contains /
# disjoint / sibling prefix / `..` and symlink normalisation / `/`), the config loader (which
# config, the reader's key-named error relayed verbatim, the parsed fields), the user build
# args and the base-image naming. No podman, no network.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LIB="${HERE}/wolfpack-sandbox.sh"
PACK=$(cd "$HERE/../.." && pwd)

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
SCRATCH=$(realpath "$SCRATCH")
unset WOLFPACK_CONFIG

PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "ok   - $1"; }
no()    { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else no "$3 (want '$2' got '$1')"; fi; }
err_has() { if grep -qF -- "$1" "$SCRATCH/err"; then ok "$2"; else no "$2 (stderr: $(tr '\n' '|' < "$SCRATCH/err"))"; fi; }
# lib <bash snippet>: run the snippet with the lib sourced (stderr → $SCRATCH/err).
lib() { bash -c "set -uo pipefail; WP_CALLER=libtest; source '$LIB'; $1" 2>"$SCRATCH/err"; }

bash -n "$LIB" && ok "the lib parses" || no "lib syntax"
check "$(lib 'echo "$WP_PACK_DIR"')" "$PACK" "WP_PACK_DIR is the lib's own pack (../..)"

# ─── wp_secrets_guard ──────────────────────────────────────────
S="$SCRATCH/sec"; mkdir -p "$S/inner" "$SCRATCH/sec-sibling" "$SCRATCH/other"
ln -s "$S" "$SCRATCH/link-to-sec"; ln -s "$SCRATCH/other" "$SCRATCH/link-to-other"
guard() { lib "WP_SECRETS_PATHS=(\"$S\" \"/etc/fixture-keys\"); wp_secrets_guard 'Secrets paths' $*"; }
for c in "equal|$S" "equal-trailing-slash|$S/" "under|$S/inner" "under-missing|$S/not/yet" "contains|$SCRATCH" "dotdot|$SCRATCH/other/../sec/inner" "symlink|$SCRATCH/link-to-sec" "root|/" "second-secret|/etc"; do
  name=${c%%|*}; p=${c#*|}
  guard "'$p'"; rc=$?
  check "$rc" 2 "guard refuses ($name: $p)"
done
guard "'$S/inner'"
err_has "✗ wolfpack: mount $S/inner overlaps a configured secret path $S (wolfpack-config.md → Execution Layer → Secrets paths) — refusing to start the container" "the refusal names the mount, the secret and the key"
for c in "disjoint|$SCRATCH/other" "sibling-prefix|$SCRATCH/sec-sibling" "symlink-elsewhere|$SCRATCH/link-to-other" "empty|"; do
  name=${c%%|*}; p=${c#*|}
  guard "'$p'"; rc=$?
  check "$rc" 0 "guard allows ($name)"
done
guard "'$SCRATCH/other' '$SCRATCH/sec-sibling' '$S/inner'"; rc=$?
check "$rc" 2 "one bad path among several → refused"
lib "WP_SECRETS_PATHS=(); wp_secrets_guard 'Secrets paths' /"; rc=$?
check "$rc" 0 "no secrets paths configured (none) → the guard is off"
lib "WP_SECRETS_PATHS=(\"$SCRATCH/link-to-sec\"); wp_secrets_guard 'Secrets paths' '$S/inner'"; rc=$?
check "$rc" 2 "a SYMLINKED secrets path is normalised too"

# ─── wp_build_args / wp_base_image_name ───────────────────────
out=$(lib 'wp_build_args')
check "$out" "$(printf '%s\n' --build-arg "USER_NAME=$(id -un)" --build-arg "USER_UID=$(id -u)" --build-arg "USER_GID=$(id -g)" --build-arg "USER_HOME=$HOME")" "wp_build_args: the four USER_* pairs, one argv word per line"
( env -u HOME bash -c "WP_CALLER=libtest; source '$LIB'; wp_build_args" >/dev/null 2>"$SCRATCH/err" ); rc=$?
check "$rc" 2 "wp_build_args with HOME unset → return 2"
err_has "HOME is not set" "…saying so"
check "$(lib 'wp_base_image_name fx-sandbox:latest')" "fx-sandbox-pack-base:latest" "base name: <name>-pack-base:<tag>"
check "$(lib 'wp_base_image_name localhost:5000/team/sb:v2')" "localhost:5000/team/sb-pack-base:v2" "base name: split at the LAST ':' (registry port kept)"

# ─── wp_load_exec_config ──────────────────────────────────────
mkcfg() {   # mkcfg <file> [extra sed expr]
  mkdir -p "$(dirname "$1")"
  awk '/^## Execution Layer/{skip=1; next} /^## /{skip=0} !skip' "$PACK/wolfpack-config.example.md" > "$1"
  cat >> "$1" <<CFG

## Execution Layer
- **Sandbox image:** \`fx-sandbox:latest\`
- **GLM image:** \`fx-sandbox-glm:latest\`
- **Sandbox project layer:** \`layers/Fx.Containerfile\`
- **Seat extra mounts:** \`$SCRATCH/m1\` \`$SCRATCH/m2:/opt/m2\`
- **Sandbox extra mounts:** \`$SCRATCH/s1\`
- **Secrets paths:** \`$S\` \`/etc/fixture-keys\`
- **Vibe agent dir:** \`$SCRATCH/agents\`
- **Seat test env:** \`A=1\` \`B=two words\`
CFG
  [ -n "${2:-}" ] && sed -i "$2" "$1"
  return 0
}
REPO="$SCRATCH/repo"; mkcfg "$REPO/wolfpack-config.md"
dump='printf "%s\n" "$WP_CFG_PATH" "$WP_SANDBOX_IMAGE" "$WP_GLM_IMAGE" "$WP_PROJECT_LAYER" "$WP_VIBE_AGENT_DIR" "${#WP_SEAT_MOUNTS[@]}" "${WP_SEAT_MOUNTS[@]}" "${#WP_SANDBOX_MOUNTS[@]}" "${WP_SANDBOX_MOUNTS[@]}" "${#WP_SECRETS_PATHS[@]}" "${WP_SECRETS_PATHS[@]}" "${#WP_SEAT_ENV[@]}" "${WP_SEAT_ENV[@]}"'
out=$(lib "wp_load_exec_config '$REPO' && $dump"); rc=$?
check "$rc" 0 "wp_load_exec_config <repo> → 0"
want=$(printf '%s\n' "$REPO/wolfpack-config.md" fx-sandbox:latest fx-sandbox-glm:latest "$REPO/layers/Fx.Containerfile" "$SCRATCH/agents" \
  2 "$SCRATCH/m1:$SCRATCH/m1" "$SCRATCH/m2:/opt/m2" 1 "$SCRATCH/s1:$SCRATCH/s1" 2 "$S" /etc/fixture-keys 2 A=1 "B=two words")
check "$out" "$want" "every field and array parsed from the reader's TAB lines (values with spaces intact)"
# WOLFPACK_CONFIG wins over <repo>/wolfpack-config.md.
ALT="$SCRATCH/alt/wolfpack-config.md"; mkcfg "$ALT" 's/`fx-sandbox:latest`/`alt-sb:1`/'
out=$(WOLFPACK_CONFIG="$ALT" lib "wp_load_exec_config '$REPO' && echo \"\$WP_CFG_PATH \$WP_SANDBOX_IMAGE\"")
check "$out" "$ALT alt-sb:1" "WOLFPACK_CONFIG overrides the repo's config"
WOLFPACK_CONFIG="alt/wolfpack-config.md" lib "wp_load_exec_config '$REPO'"; rc=$?
check "$rc" 2 "a relative WOLFPACK_CONFIG → 2"
err_has "✗ libtest: WOLFPACK_CONFIG must be an absolute path (got 'alt/wolfpack-config.md')" "…prefixed with the caller and naming the value"
WOLFPACK_CONFIG="$SCRATCH/nope.md" lib "wp_load_exec_config '$REPO'"; rc=$?
check "$rc" 2 "a WOLFPACK_CONFIG that does not exist → 2"
err_has "WOLFPACK_CONFIG names a file that does not exist: $SCRATCH/nope.md" "…naming the path"
for r in "" "$SCRATCH/no-such-repo"; do
  lib "wp_load_exec_config '$r'"; rc=$?
  check "$rc" 2 "no config ('${r:-<empty repo root>}') → 2"
  err_has "no wolfpack-config.md — run from the consuming repo's root or set WOLFPACK_CONFIG" "…with the fix"
done
# The reader's ✗ line (naming the KEY as written) reaches the user verbatim.
BAD="$SCRATCH/bad/wolfpack-config.md"; mkcfg "$BAD" '/^- \*\*GLM image:\*\*/d; /^- \*\*Vibe agent dir:\*\*/d'
lib "wp_load_exec_config '$SCRATCH/bad'"; rc=$?
check "$rc" 2 "a missing key → 2"
err_has "✗ wolfpack-config: Execution Layer: missing GLM image, Vibe agent dir" "the reader's key-named error is relayed verbatim"
err_has "✗ libtest: wolfpack-config.md → Execution Layer is incomplete or invalid ($BAD); check: node $PACK/scripts/wolfpack-config.mjs --exec $BAD" "…plus the check command"
mkcfg "$BAD" 's/`fx-sandbox:latest`/`no-tag`/'
lib "wp_load_exec_config '$SCRATCH/bad'"; rc=$?
check "$rc" 2 "an invalid value → 2"
err_has "Sandbox image 'no-tag' must carry an explicit :tag" "…the reader's problem is relayed"
# Arrays are reset on every load (no state leaks between two configs).
NOMOUNT="$SCRATCH/nm/wolfpack-config.md"; mkcfg "$NOMOUNT" 's/^- \*\*Seat extra mounts:\*\*.*/- **Seat extra mounts:** none/'
out=$(lib "wp_load_exec_config '$REPO' && WOLFPACK_CONFIG='$NOMOUNT' wp_load_exec_config '$REPO' && echo \${#WP_SEAT_MOUNTS[@]}")
check "$out" "0" "a second load resets the arrays"
# No node on PATH → 2 with the reason.
NONODE="$SCRATCH/nonode"; mkdir -p "$NONODE"
for d in /usr/local/bin /usr/bin /bin; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do b=${f##*/}; [ "$b" = node ] && continue; [ -e "$NONODE/$b" ] || ln -s "$f" "$NONODE/$b" 2>/dev/null; done
done
( PATH="$NONODE" bash -c "WP_CALLER=libtest; source '$LIB'; wp_load_exec_config '$REPO'" >/dev/null 2>"$SCRATCH/err" ); rc=$?
check "$rc" 2 "no node on PATH → 2"
err_has "needs node to read wolfpack-config.md ($REPO/wolfpack-config.md)" "…saying why"

echo
echo "──────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
