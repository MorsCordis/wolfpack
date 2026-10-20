#!/usr/bin/env bash
# Tests for scripts/podman-vibe.sh — run: bash scripts/podman-vibe.test.sh
# No network, no podman, no real Vibe: runs the shim in WOLFPACK_SANDBOX mode (direct
# `vibe` call) against a FAKE `vibe` on PATH that echoes its argv, with an isolated
# HOME + TMPDIR. Asserts the per-family command line (mistral unchanged, glm gets
# --auto-approve + the strict allow-list), --implement gating, and the per-family
# rate-limit exit contract (exit 75 + WOLFPACK_RATE_LIMITED:<family>), and seat handoff mode
# (seat-handoff-writes: a git fixture worktree + a fake seat that writes into the out dir).
# The podman path (a FAKE podman on PATH) reads a fixture wolfpack-config.md → Execution Layer
# through WOLFPACK_CONFIG: image names, the image build chain, seat extra mounts, the secrets
# guard, the Vibe agent dir, the seat test env and the fail-loud missing-key cases.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SHIM="${HERE}/podman-vibe.sh"
PACK=$(cd "$HERE/.." && pwd)

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
SCRATCH=$(realpath "$SCRATCH")
export TMPDIR="$SCRATCH/tmp"; mkdir -p "$TMPDIR"
export HOME="$SCRATCH/home"; mkdir -p "$HOME/.vibe" "$SCRATCH/bin" "$SCRATCH/wt"
touch "$HOME/.vibe/.env" "$HOME/.vibe/config.toml"
mkdir -p "$HOME/.vibe/agents-headless" "$SCRATCH/secrets"
echo "review this" > "$SCRATCH/prompt.txt"

# mkcfg <dir>: writes <dir>/wolfpack-config.md = the pack's example config with its
# Execution Layer replaced by a fixture one. CFG_<KEY> overrides a value (the whole text after
# the key, backticks included); CFG_OMIT="<written key>[|<key>…]" drops lines entirely.
mkcfg() {
  local dir="$1" f
  mkdir -p "$dir"; f="$dir/wolfpack-config.md"
  awk '/^## Execution Layer/{skip=1; next} /^## /{skip=0} !skip' "$PACK/wolfpack-config.example.md" > "$f"
  {
    echo; echo "## Execution Layer"
    echo "- **Sandbox image:** ${CFG_SANDBOX-\`fx-sandbox:latest\`}"
    echo "- **GLM image:** ${CFG_GLM-\`fx-sandbox-glm:latest\`}"
    echo "- **Sandbox project layer:** ${CFG_LAYER-none}"
    echo "- **Seat extra mounts:** ${CFG_SEAT_MOUNTS-none}"
    echo "- **Sandbox extra mounts:** ${CFG_SANDBOX_MOUNTS-none}"
    echo "- **Secrets paths:** ${CFG_SECRETS-\`$SCRATCH/secrets\`}"
    echo "- **Vibe agent dir:** ${CFG_AGENTS-\`$HOME/.vibe/agents-headless\`}"
    echo "- **Seat test env:** ${CFG_SEAT_ENV-\`SECRET_KEY=wolfpack-review-sandbox-test-only\`}"
  } > "$f.exec"
  if [ -n "${CFG_OMIT:-}" ]; then
    grep -vE "^- \*\*(${CFG_OMIT}):\*\*" "$f.exec" >> "$f"
  else
    cat "$f.exec" >> "$f"
  fi
  rm -f "$f.exec"
  echo "$f"
}
export WOLFPACK_CONFIG; WOLFPACK_CONFIG=$(mkcfg "$SCRATCH/cfg")
node "$PACK/scripts/wolfpack-config.mjs" --exec "$WOLFPACK_CONFIG" >/dev/null \
  || { echo "FAIL - fixture config does not read clean"; exit 1; }

# Fake vibe: print argv (one per line) to stdout; behaviour steered by env.
cat > "$SCRATCH/bin/vibe" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "--help" ]; then [ -z "${FAKE_VIBE_OLD:-}" ] && echo "  --auto-approve, --yolo"; exit 0; fi
if [ "${1:-}" = "--version" ]; then echo "vibe 0.0-fake"; exit 0; fi
[ -n "${FAKE_VIBE_COUNT:-}" ] && echo x >> "$FAKE_VIBE_COUNT"
[ -n "${FAKE_VIBE_SLEEP:-}" ] && sleep "$FAKE_VIBE_SLEEP"
if [ -n "${FAKE_VIBE_ERR:-}" ]; then echo "$FAKE_VIBE_ERR" >&2; exit "${FAKE_VIBE_RC:-1}"; fi
for a in "$@"; do printf '%s\n' "$a"; done
FAKE
chmod +x "$SCRATCH/bin/vibe"
export PATH="$SCRATCH/bin:$PATH"
export WOLFPACK_SANDBOX=1 WOLFPACK_RETRY_DELAY=1 WOLFPACK_MAX_DELAY=1
unset WOLFPACK_VIBE_FAMILY WOLFPACK_VIBE_TOOLS WOLFPACK_GLM_TOOLS WOLFPACK_MAX_RETRIES WOLFPACK_SEM_MAX

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $1"; }
no()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
has()    { if grep -qxF -- "$2" <<<"$1"; then ok "$3"; else no "$3 (missing '$2')"; fi; }
hasnt()  { if grep -qxF -- "$2" <<<"$1"; then no "$3 (unexpected '$2')"; else ok "$3"; fi; }
tools()  { awk 'prev=="--enabled-tools"{print} {prev=$0}' <<<"$1" | tr '\n' ' ' | sed 's/ $//'; }
check()  { if [ "$1" = "$2" ]; then ok "$3"; else no "$3 (want '$2' got '$1')"; fi; }
run()    { bash "$SHIM" "$@" 2>"$SCRATCH/err"; }

