# shellcheck shell=bash
# Shared "apply repo config to the box" helpers, SOURCED by setup.sh (bootstrap), deploy.sh (redeploy), and
# upgrade-component.sh (pinned rail/provider dependencies) so fetch/verify/install logic lives in one place
# and can't drift. No side effects beyond defining helpers + pins.
# Caller may override the role-specific environment paths before sourcing.

PROXY_ENV_FILE="${PROXY_ENV_FILE:-/etc/nullsink-proxy.env}"
PAYMENTS_ENV_FILE="${PAYMENTS_ENV_FILE:-/etc/nullsink-payments.env}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/nullsink-backup.env}"
MONITOR_ENV_FILE="${MONITOR_ENV_FILE:-/etc/nullsink-monitor.env}"

# The GitHub repo slug the box pulls release assets from — single source of truth for release fetch helpers.
# Env-overridable so a public fork/mirror can point elsewhere without editing this file.
REPO="${REPO:-nullsink/nullsink}"

# Fetch one PUBLIC Release asset $2 for tag $1 into dir $3. The repo is public, so a plain unauthenticated
# curl works — no gh, no auth on the box. -L follows GitHub's 302 to the asset CDN; -f fails the pipeline
# on a 404/5xx. Callers still `test -f` + `verify_sums` what lands here.
fetch_asset() { curl -fsSL "https://github.com/$REPO/releases/download/$1/$2" -o "$3/$2"; }

# Verify downloaded assets against a SHA256SUMS in $1, running from that dir. The checksum is the ONLY thing
# standing between a corrupted or tampered download and an installed+activated binary, so it must fail LOUD and
# HARD — an explicit `|| return 1`, never a bare command that leans on `set -e`. Several callers run as
# `if install_binary ...; then` (setup.sh) or `if install_client_ui ...; then` (deploy.sh); inside a function
# invoked in a condition, bash SUSPENDS `set -e` for the whole body, so a bare `sha256sum -c` failure would NOT
# abort — it would fall through to install + `ln -sfn`, activating an unverified artifact while the function
# still returns success. Routing every verify through this helper makes the gate independent of the caller's
# context. --ignore-missing: SHA256SUMS lists every release asset, but a given call pulled only some.
verify_sums() {  # $1=dir containing SHA256SUMS + the fetched asset(s)
  ( cd "$1" && sha256sum -c --ignore-missing SHA256SUMS ) || {
    echo "    !! CHECKSUM MISMATCH in $1 — refusing to install (corrupt download or tampered asset)" >&2
    return 1
  }
}

# --- App-box-only pinned external toolchain + verified-install primitives. Bitcoin Core lives in the
# standalone node-box bundle and is deliberately absent from this app deployment library. ---
# Monero CLI bundle: pinned version + the SHA-256 of the linux-x64 bundle, taken from the
# binaryFate-signed hashes.txt (gpg-verified at authoring; key 81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92).
MONERO_VERSION="0.18.5.1"
MONERO_SHA256_X64="22a7dda7b0cb699fdd6b7674c3b4a4465b337cc98a54983523b759e1e7cc9958"
# tinfoil-proxy: the local verifying proxy for the Tinfoil provider (enclave attestation). PROVENANCE is
# weaker than the Bitcoin/Monero pins: its SHA256SUMS is an unsigned CI artifact, so this is trust-on-first-use
# (checked once at authoring) then pinned by SHA. The enclave measurement still floats with Tinfoil's latest
# Sigstore-gated release; the proxy CLI offers no measurement pin (see docs/tinfoil-attestation.md).
TINFOIL_PROXY_VERSION="v0.1.9"
TINFOIL_PROXY_SHA256_X64="5e0179389629875c0febc98186fa085e67993a162c01a61f6db491ac9d8a3149"

fetch_verified() {  # $1=url $2=sha256 $3=dest — download + checksum-check; refuses on mismatch
  # Explicit `|| return 1` on the checksum, not a bare `set -e` gate: install_verified_tinfoil_proxy is called
  # as `if install_verified_tinfoil_proxy ...` in setup.sh, which suspends set -e for the whole call chain (see
  # verify_sums), so a bare pipe failure here would fall through to install an unverified binary.
  curl -fsSL "$1" -o "$3" || return 1
  echo "$2  $3" | sha256sum -c - || { echo "    !! CHECKSUM MISMATCH for $3 — refusing to install" >&2; return 1; }
}
require_x86_64() {  # $1=label — these pins are x86_64-only; fail loud rather than install a dud
  if [ "$(uname -m)" != "x86_64" ]; then
    echo "    !! pin for $1 is x86_64 only; this box is $(uname -m). Add the matching asset + hash." >&2
    exit 1
  fi
}

