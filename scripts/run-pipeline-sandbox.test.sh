#!/usr/bin/env bash
# Tests for scripts/run-pipeline-sandbox.sh — run: bash scripts/run-pipeline-sandbox.test.sh
# No podman, no network: a FAKE podman on PATH logs every call (and echoes `run` argv), an
# isolated HOME holds stand-in credential files, a REAL unix socket stands in for the D-Bus
# session bus (WOLFPACK_DBUS_SOCKET), and a temp git checkout is the consuming repo whose
# wolfpack-config.md → Execution Layer drives the launcher.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAUNCHER="${HERE}/run-pipeline-sandbox.sh"
PACK=$(cd "$HERE/.." && pwd)

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
SCRATCH=$(realpath "$SCRATCH")
export TMPDIR="$SCRATCH/tmp"; mkdir -p "$TMPDIR"
export HOME="$SCRATCH/home"
mkdir -p "$HOME/.vibe/agents-headless" "$HOME/.vibe/prompts" "$HOME/.claude" "$HOME/.local/share/claude" "$HOME/.local/bin" "$HOME/.config/gcloud" "$SCRATCH/bin" "$SCRATCH/secrets"
touch "$HOME/.vibe/.env" "$HOME/.vibe/config.toml" "$HOME/.claude/.credentials.json" "$HOME/.local/bin/claude"
echo '{}' > "$HOME/.claude.json"
SOCK="$SCRATCH/bus"
python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$SOCK"
export WOLFPACK_DBUS_SOCKET="$SOCK"
unset WOLFPACK_HOME WOLFPACK_CONFIG

cat > "$SCRATCH/bin/podman" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$PODMAN_LOG"
if [ "${1:-}" = "image" ]; then
  if [ -n "${FAKE_ABSENT:-}" ] && [[ "$3" =~ $FAKE_ABSENT ]]; then exit 1; fi
  exit 0
fi
[ "${1:-}" = "build" ] && exit 0
for a in "$@"; do printf '%s\n' "$a"; done
FAKE
chmod +x "$SCRATCH/bin/podman"
export PATH="$SCRATCH/bin:$PATH"
export PODMAN_LOG="$SCRATCH/podman.log"

PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); echo "ok   - $1"; }
no()    { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else no "$3 (want '$2' got '$1')"; fi; }
err_has() { if grep -qF -- "$1" "$SCRATCH/err"; then ok "$2"; else no "$2 (stderr: $(tr '\n' '|' < "$SCRATCH/err"))"; fi; }
vmount() { if grep -B1 -xF -- "$2" <<<"$1" | head -1 | grep -qxF -- "-v"; then ok "$3"; else no "$3 (no '-v $2')"; fi; }
env_has() { if grep -A1 -xF -- "-e" <<<"$1" | grep -qxF -- "$2"; then ok "$3"; else no "$3 (no '-e $2')"; fi; }
no_podman() { if [ -s "$PODMAN_LOG" ]; then no "$1 (podman was called: $(tr '\n' '|' < "$PODMAN_LOG"))"; else ok "$1"; fi; }

# The consuming repo: a git checkout with a wolfpack-config.md (the example's sections + a
# fixture Execution Layer; CFG_* override values).
REPO="$SCRATCH/consumer"; mkdir -p "$REPO"; git -C "$REPO" init -q
mkcfg() {
  local f="$REPO/wolfpack-config.md"
  awk '/^## Execution Layer/{skip=1; next} /^## /{skip=0} !skip' "$PACK/wolfpack-config.example.md" > "$f"
  {
    echo; echo "## Execution Layer"
    echo "- **Sandbox image:** ${CFG_SANDBOX-\`fx-sandbox:latest\`}"
    echo "- **GLM image:** \`fx-sandbox-glm:latest\`"
    echo "- **Sandbox project layer:** none"
    echo "- **Seat extra mounts:** none"
    echo "- **Sandbox extra mounts:** ${CFG_SANDBOX_MOUNTS-none}"
    echo "- **Secrets paths:** ${CFG_SECRETS-\`$SCRATCH/secrets\`}"
    echo "- **Vibe agent dir:** ${CFG_AGENTS-\`$HOME/.vibe/agents-headless\`}"
    echo "- **Seat test env:** none"
  } >> "$f"
}
# launch [env…]: the interactive (no-arg) mode from the consuming repo's root.
launch() { : > "$PODMAN_LOG"; ( cd "$REPO" && env "$@" bash "$LAUNCHER" 2>"$SCRATCH/err" ); }

