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

# Verify downloaded assets against a SHA256SUMS snapshot, running from the asset dir. The checksum is the ONLY thing
# standing between a corrupted or tampered download and an installed+activated binary, so it must fail LOUD and
# HARD — an explicit `|| return 1`, never a bare command that leans on `set -e`. Several callers run as
# Release installers are deliberately callable from guarded transaction/bootstrap branches; inside a function
# invoked in a condition, bash SUSPENDS `set -e` for the whole body, so a bare `sha256sum -c` failure would NOT
# abort — it would fall through to install + `ln -sfn`, activating an unverified artifact while the function
# still returns success. Routing every verify through this helper makes the gate independent of the caller's
# context. --ignore-missing: SHA256SUMS lists every release asset, but a given call pulled only some.
verify_sums_against() {  # $1=asset dir $2=the exact SHA256SUMS snapshot to trust
  local assets="$1" manifest="$2" manifest_abs
  [ -r "$manifest" ] || { echo "    !! checksum manifest is missing or unreadable: $manifest" >&2; return 1; }
  case "$manifest" in
    /*) manifest_abs="$manifest" ;;
    *) manifest_abs="$(cd "$(dirname "$manifest")" && pwd)/$(basename "$manifest")" || return 1 ;;
  esac
  ( cd "$assets" && sha256sum -c --ignore-missing "$manifest_abs" ) || {
    echo "    !! CHECKSUM MISMATCH in $assets — refusing to install (corrupt download or tampered asset)" >&2
    return 1
  }
}

verify_sums() {  # compatibility helper: $1 contains both SHA256SUMS and the fetched asset(s)
  verify_sums_against "$1" "$1/SHA256SUMS"
}

# --- Pinned external toolchain + verified-install primitives, shared by setup.sh (app box) and
# setup-nodes.sh (node box) so the pin + fetch/verify logic is ONE source of truth and can't drift. ---
# Bitcoin Core: pinned version + the SHA-256 of the x86_64-linux tarball, taken from the maintainer-signed
# SHA256SUMS (gpg-verified at authoring; key 152812300785C96444D3334D17565732E08E5E41).
BITCOIN_VERSION="31.1"
BITCOIN_SHA256_X64="b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e"

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

# The two app units: one prompt-world process, one payment-world process. Every caller that means "the app"
# means both, in this order — the proxy binds the credit socket the payments service connects to, so it goes
# up first and comes down last.
PROXY_UNIT="nullsink-proxy"
PAYMENTS_UNIT="nullsink-payments"

valid_release_tag() { # $1=strict SemVer tag; excludes path separators from every filesystem destination
  local tag="${1:-}"
  local core='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
  local identifier='[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*'
  [[ "$tag" =~ ^v${core}(-${identifier})?(\+${identifier})?$ ]]
}

matching_release_tag() {  # $1=proxy link target $2=payments target $3=UI target; print one shared tag
  local proxy_name pay_name web_name proxy_tag pay_tag web_tag
  proxy_name="$(basename "$1")"; pay_name="$(basename "$2")"; web_name="$(basename "$3")"
  # Every installer writes relative, basename-only symlinks. Reject absolute/parent paths even when their
  # basenames look valid: rollback must never copy bytes to an operator-supplied path outside our roots.
  [ "$1" = "$proxy_name" ] && [ "$2" = "$pay_name" ] && [ "$3" = "$web_name" ] || return 1
  case "$proxy_name:$pay_name:$web_name" in
    nullsink-proxy-v*:nullsink-payments-v*:web-v*) ;;
    *) return 1 ;;
  esac
  proxy_tag="${proxy_name#nullsink-proxy-}"
  pay_tag="${pay_name#nullsink-payments-}"
  web_tag="${web_name#web-}"
  valid_release_tag "$proxy_tag" || return 1
  [ "$proxy_tag" = "$pay_tag" ] && [ "$proxy_tag" = "$web_tag" ] || return 1
  printf '%s\n' "$proxy_tag"
}

release_pointers_target_tag() {  # $1=tag $2=proxy pointer $3=payments pointer $4=UI pointer
  # A fresh setup can be interrupted while flipping its three same-release pointers. Permit that exact
  # partial state to be repaired on a rerun, but do not bless a regular file, an absolute/foreign target, or
  # pointers split across tags. Callers separately require at least one pointer to exist before using this.
  local tag="$1" proxy_ptr="$2" pay_ptr="$3" web_ptr="$4" seen=0 ptr expected actual
  for ptr in "$proxy_ptr" "$pay_ptr" "$web_ptr"; do
    case "$ptr" in
      "$proxy_ptr") expected="nullsink-proxy-$tag" ;;
      "$pay_ptr") expected="nullsink-payments-$tag" ;;
      *) expected="web-$tag" ;;
    esac
    if [ -e "$ptr" ] || [ -L "$ptr" ]; then
      seen=1
      [ -L "$ptr" ] || return 1
      actual="$(readlink "$ptr")" || return 1
      [ "$actual" = "$expected" ] || return 1
    fi
  done
  [ "$seen" -eq 1 ]
}

install_units() {  # refresh ALL units + timers from the repo so on-box config can't drift, then reload
  cp "$APP_DIR"/deploy/*.service "$APP_DIR"/deploy/*.timer /etc/systemd/system/ || return 1
  systemctl daemon-reload || return 1
}

enable_app_units() { systemctl enable "$PROXY_UNIT" "$PAYMENTS_UNIT" || return 1; }   # idempotent; also arms them for reboot

restart_app() {  # proxy first: it binds the credit socket payments connects to (payments retries regardless)
  systemctl restart "$PROXY_UNIT" || return 1
  systemctl restart "$PAYMENTS_UNIT" || return 1
}

enable_timers() {  # reconcile the box's timers from the repo — shared by setup.sh + deploy.sh, idempotent.
  # The always-on timers run on every box (safe with their creds unset — they just log / no-op). Run after
  # install_units (the unit files must exist).
  systemctl enable --now status-check.timer backup.timer || return 1
}

stage_release_manifest() {  # $1=tag $2=directory — fetch exactly one manifest snapshot
  local tag="$1" dest="$2"
  mkdir -p "$dest" || return 1
  fetch_asset "$tag" 'SHA256SUMS' "$dest" || return 1
  test -f "$dest/SHA256SUMS" || return 1
  chmod a-w "$dest/SHA256SUMS" || return 1
}

stage_release_assets() {  # $1=tag $2=directory $3=manifest-or-empty $4...=required asset names
  # A reusable, fail-explicit staging gate. The install helpers are often called from an `if`, which makes
  # bash ignore `set -e` throughout their bodies; every operation therefore carries its own return check.
  # `sha256sum --ignore-missing` considers "none of the named assets are present" successful, so the
  # per-asset `test -f` checks are part of the trust boundary, not redundant tidiness.
  local tag="$1" dest="$2" manifest="${3:-}" asset
  shift 3
  [ "$#" -gt 0 ] || { echo "    !! no release assets requested for staging" >&2; return 2; }
  mkdir -p "$dest" || return 1
  for asset in "$@"; do
    fetch_asset "$tag" "$asset" "$dest" || return 1
    test -f "$dest/$asset" || return 1
  done
  if [ -z "$manifest" ]; then
    stage_release_manifest "$tag" "$dest" || return 1
    manifest="$dest/SHA256SUMS"
  fi
  [ -r "$manifest" ] || { echo "    !! shared SHA256SUMS snapshot is missing: $manifest" >&2; return 1; }
  # --ignore-missing deliberately tolerates release assets this installer did not request. It must not also
  # tolerate a malformed manifest that omits one it DID request, so prove each required filename is listed.
  for asset in "$@"; do
    awk -v required="$asset" '
      NF >= 2 { name=$2; sub(/^\*/, "", name); if (name == required) found=1 }
      END { exit(found ? 0 : 1) }
    ' "$manifest" || {
      echo "    !! SHA256SUMS does not cover required asset $asset" >&2
      return 1
    }
  done
  verify_sums_against "$dest" "$manifest" || return 1
}

