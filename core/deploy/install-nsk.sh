#!/usr/bin/env bash
# Install the optional, read-only nsk binary matching the deployed release. It exposes only live balances
# and financials; token funding remains exclusively on the normal /buy path.
set -euo pipefail

# shellcheck source=deploy/lib.sh
source "$(dirname "$0")/lib.sh"

TAG="${1:-}"
if [ -z "$TAG" ]; then
  current="$(readlink /usr/local/lib/nullsink/current-proxy 2>/dev/null || true)"
  TAG="${current#nullsink-proxy-}"
  if [ -z "$TAG" ] || [ "$TAG" = "$current" ]; then
    echo "no server binary found to match; pass a release tag" >&2
    exit 1
  fi
fi

install_nsk "$TAG"
echo "nsk installed. Run: sudo -u nullsink nsk balances"