# ─── mistral (legacy agent) — unchanged ────────────────────────
out=$(run wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" 15); rc=$?
check "$rc" 0 "mistral review → rc 0"
check "$(tools "$out")" "read grep edit write_file bash" "mistral keeps VIBE_TOOLS_DEFAULT"
hasnt "$out" "--auto-approve" "mistral: no --auto-approve"
has "$out" "--max-tokens" "mistral: keeps the --max-tokens cost guard"
has "$out" "15" "mistral: caller's max-turns passed through"
[ -d "$TMPDIR/wolfpack-sem/mistral" ] && ok "mistral sem dir = wolfpack-sem/mistral" || no "mistral sem dir missing"

# ─── glm review ───────────────────────────────────────────────
out=$(run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "glm review → rc 0"
check "$(tools "$out")" "read_file grep bash write_file dev_cortex_repo_map dev_cortex_file_outline" "glm review: sandbox-scoped shell + write_file, no edit"
hasnt "$out" "edit" "glm review: no edit"
has "$out" "write_file" "glm review: write_file (the seat writes its own handoff file — seat-handoff-writes)"
hasnt "$out" "task" "glm review: no task"
has "$out" "--auto-approve" "glm review: --auto-approve (the allow-list is the sandbox)"
has "$out" "80" "glm review: default max-turns 80"
hasnt "$out" "--max-tokens" "glm review: no token cap by default (timeouts instead)"
has "$out" "wolfpack-pointer-glm" "glm review: agent passed through"
[ -d "$TMPDIR/wolfpack-sem/glm" ] && ok "glm sem dir = wolfpack-sem/glm" || no "glm sem dir missing"

# WOLFPACK_VIBE_FAMILY=glm on a legacy agent name also selects the glm path.
out=$(WOLFPACK_VIBE_FAMILY=glm run review-anything "$SCRATCH/wt" "$SCRATCH/prompt.txt")
has "$out" "--auto-approve" "WOLFPACK_VIBE_FAMILY=glm selects the glm path"

# An operator allow-list keeps bash for REVIEW (review seats get a sandboxed shell)…
out=$(WOLFPACK_GLM_TOOLS="read_file bash grep" run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
check "$(tools "$out")" "read_file bash grep" "glm review: an operator allow-list keeps bash"
# …but task is still dropped from it (GLM_REVIEW_DROP), loudly.
out=$(WOLFPACK_GLM_TOOLS="read_file task grep" run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
check "$(tools "$out")" "read_file grep" "glm review: task is stripped from an operator allow-list"
grep -q "'task' dropped from the GLM review allow-list" "$SCRATCH/err" && ok "…with a warning naming the tool and mode" || no "review task-drop warning ($(cat "$SCRATCH/err"))"
# seat-handoff-writes AC2: edit is dropped from a REVIEW override too (review seats are edit-denied by role).
out=$(WOLFPACK_GLM_TOOLS="read_file grep bash edit" run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
check "$(tools "$out")" "read_file grep bash" "glm review: edit is stripped from an operator allow-list"
grep -q "'edit' dropped from the GLM review allow-list" "$SCRATCH/err" && ok "…with a warning naming edit and review" || no "review edit-drop warning ($(cat "$SCRATCH/err"))"
out=$(WOLFPACK_GLM_TOOLS="read_file grep bash write_file edit" run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
check "$(tools "$out")" "read_file grep bash write_file" "glm review: an override keeps write_file and loses edit"
# bash smuggled into the IMPLEMENT allow-list is dropped (implement stays shell-free).
out=$(WOLFPACK_GLM_IMPLEMENT_TOOLS="read_file bash edit" run --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
check "$(tools "$out")" "read_file edit" "glm implement: bash is stripped from an operator allow-list"
grep -q "'bash' dropped from the GLM implement allow-list" "$SCRATCH/err" && ok "…with a warning naming bash and implement" || no "implement bash-drop warning ($(cat "$SCRATCH/err"))"
out=$(WOLFPACK_GLM_IMPLEMENT_TOOLS="read_file task edit" run --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
check "$(tools "$out")" "read_file edit" "glm implement: task is stripped too"

# ─── --implement ──────────────────────────────────────────────
out=$(run --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "glm implement → rc 0"
check "$(tools "$out")" "read_file grep write_file edit dev_cortex_repo_map dev_cortex_file_outline" "glm implement: write_file + edit, NO bash"
has "$out" "--auto-approve" "glm implement: --auto-approve"
has "$out" "150" "glm implement: default max-turns 150"
[ -d "$TMPDIR/wolfpack-sem/glm-implement" ] && ok "glm implement sem dir is separate" || no "glm implement sem dir missing"

run --implement wolfpack-shepherd "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "--implement on a mistral agent → exit 2 (glm only)"

# ─── per-family rate-limit contract ───────────────────────────
# A glm cooldown fast-exits 75 for glm WITHOUT touching mistral.
echo $(( $(date +%s) + 100 )) > "$TMPDIR/wolfpack-sem/glm.cooldown"
run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 75 "glm cooling down → exit 75"
grep -q '^WOLFPACK_RATE_LIMITED:glm' "$SCRATCH/err" && ok "glm cooldown prints WOLFPACK_RATE_LIMITED:glm" || no "glm sentinel missing"
run wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 0 "mistral still dispatches while glm cools down"
rm -f "$TMPDIR/wolfpack-sem/glm.cooldown"

# A glm transient (429) that exhausts retries WITHOUT tripping the breaker → exit 75.
out=$(FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_MAX_RETRIES=1 WOLFPACK_CB_FAILS=99 \
      run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 75 "glm transient exhaustion → exit 75"
grep -q '^WOLFPACK_RATE_LIMITED:glm' "$SCRATCH/err" && ok "glm transient exhaustion prints the sentinel" || no "glm transient sentinel missing"
# …whereas mistral keeps its historical contract (raw rc, no forced 75).
FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_MAX_RETRIES=1 WOLFPACK_CB_FAILS=99 \
      run wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 1 "mistral transient exhaustion → raw rc (unchanged)"
# A permanent glm error is NOT a rate limit.
FAKE_VIBE_ERR="Error: not authenticated (401)" run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 1 "glm permanent error → rc 1, not 75"

# In unified-sandbox mode an old Vibe without --auto-approve is a PERMANENT error for
# GLM (exit 2, loud) — never a hang, never misreported as a rate limit.
FAKE_VIBE_OLD=1 run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "sandbox vibe without --auto-approve → GLM exits 2 (permanent)"
grep -q "no --auto-approve" "$SCRATCH/err" && ok "…with a loud explanation" || no "old-vibe message missing"
out=$(FAKE_VIBE_OLD=1 run wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "old sandbox vibe does not affect the mistral path"

# ─── podman path (fake podman echoes argv): mounts + in-container command ──────
cat > "$SCRATCH/bin/podman" <<'FAKE'
#!/usr/bin/env bash
[ "${1:-}" = "image" ] && exit 0
for a in "$@"; do printf '%s\n' "$a"; done
FAKE
chmod +x "$SCRATCH/bin/podman"
WT=$(realpath "$SCRATCH/wt")
out=$(WOLFPACK_SANDBOX= run wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt")
has "$out" "${WT}:/workspace:ro,z" "podman mistral: worktree ro at /workspace (unchanged)"
has "$out" "fx-sandbox:latest" "podman mistral: the configured Sandbox image"
out=$(WOLFPACK_SANDBOX= run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
has "$out" "${WT}:${WT}:ro,z" "podman glm review: worktree ro at its HOST path (dev-cortex mirror)"
has "$out" "fx-sandbox-glm:latest" "podman glm: the configured GLM image (current Vibe)"
has "$out" 'exec vibe -p "$(cat /tmp/prompt.txt)" "$@" </dev/null' "podman glm: constant in-container script (no string-built command)"
has "$out" "--auto-approve" "podman glm: --auto-approve passed as its own argv element"
grep -A1 -xF -- "--workdir" <<<"$out" | tail -1 | grep -qxF -- "$WT" && ok "podman glm: host-path workdir passed as one argv element" || no "podman glm workdir argv"
out=$(WOLFPACK_SANDBOX= run --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
has "$out" "${WT}:${WT}:rw,z" "podman glm implement: worktree READ-WRITE"
grep -q -- ":ro,z" <<<"$(grep -F "${WT}/" <<<"$out")" && no "podman glm implement: ro context overlay present" || ok "podman glm implement: no ro context overlays over the rw worktree"

# Hostile worktree path (space + single quote) stays ONE inert argv element.
QWT="$SCRATCH/w t'q"; mkdir -p "$QWT"; QWT=$(realpath "$QWT")
out=$(WOLFPACK_SANDBOX= run wolfpack-pointer-glm "$QWT" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "podman glm: worktree path with a space and a quote → rc 0"
grep -A1 -xF -- "--workdir" <<<"$out" | tail -1 | grep -qxF -- "$QWT" && ok "…workdir arrives verbatim as one argument" || no "quoted-path workdir mangled"
has "$out" "${QWT}:${QWT}:ro,z" "…and mounts verbatim"
out=$(WOLFPACK_SANDBOX=1 run wolfpack-pointer-glm "$QWT" "$SCRATCH/prompt.txt"); rc=$?
grep -A1 -xF -- "--workdir" <<<"$out" | tail -1 | grep -qxF -- "$QWT" && ok "sandbox glm: quoted-path workdir verbatim" || no "sandbox quoted-path workdir"

# ─── git visibility in review mode (podman path, fake podman echoes argv) ──────
# A `git worktree` checkout's .git is a FILE pointing into <repo>/.git/worktrees/<slug>; the
# shim must mount that common dir read-only at its host path so `git diff` works inside.
GREPO="$SCRATCH/grepo"; mkdir -p "$GREPO"
git -C "$GREPO" init -q -b main 2>/dev/null || git -C "$GREPO" init -q
git -C "$GREPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$GREPO" worktree add -q "$GREPO/.claude/worktrees/gw" -b feat/gw 2>/dev/null
GWT=$(realpath "$GREPO/.claude/worktrees/gw"); GCOMMON=$(realpath "$GREPO/.git")
[ -f "$GWT/.git" ] && ok "fixture: git worktree with a .git FILE" || no "fixture: git worktree not created"
for agent in wolfpack-pointer-glm wolfpack-pointer; do
  out=$(WOLFPACK_SANDBOX= run "$agent" "$GWT" "$SCRATCH/prompt.txt"); rc=$?
  check "$rc" 0 "podman $agent on a git worktree → rc 0"
  has "$out" "${GCOMMON}:${GCOMMON}:ro,z" "podman $agent: git common dir mounted READ-ONLY at its host path"
  grep -qF -- "${GCOMMON}:${GCOMMON}:rw" <<<"$out" && no "podman $agent: git dir mounted rw" || ok "podman $agent: git dir never rw"
  has "$out" "GIT_OPTIONAL_LOCKS=0" "podman $agent: GIT_OPTIONAL_LOCKS=0 in the podman argv"
done
# A plain checkout (its .git DIR is inside the worktree mount) → no extra git mount.
PREPO="$SCRATCH/prepo"; mkdir -p "$PREPO"; git -C "$PREPO" init -q; PREPO=$(realpath "$PREPO")
out=$(WOLFPACK_SANDBOX= run wolfpack-pointer-glm "$PREPO" "$SCRATCH/prompt.txt")
hasnt "$out" "${PREPO}/.git:${PREPO}/.git:ro,z" "podman glm: plain checkout → no extra git mount (already inside the worktree mount)"
grep -qF -- "${PREPO}/.git:" <<<"$out" && no "plain checkout: its .git dir mounted separately" || ok "…no separate mount of the checkout's own .git dir"
# A non-git directory → loud warning, run continues.
out=$(WOLFPACK_SANDBOX= run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "podman glm: non-git worktree → the run continues"
grep -q "is not a git checkout — the reviewer cannot run git diff" "$SCRATCH/err" && ok "…with a loud warning" || no "non-git warning missing ($(cat "$SCRATCH/err"))"
# --implement never gets the git mount (the wrapper commits on the host).
out=$(WOLFPACK_SANDBOX= run --implement wolfpack-shepherd-glm "$GWT" "$SCRATCH/prompt.txt")
grep -qF -- "${GCOMMON}:${GCOMMON}" <<<"$out" && no "podman glm implement: git common dir mounted" || ok "podman glm implement: no git common-dir mount"
has "$out" "GIT_OPTIONAL_LOCKS=0" "podman glm implement: GIT_OPTIONAL_LOCKS=0 too (both podman run calls)"
# Review seats run the test command in the container: WOLFPACK_SANDBOX=1 (the image runtime) and
# the configured Seat test env (here a test-only SECRET_KEY) on BOTH podman run calls; never the
# host .env; never on --implement.
for agent in wolfpack-pointer-glm wolfpack-pointer; do
  out=$(WOLFPACK_SANDBOX= run "$agent" "$GWT" "$SCRATCH/prompt.txt")
  grep -A1 -xF -- "-e" <<<"$out" | grep -qxF "WOLFPACK_SANDBOX=1" && ok "podman $agent: -e WOLFPACK_SANDBOX=1 (tests use the image Python)" || no "podman $agent: WOLFPACK_SANDBOX=1 missing"
  grep -A1 -xF -- "-e" <<<"$out" | grep -qxF "SECRET_KEY=wolfpack-review-sandbox-test-only" && ok "podman $agent: test-only SECRET_KEY" || no "podman $agent: test-only SECRET_KEY missing"
  grep -qF -- "/.env:" <<<"$(grep -vF -- "/.vibe/.env:" <<<"$out")" && no "podman $agent: a project .env is mounted" || ok "podman $agent: no project .env mount"
done
out=$(WOLFPACK_SANDBOX= run --implement wolfpack-shepherd-glm "$GWT" "$SCRATCH/prompt.txt")
hasnt "$out" "WOLFPACK_SANDBOX=1" "podman glm implement: no WOLFPACK_SANDBOX=1 (no shell, no tests)"
grep -q -- "^SECRET_KEY=" <<<"$out" && no "podman glm implement: SECRET_KEY present" || ok "podman glm implement: no SECRET_KEY"
# A git common dir path containing ':' is never passed to -v (it would split the spec).
CREPO="$SCRATCH/c:repo"; mkdir -p "$CREPO"
git -C "$CREPO" init -q -b main 2>/dev/null || git -C "$CREPO" init -q
git -C "$CREPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$CREPO" worktree add -q "$SCRATCH/cwt" -b feat/c 2>/dev/null
out=$(WOLFPACK_SANDBOX= run wolfpack-pointer-glm "$SCRATCH/cwt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "podman glm: git common dir with ':' → run continues"
grep -qF -- "c:repo/.git:" <<<"$out" && no "a ':' git dir reached -v" || ok "…and the ':' path is not mounted"
grep -q "contains ':' or a newline — not mounting it" "$SCRATCH/err" && ok "…with a loud warning" || no "colon warning missing"
# WOLFPACK_SANDBOX mode (direct vibe): no git mount logic, no warning.
out=$(WOLFPACK_SANDBOX=1 run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
grep -q "is not a git checkout" "$SCRATCH/err" && no "sandbox mode ran the git-mount probe" || ok "sandbox mode: the unified container owns its mounts (no probe)"

# ─── fail-closed validation ───────────────────────────────────
WOLFPACK_SANDBOX=1 WOLFPACK_GLM_TOOLS="task" run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "EMPTY GLM allow-list (after filtering) → exit 2, never auto-approve every tool"
grep -q "allow-list is empty" "$SCRATCH/err" && ok "…with a loud explanation" || no "empty allow-list message missing"
WOLFPACK_SANDBOX=1 WOLFPACK_GLM_TOOLS=" " run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "blank GLM allow-list → exit 2"
WOLFPACK_SANDBOX=1 WOLFPACK_GLM_IMPLEMENT_TOOLS="bash task" run --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "EMPTY GLM implement allow-list (bash+task only) → exit 2"
WOLFPACK_SANDBOX=1 run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" '80; rm -rf /' >/dev/null; rc=$?
check "$rc" 2 "non-numeric max-turns → exit 2"
WOLFPACK_SANDBOX=1 WOLFPACK_GLM_MAX_TOKENS='1 --yolo' run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "non-numeric WOLFPACK_GLM_MAX_TOKENS → exit 2"
out=$(WOLFPACK_SANDBOX=1 WOLFPACK_GLM_MAX_TOKENS=5000 run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
grep -A1 -xF -- "--max-tokens" <<<"$out" | tail -1 | grep -qxF 5000 && ok "numeric WOLFPACK_GLM_MAX_TOKENS → --max-tokens 5000" || no "max-tokens argv"

for v in 0 00 -5 abc; do
  WOLFPACK_SANDBOX=1 WOLFPACK_VIBE_REVIEW_TIMEOUT="$v" run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
  check "$rc" 2 "WOLFPACK_VIBE_REVIEW_TIMEOUT=$v → exit 2 (a GLM run always keeps a wall-clock bound)"
done
WOLFPACK_SANDBOX=1 WOLFPACK_VIBE_IMPLEMENT_TIMEOUT=0 run --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "WOLFPACK_VIBE_IMPLEMENT_TIMEOUT=0 → exit 2"
grep -q "POSITIVE integer" "$SCRATCH/err" && ok "…with a loud explanation" || no "timeout=0 message missing"

# ─── timeout ≠ rate limit ─────────────────────────────────────
: > "$SCRATCH/count"
WOLFPACK_SANDBOX=1 FAKE_VIBE_SLEEP=5 FAKE_VIBE_COUNT="$SCRATCH/count" WOLFPACK_VIBE_REVIEW_TIMEOUT=1 \
    run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 76 "glm wall-clock timeout → exit 76 (not 75)"
grep -q '^WOLFPACK_TIMEOUT:glm' "$SCRATCH/err" && ok "timeout prints WOLFPACK_TIMEOUT:glm" || no "timeout sentinel missing"
grep -q '^WOLFPACK_RATE_LIMITED' "$SCRATCH/err" && no "timeout must NOT print WOLFPACK_RATE_LIMITED" || ok "timeout does not claim a rate limit"
check "$(wc -l < "$SCRATCH/count" | tr -d ' ')" 1 "timeout is NOT retried (one vibe invocation)"
[ -f "$TMPDIR/wolfpack-sem/glm.cooldown" ] && no "timeout tripped the glm breaker" || ok "timeout leaves the glm breaker closed"

# ─── --implement retry wiring: ONE attempt, then exit 75 ──────
: > "$SCRATCH/count"
WOLFPACK_SANDBOX=1 FAKE_VIBE_ERR="HTTP 429 Too Many Requests" FAKE_VIBE_COUNT="$SCRATCH/count" WOLFPACK_CB_FAILS=99 \
    run --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 75 "--implement transient → exit 75 (Claude fallback signal)"
check "$(wc -l < "$SCRATCH/count" | tr -d ' ')" 1 "--implement makes exactly ONE attempt (WOLFPACK_MAX_RETRIES=1 = total attempts)"
: > "$SCRATCH/count"
WOLFPACK_SANDBOX=1 FAKE_VIBE_ERR="HTTP 429 Too Many Requests" FAKE_VIBE_COUNT="$SCRATCH/count" WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=2 \
    run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null
check "$(wc -l < "$SCRATCH/count" | tr -d ' ')" 2 "review mode honours WOLFPACK_MAX_RETRIES (2 attempts)"
rm -f "$TMPDIR/wolfpack-sem/glm.cooldown" "$TMPDIR/wolfpack-sem/glm.fails"

# ─── GLM image build path (fake podman: GLM image missing) ────
cat > "$SCRATCH/bin/podman" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$PODMAN_LOG"
if [ "${1:-}" = "image" ]; then
  case "$3" in *"${FAKE_MISSING_IMAGE:-none}"*) exit 1 ;; *) exit 0 ;; esac
fi
[ "${1:-}" = "build" ] && exit 0
for a in "$@"; do printf '%s\n' "$a"; done
FAKE
chmod +x "$SCRATCH/bin/podman"
export PODMAN_LOG="$SCRATCH/podman.log"; : > "$PODMAN_LOG"
( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= FAKE_MISSING_IMAGE=fx-sandbox-glm bash "$SHIM" wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>&1 ); rc=$?
check "$rc" 0 "missing GLM image → built, then run"
grep -qxF "build --build-arg BASE_IMAGE=fx-sandbox:latest -t fx-sandbox-glm:latest -f ${PACK}/containers/Containerfile.wolfpack-glm ${PACK}/containers" "$PODMAN_LOG" \
  && ok "GLM image built from the PACK's containers/Containerfile.wolfpack-glm FROM the configured Sandbox image" || no "GLM image build command ($(grep ^build "$PODMAN_LOG"))"
check "$(grep -c '^build' "$PODMAN_LOG")" 1 "…only the GLM layer is built (the Sandbox image exists)"
grep -q "fx-sandbox-glm:latest bash -c" "$PODMAN_LOG" && ok "…and the run uses the freshly built GLM image" || no "GLM run image"
: > "$PODMAN_LOG"
( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= FAKE_MISSING_IMAGE=fx-sandbox-glm bash "$SHIM" wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>&1 )
grep -q "fx-sandbox-glm" "$PODMAN_LOG" && no "mistral path touched the GLM image" || ok "mistral path never builds/uses the GLM image"
( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= WOLFPACK_GLM_IMAGE=my-glm:dev bash "$SHIM" wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>&1 )
grep -q "my-glm:dev bash -c" "$PODMAN_LOG" && ok "WOLFPACK_GLM_IMAGE override honoured" || no "GLM image override"

# ─── usage-limit-gate AC10: tmpfs sizes (fake podman logs the full command line) ───
: > "$PODMAN_LOG"
( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= bash "$SHIM" wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>&1 ); rc=$?
check "$rc" 0 "container path (fake podman) → rc 0"
runline=$(grep -- "--tmpfs" "$PODMAN_LOG" | tail -1)
grep -qF -- "--tmpfs ${HOME}/.vibe/logs:rw,size=256m,mode=1777" <<<"$runline" && ok "logs tmpfs defaults to 256m (was 10m)" || no "logs tmpfs default ($runline)"
grep -qF -- "--tmpfs ${HOME}/.vibe/vibehistory:rw,size=64m,mode=1777" <<<"$runline" && ok "vibehistory tmpfs defaults to 64m" || no "vibehistory tmpfs default"
grep -qF -- "--tmpfs ${HOME}/.vibe/cache:rw,size=64m,mode=1777" <<<"$runline" && ok "cache tmpfs defaults to 64m" || no "cache tmpfs default"
grep -q "size=10m" <<<"$runline" && no "a 10m tmpfs survived" || ok "no 10m tmpfs left"
: > "$PODMAN_LOG"
( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= WOLFPACK_VIBE_LOGS_TMPFS_SIZE=1g WOLFPACK_VIBE_SCRATCH_TMPFS_SIZE=512k bash "$SHIM" wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>&1 )
runline=$(grep -- "--tmpfs" "$PODMAN_LOG" | tail -1)
grep -qF -- "${HOME}/.vibe/logs:rw,size=1g," <<<"$runline" && ok "WOLFPACK_VIBE_LOGS_TMPFS_SIZE override honoured (glm path too)" || no "logs tmpfs override ($runline)"
grep -qF -- "${HOME}/.vibe/cache:rw,size=512k," <<<"$runline" && ok "WOLFPACK_VIBE_SCRATCH_TMPFS_SIZE override honoured" || no "scratch tmpfs override"
for bad in "10 m" "256M" "1.5g" "-1m" "256mb" "big"; do
  : > "$PODMAN_LOG"
  ( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= WOLFPACK_VIBE_LOGS_TMPFS_SIZE="$bad" bash "$SHIM" wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>"$SCRATCH/err" ); rc=$?
  check "$rc" 2 "invalid logs tmpfs size '$bad' → exit 2"
  grep -q "invalid Vibe tmpfs size" "$SCRATCH/err" && ok "invalid size '$bad' → clear error" || no "invalid size '$bad' error text"
  [ -s "$PODMAN_LOG" ] && grep -q -- "--tmpfs" "$PODMAN_LOG" && no "invalid size '$bad' still launched podman" || ok "invalid size '$bad' → podman never run"
done
( WOLFPACK_VIBE_SCRATCH_TMPFS_SIZE="x" run wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null ); rc=$?
check "$rc" 2 "invalid scratch tmpfs size → exit 2 (sandbox mode too)"

# ─── usage-limit-gate AC10: ENOSPC from Vibe → exit 77, no breaker, never 75 ───
ENOSPC="OSError: [Errno 28] No space left on device: '$SCRATCH/h/.vibe/logs/vibe.log'"
for agent in wolfpack-pointer wolfpack-pointer-glm; do
  fam=mistral; case "$agent" in *glm*) fam=glm ;; esac
  rm -f "$TMPDIR/wolfpack-sem/$fam".{cooldown,fails}
  : > "$SCRATCH/count"
  ( FAKE_VIBE_ERR="$ENOSPC" FAKE_VIBE_RC=1 FAKE_VIBE_COUNT="$SCRATCH/count" WOLFPACK_CB_FAILS=1 WOLFPACK_MAX_RETRIES=3 \
      run "$agent" "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null ); rc=$?
  check "$rc" 77 "$fam: Vibe ENOSPC → exit 77 (WOLFPACK_INFRA_ERROR), not 75"
  grep -q "^WOLFPACK_INFRA_ERROR:$fam " "$SCRATCH/err" && ok "$fam: ENOSPC → WOLFPACK_INFRA_ERROR:$fam sentinel" || no "$fam: ENOSPC sentinel ($(cat "$SCRATCH/err"))"
  grep -q "WOLFPACK_RATE_LIMITED" "$SCRATCH/err" && no "$fam: ENOSPC printed a rate-limit sentinel" || ok "$fam: ENOSPC → no rate-limit sentinel"
  check "$(wc -l < "$SCRATCH/count" | tr -d ' ')" 1 "$fam: ENOSPC → Vibe invoked once (no retry)"
  [ ! -e "$TMPDIR/wolfpack-sem/$fam.cooldown" ] && [ ! -e "$TMPDIR/wolfpack-sem/$fam.fails" ] && ok "$fam: ENOSPC → no breaker files" || no "$fam: ENOSPC touched the breaker"
  # and the next dispatch is NOT blocked by a cooldown
  ( run "$agent" "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null ); rc=$?
  check "$rc" 0 "$fam: dispatch after ENOSPC is not on cooldown"
done
# A real 429 on glm still exits 75 (unchanged contract).
rm -f "$TMPDIR/wolfpack-sem/glm".{cooldown,fails}
( FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=2 run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null ); rc=$?
check "$rc" 75 "glm 429 exhaustion → still exit 75"
rm -f "$TMPDIR/wolfpack-sem/glm".{cooldown,fails}

# ─── usage-limit-gate AC9: per-hunt events file derivation ───
REPO="$SCRATCH/repo"; SLUG=my-hunt
WT="$REPO/.claude/worktrees/$SLUG"; mkdir -p "$WT/.wolfpack/plans/$SLUG"
( FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=2 run wolfpack-pointer-glm "$WT" "$SCRATCH/prompt.txt" >/dev/null )
EVF="$WT/.wolfpack/plans/$SLUG/rate-limits.jsonl"
[ -f "$EVF" ] && ok ".claude/worktrees/<slug> → events written to the hunt's plan dir" || no "events file not derived ($EVF)"
check "$(grep -c '"family":"glm","kind":"429"' "$EVF" 2>/dev/null)" 2 "events file: two glm 429 events (one per attempt)"
rm -f "$TMPDIR/wolfpack-sem/glm".{cooldown,fails}
# .agents/worktrees/<slug> works too
WT2="$REPO/.agents/worktrees/other-hunt"; mkdir -p "$WT2/.wolfpack/plans/other-hunt"
( FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=1 run wolfpack-pointer "$WT2" "$SCRATCH/prompt.txt" >/dev/null )
[ -f "$WT2/.wolfpack/plans/other-hunt/rate-limits.jsonl" ] && ok ".agents/worktrees/<slug> → events derived" || no ".agents/worktrees events"
rm -f "$TMPDIR/wolfpack-sem/mistral".{cooldown,fails}
# worktree whose plan dir does NOT exist → no events file anywhere under it
WT3="$REPO/.claude/worktrees/no-plan"; mkdir -p "$WT3"
( FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=1 run wolfpack-pointer "$WT3" "$SCRATCH/prompt.txt" >/dev/null )
[ -z "$(find "$WT3" -name 'rate-limits.jsonl')" ] && ok "worktree without a plan dir → no events file" || no "events file created without a plan dir"
rm -f "$TMPDIR/wolfpack-sem/mistral".{cooldown,fails}
# non-worktree path → none
( FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=1 run wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null )
[ -z "$(find "$SCRATCH/wt" "$TMPDIR" -name 'rate-limits.jsonl')" ] && ok "non-worktree path → no events file" || no "events file for a non-worktree path"
rm -f "$TMPDIR/wolfpack-sem/mistral".{cooldown,fails}
# operator-set value wins
OPF="$SCRATCH/operator-events.jsonl"
( WOLFPACK_RL_EVENTS_FILE="$OPF" FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_CB_FAILS=99 WOLFPACK_MAX_RETRIES=1 run wolfpack-pointer "$WT" "$SCRATCH/prompt.txt" >/dev/null )
[ -s "$OPF" ] && ok "operator WOLFPACK_RL_EVENTS_FILE wins" || no "operator events file ignored"
check "$(grep -c '"family":"mistral"' "$EVF" 2>/dev/null)" 0 "operator value wins → derived file not written"
rm -f "$TMPDIR/wolfpack-sem/mistral".{cooldown,fails}

# ═══ exec-layer-into-pack: the Execution Layer config on the podman path ═══════════════════
# Fake podman: every call is logged (one line, "$*") to PODMAN_LOG; `image exists <name>` says
# ABSENT when <name> matches the ERE in FAKE_ABSENT (unset = everything present); `build`
# exits FAKE_BUILD_RC (default 0); `run` echoes its argv one per line.
cat > "$SCRATCH/bin/podman" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$PODMAN_LOG"
if [ "${1:-}" = "image" ]; then
  if [ -n "${FAKE_ABSENT:-}" ] && [[ "$3" =~ $FAKE_ABSENT ]]; then exit 1; fi
  exit 0
fi
[ "${1:-}" = "build" ] && exit "${FAKE_BUILD_RC:-0}"
for a in "$@"; do printf '%s\n' "$a"; done
FAKE
chmod +x "$SCRATCH/bin/podman"
# pvrun <shim args…>: the podman path from a non-git CWD (the config comes from WOLFPACK_CONFIG).
pvrun() { : > "$PODMAN_LOG"; ( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= bash "$SHIM" "$@" 2>"$SCRATCH/err" ); }
no_podman() { if [ -s "$PODMAN_LOG" ]; then no "$1 (podman was called: $(tr '\n' '|' < "$PODMAN_LOG"))"; else ok "$1"; fi; }
err_has() { if grep -qF -- "$1" "$SCRATCH/err"; then ok "$2"; else no "$2 (stderr: $(tr '\n' '|' < "$SCRATCH/err"))"; fi; }
# vmount <argv> <spec> <label>: <spec> is present AND is the value of a -v flag.
vmount() { if grep -B1 -xF -- "$2" <<<"$1" | head -1 | grep -qxF -- "-v"; then ok "$3"; else no "$3 (no '-v $2')"; fi; }
buildline() { grep -n '^build ' "$PODMAN_LOG" | grep -F -- "$1" | head -1 | cut -d: -f1; }
UNAME=$(id -un); UUID=$(id -u); UGID=$(id -g)
USER_ARGS="--build-arg USER_NAME=${UNAME} --build-arg USER_UID=${UUID} --build-arg USER_GID=${UGID} --build-arg USER_HOME=${HOME}"

# (a) Seat extra mounts → -v host:container:ro,z on review seats (both families), never on --implement.
mkdir -p "$SCRATCH/extra" "$SCRATCH/extra2" "$HOME/tilde-extra"
CFG_A=$(CFG_SEAT_MOUNTS="\`$SCRATCH/extra\` \`$SCRATCH/extra2:/opt/extra2\` \`~/tilde-extra\`" mkcfg "$SCRATCH/cfg-a")
for agent in wolfpack-pointer-glm wolfpack-pointer; do
  out=$(WOLFPACK_CONFIG="$CFG_A" pvrun "$agent" "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
  check "$rc" 0 "(a) $agent with Seat extra mounts → rc 0"
  vmount "$out" "$SCRATCH/extra:$SCRATCH/extra:ro,z" "(a) $agent: a host-only entry mounts read-only at its host path"
  vmount "$out" "$SCRATCH/extra2:/opt/extra2:ro,z" "(a) $agent: a host:container entry mounts read-only at the container path"
  vmount "$out" "$HOME/tilde-extra:$HOME/tilde-extra:ro,z" "(a) $agent: ~ expands on both sides"
done
grep -qE "extra(2)?:[^ ]*:rw" <<<"$out" && no "(a) an extra mount was rw" || ok "(a) extra mounts are never rw"
out=$(WOLFPACK_CONFIG="$CFG_A" pvrun --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "(a) --implement with Seat extra mounts → rc 0"
grep -qF -- "$SCRATCH/extra" <<<"$out" && no "(a) --implement got a seat extra mount" || ok "(a) --implement gets NO seat extra mount"
# A host path that does not exist is refused (podman would auto-create it) — no podman call.
CFG=$(CFG_SEAT_MOUNTS="\`$SCRATCH/nope\`" mkcfg "$SCRATCH/cfg-a2")
WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(a) a missing Seat extra mounts host path → exit 2"
err_has "Seat extra mounts host path does not exist: $SCRATCH/nope" "(a) …naming the key and the path"
no_podman "(a) …and podman is never called"
[ -e "$SCRATCH/nope" ] && no "(a) the missing host path was created" || ok "(a) …and the host path is not created"
# An entry with its own options (a third ':' field) is a reader problem → exit 2, no podman.
CFG=$(CFG_SEAT_MOUNTS="\`$SCRATCH/extra:/x:rw\`" mkcfg "$SCRATCH/cfg-a3")
WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(a) a mount with options (rw) → exit 2"
err_has "Seat extra mounts entry '$SCRATCH/extra:/x:rw' has a third ':' field" "(a) …the reader names the key and the entry"
no_podman "(a) …and podman is never called"

# (b) The secrets guard: a mount that equals / lies under / contains a Secrets path → exit 2
# naming the key, BEFORE any podman call — with BOTH images absent, so an early ensure would
# have shown up as a build line.
mkdir -p "$SCRATCH/secrets/sub" "$SCRATCH/secrets-not"
ln -s "$SCRATCH/secrets" "$SCRATCH/sec-link"
for c in "under|$SCRATCH/secrets/sub" "equal|$SCRATCH/secrets" "contains|$SCRATCH" "symlink-to|$SCRATCH/sec-link"; do
  name=${c%%|*}; path=${c#*|}
  CFG=$(CFG_SEAT_MOUNTS="\`$path\`" mkcfg "$SCRATCH/cfg-b-$name")
  for agent in wolfpack-pointer-glm wolfpack-pointer; do
    WOLFPACK_CONFIG="$CFG" FAKE_ABSENT='.' pvrun "$agent" "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
    check "$rc" 2 "(b) $agent: a seat mount that $name the secrets path → exit 2"
    err_has "(wolfpack-config.md → Execution Layer → Secrets paths) — refusing to start the container" "(b) $agent ($name): stderr names the Secrets paths key"
    no_podman "(b) $agent ($name): no podman build, no podman run (no podman call at all)"
  done
done
err_has "overlaps a configured secret path $SCRATCH/secrets" "(b) the message names the resolved secret path"
# A sibling whose name merely STARTS with the secret path is not refused.
CFG=$(CFG_SEAT_MOUNTS="\`$SCRATCH/secrets-not\`" mkcfg "$SCRATCH/cfg-b-sib")
out=$(WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "(b) a sibling path (secrets-not) is NOT refused"
vmount "$out" "$SCRATCH/secrets-not:$SCRATCH/secrets-not:ro,z" "(b) …and is mounted"
# The guard covers EVERY bind source, not only configured mounts: a worktree under the secrets
# path is refused too (review and --implement).
mkdir -p "$SCRATCH/secrets/wt"
WOLFPACK_CONFIG="$CFG" FAKE_ABSENT='.' pvrun wolfpack-pointer-glm "$SCRATCH/secrets/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(b) a worktree under the secrets path → exit 2 (review)"
no_podman "(b) …no podman call"
WOLFPACK_CONFIG="$CFG" FAKE_ABSENT='.' pvrun --implement wolfpack-shepherd-glm "$SCRATCH/secrets/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(b) a worktree under the secrets path → exit 2 (--implement)"
no_podman "(b) …no podman call"
# Secrets paths: none disables the guard (a legal value).
CFG=$(CFG_SECRETS=none CFG_SEAT_MOUNTS="\`$SCRATCH/secrets/sub\`" mkcfg "$SCRATCH/cfg-b-none")
out=$(WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "(b) Secrets paths: none → the guard is off (rc 0)"

# (c) Every shim-required key, when absent (or none where none is illegal), stops the shim
# with exit 2 naming the key — no hard-coded project default, no podman call.
for key in "Sandbox image" "GLM image" "Sandbox project layer" "Seat extra mounts" "Secrets paths" "Vibe agent dir"; do
  CFG=$(CFG_OMIT="$key" mkcfg "$SCRATCH/cfg-c-${key// /_}")
  for agent in wolfpack-pointer-glm wolfpack-pointer; do
    WOLFPACK_CONFIG="$CFG" pvrun "$agent" "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
    check "$rc" 2 "(c) $agent: '$key' absent → exit 2"
    err_has "Execution Layer: missing $key" "(c) $agent: stderr names '$key' as written"
    no_podman "(c) $agent: '$key' absent → no podman call"
  done
done
for key in SANDBOX GLM AGENTS; do
  CFG=$(env "CFG_${key}=none" bash -c "$(declare -f mkcfg); PACK='$PACK' SCRATCH='$SCRATCH' HOME='$HOME' mkcfg '$SCRATCH/cfg-c-none-$key'")
  WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
  check "$rc" 2 "(c) a required key set to none ($key) → exit 2"
  no_podman "(c) none ($key) → no podman call"
done
# Seat test env is optional: absent → the run proceeds.
CFG=$(CFG_OMIT="Seat test env" mkcfg "$SCRATCH/cfg-c-noenv")
WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 0 "(c) Seat test env absent → rc 0 (optional key)"
# The whole section absent → exit 2 naming every shim-required key.
NOSEC="$SCRATCH/cfg-c-nosec/wolfpack-config.md"; mkdir -p "${NOSEC%/*}"
awk '/^## Execution Layer/{skip=1; next} /^## /{skip=0} !skip' "$PACK/wolfpack-config.example.md" > "$NOSEC"
WOLFPACK_CONFIG="$NOSEC" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(c) no Execution Layer section → exit 2"
err_has "Execution Layer: missing Sandbox image, GLM image, Sandbox project layer, Seat extra mounts, Secrets paths, Vibe agent dir" "(c) …naming every shim-required key"
no_podman "(c) …no podman call"

# (d) Which config: no WOLFPACK_CONFIG and a non-git CWD → exit 2 with the fix; no podman call.
: > "$PODMAN_LOG"
( cd "$SCRATCH/wt" && env -u WOLFPACK_CONFIG WOLFPACK_SANDBOX= bash "$SHIM" wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>"$SCRATCH/err" ); rc=$?
check "$rc" 2 "(d) no WOLFPACK_CONFIG + non-git CWD → exit 2"
err_has "no wolfpack-config.md — run from the consuming repo's root or set WOLFPACK_CONFIG" "(d) …with the fix"
no_podman "(d) …no podman call"
# A relative or nonexistent WOLFPACK_CONFIG is refused.
WOLFPACK_CONFIG="cfg/wolfpack-config.md" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(d) a relative WOLFPACK_CONFIG → exit 2"
err_has "WOLFPACK_CONFIG must be an absolute path" "(d) …saying so"
WOLFPACK_CONFIG="$SCRATCH/absent/wolfpack-config.md" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(d) a WOLFPACK_CONFIG that does not exist → exit 2"
no_podman "(d) …no podman call"
# No WOLFPACK_CONFIG: the config comes from the CALLER's git toplevel — never from the worktree
# under review (a hunt branch cannot widen its own reviewer's sandbox, H7).
CALLER="$SCRATCH/caller"; mkdir -p "$CALLER"; git -C "$CALLER" init -q
mkcfg "$CALLER" >/dev/null
UNDER="$SCRATCH/under-review"; mkdir -p "$UNDER" "$SCRATCH/branch-widened"; git -C "$UNDER" init -q
CFG_SEAT_MOUNTS="\`$SCRATCH/branch-widened\`" mkcfg "$UNDER" >/dev/null
: > "$PODMAN_LOG"
out=$( cd "$CALLER" && env -u WOLFPACK_CONFIG WOLFPACK_SANDBOX= bash "$SHIM" wolfpack-pointer-glm "$UNDER" "$SCRATCH/prompt.txt" 2>"$SCRATCH/err" ); rc=$?
check "$rc" 0 "(d) no WOLFPACK_CONFIG + caller CWD in a git checkout → rc 0"
err_has "config=$CALLER/wolfpack-config.md" "(d) …the log names the CALLER's config"
grep -qF -- "$SCRATCH/branch-widened" <<<"$out" && no "(d) the worktree's own config widened the mounts" || ok "(d) …the worktree-under-review's config is never read"

# (e) The configured Vibe agent dir is the source of the seat's ~/.vibe/agents mount.
mkdir -p "$SCRATCH/agents-x"
CFG=$(CFG_AGENTS="\`$SCRATCH/agents-x\`" mkcfg "$SCRATCH/cfg-e")
for agent in wolfpack-pointer-glm wolfpack-pointer; do
  out=$(WOLFPACK_CONFIG="$CFG" pvrun "$agent" "$SCRATCH/wt" "$SCRATCH/prompt.txt")
  vmount "$out" "$SCRATCH/agents-x:$HOME/.vibe/agents:ro,z" "(e) $agent: Vibe agent dir → the read-only ~/.vibe/agents mount"
  grep -qF -- "$HOME/.vibe/agents-headless:" <<<"$out" && no "(e) $agent: the default agents dir is still mounted" || ok "(e) $agent: no hard-coded agents-headless mount"
done

# (f) Seat test env → -e NAME=value on review seats only; none → no SECRET_KEY at all.
CFG=$(CFG_SEAT_ENV="\`FOO=bar\` \`FX_EMPTY=\`" mkcfg "$SCRATCH/cfg-f")
for agent in wolfpack-pointer-glm wolfpack-pointer; do
  out=$(WOLFPACK_CONFIG="$CFG" pvrun "$agent" "$SCRATCH/wt" "$SCRATCH/prompt.txt")
  grep -A1 -xF -- "-e" <<<"$out" | grep -qxF "FOO=bar" && ok "(f) $agent: -e FOO=bar" || no "(f) $agent: FOO=bar missing"
  grep -A1 -xF -- "-e" <<<"$out" | grep -qxF "FX_EMPTY=" && ok "(f) $agent: -e FX_EMPTY= (empty value kept)" || no "(f) $agent: FX_EMPTY= missing"
  grep -A1 -xF -- "-e" <<<"$out" | grep -qxF "WOLFPACK_SANDBOX=1" && ok "(f) $agent: WOLFPACK_SANDBOX=1 kept" || no "(f) $agent: WOLFPACK_SANDBOX=1 missing"
  grep -q "^SECRET_KEY=" <<<"$out" && no "(f) $agent: a SECRET_KEY not in the config" || ok "(f) $agent: no SECRET_KEY unless configured"
done
out=$(WOLFPACK_CONFIG="$CFG" pvrun --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
grep -q "^FOO=bar$" <<<"$out" && no "(f) --implement got the seat test env" || ok "(f) --implement gets no seat test env"
CFG=$(CFG_SEAT_ENV=none mkcfg "$SCRATCH/cfg-f2")
out=$(WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "(f) Seat test env: none → rc 0"
grep -q "SECRET_KEY" <<<"$out" && no "(f) none: SECRET_KEY still passed" || ok "(f) none: no SECRET_KEY (it is config, not a shim constant)"
for bad in "\`HOME=/x\`" "\`WOLFPACK_SANDBOX=0\`" "\`GIT_DIR=/x\`" "\`PATH=/x\`" "\`not-a-pair\`"; do
  CFG=$(CFG_SEAT_ENV="$bad" mkcfg "$SCRATCH/cfg-f3")
  WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
  check "$rc" 2 "(f) Seat test env $bad → exit 2"
  err_has "Seat test env entry" "(f) $bad: stderr names the key"
  no_podman "(f) $bad: no podman call"
done

# (g) AC7: no second wolfpack checkout is mounted, whatever the env says; the git-common-dir
# ro mount is kept. (The retired variable's name is assembled so this file never spells it.)
SIB="$SCRATCH/sibling-pack"; mkdir -p "$SIB"; git -C "$SIB" init -q
OLD_DEFAULT="$HOME/Projects"/wolfpack; mkdir -p "$OLD_DEFAULT"; git -C "$OLD_DEFAULT" init -q
RETIRED_VAR="WOLFPACK_CANONICAL""_REPO"
for agent in wolfpack-pointer-glm wolfpack-pointer; do
  : > "$PODMAN_LOG"
  out=$( cd "$SCRATCH/wt" && env "${RETIRED_VAR}=${SIB}" WOLFPACK_SANDBOX= bash "$SHIM" "$agent" "$GWT" "$SCRATCH/prompt.txt" 2>"$SCRATCH/err" ); rc=$?
  check "$rc" 0 "(g) $agent with the retired canonical-repo env set → rc 0"
  grep -qF -- "$SIB" <<<"$out" && no "(g) $agent: the sibling checkout was mounted" || ok "(g) $agent: a sibling wolfpack checkout is never mounted"
  grep -qF -- "$OLD_DEFAULT" <<<"$out" && no "(g) $agent: the old default checkout was mounted" || ok "(g) $agent: nor the old default path"
  vmount "$out" "${GCOMMON}:${GCOMMON}:ro,z" "(g) $agent: the git common dir ro mount is kept"
done

# (h) The image build chain (all images absent).
# With a project layer: pack base (+ the four USER_* build args) tagged <sandbox>-pack-base:<tag>,
# then the layer FROM it with the CONFIG's dir as context, then GLM FROM the sandbox image.
mkdir -p "$SCRATCH/cfg-h/layer"; echo "FROM scratch" > "$SCRATCH/cfg-h/layer/Containerfile.fx"
CFG_H=$(CFG_LAYER="\`layer/Containerfile.fx\`" mkcfg "$SCRATCH/cfg-h")
out=$(WOLFPACK_CONFIG="$CFG_H" FAKE_ABSENT='.' pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "(h) layered build chain → rc 0"
check "$(grep -c '^build ' "$PODMAN_LOG")" 3 "(h) three builds: base, project layer, GLM"
B1=$(buildline "-t fx-sandbox-pack-base:latest"); B2=$(buildline "-t fx-sandbox:latest"); B3=$(buildline "-t fx-sandbox-glm:latest")
grep -qxF "build ${USER_ARGS} -t fx-sandbox-pack-base:latest -f ${PACK}/containers/Containerfile.wolfpack ${PACK}/containers" "$PODMAN_LOG" \
  && ok "(h) base: the pack's containers/Containerfile.wolfpack + all four USER_* args, tagged fx-sandbox-pack-base:latest" || no "(h) base build line ($(grep '^build' "$PODMAN_LOG" | head -1))"
grep -qxF "build --build-arg BASE_IMAGE=fx-sandbox-pack-base:latest -t fx-sandbox:latest -f $SCRATCH/cfg-h/layer/Containerfile.fx $SCRATCH/cfg-h" "$PODMAN_LOG" \
  && ok "(h) layer: BASE_IMAGE=fx-sandbox-pack-base:latest, the layer resolved against the config dir, config dir as context" || no "(h) layer build line ($(grep '^build' "$PODMAN_LOG" | sed -n 2p))"
grep -qxF "build --build-arg BASE_IMAGE=fx-sandbox:latest -t fx-sandbox-glm:latest -f ${PACK}/containers/Containerfile.wolfpack-glm ${PACK}/containers" "$PODMAN_LOG" \
  && ok "(h) GLM: BASE_IMAGE=<the Sandbox image>, the pack's Containerfile.wolfpack-glm" || no "(h) GLM build line ($(grep '^build' "$PODMAN_LOG" | sed -n 3p))"
[ -n "$B1" ] && [ -n "$B2" ] && [ -n "$B3" ] && [ "$B1" -lt "$B2" ] && [ "$B2" -lt "$B3" ] && ok "(h) order: base → layer → GLM" || no "(h) build order ($B1 $B2 $B3)"
R=$(grep -n '^run ' "$PODMAN_LOG" | head -1 | cut -d: -f1)
[ -n "$R" ] && [ "$R" -gt "${B3:-999}" ] && ok "(h) the run comes after every build" || no "(h) run before builds"
grep -q "^run .* fx-sandbox-glm:latest bash -c" "$PODMAN_LOG" && ok "(h) the run uses the GLM image" || no "(h) run image"
# Without a layer: the pack base IS the sandbox image (one build for a Mistral seat; no -pack-base tag).
out=$(FAKE_ABSENT='.' pvrun wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "(h) no layer → rc 0"
grep -qxF "build ${USER_ARGS} -t fx-sandbox:latest -f ${PACK}/containers/Containerfile.wolfpack ${PACK}/containers" "$PODMAN_LOG" \
  && ok "(h) no layer: the pack base is built straight to the Sandbox tag" || no "(h) no-layer build ($(grep '^build' "$PODMAN_LOG"))"
check "$(grep -c '^build ' "$PODMAN_LOG")" 1 "(h) no layer, Mistral seat: exactly one build"
grep -q "pack-base" "$PODMAN_LOG" && no "(h) no layer: a -pack-base tag appeared" || ok "(h) no layer: no -pack-base tag"
# Everything present → no build at all.
out=$(pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
check "$(grep -c '^build ' "$PODMAN_LOG")" 0 "(h) images present → nothing is built"
# A registry-port image name splits at the LAST ':' (the tag), never the port.
mkdir -p "$SCRATCH/cfg-h3/layer"; echo "FROM scratch" > "$SCRATCH/cfg-h3/layer/Containerfile.fx"
CFG=$(CFG_SANDBOX="\`localhost:5000/fx/sb:v2\`" CFG_LAYER="\`layer/Containerfile.fx\`" mkcfg "$SCRATCH/cfg-h3")
WOLFPACK_CONFIG="$CFG" FAKE_ABSENT='.' pvrun wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 0 "(h) registry-port sandbox image → rc 0"
grep -qF -- "-t localhost:5000/fx/sb-pack-base:v2 " "$PODMAN_LOG" && ok "(h) registry port: base tag localhost:5000/fx/sb-pack-base:v2" || no "(h) registry-port base tag ($(grep '^build' "$PODMAN_LOG" | head -1))"
# WOLFPACK_GLM_IMAGE still overrides the configured GLM image.
out=$(WOLFPACK_GLM_IMAGE=my-glm:dev FAKE_ABSENT='^my-glm' pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt"); rc=$?
check "$rc" 0 "(h) WOLFPACK_GLM_IMAGE override → rc 0"
grep -qxF "build --build-arg BASE_IMAGE=fx-sandbox:latest -t my-glm:dev -f ${PACK}/containers/Containerfile.wolfpack-glm ${PACK}/containers" "$PODMAN_LOG" \
  && ok "(h) the override is built FROM the configured Sandbox image" || no "(h) override build ($(grep '^build' "$PODMAN_LOG"))"
grep -q "^run .* my-glm:dev bash -c" "$PODMAN_LOG" && ok "(h) …and run" || no "(h) override run"
# A configured layer that does not exist → exit 2 naming the key; no build, no run.
CFG=$(CFG_LAYER="\`layer/absent.Containerfile\`" mkcfg "$SCRATCH/cfg-h2")
WOLFPACK_CONFIG="$CFG" FAKE_ABSENT='.' pvrun wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(h) a missing project layer file → exit 2"
err_has "Sandbox project layer" "(h) …naming the key"
grep -qE '^(build|run) ' "$PODMAN_LOG" && no "(h) missing layer: podman build/run happened" || ok "(h) missing layer: no build, no run"
# A failing build stops loud (exit 2), never runs a container.
WOLFPACK_CONFIG="$CFG_H" FAKE_ABSENT='.' FAKE_BUILD_RC=1 pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(h) a failing podman build → exit 2"
err_has "podman build of the pack base image fx-sandbox-pack-base:latest failed" "(h) …naming the failed build"
grep -q '^run ' "$PODMAN_LOG" && no "(h) a container ran after a failed build" || ok "(h) …and no container runs"

# (i) The dispatch log line names the worktree, the shim dir, the config and the image.
out=$(pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
grep -qxF "wolfpack: podman-vibe wolfpack-pointer-glm family=glm mode=review worktree=$SCRATCH/wt shim=$HERE config=$WOLFPACK_CONFIG image=fx-sandbox-glm:latest" "$SCRATCH/err" \
  && ok "(i) log line: worktree, shim dir, config path, image" || no "(i) log line ($(grep 'podman-vibe ' "$SCRATCH/err"))"
out=$(pvrun --implement wolfpack-shepherd-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
grep -qF "family=glm mode=implement worktree=$SCRATCH/wt" "$SCRATCH/err" && ok "(i) …mode=implement on --implement" || no "(i) implement log line"

# (j) WOLFPACK_SANDBOX=1 never needs a config, a node or an agents dir.
HOME2="$SCRATCH/home2"; mkdir -p "$HOME2/.vibe"; touch "$HOME2/.vibe/.env" "$HOME2/.vibe/config.toml"   # Vibe's own files, but NO agents-headless
: > "$PODMAN_LOG"
out=$( cd "$SCRATCH/wt" && env -u WOLFPACK_CONFIG HOME="$HOME2" WOLFPACK_SANDBOX=1 bash "$SHIM" wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" 2>"$SCRATCH/err" ); rc=$?
check "$rc" 0 "(j) sandbox mode, no config, no agents dir → rc 0"
has "$out" "--auto-approve" "(j) …and Vibe is invoked directly"
no_podman "(j) …podman is never called"
# …while on the podman path a configured Vibe agent dir that does not exist → exit 2, no podman.
CFG=$(CFG_AGENTS="\`$SCRATCH/no-agents\`" mkcfg "$SCRATCH/cfg-j")
WOLFPACK_CONFIG="$CFG" pvrun wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null; rc=$?
check "$rc" 2 "(j) podman path: a missing Vibe agent dir → exit 2"
err_has "the configured Vibe agent dir does not exist: $SCRATCH/no-agents (wolfpack-config.md → Execution Layer → Vibe agent dir)" "(j) …naming the key and the path"
no_podman "(j) …no podman call"
# …and the podman path without node on PATH stops loud (it cannot read the config).
NONODE="$SCRATCH/nonode"; mkdir -p "$NONODE"
for d in /usr/local/bin /usr/bin /bin; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do b=${f##*/}; [ "$b" = node ] && continue; [ -e "$NONODE/$b" ] || ln -s "$f" "$NONODE/$b" 2>/dev/null; done
done
: > "$PODMAN_LOG"
( cd "$SCRATCH/wt" && PATH="$SCRATCH/bin:$NONODE" WOLFPACK_SANDBOX= bash "$SHIM" wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>"$SCRATCH/err" ); rc=$?
check "$rc" 2 "(j) podman path without node → exit 2"
err_has "needs node to read wolfpack-config.md" "(j) …saying node is needed"
no_podman "(j) …no podman call"

# ─── shims stay executable (hunt-pipeline runs "$WOLFPACK_HOME/scripts/podman-vibe.sh" directly;
#     /run-hunt and /run-campaign `exec "$PACK/scripts/run-pipeline-sandbox.sh"`) ───
REPO_TOP=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_TOP" ]; then
  for f in scripts/podman-vibe.sh scripts/run-pipeline-sandbox.sh scripts/wolfpack-usage; do
    mode=$(git -C "$REPO_TOP" ls-files -s -- "$f" | awk '{print $1}')
    check "$mode" 100755 "$f is committed executable (git mode 100755)"
    [ -x "$REPO_TOP/$f" ] && ok "$f is executable on disk" || no "$f is NOT executable on disk"
  done
fi

# ─── usage-limit-gate AC5 container path: the snapshot is mounted READ-ONLY ───
SANDBOX_SH="$HERE/run-pipeline-sandbox.sh"
grep -qF -- '-v "${HOME}/.cache/wolfpack:${HOME}/.cache/wolfpack:ro"' "$SANDBOX_SH" && ok "run-pipeline-sandbox mounts ~/.cache/wolfpack :ro" || no "snapshot mount missing / not :ro"
grep -qF -- 'mkdir -p "${HOME}/.cache/wolfpack"' "$SANDBOX_SH" && ok "run-pipeline-sandbox creates the bind source first" || no "no mkdir for the snapshot bind source"
bash -n "$SANDBOX_SH" && ok "run-pipeline-sandbox.sh parses" || no "run-pipeline-sandbox.sh syntax"

# ═══ seat-handoff-writes: the seat writes its OWN handoff file; the shim delivers it ════════
# A git fixture worktree (a committed file, a gitignored plan dir + cache dir) and a fake SEAT:
# FAKE_SEAT names a helper the fake vibe (sandbox path: <--workdir>/$FAKE_OUT_REL, the seat's
# RELATIVE write path) and the fake podman (podman path: the host side of the ONE `-v …:rw,z`
# bind) call with the out dir. The helper mimics Vibe's write_file (create only — it refuses an
# existing file) and can also break the contract on demand:
#   FAKE_SEAT_WRITE="<name>=<fixture> …"  write each fixture into the out dir as <name>
#   FAKE_SEAT_EXTRA="<rel> …"             an extra file (a/b = an extra subdir) in the out dir
#   FAKE_SEAT_TOUCH="<wt-rel path> …"     append to a worktree path (a source change)
#   FAKE_SEAT_CMD="<bash>"                anything else, run with WT/OUT/PD exported
#   FAKE_SEAT_FAIL_FIRST=<counter file>   attempt 1 writes a PARTIAL artifact, then a 429
cat > "$SCRATCH/bin/fake-seat" <<'FAKE'
#!/usr/bin/env bash
out="$1"; export OUT="$out" WT="$FAKE_WT" PD="$FAKE_PD"
[ -n "${FAKE_SEAT_LOG:-}" ] && echo "seat out=$out" >> "$FAKE_SEAT_LOG"
wf() { if [ -e "$2" ]; then echo "write_file: refusing to overwrite $2" >&2; return 1; fi; cp "$1" "$2"; }
if [ -n "${FAKE_SEAT_FAIL_FIRST:-}" ] && [ ! -s "$FAKE_SEAT_FAIL_FIRST" ]; then
  echo 1 > "$FAKE_SEAT_FAIL_FIRST"
  for spec in ${FAKE_SEAT_WRITE:-}; do printf 'partial' > "$out/${spec%%=*}"; done
  echo "HTTP 429 Too Many Requests" >&2; exit 1
fi
for spec in ${FAKE_SEAT_WRITE:-}; do wf "${spec#*=}" "$out/${spec%%=*}" || exit 1; done
for rel in ${FAKE_SEAT_EXTRA:-}; do mkdir -p "$(dirname "$out/$rel")"; echo extra > "$out/$rel"; done
for rel in ${FAKE_SEAT_TOUCH:-}; do mkdir -p "$(dirname "$WT/$rel")"; echo touched >> "$WT/$rel"; done
if [ -n "${FAKE_SEAT_CMD:-}" ]; then bash -c "$FAKE_SEAT_CMD" || exit 1; fi
exit 0
FAKE
chmod +x "$SCRATCH/bin/fake-seat"
# The fake vibe runs the seat (before its sleep / error knobs) when FAKE_SEAT is set.
cat > "$SCRATCH/bin/vibe" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = "--help" ]; then [ -z "${FAKE_VIBE_OLD:-}" ] && echo "  --auto-approve, --yolo"; exit 0; fi
if [ "${1:-}" = "--version" ]; then echo "vibe 0.0-fake"; exit 0; fi
[ -n "${FAKE_VIBE_COUNT:-}" ] && echo x >> "$FAKE_VIBE_COUNT"
if [ -n "${FAKE_SEAT:-}" ]; then
  wd=""; prev=""; for a in "$@"; do [ "$prev" = "--workdir" ] && wd="$a"; prev="$a"; done
  "$FAKE_SEAT" "$wd/$FAKE_OUT_REL" || exit $?
fi
[ -n "${FAKE_VIBE_SLEEP:-}" ] && sleep "$FAKE_VIBE_SLEEP"
if [ -n "${FAKE_VIBE_ERR:-}" ]; then echo "$FAKE_VIBE_ERR" >&2; exit "${FAKE_VIBE_RC:-1}"; fi
for a in "$@"; do printf '%s\n' "$a"; done
FAKE
chmod +x "$SCRATCH/bin/vibe"
# The fake podman logs every call, and on `run` hands the seat the host side of the rw bind.
cat > "$SCRATCH/bin/podman" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$PODMAN_LOG"
[ "${1:-}" = "image" ] && exit 0
[ "${1:-}" = "build" ] && exit 0
if [ -n "${FAKE_SEAT:-}" ]; then
  rw=""; prev=""
  for a in "$@"; do if [ "$prev" = "-v" ]; then case "$a" in *:rw,z) rw="${a%%:*}" ;; esac; fi; prev="$a"; done
  if [ -n "$rw" ]; then "$FAKE_SEAT" "$rw" || exit $?; fi
fi
for a in "$@"; do printf '%s\n' "$a"; done
FAKE
chmod +x "$SCRATCH/bin/podman"
rm -f "$TMPDIR/wolfpack-sem/"*.cooldown "$TMPDIR/wolfpack-sem/"*.fails

HWT="$SCRATCH/hwt"; mkdir -p "$HWT"; HWT=$(realpath "$HWT")
git -C "$HWT" init -q -b main 2>/dev/null || git -C "$HWT" init -q
printf '.wolfpack/plans/\ncache/\n' > "$HWT/.gitignore"
echo "source v1" > "$HWT/src.txt"
git -C "$HWT" add .gitignore src.txt
git -C "$HWT" -c user.email=t@t -c user.name=t commit -q -m init
HBASE=$(git -C "$HWT" rev-parse HEAD)
HPD="$HWT/.wolfpack/plans/x"; HREL=".wolfpack/plans/x"
export FAKE_WT="$HWT" FAKE_PD="$HPD"
# Fixtures: a 70 KiB artifact with multi-byte UTF-8, trailing spaces and NO final newline.
FX="$SCRATCH/fixtures"; mkdir -p "$FX"
python3 - "$FX/review.md" <<'PY'
import sys
line = "## Finding — é… 中文 «quoted» `code`   \n"
body = "# Review\n\n" + line * (72 * 1024 // len(line.encode()))
body += '<verdict>\n{"verdict": "APPROVED", "findings": []}\n</verdict>   '
open(sys.argv[1], "w", encoding="utf-8", newline="").write(body)
PY
cp "$FX/review.md" "$FX/certification.md"
printf '{"feature":"x","notes":"é 中文","scores":{"adherence":5}}' > "$FX/pedigree.json"
FXSZ=$(stat -c %s "$FX/review.md")
[ "$FXSZ" -ge 71680 ] && ok "fixture: ≥70 KiB ($FXSZ bytes)" || no "fixture too small ($FXSZ)"
[ "$(tail -c1 "$FX/review.md" | od -An -c | tr -d ' ')" != '\n' ] && ok "fixture: no final newline" || no "fixture ends with a newline"
grep -q '中文' "$FX/review.md" && grep -q '   $' "$FX/review.md" && ok "fixture: multi-byte UTF-8 + trailing spaces" || no "fixture content"

# hreset: the fixture back to a clean committed state with a fresh plan dir.
hreset() {
  git -C "$HWT" reset -q --hard "$HBASE"; git -C "$HWT" clean -fdq
  git -C "$HWT" for-each-ref --format='%(refname)' refs/heads/ | grep -vx "refs/heads/main" | while read -r r; do git -C "$HWT" update-ref -d "$r"; done
  chmod -R u+w "$HPD" 2>/dev/null; rm -rf "$HWT/.wolfpack" "$HWT/cache"
  mkdir -p "$HPD"; echo '{"feature":"x","status":"reviewed"}' > "$HPD/metadata.json"; : > "$HPD/rate-limits.jsonl"
}
# hrun <out name> <expect…> -- <agent> [extra shim args]: handoff run on the SANDBOX path
# (WOLFPACK_SANDBOX=1, direct vibe); prints stdout, stderr to $SCRATCH/err, sets $rc.
hargs() { local n="$1"; shift; local a=(--deliver-to "$HPD" --out-dir "$HPD/.seat-out/$n"); local e; for e in "$@"; do a+=(--expect "$e"); done; printf '%s\0' "${a[@]}"; }
hrun() {
  local n="$1" agent="$2"; shift 2
  local -a ha; mapfile -d '' ha < <(hargs "$n" "$@")
  FAKE_SEAT="$SCRATCH/bin/fake-seat" FAKE_OUT_REL="$HREL/.seat-out/$n" bash "$SHIM" "${ha[@]}" "$agent" "$HWT" "$SCRATCH/prompt.txt" 2>"$SCRATCH/err"
}
# prun: the same on the PODMAN path (fake podman; config from WOLFPACK_CONFIG).
prun() {
  local n="$1" agent="$2"; shift 2
  local -a ha; mapfile -d '' ha < <(hargs "$n" "$@")
  : > "$PODMAN_LOG"
  ( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= FAKE_SEAT="$SCRATCH/bin/fake-seat" bash "$SHIM" "${ha[@]}" "$agent" "$HWT" "$SCRATCH/prompt.txt" 2>"$SCRATCH/err" )
}
delivered_ok() {  # <name> <fixture> <label>
  if cmp -s "$HPD/$1" "$2"; then ok "$3: $1 byte-identical (cmp)"; else no "$3: $1 differs from what the seat wrote"; fi
  local sha bytes; sha=$(sha256sum < "$HPD/$1" | cut -d' ' -f1); bytes=$(stat -c %s "$HPD/$1")
  grep -qxF "WOLFPACK_ARTIFACT_DELIVERED: $1 sha256=$sha bytes=$bytes" "$SCRATCH/err" \
    && ok "$3: DELIVERED line for $1 carries the delivered file's sha256 + size" || no "$3: DELIVERED line for $1 ($(grep DELIVERED "$SCRATCH/err" | tr '\n' '|'))"
}
quarantined() { # <out name> <label>
  local n="$1"
  [ ! -e "$HPD/.seat-out/$n" ] && ok "$2: the out dir is gone" || no "$2: the out dir is still there"
  compgen -G "$HPD/.seat-out/$n.rejected-*" >/dev/null && ok "$2: the out dir is quarantined (*.rejected-*)" || no "$2: no quarantine dir"
}
err_marker() { grep -qxF "WOLFPACK_ARTIFACT_ERROR: $1" "$SCRATCH/err" && ok "$2" || no "$2 (stderr: $(grep -E 'ARTIFACT|ERROR' "$SCRATCH/err" | tr '\n' '|'))"; }
not_delivered() { [ ! -e "$HPD/$1" ] && ok "$2: $1 NOT delivered to the plan dir" || no "$2: $1 reached the plan dir"; }

# ─── AC5: byte-identical delivery, one and two artifacts, both paths ───
for path in sandbox podman; do
  for agent in wolfpack-bloodhound-glm wolfpack-bloodhound; do
    hreset
    if [ "$path" = sandbox ]; then out=$(FAKE_SEAT_WRITE="review-1.md=$FX/review.md" hrun bloodhound-r1 "$agent" review-1.md); rc=$?
    else out=$(FAKE_SEAT_WRITE="review-1.md=$FX/review.md" prun bloodhound-r1 "$agent" review-1.md); rc=$?; fi
    check "$rc" 0 "AC5 $path $agent: one artifact → rc 0"
    delivered_ok review-1.md "$FX/review.md" "AC5 $path $agent"
    [ ! -e "$HPD/.seat-out/bloodhound-r1" ] && ok "AC5 $path $agent: the out dir is removed after delivery" || no "AC5 $path $agent: out dir left behind"
    compgen -G "$HPD/.seat-out/*.rejected-*" >/dev/null && no "AC5 $path $agent: a quarantine dir appeared" || ok "AC5 $path $agent: nothing quarantined"
  done
  hreset
  if [ "$path" = sandbox ]; then out=$(FAKE_SEAT_WRITE="certification.md=$FX/certification.md pedigree.json=$FX/pedigree.json" hrun watchdog-r0 wolfpack-watchdog-glm certification.md pedigree.json); rc=$?
  else out=$(FAKE_SEAT_WRITE="certification.md=$FX/certification.md pedigree.json=$FX/pedigree.json" prun watchdog-r0 wolfpack-watchdog-glm certification.md pedigree.json); rc=$?; fi
  check "$rc" 0 "AC5 $path watchdog: two artifacts → rc 0"
  delivered_ok certification.md "$FX/certification.md" "AC5 $path watchdog"
  delivered_ok pedigree.json "$FX/pedigree.json" "AC5 $path watchdog"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$HPD/pedigree.json" && ok "AC5 $path watchdog: pedigree.json parses" || no "AC5 $path watchdog: pedigree.json JSON"
  [ ! -e "$HPD/.seat-out/watchdog-r0" ] && ok "AC5 $path watchdog: out dir removed" || no "AC5 $path watchdog: out dir left"
done
# P4: the sandbox seat wrote through the worktree-RELATIVE path (resolved against --workdir).
hreset; FAKE_SEAT_LOG="$SCRATCH/seat.log"; : > "$FAKE_SEAT_LOG"
FAKE_SEAT_LOG="$SCRATCH/seat.log" FAKE_SEAT_WRITE="review-1.md=$FX/review.md" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null
grep -qxF "seat out=$HWT/$HREL/.seat-out/bloodhound-r1" "$SCRATCH/seat.log" && ok "P4: the seat's relative path resolves to the out dir under --workdir" || no "P4: seat path ($(cat "$SCRATCH/seat.log"))"

# ─── AC4: the podman path adds exactly ONE rw bind (the out dir); the worktree stays ro ───
hreset
out=$(FAKE_SEAT_WRITE="pointer-review-2.md=$FX/review.md" prun pointer-r2 wolfpack-pointer-glm pointer-review-2.md); rc=$?
check "$rc" 0 "AC4 podman glm: handoff run → rc 0"
check "$(grep -c ':rw,z$' <<<"$out")" 1 "AC4 podman glm: exactly one :rw,z bind"
vmount "$out" "$HPD/.seat-out/pointer-r2:$HWT/$HREL/.seat-out/pointer-r2:rw,z" "AC4 podman glm: <out>:<host worktree>/<rel>:rw,z (container path = host path)"
vmount "$out" "$HWT:$HWT:ro,z" "AC4 podman glm: the worktree bind stays :ro,z"
check "$(grep -c -- '--tmpfs' <<<"$out")" 3 "AC4 podman glm: the three tmpfs entries are unchanged"
hreset
out=$(FAKE_SEAT_WRITE="pointer-review-2.md=$FX/review.md" prun pointer-r2 wolfpack-pointer pointer-review-2.md); rc=$?
check "$rc" 0 "AC4 podman mistral: handoff run → rc 0"
check "$(grep -c ':rw,z$' <<<"$out")" 1 "AC4 podman mistral: exactly one :rw,z bind"
vmount "$out" "$HPD/.seat-out/pointer-r2:/workspace/$HREL/.seat-out/pointer-r2:rw,z" "AC4 podman mistral: <out>:/workspace/<rel>:rw,z (inside --workdir /workspace)"
vmount "$out" "$HWT:/workspace:ro,z" "AC4 podman mistral: the worktree bind stays :ro,z"
check "$(grep -c -- '--tmpfs' <<<"$out")" 3 "AC4 podman mistral: the three tmpfs entries are unchanged"
# Without the handoff options: no rw bind at all on a review seat, no out dir created.
hreset
for agent in wolfpack-pointer-glm wolfpack-pointer; do
  : > "$PODMAN_LOG"
  out=$( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= bash "$SHIM" "$agent" "$HWT" "$SCRATCH/prompt.txt" 2>"$SCRATCH/err" ); rc=$?
  check "$rc" 0 "AC4 $agent without handoff args → rc 0 (unchanged)"
  grep -q ':rw,z$' <<<"$out" && no "AC4 $agent without handoff: a rw bind appeared" || ok "AC4 $agent without handoff: no rw bind"
  check "$(grep -c -- '--tmpfs' <<<"$out")" 3 "AC4 $agent without handoff: the same three tmpfs entries"
done
[ ! -e "$HPD/.seat-out" ] && ok "AC4: no .seat-out dir without handoff args" || no "AC4: .seat-out created without handoff"

# ─── AC6: a missing artifact → exit 78, nothing delivered, out dir quarantined ───
for path in sandbox podman; do
  hreset
  if [ "$path" = sandbox ]; then hrun watchdog-r0 wolfpack-watchdog-glm certification.md pedigree.json >/dev/null; rc=$?
  else prun watchdog-r0 wolfpack-watchdog-glm certification.md pedigree.json >/dev/null; rc=$?; fi
  check "$rc" 78 "AC6 $path: nothing written → exit 78"
  err_marker "missing certification.md" "AC6 $path: missing certification.md"
  err_marker "missing pedigree.json" "AC6 $path: missing pedigree.json"
  not_delivered certification.md "AC6 $path"
  hreset
  if [ "$path" = sandbox ]; then FAKE_SEAT_WRITE="certification.md=$FX/certification.md" hrun watchdog-r0 wolfpack-watchdog-glm certification.md pedigree.json >/dev/null; rc=$?
  else FAKE_SEAT_WRITE="certification.md=$FX/certification.md" prun watchdog-r0 wolfpack-watchdog-glm certification.md pedigree.json >/dev/null; rc=$?; fi
  check "$rc" 78 "AC6 $path: only certification.md of two → exit 78"
  err_marker "missing pedigree.json" "AC6 $path: names the missing pedigree.json"
  grep -q "missing certification.md" "$SCRATCH/err" && no "AC6 $path: certification.md reported missing" || ok "AC6 $path: certification.md is not reported missing"
  not_delivered certification.md "AC6 $path (partial)"
  quarantined watchdog-r0 "AC6 $path (partial)"
  [ -f "$(compgen -G "$HPD/.seat-out/watchdog-r0.rejected-*" | head -1)/certification.md" ] && ok "AC6 $path: the quarantine keeps the seat's file as evidence" || no "AC6 $path: evidence missing from quarantine"
  grep -q "WOLFPACK_ARTIFACT_DELIVERED" "$SCRATCH/err" && no "AC6 $path: a DELIVERED line was printed" || ok "AC6 $path: no DELIVERED line"
done

# ─── AC7: anything extra in the out dir → exit 78 unexpected; plan-dir metadata untouched ───
for extra in "notes.txt" "sub/deep.md" "metadata.json" ".hidden"; do
  hreset; MSHA=$(sha256sum < "$HPD/metadata.json")
  FAKE_SEAT_WRITE="review-3.md=$FX/review.md" FAKE_SEAT_EXTRA="$extra" hrun bloodhound-r3 wolfpack-bloodhound-glm review-3.md >/dev/null; rc=$?
  check "$rc" 78 "AC7 extra '$extra' → exit 78"
  top=${extra%%/*}
  err_marker "unexpected $HREL/.seat-out/bloodhound-r3/$top" "AC7 extra '$extra': unexpected <rel path> named"
  [ "$extra" = "sub/deep.md" ] && err_marker "unexpected $HREL/.seat-out/bloodhound-r3/sub/deep.md" "AC7 extra subdir: its contents are named too"
  not_delivered review-3.md "AC7 extra '$extra'"
  check "$(sha256sum < "$HPD/metadata.json")" "$MSHA" "AC7 extra '$extra': plan-dir metadata.json sha256 unchanged"
  quarantined bloodhound-r3 "AC7 extra '$extra'"
done
# podman path too
hreset
FAKE_SEAT_WRITE="review-3.md=$FX/review.md" FAKE_SEAT_EXTRA="metadata.json" prun bloodhound-r3 wolfpack-bloodhound-glm review-3.md >/dev/null; rc=$?
check "$rc" 78 "AC7 podman: an extra metadata.json in the out dir → exit 78"
not_delivered review-3.md "AC7 podman"

# ─── symlink / non-regular artifact → exit 78 not-a-regular-file ───
hreset
FAKE_SEAT_CMD='ln -s "$WT/src.txt" "$OUT/review-1.md"' hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 78 "symlink artifact → exit 78"
err_marker "not-a-regular-file review-1.md" "symlink artifact: not-a-regular-file named"
[ ! -L "$HPD/review-1.md" ] && [ ! -e "$HPD/review-1.md" ] && ok "symlink artifact: nothing in the plan dir" || no "symlink artifact delivered"
check "$(cat "$HWT/src.txt")" "source v1" "symlink artifact: the link target is untouched"
hreset
FAKE_SEAT_CMD='mkdir "$OUT/review-1.md"' hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 78 "a DIRECTORY named like the artifact → exit 78"
err_marker "not-a-regular-file review-1.md" "directory artifact: not-a-regular-file named"

# ─── AC8: source changes are caught (sandbox AND podman); documented exclusions pass ───
for path in sandbox podman; do
  for touch in "src.txt" "newfile.txt" "deep/new/untracked.py"; do
    hreset
    if [ "$path" = sandbox ]; then FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_TOUCH="$touch" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
    else FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_TOUCH="$touch" prun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?; fi
    check "$rc" 78 "AC8 $path: seat touches $touch → exit 78"
    err_marker "source-touched $touch" "AC8 $path: source-touched $touch"
    not_delivered review-1.md "AC8 $path ($touch)"
    quarantined bloodhound-r1 "AC8 $path ($touch)"
  done
done
# Exclusions (P5): gitignored cache churn, the heartbeat, the plan dir's rate-limits/timing logs.
for c in 'mkdir -p "$WT/cache"; echo x > "$WT/cache/pyc"' \
         'mkdir -p "$WT/.wolfpack/heartbeats"; echo "{\"agent\":\"working\"}" > "$WT/.wolfpack/heartbeats/x.json"' \
         'echo "{\"family\":\"glm\"}" >> "$PD/rate-limits.jsonl"' \
         'echo "{\"phase\":\"Review\"}" >> "$PD/timing.jsonl"' \
         'mkdir -p "$PD/seat-notes"'; do
  hreset
  FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_CMD="$c" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
  check "$rc" 0 "AC8 exclusion → rc 0: $c"
  grep -q "source-touched" "$SCRATCH/err" && no "AC8 exclusion flagged: $(grep source-touched "$SCRATCH/err")" || ok "AC8 exclusion: no source-touched"
  cmp -s "$HPD/review-1.md" "$FX/review.md" && ok "AC8 exclusion: still delivered" || no "AC8 exclusion: not delivered"
done
# A pre-existing heartbeat rewritten mid-run is excluded too (it exists BEFORE and changes).
hreset; mkdir -p "$HWT/.wolfpack/heartbeats"; echo '{"agent":"starting"}' > "$HWT/.wolfpack/heartbeats/x.json"
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_CMD='echo "{\"agent\":\"done\"}" > "$WT/.wolfpack/heartbeats/x.json"' hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 0 "AC8 exclusion: an existing heartbeat rewritten mid-run → rc 0"
# The plan dir's own files are sha-pinned (sandbox path: the worktree is writable there).
for c in 'echo "{\"status\":\"hacked\"}" > "$PD/metadata.json"|metadata.json' \
         'cp "$OUT/review-1.md" "$PD/review-1.md.tmp" && mv "$PD/review-1.md.tmp" "$PD/review-2.md"|review-2.md' \
         'echo stray > "$PD/plan-final.md"|plan-final.md'; do
  cmd=${c%|*}; name=${c##*|}
  hreset
  FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_CMD="$cmd" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
  check "$rc" 78 "AC8 plan-dir pin: the seat writes $name in the plan dir → exit 78"
  err_marker "source-touched $HREL/$name" "AC8 plan-dir pin: source-touched names $HREL/$name"
  not_delivered review-1.md "AC8 plan-dir pin ($name)"
done
# A review written STRAIGHT into the plan dir (not the out dir) → caught, never mistaken for delivery.
hreset
FAKE_SEAT_CMD='cp "'"$FX"'/review.md" "$PD/review-1.md"' hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 78 "AC8: review-1.md written straight into the plan dir → exit 78"
err_marker "source-touched $HREL/review-1.md" "AC8: source-touched names the plan-dir review-1.md"
err_marker "missing review-1.md" "AC8: …and the out-dir artifact is missing"
grep -q "WOLFPACK_ARTIFACT_DELIVERED" "$SCRATCH/err" && no "AC8: straight-to-plan-dir write was reported delivered" || ok "AC8: no DELIVERED line"
# Refs are NOT snapshotted (P5): a parallel hunt moving another branch is not a violation…
hreset
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_CMD='git -C "$WT" update-ref refs/heads/other-track HEAD' hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 0 "AC8 refs: a foreign branch ref created mid-run → rc 0 (refs are repo-global)"
grep -q "source-touched" "$SCRATCH/err" && no "AC8 refs: flagged source-touched" || ok "AC8 refs: no source-touched"
# …but a commit on the checked-out branch moves HEAD and IS caught.
hreset
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_CMD='git -C "$WT" -c user.email=s@s -c user.name=s commit -q --allow-empty -m seat' hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 78 "AC8: a seat commit (HEAD moves) → exit 78"
err_marker "source-touched HEAD" "AC8: source-touched HEAD"
not_delivered review-1.md "AC8 commit"
# A staged-only change (index) is caught as well.
hreset
FAKE_SEAT_CMD='echo staged >> "$WT/src.txt"; git -C "$WT" add src.txt' FAKE_SEAT_WRITE="review-1.md=$FX/review.md" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 78 "AC8: a staged change → exit 78"
err_marker "source-touched src.txt" "AC8: staged change names src.txt"
# A worktree that was ALREADY dirty before the run is fine as long as the seat does not change it.
hreset; echo "pre-existing edit" >> "$HWT/src.txt"; echo new > "$HWT/untracked-before.txt"
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 0 "AC8: pre-existing dirt the seat leaves alone → rc 0"
hreset; echo "pre-existing edit" >> "$HWT/src.txt"
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_TOUCH="src.txt" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 78 "AC8: a further change to an already-dirty file → exit 78 (content sha, not just status)"

# ─── AC9: a pre-populated out dir is refused before anything runs ───
for path in sandbox podman; do
  hreset; mkdir -p "$HPD/.seat-out/bloodhound-r1"; echo stale > "$HPD/.seat-out/bloodhound-r1/review-1.md"
  : > "$SCRATCH/count"
  if [ "$path" = sandbox ]; then FAKE_VIBE_COUNT="$SCRATCH/count" FAKE_SEAT_WRITE="review-1.md=$FX/review.md" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
  else FAKE_SEAT_WRITE="review-1.md=$FX/review.md" prun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?; fi
  check "$rc" 2 "AC9 $path: non-empty out dir → exit 2"
  err_has "seat out dir is not empty: $HPD/.seat-out/bloodhound-r1" "AC9 $path: names the dir"
  if [ "$path" = sandbox ]; then check "$(wc -l < "$SCRATCH/count" | tr -d ' ')" 0 "AC9 sandbox: vibe never ran"; else no_podman "AC9 podman: podman never called"; fi
  check "$(cat "$HPD/.seat-out/bloodhound-r1/review-1.md")" "stale" "AC9 $path: the stale evidence is left in place (never deleted)"
  not_delivered review-1.md "AC9 $path"
done
hreset; mkdir -p "$HPD/.seat-out/bloodhound-r1/.hidden-dir"
hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 2 "AC9: an out dir holding only a hidden entry is not empty → exit 2"
hreset; mkdir -p "$HPD/.seat-out"; echo f > "$HPD/.seat-out/bloodhound-r1"
hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 2 "AC9: an out dir path that is a FILE → exit 2"
hreset; mkdir -p "$HPD/.seat-out" "$SCRATCH/elsewhere"; ln -s "$SCRATCH/elsewhere" "$HPD/.seat-out/bloodhound-r1"
: > "$PODMAN_LOG"
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" prun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 2 "AC9: a SYMLINKED out dir (would redirect the rw bind) → exit 2"
no_podman "AC9 symlinked out dir: podman never called"
[ -z "$(ls -A "$SCRATCH/elsewhere")" ] && ok "AC9 symlinked out dir: nothing written through the link" || no "AC9: wrote through the symlink"
# An empty leftover out dir is fine (reused fresh).
hreset; mkdir -p "$HPD/.seat-out/bloodhound-r1"
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 0 "AC9: an EMPTY pre-existing out dir is accepted"

# ─── AC10: malformed handoff calls → exit 2, nothing runs ───
hreset
ac10() {  # <label> <shim args…>  (agent/worktree/prompt appended unless the label says raw)
  local label="$1"; shift
  : > "$SCRATCH/count"; : > "$PODMAN_LOG"
  FAKE_VIBE_COUNT="$SCRATCH/count" FAKE_SEAT="$SCRATCH/bin/fake-seat" FAKE_OUT_REL="$HREL/.seat-out/s" bash "$SHIM" "$@" 2>"$SCRATCH/err" >/dev/null; rc=$?
  check "$rc" 2 "AC10 $label → exit 2"
  check "$(wc -l < "$SCRATCH/count" | tr -d ' ')" 0 "AC10 $label: vibe never ran"
  [ -s "$PODMAN_LOG" ] && no "AC10 $label: podman called" || ok "AC10 $label: podman never called"
  [ -z "$(ls -A "$HPD" | grep -vxE 'metadata.json|rate-limits.jsonl|\.seat-out')" ] && ok "AC10 $label: plan dir untouched" || no "AC10 $label: plan dir changed ($(ls -A "$HPD"))"
}
A=(wolfpack-bloodhound-glm "$HWT" "$SCRATCH/prompt.txt")
D=(--deliver-to "$HPD"); O=(--out-dir "$HPD/.seat-out/s")
ac10 "--expect metadata.json" "${D[@]}" "${O[@]}" --expect metadata.json "${A[@]}"
err_has "--expect 'metadata.json' is not a handoff artifact name" "AC10 metadata.json: names the value"
ac10 "--expect ../x.md" "${D[@]}" "${O[@]}" --expect ../x.md "${A[@]}"
err_has "--expect '../x.md'" "AC10 ../x.md: names the value"
ac10 "--expect a/review-1.md" "${D[@]}" "${O[@]}" --expect a/review-1.md "${A[@]}"
err_has "--expect 'a/review-1.md'" "AC10 a/review-1.md: names the value"
ac10 "--expect notes.txt" "${D[@]}" "${O[@]}" --expect notes.txt "${A[@]}"
ac10 "--expect REVIEW-1.md (case)" "${D[@]}" "${O[@]}" --expect REVIEW-1.md "${A[@]}"
ac10 "duplicate --expect" "${D[@]}" "${O[@]}" --expect review-1.md --expect review-1.md "${A[@]}"
err_has "--expect 'review-1.md' given twice" "AC10 duplicate: says so"
ac10 "only --deliver-to" "${D[@]}" "${A[@]}"
err_has "handoff mode needs --deliver-to, --out-dir and at least one --expect" "AC10 partial: names the three options"
ac10 "only --out-dir" "${O[@]}" "${A[@]}"
ac10 "only --expect" --expect review-1.md "${A[@]}"
ac10 "no --expect" "${D[@]}" "${O[@]}" "${A[@]}"
ac10 "--out-dir without a value" "${D[@]}" --expect review-1.md --out-dir
ac10 "--implement + handoff" --implement "${D[@]}" "${O[@]}" --expect review-1.md wolfpack-shepherd-glm "$HWT" "$SCRATCH/prompt.txt"
err_has "--implement cannot be combined with the handoff options" "AC10 --implement + handoff: says so"
ac10 "handoff + --implement (other order)" "${D[@]}" "${O[@]}" --expect review-1.md --implement wolfpack-shepherd-glm "$HWT" "$SCRATCH/prompt.txt"
ac10 "out dir not under .seat-out" "${D[@]}" --out-dir "$HPD/out" --expect review-1.md "${A[@]}"
err_has "--out-dir must be <deliver-to>/.seat-out/<name>" "AC10 out dir layout: says so"
ac10 "out dir nested two levels" "${D[@]}" --out-dir "$HPD/.seat-out/a/b" --expect review-1.md "${A[@]}"
ac10 "out dir name starting with a dot" "${D[@]}" --out-dir "$HPD/.seat-out/.x" --expect review-1.md "${A[@]}"
ac10 "out dir under ANOTHER plan dir" "${D[@]}" --out-dir "$HWT/.wolfpack/plans/y/.seat-out/s" --expect review-1.md "${A[@]}"
ac10 "out dir .. escape" "${D[@]}" --out-dir "$HPD/.seat-out/../../y/.seat-out/s" --expect review-1.md "${A[@]}"
ac10 "deliver-to outside the worktree" --deliver-to "$SCRATCH/wt" --out-dir "$SCRATCH/wt/.seat-out/s" --expect review-1.md "${A[@]}"
err_has "--deliver-to must lie inside the worktree" "AC10 deliver-to outside: says so"
ac10 "deliver-to = the worktree root itself" --deliver-to "$HWT" --out-dir "$HWT/.seat-out/s" --expect review-1.md "${A[@]}"
ac10 "deliver-to missing" --deliver-to "$HWT/.wolfpack/plans/nope" --out-dir "$HWT/.wolfpack/plans/nope/.seat-out/s" --expect review-1.md "${A[@]}"
mkdir -p "$HWT/.wolfpack/plans/c:x"
ac10 "deliver-to with ':'" --deliver-to "$HWT/.wolfpack/plans/c:x" --out-dir "$HWT/.wolfpack/plans/c:x/.seat-out/s" --expect review-1.md "${A[@]}"
err_has "contains ':' or a newline" "AC10 ':' path: says so"
ac10 "unknown option" --frobnicate "${A[@]}"
err_has "unknown option '--frobnicate'" "AC10 unknown option: names it"
NG="$SCRATCH/nongit"; mkdir -p "$NG/plans/x"
: > "$SCRATCH/count"
FAKE_VIBE_COUNT="$SCRATCH/count" bash "$SHIM" --deliver-to "$NG/plans/x" --out-dir "$NG/plans/x/.seat-out/s" --expect review-1.md wolfpack-bloodhound-glm "$NG" "$SCRATCH/prompt.txt" >/dev/null 2>"$SCRATCH/err"; rc=$?
check "$rc" 2 "AC10 a non-git worktree in handoff mode → exit 2 (P6)"
err_has "handoff mode needs a git checkout" "AC10 non-git: says so"
check "$(wc -l < "$SCRATCH/count" | tr -d ' ')" 0 "AC10 non-git: vibe never ran"
[ ! -e "$NG/plans/x/.seat-out" ] && ok "AC10 non-git: no out dir created" || no "AC10 non-git: out dir created"
# P1: the options come in any order before <agent>, and `--` ends them.
hreset
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT="$SCRATCH/bin/fake-seat" FAKE_OUT_REL="$HREL/.seat-out/bloodhound-r1" \
  bash "$SHIM" --expect review-1.md --out-dir "$HPD/.seat-out/bloodhound-r1" --deliver-to "$HPD" -- wolfpack-bloodhound-glm "$HWT" "$SCRATCH/prompt.txt" >/dev/null 2>"$SCRATCH/err"; rc=$?
check "$rc" 0 "P1: options in another order + '--' → rc 0"
cmp -s "$HPD/review-1.md" "$FX/review.md" && ok "P1: …and delivered" || no "P1: not delivered"
# A relative --deliver-to/--out-dir (resolved against the caller's CWD) works too.
hreset
( cd "$HWT" && FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT="$SCRATCH/bin/fake-seat" FAKE_OUT_REL="$HREL/.seat-out/bloodhound-r1" \
  bash "$SHIM" --deliver-to "$HREL" --out-dir "$HREL/.seat-out/bloodhound-r1" --expect review-1.md wolfpack-bloodhound-glm "$HWT" "$SCRATCH/prompt.txt" >/dev/null 2>"$SCRATCH/err" ); rc=$?
check "$rc" 0 "P1: relative handoff paths → rc 0"

# ─── retry: attempt 1 leaves a PARTIAL artifact + a 429, attempt 2 writes → one clean delivery ───
for agent in wolfpack-bloodhound-glm wolfpack-bloodhound; do
  hreset; : > "$SCRATCH/count"; rm -f "$SCRATCH/first"
  FAKE_VIBE_COUNT="$SCRATCH/count" FAKE_SEAT_FAIL_FIRST="$SCRATCH/first" FAKE_SEAT_WRITE="review-1.md=$FX/review.md" WOLFPACK_CB_FAILS=99 \
    hrun bloodhound-r1 "$agent" review-1.md >/dev/null; rc=$?
  check "$rc" 0 "retry $agent: transient attempt 1 + clean attempt 2 → rc 0"
  check "$(wc -l < "$SCRATCH/count" | tr -d ' ')" 2 "retry $agent: two attempts"
  delivered_ok review-1.md "$FX/review.md" "retry $agent"
  check "$(grep -c '^WOLFPACK_ARTIFACT_DELIVERED' "$SCRATCH/err")" 1 "retry $agent: exactly one delivered file"
  rm -f "$TMPDIR/wolfpack-sem/"*.cooldown "$TMPDIR/wolfpack-sem/"*.fails
done

# ─── a seat that exits non-zero keeps ITS exit code (not 78); the out dir is quarantined ───
hreset
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_VIBE_ERR="Error: not authenticated (401)" hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 1 "non-zero seat (permanent rc 1) after writing → rc 1, not 78"
grep -q "WOLFPACK_ARTIFACT" "$SCRATCH/err" && no "non-zero seat: the artifact check ran" || ok "non-zero seat: no artifact check (no ARTIFACT markers)"
not_delivered review-1.md "non-zero seat"
quarantined bloodhound-r1 "non-zero seat"
hreset
FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_VIBE_SLEEP=5 WOLFPACK_VIBE_REVIEW_TIMEOUT=1 hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 76 "seat timeout after writing → 76 (WOLFPACK_TIMEOUT), not 78"
grep -q '^WOLFPACK_TIMEOUT:glm' "$SCRATCH/err" && ok "seat timeout: the sentinel is preserved" || no "seat timeout sentinel"
not_delivered review-1.md "seat timeout"
quarantined bloodhound-r1 "seat timeout"
hreset
FAKE_VIBE_ERR="HTTP 429 Too Many Requests" WOLFPACK_MAX_RETRIES=1 WOLFPACK_CB_FAILS=99 hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
check "$rc" 75 "seat rate-limited (nothing written) → 75 preserved"
[ ! -e "$HPD/.seat-out/bloodhound-r1" ] && ok "rate-limited, empty out dir → removed (nothing to quarantine)" || no "empty out dir left behind"
compgen -G "$HPD/.seat-out/bloodhound-r1.rejected-*" >/dev/null && no "an EMPTY out dir was quarantined" || ok "an empty out dir is not quarantined"
rm -f "$TMPDIR/wolfpack-sem/"*.cooldown "$TMPDIR/wolfpack-sem/"*.fails
# podman path keeps the seat's rc too
cat > "$SCRATCH/bin/podman-fail" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$PODMAN_LOG"; [ "${1:-}" = "image" ] && exit 0
rw=""; prev=""; for a in "$@"; do if [ "$prev" = "-v" ]; then case "$a" in *:rw,z) rw="${a%%:*}" ;; esac; fi; prev="$a"; done
[ -n "$rw" ] && echo "half" > "$rw/review-1.md"
echo "Error: boom (500 permanent)" >&2; exit 3
FAKE
chmod +x "$SCRATCH/bin/podman-fail"; cp "$SCRATCH/bin/podman" "$SCRATCH/podman.keep"; cp "$SCRATCH/bin/podman-fail" "$SCRATCH/bin/podman"
hreset
WOLFPACK_MAX_RETRIES=1 WOLFPACK_CB_FAILS=99 prun bloodhound-r1 wolfpack-bloodhound review-1.md >/dev/null; rc=$?
check "$rc" 3 "podman mistral seat rc 3 → rc 3 preserved (not 78)"
quarantined bloodhound-r1 "podman non-zero seat"
cp "$SCRATCH/podman.keep" "$SCRATCH/bin/podman"

# ─── move failure: a plan dir that cannot take the rename → exit 78 move-failed ───
if [ "$(id -u)" != 0 ]; then
  hreset
  FAKE_SEAT_WRITE="review-1.md=$FX/review.md" FAKE_SEAT_CMD='chmod a-w "$PD"' hrun bloodhound-r1 wolfpack-bloodhound-glm review-1.md >/dev/null; rc=$?
  chmod u+w "$HPD"
  check "$rc" 78 "move-failed: an unwritable plan dir → exit 78"
  err_marker "move-failed review-1.md" "move-failed: names the artifact"
  grep -q "WOLFPACK_ARTIFACT_DELIVERED" "$SCRATCH/err" && no "move-failed: a DELIVERED line" || ok "move-failed: no DELIVERED line"
  quarantined bloodhound-r1 "move-failed"
fi

# ─── AC11: the --implement path never sees the handoff machinery ───
: > "$PODMAN_LOG"
out=$( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= bash "$SHIM" --implement wolfpack-shepherd-glm "$HWT" "$SCRATCH/prompt.txt" 2>"$SCRATCH/err" ); rc=$?
check "$rc" 0 "AC11 --implement on the git fixture → rc 0"
check "$(grep -c ':rw,z$' <<<"$out")" 1 "AC11 --implement: only the worktree rw bind (no out-dir bind)"
vmount "$out" "$HWT:$HWT:rw,z" "AC11 --implement: the worktree is the rw bind"
grep -q "WOLFPACK_ARTIFACT" "$SCRATCH/err" && no "AC11 --implement: artifact markers" || ok "AC11 --implement: no artifact markers"
hreset

echo
echo "──────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