stage_binary_assets() {  # $1=tag $2=directory $3=optional shared manifest — change no live pointer
  stage_release_assets "$1" "$2" "${3:-}" 'nullsink-proxy-linux-x64' 'nullsink-payments-linux-x64'
}

activate_binary_assets() {  # $1=tag $2=staged directory — install files, then flip both service pointers
  # Binary layout: versioned /usr/local/lib/nullsink/nullsink-{proxy,payments}-<tag> + a `current-proxy` /
  # `current-payments` symlink per service -> the active version (RELATIVE targets, so the dir is
  # self-contained/relocatable). Each unit's ExecStart runs its symlink; activation is an atomic `ln -sfn`
  # swap, rollback is repointing it at the previous target. Each binary is a self-contained
  # `bun build --compile` artifact (bundles prices.json etc.) — it runs with only /etc/nullsink.env +
  # /var/lib/nullsink, no source/Bun needed.
  #
  # The two are ONE release and speak a versioned credit wire. Both staged files are already checksum-gated;
  # install both before flipping either pointer. A caller that needs rollback must mark the transaction live
  # before entering this function, because the two filesystem symlinks cannot be swapped as one syscall.
  local tag="$1" staged="$2" svc
  mkdir -p /usr/local/lib/nullsink || return 1
  for svc in proxy payments; do
    install -m755 "$staged/nullsink-$svc-linux-x64" "/usr/local/lib/nullsink/nullsink-$svc-$tag" || return 1
  done
  for svc in proxy payments; do
    ln -sfn "nullsink-$svc-$tag" "/usr/local/lib/nullsink/current-$svc" || return 1
  done
  echo "    app binaries $tag activated (current-proxy + current-payments -> nullsink-{proxy,payments}-$tag)"
}

