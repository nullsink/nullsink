#!/usr/bin/env bash
# Health-gated redeploy for an EXISTING box (use setup.sh for the first bootstrap). Binary-only: fetches +
# verifies a release TAG's assets (three service binaries, optional nsk, deploy tarball, UI), atomically
# activates them, reinstalls units + Caddy edge so the box can't drift, restarts the app, waits for ledger
# readiness and both /healthz endpoints, and ROLLS BACK binaries + UI if unhealthy.
# Run as root:
#   sudo deploy/deploy.sh v0.3.0     # deploy a release tag (the only mode — no source/Bun on the box)
# Only the app services are restarted; the rail daemons' unit files are refreshed (drift closure) but left
# running — a redeploy WARNS when an enabled daemon's unit changed so you can restart it on your schedule.
# Timers are reconciled too (status-check, backup).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nullsink}"
PROXY_ENV_FILE="${PROXY_ENV_FILE:-/etc/nullsink-proxy.env}"
PAYMENTS_ENV_FILE="${PAYMENTS_ENV_FILE:-/etc/nullsink-payments.env}"
MONITOR_ENV_FILE="${MONITOR_ENV_FILE:-/etc/nullsink-monitor.env}"
WEB_BASE="${WEB_BASE:-/var/www/nullsink}"   # base for the versioned client UI ($WEB_BASE/web-<tag> + current-web)
REF="${1:-}"                              # release tag to deploy (vX.Y.Z) — required; the box is binary-only
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"    # seconds to wait for EACH service's /healthz before declaring failure

# install_units() + health_ok() + the LEDGER_UNIT/PROXY_UNIT/PAYMENTS_UNIT names live here — the shared "apply repo
# config" library, so the unit-install glob is the single source of truth for both this script and setup.sh.
# Sourced after APP_DIR and the role-specific env paths.
# shellcheck source=deploy/lib.sh
source "$(dirname "$0")/lib.sh"

sync_caddy() {  # validate a staged edge config before atomically replacing the live file
  # The Caddyfile is a {$NULLSINK_DOMAIN} template. The running caddy.service already has that env (from the
  # caddy.service.d drop-in setup.sh wrote), but this ad-hoc `caddy validate` is a separate process that does
  # NOT — so pass the domain in, or validation sees an empty site address and fails. reload (not restart) is
  # correct on a redeploy: the domain is unchanged, and reload re-resolves {$VAR} from the running env.
  local domain candidate
  domain="$(grep -E '^NULLSINK_DOMAIN=' "$MONITOR_ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  candidate="$(mktemp /etc/caddy/.Caddyfile.nullsink.XXXXXX)"
  if ! install -o root -g root -m 0644 "$APP_DIR/deploy/Caddyfile" "$candidate"; then
    rm -f -- "$candidate"
    return 1
  fi
  if ! NULLSINK_DOMAIN="$domain" caddy validate --adapter caddyfile --config "$candidate" >/dev/null 2>&1; then
    rm -f -- "$candidate"
    echo "!! candidate Caddyfile failed validation — live configuration was not changed" >&2
    return 1
  fi
  if ! mv -f -- "$candidate" /etc/caddy/Caddyfile; then
    rm -f -- "$candidate"
    return 1
  fi
  # The one-time ledger cutover deliberately keeps Caddy stopped until all three new units pass health.
  # Install its validated config now, but only reload an already-active edge.
  if systemctl is-active --quiet caddy 2>/dev/null; then systemctl reload caddy; fi
}
# Everything the box derives from the repo except timers. The timers stay suspended until the refreshed
# services pass their health gate, so neither root one-shot can execute across a mixed old/new layout.
apply_repo_config() { install_units; enable_app_units; sync_caddy; }
record() { printf '%s  %s%s\n' "$1" "$(date -u +%FT%TZ)" "${2:-}" > "$APP_DIR/REVISION"; }

CUTOVER_ROLLBACK_ARMED=0
CUTOVER_PREV_WEB=""
CUTOVER_PREV_NSK=""
CUTOVER_MIGRATION=""

rollback_initial_cutover() {
  [ "$CUTOVER_ROLLBACK_ARMED" -eq 1 ] || return 0
  [ -z "$CUTOVER_PREV_WEB" ] \
    || ln -sfn "$CUTOVER_PREV_WEB" "$WEB_BASE/current-web" \
    || return 1
  [ -z "$CUTOVER_PREV_NSK" ] \
    || ln -sfn "$CUTOVER_PREV_NSK" /usr/local/lib/nullsink/current-nsk \
    || return 1
  if [ -x "$CUTOVER_MIGRATION" ] && "$CUTOVER_MIGRATION" --rollback; then
    CUTOVER_ROLLBACK_ARMED=0
    if health_ok_legacy_app; then
      record "$REF" "  (ROLLED BACK before ledger activation)"
      echo "!! pre-traffic cutover rolled back; old two-service topology is healthy" >&2
      return 0
    fi
    record "$REF" "  (PRE-TRAFFIC ROLLBACK UNHEALTHY)"
    echo "!! old topology rollback is unhealthy — inspect $PROXY_UNIT + $PAYMENTS_UNIT" >&2
    return 1
  fi
  echo "!! automatic pre-traffic rollback failed — run $CUTOVER_MIGRATION --rollback" >&2
  return 1
}

