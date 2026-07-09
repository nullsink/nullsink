#!/usr/bin/env bash
# Install (or update) the OPTIONAL `nsk` operator CLI on the box, on demand. nsk is the break-glass /
# accounting CLI (`nsk issue|topup|balance|financials`); the box does NOT ship it by default. Run as root:
#   sudo deploy/install-nsk.sh           # install nsk matching the currently-deployed server tag
#   sudo deploy/install-nsk.sh v0.3.0    # install a specific release tag
# Once installed, deploy/deploy.sh refreshes it in lockstep with the server on each redeploy.
set -euo pipefail

# shellcheck source=deploy/lib.sh
source "$(dirname "$0")/lib.sh"   # provides install_nsk()

TAG="${1:-}"
if [ -z "$TAG" ]; then
  # Default to the live server's tag so nsk matches the running schema. Read the PROXY symlink
  # (current-proxy -> nullsink-proxy-<tag>): install_binary moves both service symlinks in lockstep, so
  # either one names the deployed tag. The pre-split `current` symlink is gone — retire_legacy_unit removes
  # it on the first post-split deploy.
  cur="$(readlink /usr/local/lib/nullsink/current-proxy 2>/dev/null || true)"
  TAG="${cur#nullsink-proxy-}"
  if [ -z "$TAG" ] || [ "$TAG" = "$cur" ]; then
    echo "no server binary found to match; pass a release tag, e.g. deploy/install-nsk.sh v0.3.0" >&2
    exit 1
  fi
fi

install_nsk "$TAG"
echo "nsk installed. Run it as the service user, e.g.: sudo -u nullsink nsk financials"