install_binary() {  # $1=tag $2=optional shared manifest — setup/bootstrap convenience wrapper
  local tag="$1" manifest="${2:-}" tmp
  tmp="$(mktemp -d)" || return 1
  if ! stage_binary_assets "$tag" "$tmp" "$manifest"; then rm -rf "$tmp"; return 1; fi
  if ! activate_binary_assets "$tag" "$tmp"; then rm -rf "$tmp"; return 1; fi
  rm -rf "$tmp" || return 1
}

stage_nsk_asset() {  # $1=tag $2=directory $3=optional shared manifest — do not replace nsk
  stage_release_assets "$1" "$2" "${3:-}" 'nsk-linux-x64'
}

activate_nsk_asset() {  # $1=staged directory
  install -m755 "$1/nsk-linux-x64" /usr/local/bin/nsk || return 1
  echo "    operator CLI nsk installed (/usr/local/bin/nsk)"
}

install_nsk() {  # $1=tag $2=optional shared manifest — fetch+verify+install the operator CLI binary (nsk)
  # A single flat binary (no version-symlink/rollback dance — it's a stateless one-shot tool), built from the
  # SAME tag as the server in one release.yml run so the two can't drift.
  local tag="$1" manifest="${2:-}" tmp
  tmp="$(mktemp -d)" || return 1
  if ! stage_nsk_asset "$tag" "$tmp" "$manifest"; then rm -rf "$tmp"; return 1; fi
  if ! activate_nsk_asset "$tmp"; then rm -rf "$tmp"; return 1; fi
  rm -rf "$tmp" || return 1
  echo "    operator CLI nsk matches $tag"
}

stage_deploy_tree() {  # $1=tag $2=staging root $3=optional shared manifest
  # Source-free box: the systemd units ExecStart $APP_DIR/deploy/*.sh, so the box needs deploy/ (NOT src/ or
  # cli/). Ship it as a release tarball instead of git-cloning the whole source repo.
  local tag="$1" assets="$2/assets" tree="$2/tree" manifest="${3:-}"
  stage_release_assets "$tag" "$assets" "$manifest" "deploy-${tag}.tar.gz" || return 1
  mkdir -p "$tree" || return 1
  tar -xzf "$assets/deploy-${tag}.tar.gz" -C "$tree" || return 1
  test -f "$tree/deploy/Caddyfile" || { echo "    !! staged deploy tree has no Caddyfile" >&2; return 1; }
  echo "    deploy tree $tag staged at $tree/deploy"
}

install_deploy_tree() {  # $1=tag $2=dest $3=optional shared manifest — staged replacement, never overlay
  local tag="$1" dest="$2" manifest="${3:-}" tmp backup had_previous=0
  mkdir -p "$dest" || return 1
  # Keep staging and the live tree on one filesystem. Each rename is atomic; if activation fails, put the
  # previous complete directory back. We never copy over a running tree (which could leave stale or mixed files).
  tmp="$(mktemp -d "$dest/.deploy-stage-${tag}.XXXXXX")" || return 1
  backup="$tmp/previous-deploy"
  if ! stage_deploy_tree "$tag" "$tmp" "$manifest"; then rm -rf "$tmp"; return 1; fi
  if [ -e "$dest/deploy" ] || [ -L "$dest/deploy" ]; then
    mv "$dest/deploy" "$backup" || { rm -rf "$tmp"; return 1; }
    had_previous=1
  fi
  if ! mv "$tmp/tree/deploy" "$dest/deploy"; then
    echo "    !! deploy-tree activation failed; restoring the previous complete tree" >&2
    if [ "$had_previous" -eq 1 ]; then
      mv "$backup" "$dest/deploy" || {
        echo "    !! deploy-tree rollback failed; $backup requires manual recovery" >&2
      }
    fi
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
  if [ "$had_previous" -eq 1 ]; then rm -rf "$backup" || true; fi
  echo "    deploy tree $tag replaced at $dest/deploy"
}

