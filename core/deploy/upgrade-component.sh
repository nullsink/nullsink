#!/usr/bin/env bash
# Narrow, health-gated upgrade for pinned external runtime components.
#
# Unlike setup.sh, this does not install packages, rewrite config, refresh units, touch the app release, or
# restart unrelated services. It stages and checksum-verifies one component, preserves the live binaries,
# restarts only that component, and automatically restores the preserved copy if activation or health fails.
set -euo pipefail
# This runs as root and invokes security-critical fetch/install tools. Do not inherit a caller-controlled
# command search path (sudo normally resets it, but direct root shells need the same guarantee).
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

APP_DIR="${APP_DIR:-/opt/nullsink}"
ENV_FILE="${ENV_FILE:-/etc/nullsink.env}"
BIN_DIR="/usr/local/bin"
ROLLBACK_ROOT="/usr/local/lib/nullsink/component-rollbacks"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

# The release deploy tree carries this script beside lib.sh.
# shellcheck source=deploy/lib.sh
source "$(dirname "$0")/lib.sh"

usage() {
  cat >&2 <<'EOF'
Usage: sudo upgrade-component.sh <component>

Components:
  bitcoin         Bitcoin Core on a dedicated node box
  monero-wallet   monero-wallet-rpc + monero-wallet-cli on the app box
  tinfoil         tinfoil-proxy on the app box
EOF
}

[ "${EUID:-$(id -u)}" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 2; }
[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
  { echo "HEALTH_TIMEOUT must be a positive integer" >&2; exit 2; }
[ "$#" -eq 1 ] || { usage; exit 2; }
command -v flock >/dev/null 2>&1 ||
  { echo "flock is required (normally provided by util-linux)" >&2; exit 2; }
# One global lock is intentionally simpler than per-component locks: two nominally independent upgrades still
# share /usr/local/bin, network/disk headroom, and operator attention. Fail fast instead of interleaving backups,
# service stops, binary copies, and rollback traps from concurrent shells.
exec 9>/run/lock/nullsink-component-upgrade.lock
flock -n 9 || { echo "another component upgrade is already running" >&2; exit 2; }

component="$1"
unit=""
desired=""
declare -a binaries=()

case "$component" in
  bitcoin)
    unit="bitcoind"
    desired="Bitcoin Core ${BITCOIN_VERSION}"
    binaries=(bitcoind bitcoin-cli)
    # This path is deliberately node-box-only. A local bitcoind on the app box is legacy architecture;
    # refusing here prevents a day-two tool from quietly perpetuating it.
    if systemctl cat nullsink-proxy.service >/dev/null 2>&1; then
      echo "refusing bitcoin upgrade on an app box; run it on the dedicated node box" >&2
      exit 2
    fi
    ;;
  monero-wallet)
    unit="monero-wallet-rpc"
    desired="Monero wallet ${MONERO_VERSION}"
    binaries=(monero-wallet-rpc monero-wallet-cli)
    systemctl cat nullsink-proxy.service nullsink-payments.service >/dev/null 2>&1 ||
      { echo "refusing monero-wallet upgrade: this is not an app box" >&2; exit 2; }
    ;;
  tinfoil)
    unit="tinfoil-proxy"
    desired="tinfoil-proxy ${TINFOIL_PROXY_VERSION}"
    binaries=(tinfoil-proxy)
    systemctl cat nullsink-proxy.service nullsink-payments.service >/dev/null 2>&1 ||
      { echo "refusing tinfoil upgrade: this is not an app box" >&2; exit 2; }
    ;;
  *)
    echo "unknown component: $component" >&2
    usage
    exit 2
    ;;
esac

# This is an upgrader, not a bootstrap/recovery command: do not silently enable or start something that the
# operator intentionally left absent/down. setup.sh/setup-nodes.sh own first install; incident recovery stays
# explicit. Requiring a healthy active starting point also makes rollback meaningful and testable.
systemctl is-enabled --quiet "$unit" ||
  { echo "refusing: $unit is not enabled; use the applicable setup path first" >&2; exit 2; }
systemctl is-active --quiet "$unit" ||
  { echo "refusing: $unit is not active; recover it before attempting an upgrade" >&2; exit 2; }
for name in "${binaries[@]}"; do
  [ -x "$BIN_DIR/$name" ] ||
    { echo "refusing: live binary missing: $BIN_DIR/$name" >&2; exit 2; }
done

