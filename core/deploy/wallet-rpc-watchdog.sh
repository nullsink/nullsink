#!/usr/bin/env bash
# Restart monero-wallet-rpc when it is HUNG — alive but not answering RPC. systemd's Restart=always only
# fires on process EXIT; a wallet wedged on its internal lock (a daemon read that stalled mid-refresh over
# Tor, classically right after a reorg) stays active(running) forever and never restarts itself. This probes
# get_height and bounces the unit on a CONFIRMED hang, so a wedge self-heals in minutes instead of stranding
# the XMR buy rail until an operator notices. Run by monero-wallet-rpc-watchdog.timer; wired OnFailure ->
# status-alert@ so a heal still pages (a heal that RECURS means the node/Tor link, not the wallet, needs a fix).
#
# Why get_height is the right probe: it returns the wallet's LOCAL height, so a healthy wallet answers it in
# well under RPC_TIMEOUT even mid-refresh AND even when the daemon is unreachable. It only fails to answer on
# a true deadlock — so this watchdog restarts ONLY on a genuine wedge, never on a merely-down node (that case
# is status-check.sh's job to report, not ours to bounce).
set -u

WALLET_RPC="${MONERO_WALLET_RPC_URL:-http://127.0.0.1:18083/json_rpc}"
RPC_TIMEOUT="${RPC_TIMEOUT:-15}"
RETRIES="${WATCHDOG_RETRIES:-3}"        # consecutive get_height failures before we call it wedged
GRACE="${WATCHDOG_GRACE:-120}"          # never bounce a wallet that (re)started < this many seconds ago — it
                                        # may still be opening the wallet file + binding RPC. Avoids a restart
                                        # loop; kept comfortably under the timer interval so it can't deadlock.

# Act only on an ENABLED + ACTIVE unit. Disabled = the rail is intentionally off. Inactive = the process
# already exited, so systemd's Restart=always owns recovery. We fix only the case systemd can't see:
# active-but-wedged.
systemctl is-enabled --quiet monero-wallet-rpc 2>/dev/null || { echo "wallet-rpc not enabled — skip"; exit 0; }
systemctl is-active  --quiet monero-wallet-rpc 2>/dev/null || { echo "wallet-rpc not active — systemd owns restart-on-exit, skip"; exit 0; }

# Startup grace. ActiveEnterTimestampMonotonic is microseconds on CLOCK_MONOTONIC; compare against
# /proc/uptime (seconds, monotonic) — NOT wall clock, which skews on this box at boot before NTP corrects.
started_us="$(systemctl show -p ActiveEnterTimestampMonotonic --value monero-wallet-rpc 2>/dev/null)"
if [ -n "$started_us" ] && [ "$started_us" -gt 0 ] 2>/dev/null; then
  up_s="$(cut -d. -f1 /proc/uptime)"
  age_s=$(( up_s - started_us / 1000000 ))
  if [ "$age_s" -lt "$GRACE" ]; then echo "wallet-rpc up ${age_s}s (< ${GRACE}s grace) — skip"; exit 0; fi
fi

# Retry to ride out a one-off slow tick (mirrors status-check.sh's node-probe retries) before declaring a hang.
probe() {
  curl -sS --max-time "$RPC_TIMEOUT" "$WALLET_RPC" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":"0","method":"get_height"}' 2>/dev/null \
    | grep -q '"height"'
}
for attempt in $(seq 1 "$RETRIES"); do
  if probe; then echo "wallet-rpc healthy (get_height ok on attempt $attempt)"; exit 0; fi
  [ "$attempt" -lt "$RETRIES" ] && sleep 5
done

echo "wallet-rpc HUNG: get_height failed ${RETRIES}x in a row — restarting monero-wallet-rpc"
systemctl restart monero-wallet-rpc
exit 1   # non-zero -> OnFailure=status-alert@ pages, so an auto-heal is never silent (and a flap stays visible)
