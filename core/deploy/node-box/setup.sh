#!/usr/bin/env bash
# Bootstrap a nullsink NODE BOX: a dedicated host that runs ONLY the pruned watch-only bitcoind for the
# Bitcoin buy rail, reached by the app box over WireGuard. NO app binary, NO ledger DBs, NO Monero, NO
# alerting stack — the app box stays the single pager and probes this node's RPC over WireGuard.
# Run as root on a fresh Ubuntu box from the standalone node-box release bundle: `bash setup.sh`.
#
# This script installs the common host prerequisites only. Chain bootstrap, wallet migration/recovery,
# authentication, and cutover are incident-specific operations: review the live topology and generate a
# fresh, bounded procedure when needed instead of relying on a permanently maintained migration runbook.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

SVC_USER="nullsink"

# Node-only verified-install primitives and the pinned Bitcoin version live beside this script. The app
# release deliberately contains neither the daemon nor its installer.
# shellcheck source=deploy/node-box/lib.sh
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
# This standalone bundle contains only the node unit; it cannot install any app service.
install -m644 "$(dirname "$0")/bitcoind.service" /etc/systemd/system/bitcoind.service
systemctl daemon-reload

step "Installing the node firewall (nftables)"
# Allows SSH + WireGuard inbound; bitcoind RPC (8332 mainnet / 38332 signet) only over wg0; P2P outbound.
# SSH stays up (established + dport 22 accepted), so applying this won't drop the session you're running
# setup from.
install -m644 "$(dirname "$0")/nftables.conf" /etc/nftables.conf
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
# (Re)start only once the box-specific conf AND a chain exist. Starting prematurely creates local chain
# state and can invalidate a planned seeded-chain transfer, so setup leaves an incomplete node stopped.
if [ -x /usr/local/bin/bitcoind ] && [ -f /var/lib/bitcoind/bitcoin.conf ] && [ -d /var/lib/bitcoind/blocks ]; then
  systemctl enable bitcoind
  systemctl restart bitcoind   # restart so a unit/conf change takes effect
  note "bitcoind (re)started — watch: bitcoin-cli -datadir=/var/lib/bitcoind getblockchaininfo (wait for initialblockdownload:false)"
elif [ -f /var/lib/bitcoind/bitcoin.conf ]; then
  note "conf present but no chain yet — choose and review a chain-bootstrap plan before starting bitcoind"
else
  note "bitcoind NOT started — finish box-specific chain, wallet, WireGuard, and RPC configuration first"
fi

step "Done — prerequisites installed"
note "Before enabling Bitcoin, generate and review a procedure for this box's current chain, wallet, RPC,"
note "WireGuard, drain, verification, and rollback state. setup.sh intentionally does not encode it."
