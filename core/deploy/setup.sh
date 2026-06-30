#!/usr/bin/env bash
# Bootstrap nullsink on a fresh Ubuntu box. Run as root: `bash setup.sh`.
# Idempotent — safe to re-run to redeploy the latest code.
set -euo pipefail

# Quiet, non-interactive apt: skip needrestart's repeated "Scanning processes…" blocks + any prompts.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1

# Runs AS ROOT. The box runs only compiled binaries (server + `nsk`) + the deploy/ scripts; setup.sh fetches
# them as verified Release assets (install_binary / install_nsk / install_deploy_tree) via plain curl — no
# gh, no auth, no source tree, no Bun.
APP_DIR="/opt/nullsink"
SVC_USER="nullsink"
SVC_NAME="nullsink"
ENV_FILE="/etc/nullsink.env"
WEB_BASE="/var/www/nullsink"   # base for the versioned client UI ($WEB_BASE/web-<tag> + current-web symlink)

# Shared "apply repo config" library (install_units + health_ok), also sourced by deploy.sh so the
# unit-install glob is one source of truth across bootstrap + redeploy. Needs APP_DIR/ENV_FILE (set above).
# shellcheck source=deploy/lib.sh
source "$(dirname "$0")/lib.sh"

# --- Output: numbered, colorized (tty only) section headers + a collected "next steps" checklist ---
if [ -t 1 ]; then _b=$'\e[1m'; _c=$'\e[1;36m'; _g=$'\e[1;32m'; _y=$'\e[1;33m'; _z=$'\e[0m'; else _b=''; _c=''; _g=''; _y=''; _z=''; fi
_step=0
step() { _step=$((_step + 1)); printf '\n%s>>> [%d] %s%s\n' "$_c" "$_step" "$1" "$_z"; }
note() { printf '%s    !! %s%s\n' "$_y" "$1" "$_z"; }   # an inline warning / info line
PENDING=()
todo() { PENDING+=("$1"); note "$1"; }                  # inline warning AND add to the end-of-run checklist

# --- Pinned external toolchain (bump deliberately) ---
# nullsink app release: the GitHub Release tag whose self-contained binary the box runs (fetched + checksum-
# verified + activated by install_binary). AUTO-BUMPED to each release by release-please — the
# `x-release-please-version` annotation on the line below + the generic extra-files entry in
# release-please-config.json — so a fresh bootstrap installs the current release without a manual edit.
# deploy/deploy.sh <tag> rolls an existing box to any tag. Env-overridable so a re-run can pin a specific
# release WITHOUT editing this file (and without downgrading a box already past the default):
# `sudo env RELEASE_TAG=vX.Y.Z deploy/setup.sh` — e.g. adding a setup-only component (the tinfoil-proxy
# attestation sidecar) onto a newer box, or staging an RC.
RELEASE_TAG="${RELEASE_TAG:-v1.2.0}" # x-release-please-version
# Bitcoin Core: pinned version + the SHA-256 of the x86_64-linux tarball, taken from the
# fanquake-signed SHA256SUMS (gpg-verified at authoring; key E777299FC265DD04793070EB944D35F9AC3DB76A).
BITCOIN_VERSION="31.0"
BITCOIN_SHA256_X64="d3e4c58a35b1d0a97a457462c94f55501ad167c660c245cb1ffa565641c65074"
# Monero CLI bundle: pinned version + the SHA-256 of the linux-x64 bundle, taken from the
# binaryFate-signed hashes.txt (gpg-verified at authoring; key 81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92).
MONERO_VERSION="0.18.5.0"
MONERO_SHA256_X64="166ad93036f95f5abeba24c8670061be022c9238dba2e6a7587611a1d759e294"
# tinfoil-proxy: the local verifying proxy for the Tinfoil provider (enclave attestation). Pinned version + the
# SHA-256 of the linux-amd64 binary. PROVENANCE is weaker than the Bitcoin/Monero pins above: those verify a
# maintainer-GPG-signed hashes file, whereas tinfoil-proxy's SHA256SUMS is an unsigned CI artifact — so this is
# trust-on-first-use (checked once at authoring) then pinned by SHA. NOTE: only the verifier BINARY is pinned;
# the enclave measurement it checks floats with Tinfoil's latest release (Sigstore-gated) and the proxy CLI gives
# no way to pin a measurement (see docs/tinfoil-attestation.md). Installed only when the Tinfoil rail is active.
TINFOIL_PROXY_VERSION="v0.1.0"
TINFOIL_PROXY_SHA256_X64="5ac964a7d4252c892e05876ed38c44dc4f37ec7d2a5c0845f1a04fd520b3d566"

