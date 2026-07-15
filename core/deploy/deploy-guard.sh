#!/usr/bin/env bash
# Durable reboot boundary for the multi-artifact deploy transaction. The marker blocks both app services
# and the backup one-shot through systemd while binaries/tree/units are being replaced. deploy.sh removes it
# only after the two backend binaries + deploy configuration form one internally consistent release; the old
# browser UI is then safe because the new /buy contract rejects it until the UI pointer flips.

DEPLOY_GUARD_PATH="${NULLSINK_DEPLOY_GUARD:-/var/lib/nullsink/.deploy-in-progress}"

deploy_arm_guard() { # $1=target/recovery label
  local label="${1:-unknown}" dir tmp
  dir="$(dirname "$DEPLOY_GUARD_PATH")"
  # deploy.sh is for an existing box. Never create the money-state directory as root with ambient mkdir
  # permissions; setup/systemd must already have made the service-owned 0700 StateDirectory.
  [ -d "$dir" ] && [ ! -L "$dir" ] || {
    echo "!! deploy guard directory is missing or unsafe: $dir (run setup/repair first)" >&2
    return 1
  }
  if [ -e "$DEPLOY_GUARD_PATH" ]; then
    [ -f "$DEPLOY_GUARD_PATH" ] && [ ! -L "$DEPLOY_GUARD_PATH" ] || {
      echo "!! unsafe deploy guard path: $DEPLOY_GUARD_PATH" >&2
      return 1
    }
    sync -f "$dir" || return 1
    return 0
  fi
  tmp="$DEPLOY_GUARD_PATH.new.$$"
  ( umask 077; printf '%s\n' "deploy in progress: $label" > "$tmp" ) || return 1
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$DEPLOY_GUARD_PATH" || { rm -f "$tmp"; return 1; }
  sync -f "$dir" || return 1
}

deploy_disarm_guard() {
  local dir
  dir="$(dirname "$DEPLOY_GUARD_PATH")"
  deploy_sync_release_filesystems || return 1
  rm -f "$DEPLOY_GUARD_PATH" || return 1
  sync -f "$dir" || return 1
}

# `sync -f` is syncfs(2): one existing path flushes every dirty inode on that path's filesystem. A release
# transaction spans directories that operators commonly mount separately, so syncing only the marker's
# /var/lib filesystem before deleting it is not a durability boundary. Flush one path for every filesystem
# that can hold live release state first; only then may marker deletion become durable. The override is a
# colon-separated test/recovery hook, not normal configuration.
deploy_sync_release_filesystems() {
  local path paths
  local -a sync_paths
  paths="${NULLSINK_DEPLOY_SYNC_PATHS:-/usr/local/lib/nullsink:/usr/local/bin:${APP_DIR:-/opt/nullsink}:/etc/systemd/system:/etc/caddy:${WEB_BASE:-/var/www/nullsink}}"
  IFS=: read -r -a sync_paths <<< "$paths"
  for path in "${sync_paths[@]}"; do
    [ -n "$path" ] || continue
    # Caddy is optional on a private/loopback-only box. Every path actually mutated by this transaction
    # already exists; skipping an absent optional root cannot skip dirty release state.
    [ -e "$path" ] || continue
    sync -f "$path" || {
      echo "!! could not flush release filesystem at $path; deploy guard remains armed" >&2
      return 1
    }
  done
}

# Existing boxes may still run units from a release that predates the base-unit Condition= below. Install a
# persistent drop-in on all money-state participants BEFORE arming the marker, so the very first hardened
# upgrade also boots fail-closed. The drop-ins are intentionally retained after success/rollback.
install_deploy_guard_dropins() {
  local unit dir tmp parent=/etc/systemd/system
  for unit in "${PROXY_UNIT:-nullsink-proxy}" "${PAYMENTS_UNIT:-nullsink-payments}" backup; do
    dir="/etc/systemd/system/$unit.service.d"
    tmp="$dir/.nullsink-deploy-guard.conf.new.$$"
    mkdir -p "$dir" || return 1
    # The first hardened upgrade can still be running old base units, so these drop-ins are the only reboot
    # gate until the target units land. Make the new directory entry durable before the marker can be armed.
    sync -f "$parent" || return 1
    {
      printf '%s\n' '[Unit]'
      printf 'ConditionPathExists=!%s\n' "$DEPLOY_GUARD_PATH"
    } > "$tmp" || return 1
    chmod 644 "$tmp" || { rm -f "$tmp"; return 1; }
    sync -f "$tmp" || { rm -f "$tmp"; return 1; }
    mv -f "$tmp" "$dir/nullsink-deploy-guard.conf" || { rm -f "$tmp"; return 1; }
    sync -f "$dir" || return 1
  done
  systemctl daemon-reload || return 1
}
