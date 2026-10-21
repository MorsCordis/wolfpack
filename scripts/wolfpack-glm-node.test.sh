#!/usr/bin/env bash
# wolfpack-test: needs podman
# scripts/wolfpack-glm-node.test.sh — merge-and-state-hygiene AC18: the GLM review image provides
# `node` (>= 22), so a GLM review seat can run the node suites. It NEVER builds or pulls an image:
#   - the configured GLM image (wolfpack-config.mjs --json → exec.glmImage) is not present locally
#     → "SKIP: <image> not built", exit 0;
#   - the local image was built BEFORE the last commit that changed containers/Containerfile.wolfpack-glm
#     → "SKIP: <image> is stale … rebuild with scripts/wolfpack-build-images.sh", exit 0 (the operator
#     step in the hunt's Deployment Notes; a stale image cannot prove anything about the new layer);
#   - otherwise `podman run --rm --entrypoint node <image> --version` must exit 0 with v22+.
# scripts/test-all.sh SKIPs the whole file (visibly) when podman is absent or WOLFPACK_TEST_NO_PODMAN=1.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok() { echo "ok   - $*"; PASS=$((PASS + 1)); }
no() { echo "FAIL - $*"; FAIL=$((FAIL + 1)); }

IMG=$(node "$ROOT/scripts/wolfpack-config.mjs" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).exec.glmImage||""))}catch{}})')
if [ -z "$IMG" ]; then
  echo "FAIL - no exec.glmImage from wolfpack-config.mjs --json"
  echo "PASS=0 FAIL=1"
  exit 1
fi

if ! podman image exists "$IMG" 2>/dev/null; then
  echo "SKIP: $IMG not built"
  exit 0
fi

built=$(podman image inspect "$IMG" --format '{{.Created.Unix}}' 2>/dev/null || echo 0)
changed=$(git -C "$ROOT" log -1 --format=%ct -- containers/Containerfile.wolfpack-glm 2>/dev/null || echo 0)
if [ -n "$changed" ] && [ "${changed:-0}" -gt 0 ] && [ "${built:-0}" -lt "$changed" ]; then
  echo "SKIP: $IMG is stale (built $(date -u -d "@$built" +%FT%TZ 2>/dev/null || echo "$built") before the last Containerfile.wolfpack-glm change) — rebuild with scripts/wolfpack-build-images.sh"
  exit 0
fi

out=$(timeout 120 podman run --rm --entrypoint node "$IMG" --version 2>&1)
rc=$?
[ "$rc" -eq 0 ] && ok "$IMG: node --version exits 0 ($out)" || no "$IMG: node --version exited $rc: $out"
major=$(printf '%s' "$out" | sed -nE 's/^v([0-9]+)\..*/\1/p')
[ -n "$major" ] && [ "$major" -ge 22 ] && ok "$IMG: node is >= 22" || no "$IMG: node version '$out' is not >= 22"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
