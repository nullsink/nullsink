#!/usr/bin/env bash
# Health-gated redeploy for an EXISTING box (use setup.sh for the first bootstrap). Binary-only: fetches +
# verifies a release TAG's assets (the two service binaries, nsk, deploy tarball, UI), atomically activates
# them + the UI, reinstalls units + Caddy edge so the box can't drift, restarts both app services, waits for
# each /healthz, and ROLLS BACK binaries + UI if unhealthy. Records the live version in $APP_DIR/REVISION.
# Run as root:
#   sudo deploy/deploy.sh v0.3.0     # deploy a release tag (the only mode — no source/Bun on the box)
# Only the app services are restarted; the rail daemons' unit files are refreshed (drift closure) but left
# running — a redeploy WARNS when an enabled daemon's unit changed so you can restart it on your schedule.
# Timers are reconciled too (status-check, backup).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nullsink}"
ENV_FILE="${ENV_FILE:-/etc/nullsink.env}"
WEB_BASE="${WEB_BASE:-/var/www/nullsink}"   # base for the versioned client UI ($WEB_BASE/web-<tag> + current-web)
REF="${1:-}"                              # release tag to deploy (vX.Y.Z) — required; the box is binary-only
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"    # seconds to wait for EACH service's /healthz before declaring failure

# install_units() + health_ok() + the PROXY_UNIT/PAYMENTS_UNIT names live here — the shared "apply repo
# config" library, so the unit-install glob is the single source of truth for both this script and setup.sh.
# Sourced after APP_DIR/ENV_FILE (env_val reads ENV_FILE).
# shellcheck source=deploy/lib.sh
source "$(dirname "$0")/lib.sh"

sync_caddy() {  # refresh the Caddy edge config from the repo; validate first, reload only if valid
  cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
  # The Caddyfile is a {$NULLSINK_DOMAIN} template. The running caddy.service already has that env (from the
  # caddy.service.d drop-in setup.sh wrote), but this ad-hoc `caddy validate` is a separate process that does
  # NOT — so pass the domain in, or validation sees an empty site address and fails. reload (not restart) is
  # correct on a redeploy: the domain is unchanged, and reload re-resolves {$VAR} from the running env.
  local domain
  domain="$(grep -E '^NULLSINK_DOMAIN=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  if NULLSINK_DOMAIN="$domain" caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
  else
    echo "!! /etc/caddy/Caddyfile failed validation after refresh — left in place but NOT reloaded; fix it" >&2
  fi
}
# Everything the box derives from the repo (units + timers + edge).
apply_repo_config() { install_units; enable_app_units; enable_timers; sync_caddy; }
record() { printf '%s  %s%s\n' "$1" "$(date -u +%FT%TZ)" "${2:-}" > "$APP_DIR/REVISION"; }

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