bash -n "$LAUNCHER" && ok "run-pipeline-sandbox.sh parses" || no "run-pipeline-sandbox.sh syntax"

# ─── happy path: the argv ───────────────────────────────────────
mkcfg
out=$(launch X=1); rc=$?
check "$rc" 0 "default config → rc 0"
vmount "$out" "${PACK}:${PACK}:ro" "the pack is mounted read-only at its host path"
env_has "$out" "WOLFPACK_HOME=${PACK}" "…and exported as WOLFPACK_HOME (the workflows inside resolve the shim)"
env_has "$out" "WOLFPACK_SANDBOX=1" "WOLFPACK_SANDBOX=1 inside the container"
vmount "$out" "${REPO}:/workspace:rw" "the consuming repo is the workspace"
vmount "$out" "${HOME}/.vibe/agents-headless:${HOME}/.vibe/agents:ro" "the configured Vibe agent dir → ~/.vibe/agents (ro)"
vmount "$out" "${SOCK}:${SOCK}" "the D-Bus socket (WOLFPACK_DBUS_SOCKET seam)"
grep -q "GOOGLE_APPLICATION_CREDENTIALS" <<<"$out" && no "GOOGLE_APPLICATION_CREDENTIALS is still set" || ok "no GOOGLE_APPLICATION_CREDENTIALS"
grep -qF -- ".config/gcloud" <<<"$out" && no "a gcloud config mount without a Sandbox extra mounts entry" || ok "no gcloud mount unless configured"
grep -q "^fx-sandbox:latest$" <<<"$out" && ok "runs the configured Sandbox image" || no "image ($out)"
grep -q '^build ' "$PODMAN_LOG" && no "image present but a build ran" || ok "image present → no build"

# WOLFPACK_HOME, when set, is what the container is told (and what is mounted).
OTHER="$SCRATCH/other-pack"; mkdir -p "$OTHER"
out=$(launch WOLFPACK_HOME="$OTHER"); rc=$?
check "$rc" 0 "WOLFPACK_HOME set → rc 0"
vmount "$out" "${OTHER}:${OTHER}:ro" "WOLFPACK_HOME is the mounted pack"
env_has "$out" "WOLFPACK_HOME=${OTHER}" "…and the exported WOLFPACK_HOME"
launch WOLFPACK_HOME=rel/pack >/dev/null; rc=$?
check "$rc" 2 "a relative WOLFPACK_HOME → exit 2"
err_has "WOLFPACK_HOME must be an absolute path" "…saying so"
no_podman "…no podman call"

# ─── Sandbox extra mounts: always :ro; the host path must exist ─────
mkdir -p "$SCRATCH/tool"
CFG_SANDBOX_MOUNTS="\`~/.config/gcloud\` \`$SCRATCH/tool:/opt/tool\`" mkcfg
out=$(launch X=1); rc=$?
check "$rc" 0 "Sandbox extra mounts → rc 0"
vmount "$out" "${HOME}/.config/gcloud:${HOME}/.config/gcloud:ro" "a configured ~ mount, read-only (the gcloud dir is now config, not hard-coded)"
vmount "$out" "${SCRATCH}/tool:/opt/tool:ro" "a host:container mount, read-only"
grep -q "GOOGLE_APPLICATION_CREDENTIALS" <<<"$out" && no "the gcloud mount brought back the credentials env var" || ok "…still no GOOGLE_APPLICATION_CREDENTIALS"
CFG_SANDBOX_MOUNTS="\`$SCRATCH/absent-dir\`" mkcfg
launch X=1 >/dev/null; rc=$?
check "$rc" 2 "a missing Sandbox extra mounts host path → exit 2"
err_has "Sandbox extra mounts host path does not exist: $SCRATCH/absent-dir" "…naming the key and path"
no_podman "…no podman call"
CFG_SANDBOX_MOUNTS="\`$SCRATCH/tool:/x:rw\`" mkcfg
launch X=1 >/dev/null; rc=$?
check "$rc" 2 "a Sandbox extra mount with options → exit 2 (reader problem)"
no_podman "…no podman call"

