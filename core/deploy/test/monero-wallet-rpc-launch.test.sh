#!/usr/bin/env bash
# Argv-fidelity + node-selection test for ../monero-wallet-rpc-launch.sh — the anti-drift guard for the
# wallet's ExecStart. A shim "monero-wallet-rpc" captures argv and a shim "curl" controls node reachability,
# so we can assert every required flag (especially the security ones: --untrusted-daemon, localhost-only
# --rpc-bind-ip + --disable-rpc-login) survives across {mainnet,stagenet}×{Tor,direct}, that the unquoted
# $MONERO_*_ARG empty-vs-set contract holds, and that selection/fallback pick the right --daemon-address.
#   Run: bash core/deploy/test/monero-wallet-rpc-launch.test.sh
# shellcheck disable=SC2015  # `cond && ok || no` is a deliberate report-either-way; ok()/no() always return 0.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$HERE/../monero-wallet-rpc-launch.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ARGV="$TMP/argv"; mkdir -p "$TMP/bin" "$TMP/state" "$TMP/run"

# shim wallet binary: record argv one-per-line, exit 0.
cat >"$TMP/wallet-bin" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$ARGV"
EOF
# shim curl on PATH: emit get_info-with-height only for the node in \$REACHABLE_NODE.
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
url=""; for a in "$@"; do case "$a" in http://*/json_rpc) url="$a";; esac; done
node="${url#http://}"; node="${node%/json_rpc}"
[ -n "${REACHABLE_NODE:-}" ] && [ "$node" = "$REACHABLE_NODE" ] && { echo '{"result":{"height":1}}'; exit 0; }
exit 1
EOF
chmod +x "$TMP/wallet-bin" "$TMP/bin/curl"

pass=0; fail=0
MONERO_NODE=""; MONERO_NET_ARG=""; MONERO_PROXY_ARG=""; REACHABLE_NODE=""
run() {
  : >"$ARGV"; rm -f "$TMP/run/active-node"
  STATE_DIRECTORY="$TMP/state" RUNTIME_DIRECTORY="$TMP/run" MONERO_WALLET_RPC_BIN="$TMP/wallet-bin" \
    PATH="$TMP/bin:$PATH" MONERO_NODE="$MONERO_NODE" MONERO_NET_ARG="$MONERO_NET_ARG" \
    MONERO_PROXY_ARG="$MONERO_PROXY_ARG" REACHABLE_NODE="$REACHABLE_NODE" \
    bash "$WRAPPER" >/dev/null 2>&1
  out="$(cat "$ARGV" 2>/dev/null)"; active="$(cat "$TMP/run/active-node" 2>/dev/null || true)"
}
has(){ grep -qxF -e "$1" <<<"$out"; }              # exact whole-line match (-e so a --flag isn't read as an option)
ok(){ pass=$((pass+1)); echo "  ok: $1"; }
no(){ fail=$((fail+1)); echo "  FAIL: $1"; printf '%s\n' "$out" | sed 's/^/      /'; }

core_ok(){  # the flags that must be present in EVERY launch, regardless of net/transport
  if has '--untrusted-daemon' && has '--rpc-bind-ip' && has '127.0.0.1' && has '--disable-rpc-login' \
     && has '--rpc-bind-port' && has '18083' && has '--non-interactive' \
     && has '--wallet-file' && has "$TMP/state/prview" && has '--password-file' && has "$TMP/state/.rpc-pw" \
     && has '--daemon-address'
  then ok "$1: core + security flags present"; else no "$1: a core/security flag is MISSING"; fi
}

echo "argv fidelity across {mainnet,stagenet}×{Tor,direct} (single node → no probe):"
MONERO_NODE="a.onion:18081"; MONERO_NET_ARG=""; MONERO_PROXY_ARG="--proxy 127.0.0.1:9050"; REACHABLE_NODE=""; run
core_ok "mainnet+tor"
has 'a.onion:18081' && ok "mainnet+tor: daemon-address=a.onion:18081" || no "mainnet+tor: wrong daemon-address"
{ has '--proxy' && has '127.0.0.1:9050'; } && ok "mainnet+tor: proxy split into 2 args (unquoted contract)" || no "mainnet+tor: proxy missing/unsplit"
has '--stagenet' && no "mainnet+tor: --stagenet leaked" || ok "mainnet+tor: no --stagenet (correct)"

MONERO_NODE="h:38089"; MONERO_NET_ARG="--stagenet"; MONERO_PROXY_ARG=""; REACHABLE_NODE=""; run
core_ok "stagenet+direct"
has '--stagenet' && ok "stagenet+direct: --stagenet present" || no "stagenet+direct: --stagenet missing"
has '--proxy' && no "stagenet+direct: --proxy leaked (should be direct)" || ok "stagenet+direct: no --proxy (empty arg added nothing)"

MONERO_NODE="m:18081"; MONERO_NET_ARG=""; MONERO_PROXY_ARG=""; REACHABLE_NODE=""; run
core_ok "mainnet+direct"
{ has '--stagenet' || has '--proxy'; } && no "mainnet+direct: leaked a net/proxy arg" || ok "mainnet+direct: clean (both empty args added nothing)"

MONERO_NODE="s.onion:18081"; MONERO_NET_ARG="--stagenet"; MONERO_PROXY_ARG="--proxy 127.0.0.1:9050"; REACHABLE_NODE=""; run
core_ok "stagenet+tor"
{ has '--stagenet' && has '--proxy'; } && ok "stagenet+tor: both args present" || no "stagenet+tor: missing arg"

echo "node selection (multi-node):"
MONERO_NODE="dead:1,live:2"; MONERO_NET_ARG=""; MONERO_PROXY_ARG="--proxy 127.0.0.1:9050"; REACHABLE_NODE="live:2"; run
{ has 'live:2' && ! has 'dead:1'; } && ok "selection: skipped dead:1 → picked live:2" || no "selection: wrong daemon-address"
[ "$active" = "live:2" ] && ok "selection: active-node file recorded live:2" || no "selection: active-node='$active'"

MONERO_NODE="dead:1,alsodead:2"; MONERO_NET_ARG=""; MONERO_PROXY_ARG="--proxy 127.0.0.1:9050"; REACHABLE_NODE=""; run
has 'dead:1' && ok "fallback: all dead → started on first listed (dead:1)" || no "fallback: wrong daemon-address"

MONERO_NODE="solo:18081"; MONERO_NET_ARG=""; MONERO_PROXY_ARG="--proxy 127.0.0.1:9050"; REACHABLE_NODE=""; run
has 'solo:18081' && ok "single node: no probe, exec'd directly even with proxy set" || no "single node: did not start"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && echo "TEST_OK" || { echo "TEST_FAIL"; exit 1; }
