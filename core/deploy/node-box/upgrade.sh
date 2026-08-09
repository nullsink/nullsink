#!/usr/bin/env bash
# Health-gated Bitcoin Core upgrade for the dedicated node box. Stages and verifies before downtime and
# automatically restores the previous binaries if activation does not recover a synced watch-only wallet.
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

BIN_DIR="/usr/local/bin"
ROLLBACK_ROOT="/usr/local/lib/nullsink-node/component-rollbacks"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
UNIT="bitcoind"
BINARIES=(bitcoind bitcoin-cli)

# shellcheck source=deploy/node-box/lib.sh
source "$(dirname "$0")/lib.sh"

[ "${EUID:-$(id -u)}" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 2; }
[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || {
  echo "HEALTH_TIMEOUT must be a positive integer" >&2
  exit 2
}
command -v flock >/dev/null 2>&1 || { echo "flock is required" >&2; exit 2; }
exec 9>/run/lock/nullsink-node-upgrade.lock
flock -n 9 || { echo "another node upgrade is already running" >&2; exit 2; }

systemctl cat bitcoind.service >/dev/null 2>&1 || {
  echo "refusing: this is not a configured node box" >&2
  exit 2
}
systemctl cat nullsink-proxy.service >/dev/null 2>&1 && {
  echo "refusing: app services are installed on this host" >&2
  exit 2
}
systemctl is-enabled --quiet "$UNIT" || { echo "refusing: $UNIT is not enabled" >&2; exit 2; }
systemctl is-active --quiet "$UNIT" || { echo "refusing: $UNIT is not active" >&2; exit 2; }
for name in "${BINARIES[@]}"; do
  [ -x "$BIN_DIR/$name" ] || { echo "refusing: live binary missing: $BIN_DIR/$name" >&2; exit 2; }
done

healthy() {
  local chain wallet
  systemctl is-active --quiet "$UNIT" || return 1
  chain="$("$BIN_DIR/bitcoin-cli" -datadir=/var/lib/bitcoind getblockchaininfo 2>/dev/null)" || return 1
  wallet="$("$BIN_DIR/bitcoin-cli" -datadir=/var/lib/bitcoind -rpcwallet=nullsink getwalletinfo 2>/dev/null)" || return 1
  grep -q '"initialblockdownload":[[:space:]]*false' <<<"$chain" &&
    grep -q '"private_keys_enabled":[[:space:]]*false' <<<"$wallet"
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    healthy && return 0
    sleep 2
  done
  return 1
}

healthy || { echo "refusing: $UNIT is not healthy" >&2; exit 1; }
if bitcoin_is_pinned; then
  echo "Bitcoin Core ${BITCOIN_VERSION} is already installed and healthy; nothing changed"
  exit 0
fi

tmp="$(mktemp -d)"
staged="$tmp/staged"
rollback_armed=0
rollback_dir=""

cleanup() {
  local rc=$? rollback_ok=1
  trap - EXIT HUP INT TERM
  set +e
  if [ "$rollback_armed" -eq 1 ]; then
    echo "upgrade failed or was interrupted; restoring $rollback_dir" >&2
    systemctl stop "$UNIT" >/dev/null 2>&1 || true
    for name in "${BINARIES[@]}"; do
      install -m755 "$rollback_dir/$name" "$BIN_DIR/$name" || rollback_ok=0
    done
    systemctl start "$UNIT" || rollback_ok=0
    wait_healthy || rollback_ok=0
    [ "$rollback_ok" -eq 1 ] || rc=1
  fi
  rm -rf "$tmp"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

echo "staging and verifying Bitcoin Core ${BITCOIN_VERSION} (live node remains up)"
stage_verified_bitcoind "$staged"
bitcoin_binary_matches_pin "$staged/bitcoind" || {
  echo "staged binary does not report the pinned version" >&2
  exit 1
}
healthy || { echo "$UNIT became unhealthy while staging" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback_dir="$ROLLBACK_ROOT/bitcoin-$stamp"
install -d -m700 "$rollback_dir"
for name in "${BINARIES[@]}"; do
  install -m755 "$BIN_DIR/$name" "$rollback_dir/$name"
done
printf 'component=bitcoin\nsaved_at=%s\nprevious=%s\ntarget=Bitcoin Core %s\n' \
  "$stamp" "$("$BIN_DIR/bitcoind" --version 2>/dev/null | sed -n '1p')" "$BITCOIN_VERSION" \
  > "$rollback_dir/manifest"

rollback_armed=1
systemctl stop "$UNIT"
for name in "${BINARIES[@]}"; do
  install -m755 "$staged/$name" "$BIN_DIR/$name"
done
systemctl start "$UNIT"
bitcoin_is_pinned || { echo "activated binaries do not match the pin" >&2; exit 1; }
wait_healthy || { echo "$UNIT did not become healthy within ${HEALTH_TIMEOUT}s" >&2; exit 1; }

rollback_armed=0
echo "upgrade complete: Bitcoin Core ${BITCOIN_VERSION} is installed; $UNIT is healthy"
echo "previous binaries retained at $rollback_dir"
