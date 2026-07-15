#!/usr/bin/env bash
# Health-gated redeploy for an EXISTING box (use setup.sh for the first bootstrap). Binary-only: fetches +
# verifies a release TAG's assets (the two service binaries, nsk, deploy tarball, UI), activates the service
# binaries, reinstalls units + Caddy edge so the box can't drift, restarts both app services, waits for each
# /healthz with the requested version, then activates the staged UI. Any activation failure restores the
# complete previous release before restarting it. Records the live version in $APP_DIR/REVISION.
# Run as root:
#   sudo /tmp/target/deploy/deploy.sh v0.3.0 /tmp/release/SHA256SUMS
# Only the app services are restarted; the rail daemons' unit files are refreshed (drift closure) but left
# running — a redeploy WARNS when an enabled daemon's unit changed so you can restart it on your schedule.
# Timers are reconciled too (status-check, backup).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nullsink}"
ENV_FILE="${ENV_FILE:-/etc/nullsink.env}"
WEB_BASE="${WEB_BASE:-/var/www/nullsink}"   # base for the versioned client UI ($WEB_BASE/web-<tag> + current-web)
REF="${1:-}"                              # release tag to deploy (vX.Y.Z) — required; the box is binary-only
RELEASE_MANIFEST="${2:-}"                 # exact manifest snapshot that authorized this target deploy bundle
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"    # seconds to wait for EACH service's /healthz before declaring failure
DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# install_units() + health_ok() + the PROXY_UNIT/PAYMENTS_UNIT names live here — the shared "apply repo
# config" library, so the unit-install glob is the single source of truth for both this script and setup.sh.
# Sourced after APP_DIR/ENV_FILE (env_val reads ENV_FILE).
# shellcheck source=deploy/lib.sh
source "$DEPLOY_SCRIPT_DIR/lib.sh"
# shellcheck source=deploy/deploy-transaction.sh
source "$DEPLOY_SCRIPT_DIR/deploy-transaction.sh"
# shellcheck source=deploy/maintenance-lock.sh
source "$DEPLOY_SCRIPT_DIR/maintenance-lock.sh"
# shellcheck source=deploy/deploy-guard.sh
source "$DEPLOY_SCRIPT_DIR/deploy-guard.sh"

