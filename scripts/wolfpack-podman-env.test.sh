#!/usr/bin/env bash
# wolfpack-test: needs podman
# scripts/wolfpack-podman-env.test.sh — host preflight for the sandbox model the seat shims
# depend on: podman is installed, `podman info` works, and the host runs ROOTLESS podman.
# It never pulls or runs an image. scripts/test-all.sh SKIPs it (visibly) when podman is
# absent or WOLFPACK_TEST_NO_PODMAN=1.
set -uo pipefail

FAILS=0
ok()   { echo "ok   $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }

if ver=$(podman --version 2>&1); then
  ok "podman --version ($ver)"
else
  fail "podman --version exited non-zero: $ver"
fi

if podman info >/dev/null 2>&1; then
  ok "podman info exits 0"
else
  fail "podman info exited non-zero (is the podman service/user namespace set up?)"
fi

rootless=$(podman info --format '{{.Host.Security.Rootless}}' 2>&1)
if [ "$rootless" = "true" ]; then
  ok "podman is rootless"
else
  fail "podman is not rootless (Host.Security.Rootless = '$rootless') — the seat sandbox expects rootless podman"
fi

if [ "$FAILS" -gt 0 ]; then
  echo "wolfpack-podman-env: $FAILS failure(s)"
  exit 1
fi
echo "wolfpack-podman-env: all checks passed"