component_healthy() {
  systemctl is-active --quiet "$unit" || return 1
  case "$component" in
    bitcoin)
      local chain wallet
      chain="$("$BIN_DIR/bitcoin-cli" -datadir=/var/lib/bitcoind getblockchaininfo 2>/dev/null)" ||
        return 1
      wallet="$("$BIN_DIR/bitcoin-cli" -datadir=/var/lib/bitcoind -rpcwallet=nullsink getwalletinfo 2>/dev/null)" ||
        return 1
      grep -q '"initialblockdownload":[[:space:]]*false' <<<"$chain" &&
        grep -q '"private_keys_enabled":[[:space:]]*false' <<<"$wallet"
      ;;
    monero-wallet)
      local response
      response="$(curl -sS --max-time 10 http://127.0.0.1:18083/json_rpc \
        -H 'content-type: application/json' \
        -d '{"jsonrpc":"2.0","id":"upgrade","method":"get_height"}' 2>/dev/null)" ||
        return 1
      grep -qE '"height"[[:space:]]*:[[:space:]]*[1-9][0-9]*' <<<"$response"
      ;;
    tinfoil)
      local code
      code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
        http://127.0.0.1:3301/ 2>/dev/null)" || return 1
      [[ "$code" =~ ^[1-4][0-9][0-9]$ ]]
      ;;
  esac
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    component_healthy && return 0
    sleep 2
  done
  return 1
}

live_is_pinned() {
  case "$component" in
    bitcoin) bitcoin_is_pinned ;;
    monero-wallet) monero_wallet_is_pinned ;;
    tinfoil) tinfoil_proxy_is_pinned ;;
  esac
}

stage_component() {
  case "$component" in
    bitcoin) stage_verified_bitcoind "$1" ;;
    monero-wallet) stage_verified_monero_wallet "$1" ;;
    tinfoil) stage_verified_tinfoil_proxy "$1" ;;
  esac
}

staged_is_pinned() {
  case "$component" in
    bitcoin) bitcoin_binary_matches_pin "$1/bitcoind" ;;
    monero-wallet) monero_wallet_binary_matches_pin "$1/monero-wallet-rpc" ;;
    tinfoil) echo "$TINFOIL_PROXY_SHA256_X64  $1/tinfoil-proxy" | sha256sum -c --status - ;;
  esac
}

current_description() {
  case "$component" in
    bitcoin) "$BIN_DIR/bitcoind" --version 2>/dev/null | sed -n '1p' ;;
    monero-wallet) "$BIN_DIR/monero-wallet-rpc" --version 2>/dev/null | sed -n '1p' ;;
    tinfoil) sha256sum "$BIN_DIR/tinfoil-proxy" | cut -d' ' -f1 | sed 's/^/sha256:/' ;;
  esac
}

component_healthy ||
  { echo "refusing: $unit is active but not healthy; recover it before attempting an upgrade" >&2; exit 1; }
if live_is_pinned; then
  echo "$desired is already installed and healthy; nothing changed"
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
    echo "upgrade failed or was interrupted; restoring $component from $rollback_dir" >&2
    systemctl stop "$unit" >/dev/null 2>&1 || true
    for name in "${binaries[@]}"; do
      install -m755 "$rollback_dir/$name" "$BIN_DIR/$name" || rollback_ok=0
    done
    systemctl start "$unit" || rollback_ok=0
    wait_healthy || rollback_ok=0
    if [ "$rollback_ok" -eq 1 ]; then
      echo "rollback succeeded; $unit is healthy on the previous binaries" >&2
    else
      echo "CRITICAL: automatic rollback did not restore health; inspect $unit immediately" >&2
      rc=1
    fi
  fi
  rm -rf "$tmp"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

echo "staging and verifying $desired (live service remains up)"
stage_component "$staged"
staged_is_pinned "$staged" ||
  { echo "staged binary does not report the pinned version/hash" >&2; exit 1; }
# A large download can take minutes. Prove the old component is STILL a known-good rollback baseline immediately
# before preserving and stopping it; otherwise a coincident outage could be misdiagnosed as an upgrade failure
# and "rollback" to a version that was already broken.
component_healthy ||
  { echo "$unit became unhealthy while staging; refusing activation" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback_dir="$ROLLBACK_ROOT/${component}-${stamp}"
install -d -m700 "$rollback_dir"
previous="$(current_description)"
for name in "${binaries[@]}"; do
  install -m755 "$BIN_DIR/$name" "$rollback_dir/$name"
done
printf 'component=%s\nsaved_at=%s\nprevious=%s\ntarget=%s\n' \
  "$component" "$stamp" "$previous" "$desired" > "$rollback_dir/manifest"

echo "saved previous binaries in $rollback_dir"
echo "stopping only $unit"
rollback_armed=1
systemctl stop "$unit"
for name in "${binaries[@]}"; do
  install -m755 "$staged/$name" "$BIN_DIR/$name"
done
systemctl start "$unit"

live_is_pinned || { echo "activated binaries do not match the pin" >&2; exit 1; }
wait_healthy || { echo "$unit did not become healthy within ${HEALTH_TIMEOUT}s" >&2; exit 1; }

rollback_armed=0
echo "upgrade complete: $desired is installed; $unit is healthy"
echo "previous binaries retained at $rollback_dir"
