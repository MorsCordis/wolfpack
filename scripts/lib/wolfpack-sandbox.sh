# scripts/lib/wolfpack-sandbox.sh — shared by the seat shim (scripts/podman-vibe.sh), the
# sandbox launcher (scripts/run-pipeline-sandbox.sh) and the image builder
# (scripts/wolfpack-build-images.sh). SOURCED, never executed.
#
# Every function fails loud: a ✗ message on stderr and `return 2`; callers append `|| exit 2`.
#
#   wp_load_exec_config <repo_root>
#       Picks the consuming project's config — WOLFPACK_CONFIG (absolute path, operator
#       override), else <repo_root>/wolfpack-config.md, else fail — and reads its
#       `## Execution Layer` through the ONE reader (node scripts/wolfpack-config.mjs --exec).
#       Sets WP_CFG_PATH WP_SANDBOX_IMAGE WP_GLM_IMAGE WP_PROJECT_LAYER WP_VIBE_AGENT_DIR and
#       the arrays WP_SEAT_MOUNTS WP_SANDBOX_MOUNTS (entries `host:container`),
#       WP_SECRETS_PATHS, WP_SEAT_ENV (entries `NAME=value`). A reader failure is relayed
#       verbatim, so the missing/bad KEY NAME reaches the user.
#   wp_secrets_guard <key-label> <host path>...
#       Refuses (return 2) when any path, normalised with realpath -m, equals a configured
#       secrets path, lies under one, or contains one.
#   wp_build_args
#       Prints the four --build-arg USER_* pairs (one argv word per line) for the base image.
#   wp_ensure_sandbox_image [--rebuild]
#       Builds WP_SANDBOX_IMAGE when absent (or always with --rebuild): the pack base, then the
#       project layer on top when one is configured.
#   wp_ensure_glm_image <name> [--rebuild]
#       Ensures the sandbox image, then builds the GLM layer FROM it as <name>.
#
# WP_PACK_DIR is this lib's own pack (../..): the pack locates itself, it never looks in the
# consuming repo for its own files.

WP_PACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

_wp_err() { echo "✗ ${WP_CALLER:-wolfpack}: $*" >&2; }

