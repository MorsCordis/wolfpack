#!/usr/bin/env bash
# Static tests for the pack's sandbox Containerfiles — run: bash scripts/wolfpack-containerfiles.test.sh
# No podman: asserts the base image is project-neutral (no home paths, no fixed user, no
# project dependency file, no database), takes its container user from REQUIRED build args
# with a loud guard, owns the pre-created seat dirs, isolates Vibe in a venv, and that the GLM
# layer builds FROM a required BASE_IMAGE and upgrades Vibe through that venv.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACK=$(cd "$HERE/.." && pwd)
BASE="$PACK/containers/Containerfile.wolfpack"
GLM="$PACK/containers/Containerfile.wolfpack-glm"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
no()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
has() { if grep -qE -- "$2" "$1"; then ok "$3"; else no "$3 (no /$2/ in ${1##*/})"; fi; }
hasnt() { if grep -qiE -- "$2" "$1"; then no "$3 ($(grep -niE -- "$2" "$1" | head -2 | tr '\n' '|'))"; else ok "$3"; fi; }
# Instruction lines only (comments stripped), for ordering checks.
instr() { grep -vE '^[[:space:]]*(#|$)' "$1"; }

for f in "$BASE" "$GLM"; do
  [ -f "$f" ] && ok "${f#"$PACK"/} exists" || { no "${f#"$PACK"/} missing"; continue; }
  hasnt "$f" '/home/' "${f##*/}: no /home/ path"
  hasnt "$f" '(groupadd|useradd) +-[ug] +[0-9]' "${f##*/}: no hard-coded uid/gid"
  bad=$(instr "$f" | grep -E '^(USER|ENV HOME=)' | grep -vE '^USER (root|\$\{[A-Z_]+\})$|^ENV HOME=\$\{[A-Z_]+\}$')
  [ -z "$bad" ] && ok "${f##*/}: every USER / HOME is root or a \${…} build value" || no "${f##*/}: hard-coded USER/HOME: $bad"
  hasnt "$f" 'requirements\.txt' "${f##*/}: no project dependency file"
  hasnt "$f" 'postgres' "${f##*/}: no database"
  hasnt "$f" 'django' "${f##*/}: no web framework"
done

# ─── base ──────────────────────────────────────────────────────
for a in USER_NAME USER_UID USER_GID USER_HOME; do
  has "$BASE" "^ARG ${a}\$" "base: ARG ${a} declared with NO default"
  instr "$BASE" | grep -qE "^ARG ${a}=" && no "base: ARG ${a} has a default" || ok "base: ARG ${a} has no default"
done
has "$BASE" 'test -n "\$\{USER_NAME\}" && test -n "\$\{USER_UID\}" && test -n "\$\{USER_GID\}" && test -n "\$\{USER_HOME\}"' "base: a RUN guard fails the build when a USER_* arg is missing"
has "$BASE" 'exit 1; \}' "base: …the guard exits non-zero"
has "$BASE" 'useradd -u "\$\{USER_UID\}" -g "\$\{USER_GID\}" -d "\$\{USER_HOME\}" -m -s /bin/bash "\$\{USER_NAME\}"$' "base: the user is created from the build args"
has "$BASE" 'groupadd -g "\$\{USER_GID\}" "\$\{USER_NAME\}"' "base: the group is created from the build args"
has "$BASE" 'chown -R \$\{USER_NAME\}:\$\{USER_NAME\} \$\{USER_HOME\}' "base: the pre-created seat dirs are chowned to the seat user"
for d in .vibe/logs .vibe/vibehistory .vibe/cache .claude; do
  has "$BASE" "\"\\\$\\{USER_HOME\\}/${d//./\\.}\"" "base: pre-creates \${USER_HOME}/${d}"
done
has "$BASE" '^ENV HOME=\$\{USER_HOME\}$' "base: HOME from the build arg"
has "$BASE" '^ENV WOLFPACK_USER=\$\{USER_NAME\}$' "base: WOLFPACK_USER exported (project + GLM layers end USER \${WOLFPACK_USER})"
has "$BASE" '^USER \$\{USER_NAME\}$' "base: runs as the seat user"
has "$BASE" 'python -m venv /opt/vibe' "base: Vibe in its own venv"
has "$BASE" '/opt/vibe/bin/pip install --no-cache-dir mistral-vibe' "base: Vibe installed with the venv's pip"
has "$BASE" 'ln -s /opt/vibe/bin/vibe /usr/local/bin/vibe' "base: vibe on PATH via a symlink"
instr "$BASE" | grep -E '^RUN .*pip install' | grep -vq '/opt/vibe/bin/pip' && no "base: a pip install outside the Vibe venv" || ok "base: every pip install targets the Vibe venv"
for pkg in git jq dbus libsecret-1-0 curl ca-certificates gnupg; do
  has "$BASE" "(^|[[:space:]])${pkg}([[:space:]]|$)" "base: installs ${pkg}"
done
# Ordering: the guard runs before the user is created; the chown before USER.
g=$(instr "$BASE" | grep -n 'test -n' | head -1 | cut -d: -f1)
u=$(instr "$BASE" | grep -n 'useradd' | head -1 | cut -d: -f1)
c=$(instr "$BASE" | grep -n 'chown -R' | head -1 | cut -d: -f1)
s=$(instr "$BASE" | grep -n '^USER ' | head -1 | cut -d: -f1)
[ -n "$g" ] && [ -n "$u" ] && [ "$g" -lt "$u" ] && ok "base: the arg guard precedes useradd" || no "base: guard order ($g/$u)"
[ -n "$c" ] && [ -n "$s" ] && [ "$c" -lt "$s" ] && ok "base: the chown precedes USER" || no "base: chown order ($c/$s)"

# ─── GLM layer ────────────────────────────────────────────────
first=$(instr "$GLM" | head -1); second=$(instr "$GLM" | sed -n 2p)
[ "$first" = "ARG BASE_IMAGE" ] && ok "glm: ARG BASE_IMAGE (no default) is the first instruction" || no "glm: first instruction is '$first'"
[ "$second" = 'FROM ${BASE_IMAGE}' ] && ok 'glm: FROM ${BASE_IMAGE} right after it' || no "glm: second instruction is '$second'"
instr "$GLM" | grep -qE '^ARG BASE_IMAGE=' && no "glm: BASE_IMAGE has a default" || ok "glm: BASE_IMAGE has no default (an unset one fails the build)"
has "$GLM" '^RUN /opt/vibe/bin/pip install --no-cache-dir --upgrade "mistral-vibe>=2\.24\.1"$' "glm: upgrades Vibe through the venv's pip"
has "$GLM" '^USER \$\{WOLFPACK_USER\}$' "glm: back to the seat user (from the base's ENV)"
instr "$GLM" | grep -qE '^FROM [a-z]' && no "glm: a hard-coded FROM image" || ok "glm: no hard-coded FROM image"

echo
echo "──────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