# --- Verified-install helpers (pinned + checksum-verified; same model as the Bun block below) ---
fetch_verified() {  # $1=url $2=sha256 $3=dest — download + checksum-check; aborts (set -e) on mismatch
  curl -fsSL "$1" -o "$3"
  echo "$2  $3" | sha256sum -c -
}
require_x86_64() {  # $1=label — these pins are x86_64-only; fail loud rather than install a dud
  if [ "$(uname -m)" != "x86_64" ]; then
    echo "    !! setup.sh pins $1 for x86_64 only; this box is $(uname -m). Add the matching asset + hash." >&2
    exit 1
  fi
}
rail_active() {  # $1=rail — true if listed in PAY_RAILS (or legacy PAY_RAIL) in $ENV_FILE
  [ -f "$ENV_FILE" ] || return 1
  local rails
  rails="$(grep -E '^(PAY_RAILS|PAY_RAIL)=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  case ",${rails// /}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}
proxy_disabled() {  # true if the env sets MONERO_PROXY_ARG empty (direct/clearnet node, no Tor — e.g. staging)
  [ -f /etc/monero-wallet-rpc.env ] && grep -qE '^MONERO_PROXY_ARG=[[:space:]]*$' /etc/monero-wallet-rpc.env
}
tinfoil_active() {  # true if a REAL TINFOIL_API_KEY is set in $ENV_FILE — gates the Tinfoil verifying proxy
  [ -f "$ENV_FILE" ] || return 1
  local k
  k="$(grep -E '^TINFOIL_API_KEY=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  [ -n "$k" ] && [ "$k" != "tk_..." ] && [ "$k" != "replace-me" ]
}
install_verified_bitcoind() {  # bitcoind + bitcoin-cli (the unit's ExecStop calls the cli)
  if /usr/local/bin/bitcoind --version 2>/dev/null | grep -q "v${BITCOIN_VERSION}"; then return 0; fi
  require_x86_64 "Bitcoin Core"
  local tmp; tmp="$(mktemp -d)"
  fetch_verified "https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz" \
    "$BITCOIN_SHA256_X64" "$tmp/bitcoin.tar.gz"
  tar -xzf "$tmp/bitcoin.tar.gz" -C "$tmp" --strip-components=1   # -> $tmp/bin/{bitcoind,bitcoin-cli}
  install -m755 "$tmp/bin/bitcoind" "$tmp/bin/bitcoin-cli" /usr/local/bin/
  rm -rf "$tmp"
  echo "    $(/usr/local/bin/bitcoind --version | head -1) installed"
}
install_verified_monero_wallet() {  # monero-wallet-rpc (watcher) + monero-wallet-cli (one-time view-wallet creation)
  if /usr/local/bin/monero-wallet-rpc --version 2>/dev/null | grep -q "v${MONERO_VERSION}"; then return 0; fi
  require_x86_64 "Monero CLI"
  local tmp; tmp="$(mktemp -d)"
  fetch_verified "https://downloads.getmonero.org/cli/monero-linux-x64-v${MONERO_VERSION}.tar.bz2" \
    "$MONERO_SHA256_X64" "$tmp/monero.tar.bz2"
  tar -xjf "$tmp/monero.tar.bz2" -C "$tmp" --strip-components=1   # -> $tmp/monero-wallet-{rpc,cli}
  install -m755 "$tmp/monero-wallet-rpc" "$tmp/monero-wallet-cli" /usr/local/bin/
  rm -rf "$tmp"
  echo "    monero-wallet-rpc/cli v${MONERO_VERSION} installed"
}
install_verified_tinfoil_proxy() {  # the Tinfoil attestation sidecar — fetch+verify+install /usr/local/bin/tinfoil-proxy
  # Idempotent by SHA (the binary exposes no --version flag): skip the re-fetch when the pinned binary is already
  # in place, so a setup.sh re-run does no network here.
  if [ -x /usr/local/bin/tinfoil-proxy ] && echo "$TINFOIL_PROXY_SHA256_X64  /usr/local/bin/tinfoil-proxy" | sha256sum -c --status -; then return 0; fi
  # This install is GUARDED (called in an `if`), so a wrong arch must `return 1` to degrade to a todo — NOT
  # require_x86_64's `exit 1`, which would kill the whole bootstrap (the firewall, app, and rails come later).
  if [ "$(uname -m)" != "x86_64" ]; then
    echo "    !! tinfoil-proxy pin is x86_64-only; this box is $(uname -m) — skipping" >&2
    return 1
  fi
  local tmp; tmp="$(mktemp -d)"
  # Explicit `|| return 1` (not bare set -e): this runs guarded in an `if`, where set -e is suspended for the
  # whole function — so a failed fetch must propagate by hand, or the caller's then-branch would start a unit
  # with no binary behind it.
  fetch_verified "https://github.com/tinfoilsh/tinfoil-proxy/releases/download/${TINFOIL_PROXY_VERSION}/tinfoil-proxy-linux-amd64" \
    "$TINFOIL_PROXY_SHA256_X64" "$tmp/tinfoil-proxy" || { rm -rf "$tmp"; return 1; }
  install -m755 "$tmp/tinfoil-proxy" /usr/local/bin/tinfoil-proxy || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  echo "    tinfoil-proxy ${TINFOIL_PROXY_VERSION} installed"
}

step "Installing system packages"
apt-get update -qq
# sqlite3 CLI: required by deploy/backup.sh, restore.sh and the status-check integrity probe (the APP uses
# bun:sqlite, an embedded engine — the CLI is a separate package). age: encrypted off-box backups.
# bzip2: the Monero CLI .tar.bz2 bundle. curl: fetches the public Release assets (binaries + tarballs).
apt-get install -y -qq curl bzip2 sqlite3 age

step "Configuring unattended SECURITY upgrades (no auto-reboot)"
# Deterministic patching instead of inheriting whatever the base image enables. Ubuntu's shipped
# 50unattended-upgrades is already security-pocket-only; we add the package, turn on the daily
# update+upgrade timers, and FORCE no automatic reboot (payment box — reboots are operator-scheduled).
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

step "Installing the deploy tree to $APP_DIR (release tarball)"
# Fetch+verify+extract the release's deploy tarball instead of git-cloning source (source-free box).
# SELF-OVERWRITE GUARD: setup.sh is itself run from $APP_DIR/deploy (per the bootstrap procedure),
# so re-extracting over it mid-run could splice the executing script. When already running from $APP_DIR the
# operator just extracted the tree, so skip the re-fetch. (deploy.sh re-fetches inside its terminal
# deploy_binary function, which is already parsed into memory + exits, so it has no such hazard.)
if [ "$(realpath "$(dirname "$0")/.." 2>/dev/null)" = "$APP_DIR" ]; then
  note "running from $APP_DIR/deploy — using the already-extracted deploy tree (no re-fetch)"
elif install_deploy_tree "$RELEASE_TAG" "$APP_DIR"; then
  :
else
  todo "deploy tree not installed (check network/tag + re-run) — backup/status-check/alert units can't run until $APP_DIR/deploy exists"
fi
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
chmod +x "$APP_DIR"/deploy/*.sh   # status-check.sh + alert.sh + backup.sh are run by systemd; keep the exec bit

step "Ensuring env file at $ENV_FILE"
FRESH_ENV=0
if [ ! -f "$ENV_FILE" ]; then
  FRESH_ENV=1
  cat > "$ENV_FILE" <<EOF
ANTHROPIC_API_KEY=replace-me
HOST=127.0.0.1
PORT=8080
# Public edge (Caddy): the domain this box serves on. setup.sh feeds it to Caddy via a systemd drop-in, so
# the committed Caddyfile hardcodes no host. EMPTY = setup.sh skips the public edge (the app still runs on
# 127.0.0.1); re-run after setting it. Keep bare (no inline # comment).
NULLSINK_DOMAIN=
# Buy rail (POST /buy) — optional, and NOT to be exposed publicly yet (see README). PAY_RAILS is a comma list
# of active rails (default monero; legacy PAY_RAIL=<one name> still works); the FIRST is the /buy default, and
# each rail reads its own MONERO_CONFIRMATIONS / BITCOIN_CONFIRMATIONS. Monero needs a view-only
# monero-wallet-rpc + node; Bitcoin needs a pruned watch-only bitcoind — add "bitcoin" only once its
# node is 100% synced.
PAY_RAILS=monero
MONERO_WALLET_RPC_URL=http://127.0.0.1:18083/json_rpc
# MONERO_CONFIRMATIONS=10   # XMR finality depth (default 10; ~10 is the floor — outputs lock ~10 blocks)
# Bitcoin rail (add "bitcoin" to PAY_RAILS): the wallet-scoped RPC endpoint + rpcauth creds. Keep these bare.
# RPC port is 8332 on mainnet; a signet/testnet box uses 38332. PASSWORD is written by
# deploy/regen-bitcoin-rpcauth.sh (matched with the conf's rpcauth=) — leave it empty here.
BITCOIN_RPC_URL=http://127.0.0.1:8332/wallet/nullsink
BITCOIN_RPC_USER=
BITCOIN_RPC_PASSWORD=
# BITCOIN_CONFIRMATIONS=3   # BTC finality depth (default 3)
# Telegram health alerts (status-check OnFailure). EMPTY = alerts disabled (a safe no-op). Bot token from
# @BotFather, numeric chat id from @userinfobot. Keep these lines BARE (no inline # comment — systemd keeps
# everything after = as the value).
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
# Dead-man's-switch ping target (a healthchecks.io URL or a self-hosted Uptime Kuma push URL). EMPTY =
# disabled. The health check pings this on success so an OFF-BOX monitor alerts if the ping STOPS (a dead
# box/network/timer that OnFailure can't catch). Keep bare (no inline # comment).
HEARTBEAT_URL=
# --- Backups (deploy/backup.sh, run daily by backup.timer; restore/verify with deploy/restore.sh) ---
# OFF-BOX copies MUST be encrypted: set BACKUP_AGE_RECIPIENT to an age PUBLIC key whose private key you keep
# OFFLINE, so the box can only ENCRYPT, never decrypt past backups (apt-get install age; age-keygen on your
# secure machine). EMPTY = local-only PLAINTEXT snapshots (fine on-box; never push those off). Keep bare.
BACKUP_AGE_RECIPIENT=
# Shell snippet to ship each finished artifact off-box, run with \$ARTIFACT = the file path, e.g.:
#   BACKUP_PUSH_CMD=rclone copy "\$ARTIFACT" remote:nullsink-backups/
# EMPTY = keep backups on-box only. Keep this line bare (no inline # comment).
BACKUP_PUSH_CMD=
EOF
  chmod 600 "$ENV_FILE"
  chown "$SVC_USER:$SVC_USER" "$ENV_FILE"
  note "Templated $ENV_FILE with placeholders"
fi

# Attestation: when the Tinfoil rail is active and TINFOIL_BASE_URL is UNSET, default it to the local verifying proxy
# (the real upgrade path — the earlier template never wrote this line). Any EXPLICIT value is respected and
# survives re-runs — there's no self-reverting flip of a value the operator can see: http://127.0.0.1:3301 routes
# through the attesting proxy; the public endpoint forwards directly (unverified) and is flagged each run. Done
# here, BEFORE the app (re)start below, so the app reads the value; the proxy itself is installed + started in its
# own step further down (also before the app restart). Append is in-place (`>>`), preserving the file's 600/owner.
if tinfoil_active; then
  _tbu="$(grep -E '^TINFOIL_BASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  if [ -z "$_tbu" ]; then
    { echo "# Tinfoil enclave attestation: the local verifying proxy (tinfoil-proxy.service). Set to"
      echo "# https://inference.tinfoil.sh to forward directly, WITHOUT attestation (respected on re-runs)."
      echo "TINFOIL_BASE_URL=http://127.0.0.1:3301"
    } >> "$ENV_FILE"
    note "TINFOIL_BASE_URL defaulted to the local attesting proxy (http://127.0.0.1:3301)"
  elif [ "$_tbu" = "http://127.0.0.1:3301" ]; then
    : # already routing through the local proxy — nothing to do
  else
    note "TINFOIL_BASE_URL=$_tbu — Tinfoil is forwarding UNVERIFIED (not via the attesting proxy); set it to http://127.0.0.1:3301 to enable attestation"
  fi
fi

step "Installing systemd units"
# One glob-based install of every deploy/*.service + *.timer (via lib.sh's install_units, shared with
# deploy.sh) so a newly-added unit can't be silently missed by a hand-maintained per-unit list. The
# per-rail steps below then only enable/restart (and install binaries / drop-ins) — they no longer cp.
install_units

step "Installing the app binary (pinned release)"
# Fetch+verify+activate the pinned binary for nullsink.service. Guarded: a failure here (network down, or
# the release missing) must NOT abort the rest of the bootstrap — the box still gets units/edge/firewall; finish
# the binary install after. The unit won't start until the binary is in place (next step warns/continues).
if install_binary "$RELEASE_TAG"; then
  :
else
  todo "app binary not installed (re-run, or run: sudo deploy/deploy.sh $RELEASE_TAG) — nullsink.service won't start until the binary is in place"
fi

step "Installing the client UI (pinned release)"
# Fetch+verify+activate the pinned release's UI into the versioned webroot ($WEB_BASE/web-<tag> + a current-web
# symlink); the Caddyfile serves {$NULLSINK_WEBROOT:/var/www/nullsink/current-web}. Guarded like the binary above.
if install_client_ui "$RELEASE_TAG" "$WEB_BASE"; then
  :
else
  todo "client UI not installed (re-run, or run: sudo deploy/deploy.sh $RELEASE_TAG) — Caddy 404s the site until $WEB_BASE/current-web exists"
fi

step "Configuring tinfoil-proxy (enclave attestation sidecar)"
# Install + enable the local verifying proxy when the Tinfoil rail is active, BEFORE the app (re)start below so
# the app's first Tinfoil request reaches a ready proxy (and the flipped TINFOIL_BASE_URL resolves). The unit
# was refreshed by install_units above. GUARDED like the binary install: a transient GitHub/Tinfoil fetch
# failure must NOT abort the bootstrap — Tinfoil simply fails closed until it's installed; OpenAI/Anthropic are
# unaffected. To bump the proxy, bump the pin above + re-run setup.sh (the rail-daemon model — deploy.sh refreshes
# the unit but never installs this binary).
if tinfoil_active; then
  if install_verified_tinfoil_proxy; then
    systemctl enable tinfoil-proxy
    systemctl restart tinfoil-proxy   # restart so a unit/binary change takes effect
  else
    todo "tinfoil-proxy not installed (network/release issue; re-run setup.sh) — Tinfoil requests fail closed until it's up; OpenAI/Anthropic unaffected"
  fi
else
  echo "    skip tinfoil-proxy (TINFOIL_API_KEY not set — Tinfoil rail inactive)"
fi

step "Installing systemd service"
# The unit's ExecStart points at the binary (/usr/local/lib/nullsink/current), installed in the step above.
systemctl enable "$SVC_NAME"
# The env file EXISTING isn't the same as it being CONFIGURED. On a re-run (env present) we (re)start so the
# buy-rail poller runs — but if ANTHROPIC_API_KEY is still the placeholder, WARN: the box boots and the rails
# work, yet /v1/messages will 401 until a real Anthropic key is set (or run OpenAI-only via OPENAI_API_KEY —
# at least one provider key is required to boot). A freshly templated env is left for the operator to fill.
if [ "$FRESH_ENV" -eq 0 ]; then
  systemctl restart "$SVC_NAME"
  _akey="$(grep -E '^ANTHROPIC_API_KEY=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  if [ -z "$_akey" ] || [ "$_akey" = replace-me ]; then
    todo "ANTHROPIC_API_KEY is still the placeholder in $ENV_FILE — the app runs (buy rails OK) but /v1/messages will 401 until you set a real Anthropic key (or use OPENAI_API_KEY for OpenAI-only), then restart $SVC_NAME"
  fi
else
  todo "Edit $ENV_FILE (set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or TINFOIL_API_KEY — at least one), then: systemctl start $SVC_NAME"
fi

step "Configuring monero-wallet-rpc (XMR buy-rail watcher)"
# The unit was refreshed by install_units above. Only enable/start it once its view-only wallet AND
# node env exist — without them it would crash-loop.
# Install the wallet binaries (rpc watcher + cli) when the XMR rail is active, BEFORE the
# wallet-exists check below — creating the view-only wallet needs monero-wallet-cli.
if rail_active monero; then
  install_verified_monero_wallet
  # Tor is only needed when the watcher proxies node traffic through it (the default, for an .onion node).
  # Skip it when the operator disabled the proxy (MONERO_PROXY_ARG= → a direct/clearnet node, e.g. staging).
  # Installed here (not gated on the wallet existing) so a manual `enable --now monero-wallet-rpc` works too.
  xmr_dropin="/etc/systemd/system/monero-wallet-rpc.service.d/staging-clearnet.conf"
  if proxy_disabled; then
    note "MONERO_PROXY_ARG is empty — direct node connection, skipping Tor"
    # The unit hardens egress to localhost only (IPAddressDeny=any) — correct for the Tor default (the node is
    # reached via the LOCAL SOCKS proxy), but that filter BLOCKS a direct clearnet node (non-localhost), so the
    # watcher would loop on "no connection to daemon". Reset the filter via a drop-in; the base unit stays
    # prod-hardened and PROD (Tor + .onion node) never reaches this branch.
    install -d -m 755 "$(dirname "$xmr_dropin")"
    cat > "$xmr_dropin" <<'EOF'
[Service]
# Written by setup.sh because MONERO_PROXY_ARG is empty (direct/clearnet node, no Tor). The base unit's
# localhost-only IP filter would block a non-localhost node; reset both lists here.
IPAddressDeny=
IPAddressAllow=
EOF
    systemctl daemon-reload
  else
    if ! command -v tor &>/dev/null; then apt-get install -y -qq tor; fi
    systemctl enable --now tor
    # Re-lock egress to localhost-only when running with Tor: drop any stale clearnet override (idempotent).
    if [ -f "$xmr_dropin" ]; then rm -f "$xmr_dropin"; systemctl daemon-reload; fi
  fi
fi
if [ -f /etc/monero-wallet-rpc.env ] && [ -f /var/lib/nullsink-wallet/prview ]; then
  systemctl enable monero-wallet-rpc
  systemctl restart monero-wallet-rpc        # restart so a unit/env change takes effect
  # The liveness watchdog (bounces a HUNG wallet that systemd's Restart=always can't catch) is enabled by
  # enable_timers below — it tracks this unit's enabled state, so it follows the XMR rail automatically.
elif rail_active monero; then
  todo "XMR rail: create the view-only wallet + /etc/monero-wallet-rpc.env, then: systemctl enable --now monero-wallet-rpc (re-run setup.sh or deploy.sh after, to bring up the liveness watchdog)"
else
  todo "XMR rail (optional): add 'monero' to PAY_RAILS in $ENV_FILE + re-run setup.sh to install the wallet binaries"
fi

step "Configuring bitcoind (BTC buy-rail watcher)"
# The unit was refreshed by install_units above. The bitcoind BINARY is only installed when the BTC
# rail is active (below); enable/start only once the pruned datadir + watch-only wallet exist, or it would
# crash-loop.
# Install bitcoind + bitcoin-cli when the BTC rail is active, before the datadir check below.
if rail_active bitcoin; then install_verified_bitcoind; fi
if [ -x /usr/local/bin/bitcoind ] && [ -f /var/lib/bitcoind/bitcoin.conf ]; then
  systemctl enable bitcoind
  systemctl restart bitcoind        # restart so a unit/conf change takes effect
elif rail_active bitcoin; then
  todo "BTC rail: create the pruned datadir + bitcoin.conf + watch-only wallet, then: systemctl enable --now bitcoind"
else
  todo "BTC rail (optional): add 'bitcoin' to PAY_RAILS in $ENV_FILE + re-run setup.sh to install bitcoind"
fi

step "Enabling timers (health check, daily backup, wallet watchdog)"
# One shared reconcile (lib.sh enable_timers, also run by deploy.sh): enables the always-on timers, plus the
# XMR watchdog timer iff monero-wallet-rpc is enabled (done just above) so it follows the rail. Units were
# refreshed by install_units above. Both always-on timers are safe with their creds unset:
#   - status-check.timer runs status-check.sh every 10 min; a failure pages Telegram via status-alert@.service
#     (a NO-OP until TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set — still logs to journald).
#   - backup.timer runs deploy/backup.sh daily AS the service user: sqlite3 .backup of balances.db + pending.db,
#     optional age-encryption (BACKUP_AGE_RECIPIENT) + off-box push (BACKUP_PUSH_CMD), both set in $ENV_FILE.
#     Unset = local-only plaintext snapshots in /var/lib/nullsink/backups (status-check warns if the newest goes
#     stale). Restore or TEST a backup with deploy/restore.sh (dry-run by default).
enable_timers
# Seed the first backup artifact now, so the freshness check doesn't warn until the daily timer first fires AND
# so any backup misconfig surfaces immediately. Non-fatal (e.g. before the app has created balances.db).
systemctl start backup.service || note "initial backup run failed — check: journalctl -u backup.service"

step "Installing Caddy (public edge: TLS + reverse proxy)"
# The app binds 127.0.0.1 (HOST default); Caddy is the only thing that faces the internet.
if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
# The committed Caddyfile is a host-agnostic TEMPLATE: the served domain comes from {$NULLSINK_DOMAIN},
# which Caddy reads from a systemd drop-in we write here from NULLSINK_DOMAIN in $ENV_FILE. So per-box edge
# config lives in the env file, never in the published Caddyfile. Without a domain set, skip the edge so the
# rest of the (idempotent) bootstrap still completes; re-run after setting it.
_domain="$(grep -E '^NULLSINK_DOMAIN=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
if [ -z "$_domain" ]; then
  todo "Public edge: set NULLSINK_DOMAIN in $ENV_FILE + re-run setup.sh (Caddy needs the domain)"
else
  # A drop-in (NOT EnvironmentFile=$ENV_FILE) so Caddy gets ONLY the domain — never the upstream API keys.
  install -d -m755 /etc/systemd/system/caddy.service.d
  cat > /etc/systemd/system/caddy.service.d/nullsink.conf <<EOF
[Service]
Environment=NULLSINK_DOMAIN=$_domain
EOF
  systemctl daemon-reload
  # Refresh the edge config from the repo template, replacing the stock default the caddy package ships.
  # Safe to overwrite: nothing is box-specific in it now (per-box config is the drop-in above), matching
  # deploy.sh's unconditional redeploy refresh. We deliberately do NOT start/restart Caddy here — ACME needs
  # DNS pointed at this box AND 80/443 open first, or it burns Let's Encrypt rate limits.
  install -D -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
  note "Caddyfile installed; serves NULLSINK_DOMAIN=$_domain (via a caddy.service.d drop-in)"
  # restart (NOT reload): a systemd Environment= drop-in is only picked up by a process (re)start, and the
  # caddy package already started Caddy (with its stock config) before this drop-in existed.
  todo "Public edge: point DNS at this box + open 80/443, then: systemctl restart caddy"
fi

step "Installing the edge firewall (nftables)"
# Default-deny inbound except SSH (22) + HTTP(S) (80/443). The app is on 127.0.0.1 and the crypto nodes
# work outbound-only, so nothing else needs opening. SSH is allowed BEFORE the ruleset applies and
# established connections are kept, so this won't drop the session you're running setup from. A syntax
# error in the ruleset makes `nft -f` fail here (set -e) rather than half-applying.
if ! command -v nft &>/dev/null; then apt-get install -y -qq nftables; fi
install -m644 "$APP_DIR/deploy/nftables.conf" /etc/nftables.conf
systemctl enable --now nftables
nft -f /etc/nftables.conf   # apply now (idempotent — the file starts with `flush ruleset`)

step "Done"
_state="$(systemctl is-active "$SVC_NAME" 2>/dev/null || true)"
if [ "$_state" = active ]; then _sc="$_g"; else _sc="$_y"; fi
printf '    nullsink.service: %s%s%s   (detail: systemctl status %s)\n' "$_sc" "${_state:-unknown}" "$_z" "$SVC_NAME"
# Extra, non-fatal confirmation that the app actually answers /healthz (the unit being "active" isn't the
# same as it serving). A fresh env (app not started yet) or a still-warming app simply prints "no" here.
if health_ok; then note "/healthz responded 200"; else note "/healthz not answering yet (fine if the app isn't started / still warming)"; fi
printf '\n%sAccess%s — the app is PRIVATE on %s127.0.0.1:8080%s; Caddy is the only public edge:\n' "$_c" "$_z" "$_b" "$_z"
echo "  • Direct (SSH tunnel):  ssh -L 8080:localhost:8080 root@<box>   then  curl http://localhost:8080/healthz"
echo "  • Go public:            point DNS at this box + open 80/443, then: systemctl restart caddy"
echo "  • Operator CLI (opt):   sudo deploy/install-nsk.sh   then  sudo -u nullsink nsk financials"
if [ "${#PENDING[@]}" -gt 0 ]; then
  printf '\n%s>>> Next steps (%d)%s\n' "$_c" "${#PENDING[@]}" "$_z"
  _i=1; for _item in "${PENDING[@]}"; do printf '  %d. %s\n' "$_i" "$_item"; _i=$((_i + 1)); done
fi
