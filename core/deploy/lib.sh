# shellcheck shell=bash
# Shared "apply repo config to the box" helpers, SOURCED by setup.sh (bootstrap) and deploy.sh (redeploy)
# so unit/timer install lives in one place and can't drift. No side effects beyond defining helpers + REPO +
# the shared Bitcoin pin (below).
# Caller must set APP_DIR (and ENV_FILE for health_ok).

# The GitHub repo slug the box pulls release assets from — single source of truth for all four fetch
# helpers. Env-overridable so a public fork/mirror can point elsewhere without editing this file.
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

# --- Pinned external toolchain + verified-install primitives, shared by setup.sh (app box) and
# setup-nodes.sh (node box) so the pin + fetch/verify logic is ONE source of truth and can't drift. ---
# Bitcoin Core: pinned version + the SHA-256 of the x86_64-linux tarball, taken from the fanquake-signed
# SHA256SUMS (gpg-verified at authoring; key E777299FC265DD04793070EB944D35F9AC3DB76A).
BITCOIN_VERSION="31.0"
BITCOIN_SHA256_X64="d3e4c58a35b1d0a97a457462c94f55501ad167c660c245cb1ffa565641c65074"

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

install_units() {  # refresh ALL units + timers from the repo so on-box config can't drift, then reload
  cp "$APP_DIR"/deploy/*.service "$APP_DIR"/deploy/*.timer /etc/systemd/system/
  systemctl daemon-reload
}

enable_timers() {  # reconcile the box's timers from the repo — shared by setup.sh + deploy.sh, idempotent.
  # The always-on timers run on every box (safe with their creds unset — they just log / no-op). Run after
  # install_units (the unit files must exist).
  systemctl enable --now status-check.timer backup.timer
  # The XMR liveness watchdog was removed in v1.3.1 (it could livelock a slow-starting wallet over Tor);
  # disable the orphaned timer on any box still carrying it from a v1.3.0 deploy.
  systemctl disable --now monero-wallet-rpc-watchdog.timer 2>/dev/null || true
}

install_binary() {  # $1=tag — fetch+verify+activate the self-contained app binary for a release tag
  # Binary layout: versioned /usr/local/lib/nullsink/nullsink-<tag> + a `current` symlink -> the active
  # version (a RELATIVE target, so the dir is self-contained/relocatable). The unit's ExecStart runs the
  # symlink; activation is an atomic `ln -sfn` swap, rollback is repointing it at the previous target.
  # The binary is the self-contained `bun build --compile` artifact (bundles prices.json etc.) — it runs
  # with only /etc/nullsink.env + /var/lib/nullsink, no source/Bun needed.
  local tag="$1" tmp
  mkdir -p /usr/local/lib/nullsink
  tmp="$(mktemp -d)"
  fetch_asset "$tag" 'nullsink-linux-x64' "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/nullsink-linux-x64"   # assert the asset downloaded
  verify_sums "$tmp" || return 1   # the checksum gate — fires even when a caller invokes us in an `if` (see verify_sums)
  install -m755 "$tmp/nullsink-linux-x64" "/usr/local/lib/nullsink/nullsink-$tag"
  ln -sfn "nullsink-$tag" /usr/local/lib/nullsink/current   # atomic activate (relative target)
  rm -rf "$tmp"
  echo "    app binary $tag activated (/usr/local/lib/nullsink/current -> nullsink-$tag)"
}

install_nsk() {  # $1=tag — fetch+verify+install the operator CLI binary (nsk) to /usr/local/bin/nsk
  # A single flat binary (no version-symlink/rollback dance — it's a stateless one-shot tool), built from the
  # SAME tag as the server in one release.yml run so the two can't drift.
  local tag="$1" tmp
  tmp="$(mktemp -d)"
  fetch_asset "$tag" 'nsk-linux-x64' "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/nsk-linux-x64"
  verify_sums "$tmp" || return 1
  install -m755 "$tmp/nsk-linux-x64" /usr/local/bin/nsk
  rm -rf "$tmp"
  echo "    operator CLI nsk $tag installed (/usr/local/bin/nsk)"
}

install_deploy_tree() {  # $1=tag $2=dest — fetch+verify+extract deploy-<tag>.tar.gz so $2/deploy/ exists
  # Source-free box: the systemd units ExecStart $APP_DIR/deploy/*.sh, so the box needs deploy/ (NOT src/ or
  # cli/). Ship it as a release tarball instead of git-cloning the whole source repo.
  local tag="$1" dest="$2" tmp
  tmp="$(mktemp -d)"
  fetch_asset "$tag" "deploy-${tag}.tar.gz" "$tmp"
  fetch_asset "$tag" 'SHA256SUMS' "$tmp"
  test -f "$tmp/deploy-${tag}.tar.gz"
  verify_sums "$tmp" || return 1
  mkdir -p "$dest"
  tar -xzf "$tmp/deploy-${tag}.tar.gz" -C "$dest"   # release.yml `tar -czf … -C core deploy` -> $dest/deploy/*
  rm -rf "$tmp"
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
  tar -xzf "$tmp/nullsink-ui-${tag}.tar.gz" -C "$staging" --strip-components=1 || return 1   # dist/* -> web-$tag.new/*
  test -f "$staging/index.html" || { echo "    !! UI tarball for $tag has no index.html — refusing to swap" >&2; return 1; }
  chmod -R a+rX "$staging"                     # Caddy runs as its own user — ensure it can read files + traverse dirs
  rm -rf "${webbase:?}/web-$tag"               # drop the old copy only now — the new one is staged + validated
  mv "$staging" "$webbase/web-$tag" || return 1   # swap into place
  ln -sfn "web-$tag" "$webbase/current-web" || return 1   # atomic activate (relative target)
  rm -rf "$tmp"
  echo "    client UI $tag activated ($webbase/current-web -> web-$tag)"
}

health_ok() {  # poll /healthz until it answers 200, up to HEALTH_TIMEOUT (default 60) seconds; return 0/1
  # /healthz is localhost-only (Caddy never routes it). Port from the env file (default 8080).
  local port health_url waited=0
  port="$(grep -E '^PORT=' "${ENV_FILE:-/etc/nullsink.env}" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  health_url="http://127.0.0.1:${port:-8080}/healthz"
  while [ "$waited" -lt "${HEALTH_TIMEOUT:-60}" ]; do
    if curl -fsS --max-time 3 "$health_url" >/dev/null 2>&1; then return 0; fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}