configured_domain() {
  grep -E '^NULLSINK_DOMAIN=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

validate_caddy_config() {  # $1=candidate; a box with no public domain intentionally has no active edge
  local candidate="$1" domain
  domain="$(configured_domain)"
  [ -n "$domain" ] || return 0
  command -v caddy >/dev/null || { echo "!! NULLSINK_DOMAIN is set but caddy is not installed" >&2; return 1; }
  NULLSINK_DOMAIN="$domain" caddy validate --adapter caddyfile --config "$candidate" >/dev/null 2>&1 || {
    echo "!! staged Caddyfile failed validation — refusing to alter the live edge" >&2
    return 1
  }
}

sync_caddy() {  # validate the repo candidate BEFORE replacing/reloading the live edge
  # The Caddyfile is a {$NULLSINK_DOMAIN} template. The running caddy.service already has that env (from the
  # caddy.service.d drop-in setup.sh wrote), but this ad-hoc `caddy validate` is a separate process that does
  # NOT — so pass the domain in, or validation sees an empty site address and fails. reload (not restart) is
  # correct on a redeploy: the domain is unchanged, and reload re-resolves {$VAR} from the running env.
  local candidate="$APP_DIR/deploy/Caddyfile" domain
  domain="$(configured_domain)"
  [ -n "$domain" ] || return 0
  validate_caddy_config "$candidate" || return 1
  cp "$candidate" /etc/caddy/Caddyfile || return 1
  systemctl reload caddy || return 1
}
# Install the non-running repo config. Timers are deliberately enabled only after both new services pass
# health, so Persistent=true cannot launch a backup script from a half-activated deploy tree.
apply_repo_config() {
  install_units || return 1
  enable_app_units || return 1
  sync_caddy || return 1
}
record() {  # atomic REVISION update; a failure is still inside the rollback transaction
  local tmp="$APP_DIR/.REVISION.new"
  printf '%s  %s%s\n' "$1" "$(date -u +%FT%TZ)" "${2:-}" > "$tmp" || return 1
  mv -f "$tmp" "$APP_DIR/REVISION" || return 1
}

# Rail daemons (bitcoind, monero-wallet-rpc) are deliberately NOT bounced by a redeploy — restarting a node
# mid-sync is disruptive. But silently refreshing a daemon's unit FILE while it keeps running the old one is a
# footgun, so when a redeploy actually CHANGES an enabled daemon's unit, tell the operator to restart it on
# their schedule. Call BEFORE install_units overwrites /etc/systemd/system (compares the live unit vs the new tree).
warn_changed_daemons() {
  local u live new
  for u in monero-wallet-rpc bitcoind; do
    live="/etc/systemd/system/$u.service"; new="$APP_DIR/deploy/$u.service"
    [ -f "$new" ] || continue
    systemctl is-enabled --quiet "$u" 2>/dev/null || continue   # only matters for a daemon that's actually in use
    if [ -f "$live" ] && ! cmp -s "$live" "$new"; then
      echo "!! $u.service changed in $REF but the daemon was left running the OLD unit — restart on your schedule: systemctl restart $u" >&2
    fi
  done
}

# Transaction state. deploy.sh is a one-shot process, so globals make the callback contract in
# deploy-transaction.sh easy to fault-test while keeping the live implementation readable.
TXN_ACTIVE=0
TXN_ROOT=""
WEB_TXN_ROOT=""
TXN_PREV_PROXY=""
TXN_PREV_PAY=""
TXN_PREV_WEB=""
TXN_PREV_TAG=""
TXN_PREV_PROXY_PATH=""
TXN_PREV_PAY_PATH=""
TXN_NSK_PRESENT=0
TXN_REVISION_PRESENT=0
TXN_OLD_TREE_MOVED=0
TXN_WEB_REPLACED=0
TXN_NEW_WEB_INSTALLED=0
TXN_CADDY_TOUCHED=0

target_path() {  # $1=base directory, $2=readlink target
  case "$2" in /*) printf '%s\n' "$2" ;; *) printf '%s/%s\n' "$1" "$2" ;; esac
}

# --- Concrete staging callbacks: every release fetch/verify/extract completes before TXN_ACTIVE is armed. ---
# Preserve the exact manifest that authorized the target deploy bundle. Every artifact below is checked
# against this same snapshot, so a mutable release cannot splice deployer A together with assets B.
deploy_stage_manifest() {
  mkdir -p "$TXN_ROOT/release" || return 1
  cp -p "$RELEASE_MANIFEST" "$TXN_ROOT/release/SHA256SUMS" || return 1
  chmod a-w "$TXN_ROOT/release/SHA256SUMS" || return 1
}
deploy_stage_ui() { stage_client_ui "$REF" "$WEB_TXN_ROOT/ui" "$TXN_ROOT/release/SHA256SUMS"; }
deploy_stage_binaries() { stage_binary_assets "$REF" "$TXN_ROOT/binaries" "$TXN_ROOT/release/SHA256SUMS"; }
deploy_stage_nsk() {
  [ "$TXN_NSK_PRESENT" -eq 1 ] || return 0
  stage_nsk_asset "$REF" "$TXN_ROOT/nsk" "$TXN_ROOT/release/SHA256SUMS"
}
deploy_stage_tree() {
  stage_deploy_tree "$REF" "$TXN_ROOT/deploy" "$TXN_ROOT/release/SHA256SUMS" || return 1
  validate_caddy_config "$TXN_ROOT/deploy/tree/deploy/Caddyfile" || return 1
}

# --- Concrete activation callbacks: any non-zero result flows through deploy_rollback exactly once. ---
deploy_prepare_guard() {
  install_deploy_guard_dropins || return 1
  deploy_arm_guard "$REF" || return 1
}
deploy_quiesce() {
  systemctl stop status-check.timer || return 1
  systemctl stop backup.timer || return 1
  # Stopping a timer does not stop a one-shot it already launched. Drain those DB-reading/writing jobs before
  # stopping the app or changing the deploy scripts beneath them.
  systemctl stop status-check.service || return 1
  systemctl stop backup.service || return 1
  systemctl stop "$PAYMENTS_UNIT" || return 1
  systemctl stop "$PROXY_UNIT" || return 1
}
deploy_activate_binaries() { activate_binary_assets "$REF" "$TXN_ROOT/binaries"; }
deploy_activate_nsk() {
  [ "$TXN_NSK_PRESENT" -eq 1 ] || return 0
  activate_nsk_asset "$TXN_ROOT/nsk"
}
deploy_activate_tree() {
  # Mark each attempted rename first. A signal can arrive between any command and the next assignment; rollback
  # therefore combines these intent flags with filesystem evidence instead of trusting a post-mutation flag.
  TXN_OLD_TREE_MOVED=1
  mv "$APP_DIR/deploy" "$TXN_ROOT/previous-deploy" || { TXN_OLD_TREE_MOVED=0; return 1; }
  mv "$TXN_ROOT/deploy/tree/deploy" "$APP_DIR/deploy" || return 1
}
deploy_apply_config() {
  warn_changed_daemons
  apply_repo_config
}
# The UI flips while the durable guard still blocks both app services. At the following commit boundary the
# binaries, pointers, deploy tree, units, Caddy config, AND browser UI are one target release. Disarming then
# flushes every touched filesystem before marker deletion, so a crash is either gated on an incomplete
# transaction or boots a complete target set—never target backends with an unrecoverable old-UI baseline.
deploy_activate_ui() {
  local final="$WEB_BASE/web-$REF"
  if [ -e "$final" ] || [ -L "$final" ]; then
    TXN_WEB_REPLACED=1
    mv "$final" "$WEB_TXN_ROOT/replaced-web" || { TXN_WEB_REPLACED=0; return 1; }
  fi
  TXN_NEW_WEB_INSTALLED=1
  mv "$WEB_TXN_ROOT/ui/web" "$final" || return 1
  ln -sfn "web-$REF" "$WEB_BASE/current-web" || return 1
}
deploy_commit_backend() { deploy_disarm_guard; }
deploy_restart_new() { restart_app; }
deploy_health_new() { health_ok_app_version "$REF"; }
deploy_enable_timers() { enable_timers; }
deploy_record_success() {
  record "$REF" "  (proxy nullsink-proxy-$REF, payments nullsink-payments-$REF, UI web-$REF)"
}

snapshot_live_config() {  # exact files the new tree may overwrite; required before rollback is armed
  local source="$TXN_ROOT/deploy/tree/deploy" snapshot="$TXN_ROOT/previous-config" f base domain
  mkdir -p "$snapshot/systemd" || return 1
  : > "$snapshot/missing-systemd" || return 1
  for f in "$source"/*.service "$source"/*.timer; do
    [ -f "$f" ] || { echo "!! staged deploy tree has no complete unit/timer set" >&2; return 1; }
    base="$(basename "$f")"
    if [ -e "/etc/systemd/system/$base" ] || [ -L "/etc/systemd/system/$base" ]; then
      cp -a "/etc/systemd/system/$base" "$snapshot/systemd/$base" || return 1
    else
      printf '%s\n' "$base" >> "$snapshot/missing-systemd" || return 1
    fi
  done
  domain="$(configured_domain)"
  if [ -n "$domain" ]; then
    [ -f /etc/caddy/Caddyfile ] || {
      echo "!! NULLSINK_DOMAIN is set but there is no live Caddyfile to roll back to" >&2
      return 1
    }
    cp -a /etc/caddy/Caddyfile "$snapshot/Caddyfile" || return 1
    TXN_CADDY_TOUCHED=1
  fi
}

restore_live_config() {  # restore exact pre-deploy files, including removal of units introduced by the tag
  local snapshot="$TXN_ROOT/previous-config" f base
  [ -d "$snapshot/systemd" ] && [ -f "$snapshot/missing-systemd" ] || return 1
  for f in "$snapshot/systemd"/*; do
    [ -e "$f" ] || continue
    cp -a "$f" "/etc/systemd/system/$(basename "$f")" || return 1
  done
  while IFS= read -r base; do
    [ -n "$base" ] || continue
    rm -f "/etc/systemd/system/$base" || return 1
  done < "$snapshot/missing-systemd"
  systemctl daemon-reload || return 1
  if [ "$TXN_CADDY_TOUCHED" -eq 1 ]; then
    cp -a "$snapshot/Caddyfile" /etc/caddy/Caddyfile || return 1
    systemctl reload caddy || return 1
  fi
}

deploy_rollback() {  # $1=failed activation step; attempts every restoration, restarts only when complete
  # This must be the first operation: an activation-time signal must not open a recursive EXIT/rollback gap
  # before the recovery children inherit an ignored signal disposition.
  begin_deploy_rollback
  local failed_step="$1" ok=1 failed_tree="$TXN_ROOT/failed-deploy" final="$WEB_BASE/web-$REF" final_status
  TXN_ACTIVE=0
  set +e
  echo "!! deploy failed at $failed_step — restoring the complete previous release" >&2

  # Forward activation removes the guard only after the backend/config set is internally complete. Re-arm it
  # before the first rollback mutation; if that cannot be made durable, leave the consistent target bytes in
  # place for manual recovery rather than risk a power loss halfway through an unguarded rollback.
  if ! deploy_arm_guard "rollback after $failed_step"; then
    echo "!! could not arm the durable deploy guard — refusing unsafe automatic rollback" >&2
    echo "!! app state was left for manual recovery in $TXN_ROOT and $WEB_TXN_ROOT" >&2
    set -e
    finish_deploy_rollback 1 || true
    return 1
  fi

  systemctl stop status-check.timer >/dev/null 2>&1 || ok=0
  systemctl stop backup.timer >/dev/null 2>&1 || ok=0
  systemctl stop status-check.service >/dev/null 2>&1 || ok=0
  systemctl stop backup.service >/dev/null 2>&1 || ok=0
  systemctl stop "$PAYMENTS_UNIT" >/dev/null 2>&1 || ok=0
  systemctl stop "$PROXY_UNIT" >/dev/null 2>&1 || ok=0

  # Restore the UI directory before its pointer. This also covers a same-tag redeploy, where web-$REF was
  # the previously served directory rather than a harmless inactive version.
  if [ "$TXN_NEW_WEB_INSTALLED" -eq 1 ] && { [ -e "$final" ] || [ -L "$final" ]; }; then
    mv "$final" "$WEB_TXN_ROOT/failed-web" || ok=0
  fi
  if [ "$TXN_WEB_REPLACED" -eq 1 ] && [ -e "$WEB_TXN_ROOT/replaced-web" ]; then
    mv "$WEB_TXN_ROOT/replaced-web" "$final" || ok=0
  fi
  if [ -n "$TXN_PREV_WEB" ]; then
    ln -sfn "$TXN_PREV_WEB" "$WEB_BASE/current-web" || ok=0
  else
    rm -f "$WEB_BASE/current-web" || ok=0
  fi

  # Put the old deploy tree back before reinstalling any config derived from it. Keep the failed tree in the
  # transaction directory so newly introduced unit files can be removed exactly.
  if [ "$TXN_OLD_TREE_MOVED" -eq 1 ]; then
    if [ -d "$TXN_ROOT/previous-deploy" ]; then
      if [ -d "$APP_DIR/deploy" ] || [ -L "$APP_DIR/deploy" ]; then
        mv "$APP_DIR/deploy" "$failed_tree" || ok=0
      fi
      mv "$TXN_ROOT/previous-deploy" "$APP_DIR/deploy" || ok=0
    elif [ ! -d "$APP_DIR/deploy" ]; then
      ok=0
    fi
  fi

  # Restore bytes as well as pointers: on a same-tag redeploy the destination filename is identical and was
  # overwritten during activation, so merely re-pointing the symlink would not restore the old release.
  cp -p "$TXN_ROOT/previous-proxy-bin" "$TXN_PREV_PROXY_PATH" || ok=0
  cp -p "$TXN_ROOT/previous-payments-bin" "$TXN_PREV_PAY_PATH" || ok=0
  ln -sfn "$TXN_PREV_PROXY" /usr/local/lib/nullsink/current-proxy || ok=0
  ln -sfn "$TXN_PREV_PAY" /usr/local/lib/nullsink/current-payments || ok=0
  if [ "$TXN_NSK_PRESENT" -eq 1 ]; then cp -p "$TXN_ROOT/previous-nsk" /usr/local/bin/nsk || ok=0; fi
  if [ "$TXN_REVISION_PRESENT" -eq 1 ]; then
    cp -p "$TXN_ROOT/previous-REVISION" "$APP_DIR/REVISION" || ok=0
  else
    rm -f "$APP_DIR/REVISION" || ok=0
  fi

  [ -d "$APP_DIR/deploy" ] || ok=0
  restore_live_config || ok=0

  # Do not launch old binaries through uncertain unit/Caddy state. If restoration is complete, prove the old
  # pair healthy before re-enabling scripts that act on its databases.
  if [ "$ok" -eq 1 ]; then
    deploy_disarm_guard || ok=0
    if [ "$ok" -eq 1 ]; then restart_app || ok=0; fi
    if [ "$ok" -eq 1 ]; then health_ok_app_version "$TXN_PREV_TAG" || ok=0; fi
    if [ "$ok" -eq 1 ]; then enable_timers || ok=0; fi
  fi

  # If old-service restart/health/timer recovery failed after disarming, gate the next boot again and stop
  # both app services. The bytes are one old release, but automatic restart into an unverified recovery is
  # not a safe success state.
  if [ "$ok" -ne 1 ]; then
    deploy_arm_guard "incomplete rollback after $failed_step" >/dev/null 2>&1 || true
    systemctl stop "$PAYMENTS_UNIT" >/dev/null 2>&1 || true
    systemctl stop "$PROXY_UNIT" >/dev/null 2>&1 || true
  fi

  if [ "$ok" -eq 1 ]; then
    echo "!! rollback complete and healthy on $TXN_PREV_TAG: $TXN_PREV_PROXY + $TXN_PREV_PAY + $TXN_PREV_WEB" >&2
    rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT" >/dev/null 2>&1 || true
    set -e
    final_status=0
  else
    echo "!! ROLLBACK INCOMPLETE — app services/timers remain stopped; recover from $TXN_ROOT and $WEB_TXN_ROOT" >&2
    set -e
    final_status=1
  fi
  finish_deploy_rollback "$final_status"
}

deploy_exit_guard() {
  local status=$?
  if [ "$TXN_ACTIVE" -eq 1 ]; then
    trap - EXIT
    deploy_rollback "unexpected_exit_${status}" || true
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}

deploy_binary() {  # stage every asset, snapshot rollback state, then enter the activation transaction
  local prev_web_path activation_status=0
  mkdir -p "$APP_DIR" "$WEB_BASE" || return 1
  TXN_ROOT="$(mktemp -d "$APP_DIR/.deploy-txn-$REF.XXXXXX")" || return 1
  WEB_TXN_ROOT="$(mktemp -d "$WEB_BASE/.deploy-ui-$REF.XXXXXX")" || { rm -rf "$TXN_ROOT"; return 1; }
  TXN_PREV_PROXY="$(readlink /usr/local/lib/nullsink/current-proxy 2>/dev/null || true)"
  TXN_PREV_PAY="$(readlink /usr/local/lib/nullsink/current-payments 2>/dev/null || true)"
  TXN_PREV_WEB="$(readlink "$WEB_BASE/current-web" 2>/dev/null || true)"
  TXN_PREV_TAG="$(matching_release_tag "$TXN_PREV_PROXY" "$TXN_PREV_PAY" "$TXN_PREV_WEB" || true)"
  echo ">>> Staging $REF (proxy ${TXN_PREV_PROXY:-none}, payments ${TXN_PREV_PAY:-none}, UI ${TXN_PREV_WEB:-none})"

  # Redeploy is intentionally not bootstrap. The three live pointers must name ONE release; accepting three
  # merely non-empty targets could make rollback deliberately recreate a mixed wire/UI contract.
  [ -n "$TXN_PREV_TAG" ] && [ -d "$APP_DIR/deploy" ] || {
    echo "!! previous proxy + payments + UI do not name one matching release — use setup.sh for bootstrap/repair" >&2
    rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT"
    return 1
  }
  TXN_PREV_PROXY_PATH="$(target_path /usr/local/lib/nullsink "$TXN_PREV_PROXY")"
  TXN_PREV_PAY_PATH="$(target_path /usr/local/lib/nullsink "$TXN_PREV_PAY")"
  prev_web_path="$(target_path "$WEB_BASE" "$TXN_PREV_WEB")"
  [ -x "$TXN_PREV_PROXY_PATH" ] && [ -x "$TXN_PREV_PAY_PATH" ] &&
    [ -d "$prev_web_path" ] && [ -r "$prev_web_path/index.html" ] || {
    echo "!! previous release pointers are incomplete/dangling — refusing a non-recoverable deploy" >&2
    rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT"
    return 1
  }
  TXN_NSK_PRESENT=0; [ -x /usr/local/bin/nsk ] && TXN_NSK_PRESENT=1

  if ! run_deploy_staging; then
    echo "!! release assets failed to stage — live release was not touched" >&2
    rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT"
    return 1
  fi

  # Snapshot mutable same-tag destinations before arming rollback. These copies are also proof that every
  # path required to recover is readable before the first service/timer is stopped.
  if ! cp -p "$TXN_PREV_PROXY_PATH" "$TXN_ROOT/previous-proxy-bin" ||
     ! cp -p "$TXN_PREV_PAY_PATH" "$TXN_ROOT/previous-payments-bin"; then
    rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT"
    return 1
  fi
  if [ "$TXN_NSK_PRESENT" -eq 1 ] && ! cp -p /usr/local/bin/nsk "$TXN_ROOT/previous-nsk"; then
    rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT"
    return 1
  fi
  if [ -f "$APP_DIR/REVISION" ]; then
    if ! cp -p "$APP_DIR/REVISION" "$TXN_ROOT/previous-REVISION"; then
      rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT"
      return 1
    fi
    TXN_REVISION_PRESENT=1
  fi
  if ! snapshot_live_config; then
    rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT"
    return 1
  fi

  TXN_ACTIVE=1
  trap deploy_exit_guard EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  run_deploy_activation || activation_status=$?
  if [ "$activation_status" -ne 0 ]; then
    trap - EXIT INT TERM
    return "$activation_status"
  fi

  # record_success is the final fallible operation. The complete target set became crash-durable before its
  # services restarted; cleanup and success output are now best-effort and cannot trigger rollback.
  TXN_ACTIVE=0
  trap - EXIT INT TERM
  rm -rf "$TXN_ROOT" "$WEB_TXN_ROOT" >/dev/null 2>&1 || true
  echo ">>> OK — $PROXY_UNIT + $PAYMENTS_UNIT healthy on $REF; release activated as one durable set"
  return 0
}

require_target_deployer() {
  local running installed="$APP_DIR/deploy/deploy.sh"
  [ -e "$installed" ] || return 0
  running="$(realpath "$0" 2>/dev/null || true)"
  installed="$(realpath "$installed" 2>/dev/null || true)"
  if [ -n "$running" ] && [ "$running" = "$installed" ]; then
    echo "!! refusing to run the already-installed deployer for target $REF" >&2
    echo "!! an older deployer cannot provide the target release's rollback semantics." >&2
    echo "!! fetch + checksum-verify deploy-$REF.tar.gz, then run its extracted deploy/deploy.sh (see deploy/README.md)." >&2
    return 1
  fi
}

# Binary-only: a version tag is required. The box has no source tree or Bun to run from (source-free box),
# so there is no branch/fast-forward mode — recovery from a bad binary is the symlink rollback inside
# deploy_binary, or building a fixed release and re-running this.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi
if [ -z "$REF" ] || [ -z "$RELEASE_MANIFEST" ]; then
  echo "usage: <verified-target>/deploy/deploy.sh <vX.Y.Z> <verified-SHA256SUMS>" >&2
  exit 1
fi
if ! valid_release_tag "$REF"; then
  echo "!! '$REF' is not a version tag (expected vMAJOR.MINOR.PATCH[-PRERELEASE][+BUILD])." >&2
  exit 1
fi
[ -r "$RELEASE_MANIFEST" ] || { echo "!! verified manifest is unreadable: $RELEASE_MANIFEST" >&2; exit 1; }
require_target_deployer || exit 1
acquire_maintenance_lock "deploy $REF" || exit 1
deploy_binary   # exits within (health-gated, symlink rollback on failure)
