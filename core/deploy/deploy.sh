#!/usr/bin/env bash
# Health-gated redeploy for an EXISTING box (use setup.sh for the first bootstrap). Binary-only: fetches +
# verifies a release TAG's assets (server binary, nsk, deploy tarball, UI), atomically activates the binary +
# UI, reinstalls units + Caddy edge so the box can't drift, restarts the app, waits for /healthz, and ROLLS
# BACK binary + UI if unhealthy. Records the live version in $APP_DIR/REVISION. Run as root:
#   sudo deploy/deploy.sh v0.3.0     # deploy a release tag (the only mode — no source/Bun on the box)
# Only the app service is restarted; the rail daemons' unit files are refreshed (drift closure) but left
# running — a redeploy WARNS when an enabled daemon's unit changed so you can restart it on your schedule.
# Timers are reconciled too (status-check, backup).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nullsink}"
SVC_NAME="${SVC_NAME:-nullsink}"
ENV_FILE="${ENV_FILE:-/etc/nullsink.env}"
WEB_BASE="${WEB_BASE:-/var/www/nullsink}"   # base for the versioned client UI ($WEB_BASE/web-<tag> + current-web)
REF="${1:-}"                              # tag/SHA/branch to deploy; empty = fast-forward current branch
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"    # seconds to wait for /healthz before declaring failure

# /healthz is localhost-only (Caddy never routes it). Port from the env file (default 8080). Computed here
# only for the rollback message below; health_ok() (in lib.sh) derives the same URL internally.
port="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
HEALTH_URL="http://127.0.0.1:${port:-8080}/healthz"

# install_units() + health_ok() live here — the shared "apply repo config" library, so the unit-install
# glob is the single source of truth for both this script and setup.sh. Sourced after APP_DIR/ENV_FILE.
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
apply_repo_config() { install_units; enable_timers; sync_caddy; }   # everything the box derives from the repo (units + timers + edge)
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

deploy_binary() {  # binary mode (REF is a version tag): fetch+verify+swap the binary + UI, health-gated
  # binary mode: fetch+verify+swap the binary + UI symlinks, refresh units/edge (NO git-checkout — the
  # binary IS the app), restart, roll both symlinks back if unhealthy.
  local prev_bin new_bin prev_web new_web
  prev_bin="$(readlink /usr/local/lib/nullsink/current 2>/dev/null || true)"   # for rollback
  prev_web="$(readlink "$WEB_BASE/current-web" 2>/dev/null || true)"           # roll the UI back in lockstep
  echo ">>> Deploying $REF  (binary was ${prev_bin:-none}, UI was ${prev_web:-none})"
  install_binary "$REF"                  # fetch+verify+activate /usr/local/lib/nullsink/current -> nullsink-$REF
  # nsk is an OPTIONAL operator CLI (install on demand: deploy/install-nsk.sh). Only refresh it here when it's
  # already installed, so it stays in lockstep with the server without being forced onto every box.
  [ -x /usr/local/bin/nsk ] && install_nsk "$REF"
  install_deploy_tree "$REF" "$APP_DIR"  # refresh deploy/ (units + scripts + Caddyfile) from the release
  # UI is non-fatal: /healthz tests the BINARY, which serves fine with a stale UI, so a UI fetch hiccup must not
  # abort (and half-apply) a binary deploy. Activate it; the health gate below still judges the binary.
  if install_client_ui "$REF" "$WEB_BASE"; then   # fetch+verify+activate $WEB_BASE/current-web -> web-$REF
    new_web="$(readlink "$WEB_BASE/current-web" 2>/dev/null || true)"
  else
    echo "!! client UI $REF failed to install — proceeding on the binary; UI left at ${prev_web:-current state}" >&2
    new_web="${prev_web:-unchanged}"
  fi
  new_bin="$(readlink /usr/local/lib/nullsink/current 2>/dev/null || true)"
  warn_changed_daemons                   # flag (don't bounce) an enabled rail daemon whose unit changed — before the overwrite below
  apply_repo_config                      # refresh units (binary-ExecStart) + timers + edge from the now-current deploy/
  systemctl restart "$SVC_NAME"

  if health_ok; then
    record "$REF" "  (binary $new_bin, UI $new_web)"
    echo ">>> OK — $SVC_NAME healthy on binary $REF"
    exit 0
  fi

  # /healthz is the app's own liveness, so a failure is the BINARY — but roll the UI back too so the served
  # UI never gets ahead of the running binary (no new-UI / old-binary mismatch).
  echo "!! $SVC_NAME failed $HEALTH_URL within ${HEALTH_TIMEOUT}s — rolling back binary + UI" >&2
  if [ -n "$prev_bin" ]; then
    ln -sfn "$prev_bin" /usr/local/lib/nullsink/current
    if [ -n "$prev_web" ]; then
      ln -sfn "$prev_web" "$WEB_BASE/current-web"   # roll the UI back in lockstep with the binary
    else
      # Only reachable if the FIRST versioned-UI install happened via deploy.sh (not setup.sh) — the cutover is
      # documented to go through setup.sh, which avoids this. Be honest rather than claim a lockstep we can't do.
      echo "!! no prior versioned UI to roll back to (first/cutover deploy) — UI stays at ${new_web}; verify it against the rolled-back binary, or re-point $WEB_BASE/current-web by hand" >&2
    fi
    systemctl restart "$SVC_NAME"
    if health_ok; then
      record "$REF" "  (ROLLED BACK to binary $prev_bin, UI ${prev_web:-unchanged})"
      echo "!! rolled back to binary $prev_bin + UI ${prev_web:-unchanged} (healthy) — $REF NOT applied" >&2
    else
      record "$REF" "  (ROLLBACK UNHEALTHY)"
      echo "!! ROLLBACK ALSO UNHEALTHY — manual intervention: journalctl -u $SVC_NAME" >&2
    fi
  else
    record "$REF" "  (ROLLBACK IMPOSSIBLE — no previous binary)"
    echo "!! no previous binary to roll back to — manual intervention: journalctl -u $SVC_NAME" >&2
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
