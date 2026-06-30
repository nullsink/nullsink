#!/usr/bin/env bash
# ExecStart wrapper for monero-wallet-rpc.service. MONERO_NODE may be a comma-separated, preference-ordered
# list of daemon addresses; this picks the FIRST REACHABLE one and exec's the wallet against it, so a dead or
# flaky primary fails over to a fallback at (re)start. A single node (no comma) starts immediately with NO
# probe — identical to the old inline ExecStart, no Tor dependency at boot. Failover is restart-driven: every
# reboot, deploy, wedge-heal (the watchdog), or operator restart re-runs this selection — there is no separate
# runtime switcher. systemd provides $STATE_DIRECTORY (StateDirectory=) and $RUNTIME_DIRECTORY (RuntimeDirectory=).
#
# All listed nodes MUST share ONE transport: all .onion-over-Tor (MONERO_PROXY_ARG set) OR all direct/clearnet
# (MONERO_PROXY_ARG empty) — the proxy is all-or-nothing.
set -u

WALLET_DIR="${STATE_DIRECTORY:-/var/lib/nullsink-wallet}"
RUN_DIR="${RUNTIME_DIRECTORY:-/run/monero-wallet-rpc}"
TOR_SOCKS="${TOR_SOCKS:-127.0.0.1:9050}"        # local Tor SOCKS — derived independently, NOT from $MONERO_PROXY_ARG
PROBE_TIMEOUT="${PROBE_TIMEOUT:-10}"
BIN="${MONERO_WALLET_RPC_BIN:-/usr/local/bin/monero-wallet-rpc}"   # overridable seam for the argv test

# Default the optional flag vars so `set -u` is happy. They MUST stay UNQUOTED at exec time: an empty value
# then adds NO argument (a quoted "" is an arg monero-wallet-rpc rejects); a set value splits into its flags.
MONERO_NET_ARG="${MONERO_NET_ARG:-}"
MONERO_PROXY_ARG="${MONERO_PROXY_ARG:-}"

# Split MONERO_NODE on commas; trim whitespace; drop empties (so a trailing comma or stray space can never
# produce an empty --daemon-address). Pure parameter expansion — no arrays-from-read, portable + set -u safe.
nodes=()
_rest="${MONERO_NODE:-}"
while [ -n "$_rest" ]; do
  case "$_rest" in *,*) _n="${_rest%%,*}"; _rest="${_rest#*,}";; *) _n="$_rest"; _rest="";; esac
  _n="${_n//[[:space:]]/}"
  [ -n "$_n" ] && nodes+=("$_n")
done
[ "${#nodes[@]}" -ge 1 ] || { echo "launch: MONERO_NODE is empty — refusing to start" >&2; exit 1; }

# Probe a node's get_info the SAME way the wallet will reach it: over Tor when the proxy is set
# (--socks5-hostname so Tor resolves the .onion; a per-call SOCKS user forces a fresh circuit), else direct.
node_reachable() {
  local n="$1" tag="$2"
  if [ -n "$MONERO_PROXY_ARG" ]; then
    curl -sS --max-time "$PROBE_TIMEOUT" --socks5-hostname "$TOR_SOCKS" --proxy-user "hc:probe$tag" \
      "http://$n/json_rpc" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}' 2>/dev/null | grep -q '"height"'
  else
    curl -sS --max-time "$PROBE_TIMEOUT" \
      "http://$n/json_rpc" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}' 2>/dev/null | grep -q '"height"'
  fi
}

picked="${nodes[0]}"
if [ "${#nodes[@]}" -gt 1 ]; then
  # One probe per node — a tight start budget (see TimeoutStartSec on the unit). First to answer wins; an
  # occasional flake just starts us on a fallback, self-corrected on the next restart.
  picked=""
  i=0
  for n in "${nodes[@]}"; do
    i=$((i + 1))
    if node_reachable "$n" "$i"; then picked="$n"; break; fi
  done
  # None answered: start on the FIRST listed and let the wallet retry; status-check pages a stalled rail.
  [ -n "$picked" ] || { picked="${nodes[0]}"; echo "launch: no listed node answered get_info — starting on $picked, will retry" >&2; }
fi

# Record the active node so status-check can probe it (best-effort; $RUN_DIR may be absent for a beat on restart).
[ -d "$RUN_DIR" ] && printf '%s\n' "$picked" >"$RUN_DIR/active-node" 2>/dev/null || true
echo "launch: monero-wallet-rpc → $picked (of ${#nodes[@]} candidate node(s))"

# shellcheck disable=SC2086  # $MONERO_NET_ARG / $MONERO_PROXY_ARG MUST be unquoted: empty = no arg (see above).
exec "$BIN" \
  $MONERO_NET_ARG \
  --wallet-file "$WALLET_DIR/prview" \
  --password-file "$WALLET_DIR/.rpc-pw" \
  --daemon-address "$picked" \
  $MONERO_PROXY_ARG \
  --untrusted-daemon \
  --rpc-bind-ip 127.0.0.1 \
  --rpc-bind-port 18083 \
  --disable-rpc-login \
  --non-interactive \
  --log-file "$WALLET_DIR/wallet-rpc.log"