# ─── the secrets guard: before ANY build or run (images absent) ─────
mkdir -p "$SCRATCH/secrets/inner"
for c in "under|\`$SCRATCH/secrets/inner\`" "equal|\`$SCRATCH/secrets\`" "contains|\`$SCRATCH\`"; do
  name=${c%%|*}; val=${c#*|}
  CFG_SANDBOX_MOUNTS="$val" mkcfg
  launch FAKE_ABSENT='.' >/dev/null; rc=$?
  check "$rc" 2 "a Sandbox extra mount that $name the secrets path → exit 2"
  err_has "(wolfpack-config.md → Execution Layer → Secrets paths) — refusing to start the container" "…($name) naming the key"
  no_podman "…($name) no podman build, no podman run"
done
# Built-in mounts are guarded too: a secrets path under the Vibe agent dir / the home dir.
CFG_SANDBOX_MOUNTS=none CFG_SECRETS="\`$HOME/.claude/.credentials.json\`" mkcfg
launch FAKE_ABSENT='.' >/dev/null; rc=$?
check "$rc" 2 "a secrets path inside a BUILT-IN mount (~/.claude) → exit 2"
no_podman "…no podman call"
CFG_SECRETS="\`$PACK\`" mkcfg
launch FAKE_ABSENT='.' >/dev/null; rc=$?
check "$rc" 2 "the pack mount itself is guarded (secrets path = the pack) → exit 2"

# ─── image absent → built AFTER the guard, then run ─────────────
CFG_SECRETS="\`$SCRATCH/secrets\`" mkcfg
out=$(launch FAKE_ABSENT='.'); rc=$?
check "$rc" 0 "image absent → built, then run (rc 0)"
grep -qxF "build --build-arg USER_NAME=$(id -un) --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) --build-arg USER_HOME=${HOME} -t fx-sandbox:latest -f ${PACK}/containers/Containerfile.wolfpack ${PACK}/containers" "$PODMAN_LOG" \
  && ok "the pack base built as the Sandbox image (no layer configured)" || no "build line ($(grep '^build' "$PODMAN_LOG"))"
B=$(grep -n '^build ' "$PODMAN_LOG" | head -1 | cut -d: -f1); R=$(grep -n '^run ' "$PODMAN_LOG" | head -1 | cut -d: -f1)
[ -n "$B" ] && [ -n "$R" ] && [ "$B" -lt "$R" ] && ok "build before run" || no "order (build $B, run $R)"

# ─── fail loud on the config / environment ─────────────────────
CFG_AGENTS="\`$SCRATCH/no-agents\`" mkcfg
launch X=1 >/dev/null; rc=$?
check "$rc" 2 "a missing Vibe agent dir → exit 2"
err_has "the configured Vibe agent dir does not exist: $SCRATCH/no-agents" "…naming it"
no_podman "…no podman call"
CFG_SANDBOX=none mkcfg
launch X=1 >/dev/null; rc=$?
check "$rc" 2 "Sandbox image: none → exit 2"
err_has "Execution Layer: missing Sandbox image" "…naming the key"
rm -f "$REPO/wolfpack-config.md"
launch X=1 >/dev/null; rc=$?
check "$rc" 2 "no wolfpack-config.md in the consuming repo → exit 2"
err_has "no wolfpack-config.md" "…saying so"
mkcfg
mkdir -p "$SCRATCH/not-git"
: > "$PODMAN_LOG"
( cd "$SCRATCH/not-git" && bash "$LAUNCHER" >/dev/null 2>"$SCRATCH/err" ); rc=$?
check "$rc" 1 "outside a git checkout → exit 1"
err_has "run from the consuming repo's checkout" "…with the fix"
no_podman "…no podman call"
# WOLFPACK_CONFIG overrides the repo's config.
ALT="$SCRATCH/alt"; mkdir -p "$ALT"; cp "$REPO/wolfpack-config.md" "$ALT/wolfpack-config.md"
sed -i 's/`fx-sandbox:latest`/`alt-sandbox:v1`/' "$ALT/wolfpack-config.md"
out=$(launch WOLFPACK_CONFIG="$ALT/wolfpack-config.md"); rc=$?
check "$rc" 0 "WOLFPACK_CONFIG → rc 0"
grep -q "^alt-sandbox:v1$" <<<"$out" && ok "WOLFPACK_CONFIG's Sandbox image is used" || no "WOLFPACK_CONFIG ignored"
# The monitor is the PACK's (static check: the launcher never runs a consuming repo's copy).
grep -qF '"${PACK_DIR}/scripts/wolfpack-watch.sh" --loop' "$LAUNCHER" && ok "the auto-monitor is the pack's wolfpack-watch.sh" || no "monitor path"
grep -qF 'REPO_ROOT}/scripts/' "$LAUNCHER" && no "the launcher still runs a script from the consuming repo" || ok "no script is run from the consuming repo"

echo
echo "──────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
