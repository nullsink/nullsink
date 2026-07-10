#!/usr/bin/env bash
# Bootstrap a nullsink NODE BOX: a dedicated host that runs ONLY the pruned watch-only bitcoind for the
# Bitcoin buy rail, reached by the app box over WireGuard. NO app binary, NO ledger DBs, NO Monero, NO
# alerting stack — the app box stays the single pager and probes this node's RPC over WireGuard.
# Run as root on a fresh Ubuntu box: `bash setup-nodes.sh`. Idempotent — safe to re-run.
#
# The watch-only wallet is MIGRATED from the app box (backupwallet -> transfer over WG -> restorewallet),
# NEVER re-imported: an order's PK is the wallet's derivation index (src/rails/bitcoin.ts pathIndex), so a
# fresh keypool would collide with already-keyed orders, and a pruned node can't rescan history.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1

SVC_USER="nullsink"

# Shared verified-install primitives (fetch_verified / require_x86_64 / install_verified_bitcoind + the
# pinned Bitcoin version) live in lib.sh — one source of truth with the app-box setup.sh, no pin drift.
# shellcheck source=deploy/lib.sh
source "$(dirname "$0")/lib.sh"

if [ -t 1 ]; then _c=$'\e[1;36m'; _y=$'\e[1;33m'; _z=$'\e[0m'; else _c=''; _y=''; _z=''; fi
_step=0
step() { _step=$((_step + 1)); printf '\n%s>>> [%d] %s%s\n' "$_c" "$_step" "$1" "$_z"; }
note() { printf '%s    !! %s%s\n' "$_y" "$1" "$_z"; }

step "Installing system packages"
apt-get update -qq
# curl: fetch the pinned bitcoind tarball. nftables: the node firewall. wireguard: the private link to the app box.
apt-get install -y -qq curl nftables wireguard

step "Configuring unattended SECURITY upgrades (no auto-reboot)"
apt-get install -y -qq unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/51nullsink-no-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
EOF

step "Creating service user '$SVC_USER'"
if ! id "$SVC_USER" &>/dev/null; then
  useradd --system --create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

step "Installing bitcoind (pinned, verified)"
install_verified_bitcoind

step "Installing the bitcoind systemd unit"
# ONLY bitcoind.service — deliberately NOT lib.sh's install_units, which globs EVERY deploy/*.service (incl.
# the app's nullsink.service, backup.timer, …). This box runs no app; installing those here would be drift.
install -m644 "$(dirname "$0")/bitcoind.service" /etc/systemd/system/bitcoind.service
systemctl daemon-reload

step "Installing the node firewall (nftables)"
# Allows SSH + WireGuard inbound; bitcoind RPC (8332 mainnet / 38332 signet) only over wg0; P2P outbound.
# SSH stays up (established + dport 22 accepted), so applying this won't drop the session you're running
# setup from.
install -m644 "$(dirname "$0")/nftables-nodes.conf" /etc/nftables.conf
systemctl enable --now nftables
nft -f /etc/nftables.conf

step "Configuring WireGuard (private link to the app box)"
# Box-specific keys/peer IPs are NOT committed (deploy/README: nothing box-specific in the repo). Generate a
# keypair if absent and write a wg0.conf SKELETON for the operator to finish (peer = the app box).
install -d -m 700 /etc/wireguard
if [ ! -f /etc/wireguard/wg0.conf ]; then
  ( umask 077
    [ -f /etc/wireguard/node.key ] || wg genkey > /etc/wireguard/node.key
    wg pubkey < /etc/wireguard/node.key > /etc/wireguard/node.pub
    cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
# This node box. Set Address to the node's WG IP (e.g. 10.55.0.2/24).
Address = 10.55.0.2/24
ListenPort = 51820
PrivateKey = $(cat /etc/wireguard/node.key)

[Peer]
# The app box. Set PublicKey (from the app box) + AllowedIPs = the app's WG IP (e.g. 10.55.0.1/32).
PublicKey = <APP_BOX_WG_PUBLIC_KEY>
AllowedIPs = 10.55.0.1/32
EOF
  )
  note "wrote /etc/wireguard/wg0.conf skeleton — set the app box PublicKey + AllowedIPs, then: systemctl enable --now wg-quick@wg0"
  note "paste this [Peer] block into the APP box's /etc/wireguard/wg0.conf (fill in this box's public IP):"
  cat <<PEER

[Peer]
PublicKey = $(cat /etc/wireguard/node.pub)
AllowedIPs = 10.55.0.2/32
Endpoint = <NODE_PUBLIC_IP>:51820
PersistentKeepalive = 25

PEER
else
  note "/etc/wireguard/wg0.conf exists — leaving it; enable with: systemctl enable --now wg-quick@wg0"
fi

step "Configuring bitcoind"
# (Re)start only once the conf AND a chain exist. The blocks/ check is load-bearing: a re-run between
# runbook steps 2 (conf written) and 3 (chain path chosen) must NOT start bitcoind — a started daemon
# creates its own LevelDB + block-obfuscation key, which poisons the fast-path rsync seed (recovery is
# stop + rm -rf blocks/ chainstate/). The operator starts it per the runbook's step-3 path instead.
if [ -x /usr/local/bin/bitcoind ] && [ -f /var/lib/bitcoind/bitcoin.conf ] && [ -d /var/lib/bitcoind/blocks ]; then
  systemctl enable bitcoind
  systemctl restart bitcoind   # restart so a unit/conf change takes effect
  note "bitcoind (re)started — watch: bitcoin-cli -datadir=/var/lib/bitcoind getblockchaininfo (wait for initialblockdownload:false)"
elif [ -f /var/lib/bitcoind/bitcoin.conf ]; then
  note "conf present but no chain yet — choose the runbook's step-3 path (fast-path seed or IBD) before starting bitcoind"
else
  note "bitcoind NOT started yet — finish the runbook, then: systemctl enable --now bitcoind"
fi

step "Done — continue with the migration runbook"
note "NEXT: deploy/node-box-runbook.md — the ordered runbook (7 steps: WG -> conf -> SYNC -> drain+migrate -> rpcauth -> verify -> decommission)."
note "Two absolutes: let IBD FINISH before draining the rail (the drain window must be minutes, not the sync),"
note "and MIGRATE the wallet (backupwallet -> restorewallet) — never re-import from the xpub."
