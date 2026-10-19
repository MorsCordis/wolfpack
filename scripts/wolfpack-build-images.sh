#!/usr/bin/env bash
# scripts/wolfpack-build-images.sh — build (or --rebuild) a consuming project's seat images
# from the pack's Containerfiles plus the project's configured layer.
#
# Usage (from the consuming repo's root):
#   bash "$WOLFPACK_HOME/scripts/wolfpack-build-images.sh" [--rebuild]
#
# Reads wolfpack-config.md → Execution Layer (WOLFPACK_CONFIG overrides the path) and ensures:
#   1. the Sandbox image — the pack base (containers/Containerfile.wolfpack), with the
#      Sandbox project layer built on top when one is configured (the base is then tagged
#      <sandbox name>-pack-base:<tag>);
#   2. the GLM image (WOLFPACK_GLM_IMAGE overrides) — containers/Containerfile.wolfpack-glm
#      FROM the Sandbox image.
# Without --rebuild an existing image is kept. With --rebuild it first prints the current
# image IDs and the rollback command, then rebuilds both. Prints the resulting image IDs.
#
# Exit: 0 built/present · 2 usage, config or build error.
set -euo pipefail

REBUILD=""
case "${1:-}" in
    '') ;;
    --rebuild) REBUILD="--rebuild" ;;
    *) echo "usage: bash \"\$WOLFPACK_HOME/scripts/wolfpack-build-images.sh\" [--rebuild]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: bash \"\$WOLFPACK_HOME/scripts/wolfpack-build-images.sh\" [--rebuild]" >&2; exit 2; }

if ! command -v podman >/dev/null 2>&1; then
    echo "✗ wolfpack-build-images: podman is not on PATH" >&2
    exit 2
fi

WP_CALLER="wolfpack-build-images"
# shellcheck source=lib/wolfpack-sandbox.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/wolfpack-sandbox.sh"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
wp_load_exec_config "$REPO_ROOT" || exit 2
GLM_IMAGE="${WOLFPACK_GLM_IMAGE:-$WP_GLM_IMAGE}"

image_id() { podman image inspect --format '{{.Id}}' "$1" 2>/dev/null | cut -c1-12; }

echo "config: ${WP_CFG_PATH}"
if [ -n "$REBUILD" ]; then
    for img in "$WP_SANDBOX_IMAGE" "$GLM_IMAGE"; do
        old=$(image_id "$img" || true)
        if [ -n "$old" ]; then
            echo "previous ${img} = ${old}   (rollback: podman tag ${old} ${img})"
        else
            echo "previous ${img} = (absent)"
        fi
    done
fi

wp_ensure_sandbox_image $REBUILD || exit 2
wp_ensure_glm_image "$GLM_IMAGE" $REBUILD || exit 2

for img in "$WP_SANDBOX_IMAGE" "$GLM_IMAGE"; do
    id=$(image_id "$img" || true)
    if [ -z "$id" ]; then
        echo "✗ wolfpack-build-images: ${img} is still absent after the build" >&2
        exit 2
    fi
    echo "${img} = ${id}"
done