# shellcheck disable=SC2329 # invoked indirectly by `trap ... EXIT` during a suspended deploy
restore_deploy_on_exit() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$CUTOVER_ROLLBACK_ARMED" -eq 1 ]; then
    if [ -f /etc/nullsink-ledger-extraction.activated ]; then
      record "$REF" "  (LEDGER ACTIVATED; DEPLOY INCOMPLETE — inspect Caddy and logs)"
      echo "!! ledger activation crossed the public-admission boundary; refusing an unsafe automatic rollback" >&2
    else
      rollback_initial_cutover || true
    fi
  fi
  restore_control_timers || true
  exit "$status"
}

# The app-local Monero watcher is deliberately not bounced by a redeploy. If its unit changes, tell the
# operator to restart it deliberately after the app deployment. Bitcoin Core lives on the node box and is
# neither shipped nor managed here.
warn_changed_daemons() {
  local u="monero-wallet-rpc" live new
  live="/etc/systemd/system/$u.service"
  new="$APP_DIR/deploy/$u.service"
  [ -f "$new" ] || return 0
  systemctl is-enabled --quiet "$u" 2>/dev/null || return 0
  if [ -f "$live" ] && ! cmp -s "$live" "$new"; then
    echo "!! $u.service changed in $REF but the daemon was left running the OLD unit — restart on your schedule: systemctl restart $u" >&2
  fi
}