monero_wallet_binary_matches_pin() {  # $1=monero-wallet-rpc path
  local first
  first="$("$1" --version 2>/dev/null | sed -n '1p')" || return 1
  [[ "$first" == *"(v${MONERO_VERSION}-release)"* ||
     "$first" == *" v${MONERO_VERSION} "* ]]
}
monero_wallet_is_pinned() {
  monero_wallet_binary_matches_pin /usr/local/bin/monero-wallet-rpc
}
tinfoil_proxy_is_pinned() {
  [ -x /usr/local/bin/tinfoil-proxy ] &&
    echo "$TINFOIL_PROXY_SHA256_X64  /usr/local/bin/tinfoil-proxy" | sha256sum -c --status -
}

stage_verified_monero_wallet() {  # $1=dest — verified wallet RPC + CLI, without touching the live binaries
  require_x86_64 "Monero CLI"
  local dest="$1" tmp
  mkdir -p "$dest" || return 1
  tmp="$(mktemp -d)" || return 1
  fetch_verified "https://downloads.getmonero.org/cli/monero-linux-x64-v${MONERO_VERSION}.tar.bz2" \
    "$MONERO_SHA256_X64" "$tmp/monero.tar.bz2" || { rm -rf "$tmp"; return 1; }
  tar -xjf "$tmp/monero.tar.bz2" -C "$tmp" --strip-components=1 ||
    { rm -rf "$tmp"; return 1; }   # -> $tmp/monero-wallet-{rpc,cli}
  install -m755 "$tmp/monero-wallet-rpc" "$dest/monero-wallet-rpc" ||
    { rm -rf "$tmp"; return 1; }
  install -m755 "$tmp/monero-wallet-cli" "$dest/monero-wallet-cli" ||
    { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}
stage_verified_tinfoil_proxy() {  # $1=dest — verified proxy, without touching the live binary
  # Unlike the bootstrap's required rail tools, Tinfoil is optional. Return instead of exiting on wrong arch
  # so setup.sh can keep configuring the rest of the box and print a next-step warning.
  if [ "$(uname -m)" != "x86_64" ]; then
    echo "    !! tinfoil-proxy pin is x86_64-only; this box is $(uname -m) — refusing to stage" >&2
    return 1
  fi
  local dest="$1" tmp
  mkdir -p "$dest" || return 1
  tmp="$(mktemp -d)" || return 1
  fetch_verified "https://github.com/tinfoilsh/tinfoil-proxy/releases/download/${TINFOIL_PROXY_VERSION}/tinfoil-proxy-linux-amd64" \
    "$TINFOIL_PROXY_SHA256_X64" "$tmp/tinfoil-proxy" || { rm -rf "$tmp"; return 1; }
  install -m755 "$tmp/tinfoil-proxy" "$dest/tinfoil-proxy" ||
    { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

install_verified_monero_wallet() {  # wallet watcher + CLI (the latter creates the view-only wallet once)
  if monero_wallet_is_pinned; then return 0; fi
  local tmp
  tmp="$(mktemp -d)" || return 1
  stage_verified_monero_wallet "$tmp" || { rm -rf "$tmp"; return 1; }
  install -m755 "$tmp/monero-wallet-rpc" "$tmp/monero-wallet-cli" /usr/local/bin/ ||
    { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  echo "    monero-wallet-rpc/cli v${MONERO_VERSION} installed"
}
install_verified_tinfoil_proxy() {  # local attestation sidecar
  if tinfoil_proxy_is_pinned; then return 0; fi
  local tmp
  tmp="$(mktemp -d)" || return 1
  stage_verified_tinfoil_proxy "$tmp" || { rm -rf "$tmp"; return 1; }
  install -m755 "$tmp/tinfoil-proxy" /usr/local/bin/tinfoil-proxy ||
    { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  echo "    tinfoil-proxy ${TINFOIL_PROXY_VERSION} installed"
}

# The two app units: one proxy trust domain process, one payments trust domain process. Every caller that means "the app"
# means both, in this order — the proxy binds the credit socket the payments service connects to, so it goes
# up first and comes down last.
PROXY_UNIT="nullsink-proxy"
PAYMENTS_UNIT="nullsink-payments"

install_units() {  # refresh the explicit app-box unit allowlist; other host roles cannot leak into this box
  local unit
  for unit in \
    nullsink-proxy.service nullsink-payments.service \
    monero-wallet-rpc.service tinfoil-proxy.service nullsink-bitcoin-label-export.service \
    backup.service backup.timer status-check.service status-check.timer status-alert@.service; do
    install -m644 "$APP_DIR/deploy/$unit" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
}

enable_app_units() { systemctl enable "$PROXY_UNIT" "$PAYMENTS_UNIT"; }   # idempotent; also arms them for reboot

restart_app() {  # proxy first: it binds the credit socket payments connects to (payments retries regardless)
  systemctl restart "$PROXY_UNIT"
  systemctl restart "$PAYMENTS_UNIT"
}

CONTROL_TIMERS_SUSPENDED=0
CONTROL_TIMERS_WERE_ACTIVE=()
suspend_control_timers() {
  # status-check.service and backup.service execute scripts through the live deploy/ path. Stop both timers,
  # then drain either one-shot before that tree is replaced; otherwise an old unit can race into a new script.
  local unit
  CONTROL_TIMERS_WERE_ACTIVE=()
  for unit in status-check.timer backup.timer; do
    systemctl is-active --quiet "$unit" 2>/dev/null && CONTROL_TIMERS_WERE_ACTIVE+=("$unit")
  done
  CONTROL_TIMERS_SUSPENDED=1
  systemctl stop status-check.timer backup.timer || { restore_control_timers || true; return 1; }
  systemctl stop status-check.service backup.service || { restore_control_timers || true; return 1; }
}

restore_control_timers() {
  [ "$CONTROL_TIMERS_SUSPENDED" -eq 1 ] || return 0
  if [ "${#CONTROL_TIMERS_WERE_ACTIVE[@]}" -gt 0 ]; then
    systemctl start "${CONTROL_TIMERS_WERE_ACTIVE[@]}"
  fi
  CONTROL_TIMERS_SUSPENDED=0
  CONTROL_TIMERS_WERE_ACTIVE=()
}

enable_timers() {  # reconcile the box's timers from the repo — shared by setup.sh + deploy.sh, idempotent.
  # The always-on timers run on every box (safe with their creds unset — they just log / no-op). Run after
  # install_units (the unit files must exist).
  systemctl enable --now status-check.timer backup.timer
  CONTROL_TIMERS_SUSPENDED=0
  CONTROL_TIMERS_WERE_ACTIVE=()
}

install_binary() {  # $1=tag — fetch+verify+activate BOTH self-contained app binaries for a release tag
  # Binary layout: versioned /usr/local/lib/nullsink/nullsink-{proxy,payments}-<tag> + a `current-proxy` /
  # `current-payments` symlink per service -> the active version (RELATIVE targets, so the dir is
  # self-contained/relocatable). Each unit's ExecStart runs its symlink; activation is an atomic `ln -sfn`
  # swap, rollback is repointing it at the previous target. Each binary is a self-contained
  # `bun build --compile` artifact (bundles prices.json etc.) — it runs with role-specific environment and
  # state paths, no source/Bun needed.
  #
  # The two are ONE release, deployed in lockstep: they speak a versioned credit wire and a mismatched pair
  # fails closed (the proxy 400s an unknown wire version, credits wait in the durable outbox). So fetch and
  # verify BOTH before flipping EITHER symlink — a half-applied activation is the one state we can always
  # avoid here.
  local tag="$1" tmp svc
  mkdir -p /usr/local/lib/nullsink
  tmp="$(mktemp -d)"
  for svc in proxy payments; do fetch_asset "$tag" "nullsink-$svc-linux-x64" "$tmp"; done
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  for svc in proxy payments; do test -f "$tmp/nullsink-$svc-linux-x64"; done   # assert both assets downloaded
  verify_sums "$tmp" || return 1   # the checksum gate — fires even when a caller invokes us in an `if` (see verify_sums). Verify BOTH assets before flipping EITHER symlink.
  for svc in proxy payments; do
    install -m755 "$tmp/nullsink-$svc-linux-x64" "/usr/local/lib/nullsink/nullsink-$svc-$tag"
  done
  for svc in proxy payments; do
    ln -sfn "nullsink-$svc-$tag" "/usr/local/lib/nullsink/current-$svc"   # atomic activate (relative target)
  done
  rm -rf "$tmp"
  echo "    app binaries $tag activated (current-proxy + current-payments -> nullsink-{proxy,payments}-$tag)"
}

install_nsk() {  # $1=tag — install the optional read-only operator CLI
  local tag="$1" tmp wrapper
  mkdir -p /usr/local/lib/nullsink
  tmp="$(mktemp -d)"
  fetch_asset "$tag" 'nsk-linux-x64' "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/nsk-linux-x64"
  verify_sums "$tmp" || return 1
  install -m755 "$tmp/nsk-linux-x64" "/usr/local/lib/nullsink/nsk-$tag"
  ln -sfn "nsk-$tag" /usr/local/lib/nullsink/current-nsk
  wrapper="$tmp/nsk"
  cat > "$wrapper" <<'EOF'
#!/bin/sh
exec env \
  BALANCES_DB_PATH=/var/lib/nullsink-proxy/balances.db \
  PENDING_DB_PATH=/var/lib/nullsink-payments/pending.db \
  /usr/local/lib/nullsink/current-nsk "$@"
EOF
  install -m755 "$wrapper" /usr/local/bin/nsk
  rm -rf "$tmp"
  echo "    read-only operator CLI nsk $tag installed"
}

install_deploy_tree() {  # $1=tag $2=dest — fetch+verify+extract deploy-<tag>.tar.gz so $2/deploy/ exists
  # Source-free box: the systemd units ExecStart $APP_DIR/deploy/*.sh, so the box needs deploy/ (NOT src/ or
  # cli/). Extract away from the live path, discard archive ownership, then replace the complete directory;
  # a corrupt/partial archive can never splice the scripts that root timers execute.
  local tag="$1" dest="$2" tmp staging previous had_previous=0
  tmp="$(mktemp -d)" || return 1
  fetch_asset "$tag" "deploy-${tag}.tar.gz" "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/deploy-${tag}.tar.gz"
  verify_sums "$tmp" || return 1
  mkdir -p "$dest" || { rm -rf "$tmp"; return 1; }
  staging="$dest/.deploy-${tag}.new"
  previous="$dest/.deploy.previous"
  rm -rf -- "$staging" "$previous" || { rm -rf "$tmp"; return 1; }
  mkdir -p "$staging" || { rm -rf "$tmp"; return 1; }
  tar --no-same-owner -xzf "$tmp/deploy-${tag}.tar.gz" -C "$staging" || {
    rm -rf "$tmp" "$staging"; return 1;
  }
  for required in deploy.sh lib.sh status-check.sh backup.sh; do
    test -f "$staging/deploy/$required" || {
      echo "    !! deploy tree $tag is missing deploy/$required — refusing to activate" >&2
      rm -rf "$tmp" "$staging"
      return 1
    }
  done
  chown -R root:root "$staging/deploy" || { rm -rf "$tmp" "$staging"; return 1; }
  chmod -R go-w "$staging/deploy" || { rm -rf "$tmp" "$staging"; return 1; }
  if [ -e "$dest/deploy" ] || [ -L "$dest/deploy" ]; then
    mv "$dest/deploy" "$previous" || { rm -rf "$tmp" "$staging"; return 1; }
    had_previous=1
  fi
  if ! mv "$staging/deploy" "$dest/deploy"; then
    [ "$had_previous" -eq 0 ] || mv "$previous" "$dest/deploy" || true
    rm -rf "$tmp" "$staging"
    return 1
  fi
  rm -rf "$tmp" "$staging" "$previous"
  echo "    deploy tree $tag extracted to $dest/deploy"
}

install_client_ui() {  # $1=tag $2=webbase — fetch+verify+extract the client UI, activate via a versioned symlink
  # Versioned webroot, mirroring the binary's versioned dir + `current` symlink: each release's UI lands in
  # $webbase/web-<tag>, and an atomic `ln -sfn` swaps $webbase/current-web at it. The Caddyfile root is
  # {$NULLSINK_WEBROOT:/var/www/nullsink/current-web}, so this swap (and its rollback in deploy.sh) is exactly
  # what the edge serves. release.yml `tar -czf … -C client dist` -> entries dist/*, so strip one component.
  local tag="$1" webbase="$2" tmp
  mkdir -p "$webbase"
  tmp="$(mktemp -d)"
  fetch_asset "$tag" "nullsink-ui-${tag}.tar.gz" "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/nullsink-ui-${tag}.tar.gz"
  verify_sums "$tmp" || return 1
  # Stage the extract in web-$tag.new and swap it into place only once it's verified-good, so a
  # fetch-ok-then-extract-fail on a SAME-tag redeploy can't destroy the currently-serving web-$tag. Each step
  # that must hold before the destructive `rm -rf web-$tag` gets an explicit `|| return 1`: deploy.sh calls us
  # as `if install_client_ui ...`, which SUSPENDS set -e for this whole body (see verify_sums), so a bare
  # `test -f`/`tar` failure would otherwise fall straight through to the rm+mv and swap an EMPTY dir into place
  # while returning success — silently breaking the buy UI. The activate stays an atomic ln -sfn.
  local staging="$webbase/web-$tag.new"
  rm -rf "${staging:?}"
  mkdir -p "$staging"
  tar --no-same-owner -xzf "$tmp/nullsink-ui-${tag}.tar.gz" -C "$staging" --strip-components=1 || return 1   # dist/* -> web-$tag.new/*
  test -f "$staging/index.html" || { echo "    !! UI tarball for $tag has no index.html — refusing to swap" >&2; return 1; }
  chown -R root:root "$staging" || return 1
  chmod -R a+rX "$staging"                     # Caddy runs as its own user — ensure it can read files + traverse dirs
  rm -rf "${webbase:?}/web-$tag"               # drop the old copy only now — the new one is staged + validated
  mv "$staging" "$webbase/web-$tag" || return 1   # swap into place
  ln -sfn "web-$tag" "$webbase/current-web" || return 1   # atomic activate (relative target)
  rm -rf "$tmp"
  echo "    client UI $tag activated ($webbase/current-web -> web-$tag)"
}

env_val_from() { grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
proxy_port()    { local p; p="$(env_val_from "$PROXY_ENV_FILE" PORT)"; echo "${p:-8080}"; }
payments_port() { local p; p="$(env_val_from "$PAYMENTS_ENV_FILE" PAYMENTS_PORT)"; echo "${p:-8081}"; }

prepare_service_isolation() { "$APP_DIR/deploy/migrate-service-isolation.sh" --prepare; }
activate_isolation_sidecars() {
  [ -f /etc/nullsink-service-isolation.finalized ] && return 0
  if [ -d /var/lib/nullsink-wallet ]; then
    chown -R nullsink-payments:nullsink-payments-read /var/lib/nullsink-wallet
    chmod -R go-rwx /var/lib/nullsink-wallet
  fi
  if [ -f /etc/monero-wallet-rpc.env ]; then
    chown root:root /etc/monero-wallet-rpc.env
    chmod 0600 /etc/monero-wallet-rpc.env
  fi
  if [ -d /var/lib/tinfoil-proxy ]; then
    chown -R nullsink-proxy:nullsink-proxy-read /var/lib/tinfoil-proxy
    chmod -R go-rwx /var/lib/tinfoil-proxy
  fi
}
restart_isolation_sidecars() {
  [ -f /etc/nullsink-service-isolation.finalized ] && return 0
  local unit active_units=()
  for unit in tinfoil-proxy monero-wallet-rpc; do
    systemctl is-active --quiet "$unit" 2>/dev/null && active_units+=("$unit")
  done
  # Stop legacy-uid processes while they still own their state. In particular, monero-wallet-rpc saves its
  # view-only wallet during SIGTERM; chowning first makes that final save fail before the isolated restart.
  [ "${#active_units[@]}" -eq 0 ] || systemctl stop "${active_units[@]}"
  activate_isolation_sidecars
  [ "${#active_units[@]}" -eq 0 ] || systemctl start "${active_units[@]}"
}

health_ok() {  # $1=port — poll /healthz until it answers 200, up to HEALTH_TIMEOUT (default 60) s; return 0/1
  # /healthz is localhost-only (Caddy never routes it). Both services serve it on their own port.
  local port="$1" waited=0
  while [ "$waited" -lt "${HEALTH_TIMEOUT:-60}" ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

health_ok_app() {  # BOTH services must serve. Proxy first (it's the one that comes up first).
  health_ok "$(proxy_port)" && health_ok "$(payments_port)"
}