wp_load_exec_config() {
    local repo_root="${1:-}" cfg out err rc
    if [ -n "${WOLFPACK_CONFIG:-}" ]; then
        cfg="$WOLFPACK_CONFIG"
        case "$cfg" in
            /*) ;;
            *) _wp_err "WOLFPACK_CONFIG must be an absolute path (got '$cfg')"; return 2 ;;
        esac
        if [ ! -f "$cfg" ]; then
            _wp_err "WOLFPACK_CONFIG names a file that does not exist: $cfg"
            return 2
        fi
    elif [ -n "$repo_root" ] && [ -f "$repo_root/wolfpack-config.md" ]; then
        cfg="$repo_root/wolfpack-config.md"
    else
        _wp_err "no wolfpack-config.md — run from the consuming repo's root or set WOLFPACK_CONFIG"
        return 2
    fi
    if ! command -v node >/dev/null 2>&1; then
        _wp_err "needs node to read wolfpack-config.md (${cfg}) — install node on the host"
        return 2
    fi
    err=$(mktemp -t wolfpack-exec-cfg.XXXXXX)
    rc=0
    out=$(node "$WP_PACK_DIR/scripts/wolfpack-config.mjs" --exec "$cfg" 2>"$err") || rc=$?
    if [ "$rc" -ne 0 ]; then
        cat "$err" >&2
        rm -f "$err"
        _wp_err "wolfpack-config.md → Execution Layer is incomplete or invalid (${cfg}); check: node ${WP_PACK_DIR}/scripts/wolfpack-config.mjs --exec ${cfg}"
        return 2
    fi
    rm -f "$err"
    WP_CFG_PATH="" WP_SANDBOX_IMAGE="" WP_GLM_IMAGE="" WP_PROJECT_LAYER="" WP_VIBE_AGENT_DIR=""
    WP_SEAT_MOUNTS=() WP_SANDBOX_MOUNTS=() WP_SECRETS_PATHS=() WP_SEAT_ENV=()
    local k a b
    while IFS=$'\t' read -r k a b; do
        case "$k" in
            config)         WP_CFG_PATH="$a" ;;
            sandbox_image)  WP_SANDBOX_IMAGE="$a" ;;
            glm_image)      WP_GLM_IMAGE="$a" ;;
            project_layer)  WP_PROJECT_LAYER="$a" ;;
            vibe_agent_dir) WP_VIBE_AGENT_DIR="$a" ;;
            seat_mount)     WP_SEAT_MOUNTS+=("${a}:${b}") ;;
            sandbox_mount)  WP_SANDBOX_MOUNTS+=("${a}:${b}") ;;
            secrets_path)   WP_SECRETS_PATHS+=("$a") ;;
            seat_env)       WP_SEAT_ENV+=("$a") ;;
            '') ;;
            *) _wp_err "unexpected line from wolfpack-config.mjs --exec: '$k' — pack scripts out of sync?"; return 2 ;;
        esac
    done <<< "$out"
    if [ -z "$WP_SANDBOX_IMAGE" ] || [ -z "$WP_GLM_IMAGE" ] || [ -z "$WP_VIBE_AGENT_DIR" ] || [ -z "$WP_CFG_PATH" ]; then
        _wp_err "wolfpack-config.mjs --exec returned an incomplete record for ${cfg}"
        return 2
    fi
    return 0
}

wp_secrets_guard() {
    local label="${1:?wp_secrets_guard <key-label> <path>...}"
    shift
    [ "${#WP_SECRETS_PATHS[@]}" -gt 0 ] || return 0
    local p s rp rs
    for p in "$@"; do
        [ -n "$p" ] || continue
        rp=$(realpath -m -- "$p")
        for s in "${WP_SECRETS_PATHS[@]}"; do
            rs=$(realpath -m -- "$s")
            if [ "$rp" = "$rs" ] || [ "${rp#"$rs"/}" != "$rp" ] || [ "${rs#"$rp"/}" != "$rs" ] || [ "$rp" = "/" ]; then
                echo "✗ wolfpack: mount ${rp} overlaps a configured secret path ${rs} (wolfpack-config.md → Execution Layer → ${label}) — refusing to start the container" >&2
                return 2
            fi
        done
    done
    return 0
}

wp_build_args() {
    local name uid gid
    name=$(id -un) && uid=$(id -u) && gid=$(id -g) || { _wp_err "cannot read the host user (id)"; return 2; }
    if [ -z "${HOME:-}" ]; then _wp_err "HOME is not set — the container user's home comes from it"; return 2; fi
    printf '%s\n' --build-arg "USER_NAME=${name}" --build-arg "USER_UID=${uid}" \
        --build-arg "USER_GID=${gid}" --build-arg "USER_HOME=${HOME}"
}

# <name>-pack-base:<tag> for a sandbox image <name>:<tag> (split at the LAST ':'; the reader
# guarantees a tag, so a ':' followed by '/' — a registry port — is never the split point).
wp_base_image_name() {
    local img="$1"
    printf '%s-pack-base:%s\n' "${img%:*}" "${img##*:}"
}

wp_ensure_sandbox_image() {
    local rebuild=""
    [ "${1:-}" = "--rebuild" ] && rebuild=1
    if [ -z "$rebuild" ] && podman image exists "$WP_SANDBOX_IMAGE" 2>/dev/null; then
        return 0
    fi
    local args=() base
    mapfile -t args < <(wp_build_args) || return 2
    [ "${#args[@]}" -eq 8 ] || { _wp_err "could not compute the container user build args"; return 2; }
    if [ -n "$WP_PROJECT_LAYER" ]; then
        if [ ! -f "$WP_PROJECT_LAYER" ]; then
            _wp_err "the configured project layer does not exist: ${WP_PROJECT_LAYER} (wolfpack-config.md → Execution Layer → Sandbox project layer)"
            return 2
        fi
        base=$(wp_base_image_name "$WP_SANDBOX_IMAGE")
        echo "Building ${base} (pack base image)..." >&2
        podman build "${args[@]}" -t "$base" -f "$WP_PACK_DIR/containers/Containerfile.wolfpack" "$WP_PACK_DIR/containers" >&2 \
            || { _wp_err "podman build of the pack base image ${base} failed"; return 2; }
        echo "Building ${WP_SANDBOX_IMAGE} (project layer ${WP_PROJECT_LAYER})..." >&2
        podman build --build-arg "BASE_IMAGE=${base}" -t "$WP_SANDBOX_IMAGE" -f "$WP_PROJECT_LAYER" "$(dirname "$WP_CFG_PATH")" >&2 \
            || { _wp_err "podman build of the project layer ${WP_PROJECT_LAYER} failed"; return 2; }
    else
        echo "Building ${WP_SANDBOX_IMAGE} (pack base image)..." >&2
        podman build "${args[@]}" -t "$WP_SANDBOX_IMAGE" -f "$WP_PACK_DIR/containers/Containerfile.wolfpack" "$WP_PACK_DIR/containers" >&2 \
            || { _wp_err "podman build of ${WP_SANDBOX_IMAGE} failed"; return 2; }
    fi
    return 0
}

wp_ensure_glm_image() {
    local name="${1:?wp_ensure_glm_image <name> [--rebuild]}" rebuild=""
    [ "${2:-}" = "--rebuild" ] && rebuild=1
    wp_ensure_sandbox_image || return 2
    if [ -z "$rebuild" ] && podman image exists "$name" 2>/dev/null; then
        return 0
    fi
    echo "Building ${name} (GLM Vibe layer FROM ${WP_SANDBOX_IMAGE})..." >&2
    podman build --build-arg "BASE_IMAGE=${WP_SANDBOX_IMAGE}" -t "$name" \
        -f "$WP_PACK_DIR/containers/Containerfile.wolfpack-glm" "$WP_PACK_DIR/containers" >&2 \
        || { _wp_err "podman build of the GLM image ${name} failed"; return 2; }
    return 0
}
