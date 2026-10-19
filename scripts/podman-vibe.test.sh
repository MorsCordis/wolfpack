#!/usr/bin/env bash
# Tests for scripts/podman-vibe.sh — run: bash scripts/podman-vibe.test.sh
# No network, no podman, no real Vibe: runs the shim in WOLFPACK_SANDBOX mode (direct
# `vibe` call) against a FAKE `vibe` on PATH that echoes its argv, with an isolated
# HOME + TMPDIR. Asserts the per-family command line (mistral unchanged, glm gets
# --auto-approve + the strict allow-list), --implement gating, and the per-family
# rate-limit exit contract (exit 75 + WOLFPACK_RATE_LIMITED:<family>).
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SHIM="${HERE}/podman-vibe.sh"

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
export TMPDIR="$SCRATCH/tmp"; mkdir -p "$TMPDIR"
export HOME="$SCRATCH/home"; mkdir -p "$HOME/.vibe" "$SCRATCH/bin" "$SCRATCH/wt"
touch "$HOME/.vibe/.env" "$HOME/.vibe/config.toml"
echo "review this" > "$SCRATCH/prompt.txt"

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
check "$(tools "$out")" "read_file grep bash dev_cortex_repo_map dev_cortex_file_outline" "glm review: sandbox-scoped shell, no edit/write"
hasnt "$out" "edit" "glm review: no edit"
hasnt "$out" "write_file" "glm review: no write_file"
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
has "$out" "wolfpack-sandbox:latest" "podman mistral: base image (unchanged)"
out=$(WOLFPACK_SANDBOX= run wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt")
has "$out" "${WT}:${WT}:ro,z" "podman glm review: worktree ro at its HOST path (dev-cortex mirror)"
has "$out" "wolfpack-sandbox-glm:latest" "podman glm: layered GLM image (current Vibe)"
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
# Review seats run the test command in the container: WOLFPACK_SANDBOX=1 (image Python + /tmp
# PG) and a test-only SECRET_KEY on BOTH podman run calls; never the host .env; never on --implement.
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
( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= FAKE_MISSING_IMAGE=wolfpack-sandbox-glm bash "$SHIM" wolfpack-pointer-glm "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>&1 ); rc=$?
check "$rc" 0 "missing GLM image → built, then run"
grep -q "^build -t wolfpack-sandbox-glm:latest -f .*/.claude/containers/Containerfile.wolfpack-glm .*/.claude/containers$" "$PODMAN_LOG" \
  && ok "GLM image built from Containerfile.wolfpack-glm with the small .claude/containers context" || no "GLM image build command ($(grep ^build "$PODMAN_LOG"))"
grep -q "wolfpack-sandbox-glm:latest bash -c" "$PODMAN_LOG" && ok "…and the run uses the freshly built GLM image" || no "GLM run image"
: > "$PODMAN_LOG"
( cd "$SCRATCH/wt" && WOLFPACK_SANDBOX= FAKE_MISSING_IMAGE=wolfpack-sandbox-glm bash "$SHIM" wolfpack-pointer "$SCRATCH/wt" "$SCRATCH/prompt.txt" >/dev/null 2>&1 )
grep -q "wolfpack-sandbox-glm" "$PODMAN_LOG" && no "mistral path touched the GLM image" || ok "mistral path never builds/uses the GLM image"
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
ENOSPC="OSError: [Errno 28] No space left on device: '/home/u/.vibe/logs/vibe.log'"
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

# ─── shims stay executable (hunt-pipeline runs "<repo>/scripts/podman-vibe.sh" directly;
#     /run-hunt and /run-campaign `exec ./scripts/run-pipeline-sandbox.sh`) ───
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

echo
echo "──────────────────────────────"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
