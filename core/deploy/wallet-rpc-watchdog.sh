#!/usr/bin/env bash
# Restart monero-wallet-rpc when it is HUNG — active(running) but not answering get_height. systemd's
# Restart=always fires only on process EXIT, so a wallet wedged on its internal lock (a daemon read stalled
# mid-refresh over Tor, classically after a reorg) never self-heals and the XMR buy rail silently stops
# crediting deposits. get_height returns the wallet's LOCAL height, so a healthy wallet answers it fast even
# mid-refresh and even when the node is unreachable — it stalls only on a true deadlock, so we bounce ONLY a
# real wedge, never a merely-down node. Run by monero-wallet-rpc-watchdog.timer.
set -u

WALLET_RPC='http://127.0.0.1:18083/json_rpc'   # localhost RPC; matches the unit's hardcoded --rpc-bind-port
TIMEOUT=15                                       # per-probe; ExecStart must stay under the unit's TimeoutStartSec

# Act only on an enabled (else the rail is intentionally off) AND active (else it exited and systemd's
# Restart=always already owns recovery) unit — we fix only the case systemd can't see: active-but-wedged.
systemctl is-enabled --quiet monero-wallet-rpc 2>/dev/null || exit 0
systemctl is-active  --quiet monero-wallet-rpc 2>/dev/null || exit 0

# Probe get_height; retry to ride out a one-off mid-refresh stall before declaring a wedge (stateless — no
# cross-tick counter). The retry window (~55s) also covers a wallet still reopening after any restart, so no
# separate startup grace is needed; the 3-min timer makes a sustained restart loop impossible regardless.
probe() {
  curl -sS --max-time "$TIMEOUT" "$WALLET_RPC" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":"0","method":"get_height"}' 2>/dev/null | grep -q '"height"'
}
for attempt in 1 2 3; do
  probe && exit 0
  [ "$attempt" -lt 3 ] && sleep 5
done

echo "wallet-rpc HUNG: get_height failed 3x — restarting monero-wallet-rpc"
if systemctl restart monero-wallet-rpc; then
  # Heal succeeded: page it as a wallet RECOVERY (reuses status-alert's --recovered path, exactly as
  # status-check.sh does), then exit 0 — so this unit's OnFailure fires ONLY on a genuine watchdog fault,
  # never on a successful heal. A recurring recovery page is the flap signal that the node/Tor link needs a fix.
  "$(dirname "$0")/alert.sh" --recovered monero-wallet-rpc.service || true
else
  echo "restart FAILED — wallet did not come back; letting OnFailure page"
  exit 1
fi