deploy_binary() {  # binary mode: fetch+verify+swap all service binaries + UI, health-gated
  local prev_ledger prev_proxy prev_pay prev_nsk new_ledger new_proxy new_pay prev_web new_web initial_cutover=0
  prev_ledger="$(readlink /usr/local/lib/nullsink/current-ledger 2>/dev/null || true)"
  prev_proxy="$(readlink /usr/local/lib/nullsink/current-proxy 2>/dev/null || true)"       # for rollback
  prev_pay="$(readlink /usr/local/lib/nullsink/current-payments 2>/dev/null || true)"
  prev_nsk="$(readlink /usr/local/lib/nullsink/current-nsk 2>/dev/null || true)"
  prev_web="$(readlink "$WEB_BASE/current-web" 2>/dev/null || true)"                       # roll the UI back in lockstep
  echo ">>> Deploying $REF  (ledger was ${prev_ledger:-none}, proxy was ${prev_proxy:-none}, payments was ${prev_pay:-none}, UI was ${prev_web:-none})"
  if [ ! -f /etc/nullsink-service-isolation.prepared ]; then
    echo "!! service isolation is not prepared; no release artifact, unit, or service was changed" >&2
    echo "!! Review and run: $APP_DIR/deploy/migrate-service-isolation.sh --prepare" >&2
    echo "!! Then rerun this exact deploy command. The old services remain live on the legacy layout." >&2
    exit 1
  fi
  if [ ! -f /etc/nullsink-ledger-extraction.prepared ]; then
    echo "!! ledger extraction is not prepared; no release artifact, unit, or service was changed" >&2
    echo "!! Verify this release's deploy bundle, run migrate-ledger-service.sh --prepare from it," >&2
    echo "!! then run that same verified bundle's deploy.sh $REF (not the older live deploy script)." >&2
    exit 1
  fi
  [ -f /etc/nullsink-ledger-extraction.activated ] || initial_cutover=1
  if [ "$initial_cutover" -eq 1 ]; then
    CUTOVER_ROLLBACK_ARMED=1
    CUTOVER_PREV_WEB="$prev_web"
    CUTOVER_PREV_NSK="$prev_nsk"
    CUTOVER_MIGRATION="$(dirname "$0")/migrate-ledger-service.sh"
    [ -x "$CUTOVER_MIGRATION" ] || { echo "!! verified ledger migration script is missing" >&2; exit 1; }
    "$CUTOVER_MIGRATION" --validate
  fi
  trap restore_deploy_on_exit EXIT
  suspend_control_timers                  # drain root one-shots before any release activation begins
  install_binary "$REF"                  # fetch+verify+activate current-{ledger,proxy,payments}
  install_deploy_tree "$REF" "$APP_DIR"  # atomically refresh deploy/ (units + scripts + Caddyfile)
  if [ -x /usr/local/bin/nsk ]; then install_nsk "$REF"; fi
  # UI is non-fatal: /healthz tests the BINARIES, which serve fine with a stale UI, so a UI fetch hiccup must not
  # abort (and half-apply) a binary deploy. Activate it; the health gate below still judges the binaries.
  if install_client_ui "$REF" "$WEB_BASE"; then   # fetch+verify+activate $WEB_BASE/current-web -> web-$REF
    new_web="$(readlink "$WEB_BASE/current-web" 2>/dev/null || true)"
  else
    echo "!! client UI $REF failed to install — proceeding on the binaries; UI left at ${prev_web:-current state}" >&2
    new_web="${prev_web:-unchanged}"
  fi
  new_ledger="$(readlink /usr/local/lib/nullsink/current-ledger 2>/dev/null || true)"
  new_proxy="$(readlink /usr/local/lib/nullsink/current-proxy 2>/dev/null || true)"
  new_pay="$(readlink /usr/local/lib/nullsink/current-payments 2>/dev/null || true)"
  warn_changed_daemons                   # flag (don't bounce) an enabled rail daemon whose unit changed — before the overwrite below
  apply_repo_config                      # refresh units + edge from the now-current deploy/; timers remain stopped
  restart_isolation_sidecars             # one-time uid transition only; finalized boxes retain the no-bounce policy
  if [ "$initial_cutover" -eq 1 ]; then
    # Close the download/configuration window: the prepared DB and stopped financial state must still match the
    # manifest at the last possible point before any new service can open the ledger or mutate pending.db.
    "$CUTOVER_MIGRATION" --validate
  fi
  restart_app                            # one ordered ledger/proxy/payments transaction

  if health_ok_app; then
    if [ "$initial_cutover" -eq 1 ]; then
      "$APP_DIR/deploy/migrate-ledger-service.sh" --activate
      CUTOVER_ROLLBACK_ARMED=0
    fi
    enable_timers                        # only the healthy, fully aligned release may resume the root one-shots
    trap - EXIT
    record "$REF" "  (ledger $new_ledger, proxy $new_proxy, payments $new_pay, UI $new_web)"
    echo ">>> OK — $LEDGER_UNIT + $PROXY_UNIT + $PAYMENTS_UNIT healthy on $REF"
    exit 0
  fi

  # Roll every service and the UI together. During the first cutover Caddy is still stopped, so failure can
  # restore the frozen two-service topology before any public request reaches the new ledger.
  echo "!! ledger readiness and/or app /healthz failed within ${HEALTH_TIMEOUT}s — rolling back" >&2
  if [ "$initial_cutover" -eq 1 ] && [ -n "$prev_proxy" ] && [ -n "$prev_pay" ]; then
    rollback_initial_cutover || true
  elif [ -n "$prev_ledger" ] && [ -n "$prev_proxy" ] && [ -n "$prev_pay" ]; then
    ln -sfn "$prev_ledger" /usr/local/lib/nullsink/current-ledger
    ln -sfn "$prev_proxy" /usr/local/lib/nullsink/current-proxy
    ln -sfn "$prev_pay" /usr/local/lib/nullsink/current-payments
    if [ -n "$prev_nsk" ]; then ln -sfn "$prev_nsk" /usr/local/lib/nullsink/current-nsk; fi
    if [ -n "$prev_web" ]; then
      ln -sfn "$prev_web" "$WEB_BASE/current-web"   # roll the UI back in lockstep with the binaries
    else
      # Only reachable if the FIRST versioned-UI install happened via deploy.sh — bootstrap goes through
      # setup.sh, which avoids this. Be honest rather than claim a lockstep we can't do.
      echo "!! no prior versioned UI to roll back to (first deploy) — UI stays at ${new_web}; verify it against the rolled-back binaries, or re-point $WEB_BASE/current-web by hand" >&2
    fi
    restart_app
    if health_ok_app; then
      record "$REF" "  (ROLLED BACK to ledger $prev_ledger + proxy $prev_proxy + payments $prev_pay, UI ${prev_web:-unchanged})"
      echo "!! rolled back all three services + UI (healthy) — $REF NOT applied" >&2
    else
      record "$REF" "  (ROLLBACK UNHEALTHY)"
      echo "!! ROLLBACK ALSO UNHEALTHY — manual intervention: journalctl -u $LEDGER_UNIT -u $PROXY_UNIT -u $PAYMENTS_UNIT" >&2
    fi
  else
    # No previous binaries on this box: there is nothing to flip back to — say so plainly instead of
    # half-restoring.
    record "$REF" "  (ROLLBACK IMPOSSIBLE — no previous binaries)"
    echo "!! no compatible previous topology to roll back to — diagnose: journalctl -u $LEDGER_UNIT -u $PROXY_UNIT -u $PAYMENTS_UNIT" >&2
  fi
  exit 1
}

# Binary-only: a version tag is required. The box has no source tree or Bun to run from (source-free box),
# so there is no branch/fast-forward mode — recovery from a bad binary is the symlink rollback inside
# deploy_binary, or building a fixed release and re-running this.
if [ -z "$REF" ]; then
  echo "usage: deploy/deploy.sh <vX.Y.Z>   (deploys a release tag; there is no source mode)" >&2
  exit 1
fi
if [[ ! "$REF" =~ ^v[0-9] ]]; then
  echo "!! '$REF' is not a version tag (expected vX.Y.Z). The box is binary-only; pass a release tag." >&2
  exit 1
fi
deploy_binary   # exits within (health-gated, symlink rollback on failure)