deploy_binary() {  # binary mode (REF is a version tag): fetch+verify+swap both binaries + UI, health-gated
  # binary mode: fetch+verify+swap the two service binaries + the UI symlink, refresh units/edge (NO
  # git-checkout — the binaries ARE the app), restart both, roll every symlink back if unhealthy.
  local prev_proxy prev_pay new_proxy new_pay prev_web new_web
  prev_proxy="$(readlink /usr/local/lib/nullsink/current-proxy 2>/dev/null || true)"       # for rollback
  prev_pay="$(readlink /usr/local/lib/nullsink/current-payments 2>/dev/null || true)"
  prev_web="$(readlink "$WEB_BASE/current-web" 2>/dev/null || true)"                       # roll the UI back in lockstep
  echo ">>> Deploying $REF  (proxy was ${prev_proxy:-none}, payments was ${prev_pay:-none}, UI was ${prev_web:-none})"
  install_binary "$REF"                  # fetch+verify+activate both current-{proxy,payments} symlinks
  # nsk is an OPTIONAL operator CLI (install on demand: deploy/install-nsk.sh). Only refresh it here when it's
  # already installed, so it stays in lockstep with the server without being forced onto every box. Must be an
  # `if`, not `[ ... ] &&`: on a box without nsk that compound would exit 1 and abort the deploy under set -e.
  if [ -x /usr/local/bin/nsk ]; then install_nsk "$REF"; fi
  install_deploy_tree "$REF" "$APP_DIR"  # refresh deploy/ (units + scripts + Caddyfile) from the release
  # UI is non-fatal: /healthz tests the BINARIES, which serve fine with a stale UI, so a UI fetch hiccup must not
  # abort (and half-apply) a binary deploy. Activate it; the health gate below still judges the binaries.
  if install_client_ui "$REF" "$WEB_BASE"; then   # fetch+verify+activate $WEB_BASE/current-web -> web-$REF
    new_web="$(readlink "$WEB_BASE/current-web" 2>/dev/null || true)"
  else
    echo "!! client UI $REF failed to install — proceeding on the binaries; UI left at ${prev_web:-current state}" >&2
    new_web="${prev_web:-unchanged}"
  fi
  new_proxy="$(readlink /usr/local/lib/nullsink/current-proxy 2>/dev/null || true)"
  new_pay="$(readlink /usr/local/lib/nullsink/current-payments 2>/dev/null || true)"
  warn_changed_daemons                   # flag (don't bounce) an enabled rail daemon whose unit changed — before the overwrite below
  apply_repo_config                      # refresh units + timers + edge from the now-current deploy/
  restart_app                            # proxy, then payments

  if health_ok_app; then
    record "$REF" "  (proxy $new_proxy, payments $new_pay, UI $new_web)"
    echo ">>> OK — $PROXY_UNIT + $PAYMENTS_UNIT healthy on $REF"
    exit 0
  fi

  # /healthz is each service's own liveness, so a failure is a BINARY — but roll the UI back too so the served
  # UI never gets ahead of the running binaries (no new-UI / old-binary mismatch). Roll BOTH services back
  # together even when only one failed: they speak one versioned credit wire, and a mixed pair fails closed.
  echo "!! $PROXY_UNIT :$(proxy_port) and/or $PAYMENTS_UNIT :$(payments_port) failed /healthz within ${HEALTH_TIMEOUT}s — rolling back binaries + UI" >&2
  if [ -n "$prev_proxy" ] && [ -n "$prev_pay" ]; then
    ln -sfn "$prev_proxy" /usr/local/lib/nullsink/current-proxy
    ln -sfn "$prev_pay" /usr/local/lib/nullsink/current-payments
    if [ -n "$prev_web" ]; then
      ln -sfn "$prev_web" "$WEB_BASE/current-web"   # roll the UI back in lockstep with the binaries
    else
      # Only reachable if the FIRST versioned-UI install happened via deploy.sh — bootstrap goes through
      # setup.sh, which avoids this. Be honest rather than claim a lockstep we can't do.
      echo "!! no prior versioned UI to roll back to (first deploy) — UI stays at ${new_web}; verify it against the rolled-back binaries, or re-point $WEB_BASE/current-web by hand" >&2
    fi
    restart_app
    if health_ok_app; then
      record "$REF" "  (ROLLED BACK to proxy $prev_proxy + payments $prev_pay, UI ${prev_web:-unchanged})"
      echo "!! rolled back to proxy $prev_proxy + payments $prev_pay + UI ${prev_web:-unchanged} (healthy) — $REF NOT applied" >&2
    else
      record "$REF" "  (ROLLBACK UNHEALTHY)"
      echo "!! ROLLBACK ALSO UNHEALTHY — manual intervention: journalctl -u $PROXY_UNIT -u $PAYMENTS_UNIT" >&2
    fi
  else
    # No previous binaries on this box: there is nothing to flip back to — say so plainly instead of
    # half-restoring.
    record "$REF" "  (ROLLBACK IMPOSSIBLE — no previous binaries)"
    echo "!! no previous binaries to roll back to — diagnose: journalctl -u $PROXY_UNIT -u $PAYMENTS_UNIT" >&2
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