stage_client_ui() {  # $1=tag $2=staging root $3=optional shared manifest
  local tag="$1" assets="$2/assets" web="$2/web" manifest="${3:-}"
  stage_release_assets "$tag" "$assets" "$manifest" "nullsink-ui-${tag}.tar.gz" || return 1
  mkdir -p "$web" || return 1
  tar -xzf "$assets/nullsink-ui-${tag}.tar.gz" -C "$web" --strip-components=1 || return 1
  test -f "$web/index.html" || { echo "    !! UI tarball for $tag has no index.html" >&2; return 1; }
  chmod -R a+rX "$web" || return 1
  echo "    client UI $tag staged at $web"
}

activate_client_ui_assets() {  # $1=tag $2=staged UI root $3=webbase $4=mode
  # Versioned webroot, mirroring the binary's versioned dir + `current` symlink: each release's UI lands in
  # $webbase/web-<tag>, and an atomic `ln -sfn` swaps $webbase/current-web at it. The Caddyfile root is
  # {$NULLSINK_WEBROOT:/var/www/nullsink/current-web}. The caller must have already checksum-verified and
  # extracted staged/web through stage_client_ui.
  local tag="$1" staged="$2" webbase="$3" mode="${4:-activate}"
  if [ "$mode" != activate ] && [ "$mode" != stage ]; then
    echo "    !! invalid UI install mode '$mode' (expected activate or stage)" >&2
    return 2
  fi
  mkdir -p "$webbase" || return 1
  # Stage the extract in web-$tag.new and swap it into place only once it's verified-good, so a
  # fetch-ok-then-extract-fail on a SAME-tag redeploy can't destroy the currently-serving web-$tag. Each step
  # that must hold before the destructive `rm -rf web-$tag` gets an explicit `|| return 1`: callers may enter
  # through a guarded install branch, which SUSPENDS set -e for this whole body (see verify_sums), so a bare
  # `test -f`/`tar` failure would otherwise fall straight through to the rm+mv and swap an EMPTY dir into place
  # while returning success — silently breaking the buy UI. The activate stays an atomic ln -sfn.
  local staging="$webbase/web-$tag.new"
  test -f "$staged/web/index.html" || return 1
  rm -rf "${staging:?}" || return 1
  mv "$staged/web" "$staging" || return 1
  rm -rf "${webbase:?}/web-$tag" || return 1
  mv "$staging" "$webbase/web-$tag" || return 1
  if [ "$mode" = activate ]; then
    ln -sfn "web-$tag" "$webbase/current-web" || return 1   # atomic activate (relative target)
    echo "    client UI $tag activated ($webbase/current-web -> web-$tag)"
  else
    echo "    client UI $tag staged ($webbase/web-$tag); activation deferred"
  fi
}

install_client_ui() {  # $1=tag $2=webbase $3=mode $4=optional shared manifest, convenience wrapper
  local tag="$1" webbase="$2" mode="${3:-activate}" manifest="${4:-}" tmp
  tmp="$(mktemp -d)" || return 1
  if ! stage_client_ui "$tag" "$tmp" "$manifest"; then rm -rf "$tmp"; return 1; fi
  if ! activate_client_ui_assets "$tag" "$tmp" "$webbase" "$mode"; then rm -rf "$tmp"; return 1; fi
  rm -rf "$tmp" || return 1
}

install_bootstrap_release() {  # $1=tag $2=staging root $3=webbase $4=shared manifest
  # Fresh setup has no rollback baseline, so its safety rule is simple: checksum-verify and extract BOTH
  # binaries and UI before either live pointer can move. Pointer activation can still be interrupted between
  # files; setup's preflight admits only that exact same-target partial state and this function repairs it.
  local tag="$1" staged="$2" webbase="$3" manifest="$4"
  rm -rf "$staged" || return 1
  mkdir -p "$staged" || return 1
  stage_binary_assets "$tag" "$staged/binaries" "$manifest" || return 1
  stage_client_ui "$tag" "$staged/ui" "$manifest" || return 1
  activate_binary_assets "$tag" "$staged/binaries" || return 1
  activate_client_ui_assets "$tag" "$staged/ui" "$webbase" activate || return 1
}

env_val() { grep -E "^$1=" "${ENV_FILE:-/etc/nullsink.env}" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
proxy_port()    { local p; p="$(env_val PORT)";          echo "${p:-8080}"; }
payments_port() { local p; p="$(env_val PAYMENTS_PORT)"; echo "${p:-8081}"; }

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

health_ok_version() {  # $1=port $2=expected release tag — reject a healthy OLD process after a no-op restart
  local port="$1" expected="$2" waited=0 body
  while [ "$waited" -lt "${HEALTH_TIMEOUT:-60}" ]; do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/healthz" 2>/dev/null)" || body=""
    if [ "$body" = "ok $expected" ]; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

health_ok_app_version() {  # BOTH newly started services must identify as the requested release.
  health_ok_version "$(proxy_port)" "$1" && health_ok_version "$(payments_port)" "$1"
}
