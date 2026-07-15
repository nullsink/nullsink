#!/usr/bin/env bash
# One host-wide exclusion boundary for every operation that can stop services or replace live release/ledger
# state. The lock itself is intentionally ephemeral (/run): it prevents concurrent operators/processes, while
# restore.sh's separate durable sentinel handles reboot safety after a crash in the middle of a DB restore.

acquire_maintenance_lock() { # $1=operation, $2=allow restore guard, $3=allow deploy guard
  local operation="${1:-maintenance}" allow_restore_guard="${2:-0}" allow_deploy_guard="${3:-0}"
  local lock_path restore_guard restore_activation_guard deploy_guard
  lock_path="${NULLSINK_MAINTENANCE_LOCK:-/run/lock/nullsink-maintenance.lock}"
  restore_guard="${NULLSINK_RESTORE_GUARD:-/var/lib/nullsink/.restore-in-progress}"
  restore_activation_guard="${NULLSINK_RESTORE_ACTIVATION_GUARD:-$(dirname "$restore_guard")/.restore-activation-pending}"
  deploy_guard="${NULLSINK_DEPLOY_GUARD:-/var/lib/nullsink/.deploy-in-progress}"
  if [ "$allow_restore_guard" != 1 ] && [ -e "$restore_guard" ]; then
    echo "!! an interrupted ledger restore is still gated at $restore_guard; resume/recover it before $operation" >&2
    return 1
  fi
  if [ "$allow_restore_guard" != 1 ] && { [ -e "$restore_activation_guard" ] || [ -L "$restore_activation_guard" ]; }; then
    echo "!! a validated ledger restore still awaits activation at $restore_activation_guard; resume it before $operation" >&2
    return 1
  fi
  if [ "$allow_deploy_guard" != 1 ] && [ -e "$deploy_guard" ]; then
    echo "!! an interrupted app deploy is still gated at $deploy_guard; recover it before $operation" >&2
    return 1
  fi
  command -v flock >/dev/null || {
    echo "!! flock is required to serialize nullsink maintenance" >&2
    return 1
  }
  mkdir -p "$(dirname "$lock_path")" || return 1
  exec {NULLSINK_MAINTENANCE_LOCK_FD}>"$lock_path" || return 1
  if ! flock -n "$NULLSINK_MAINTENANCE_LOCK_FD"; then
    echo "!! another nullsink maintenance operation is active; refusing concurrent $operation" >&2
    return 1
  fi
}

# Serialize complete backup runs independently of the shared ledger lock. Shared locks deliberately allow
# multiple readers, but two manual runs in the same second would otherwise target the same final artifact
# name. Holding this owner-only lock until process exit makes publication and retention single-writer.
acquire_backup_run_lock() { # $1=backup directory
  local backup_dir="${1:?backup directory is required}" lock_path
  lock_path="${NULLSINK_BACKUP_LOCK:-$backup_dir/.backup-run.lock}"
  command -v flock >/dev/null || {
    echo "!! flock is required to serialize ledger backups" >&2
    return 1
  }
  [ -d "$backup_dir" ] || {
    echo "!! backup directory does not exist: $backup_dir" >&2
    return 1
  }
  if [ -L "$lock_path" ]; then
    echo "!! unsafe backup lock path (symlink): $lock_path" >&2
    return 1
  fi
  ( umask 077; : >> "$lock_path" ) || return 1
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || {
    echo "!! unsafe backup lock path: $lock_path" >&2
    return 1
  }
  chmod 600 "$lock_path" || return 1
  exec {NULLSINK_BACKUP_RUN_LOCK_FD}<>"$lock_path" || return 1
  if ! flock -x -n "$NULLSINK_BACKUP_RUN_LOCK_FD"; then
    echo "!! another ledger backup is active; refusing a concurrent run" >&2
    exec {NULLSINK_BACKUP_RUN_LOCK_FD}>&-
    return 1
  fi
}

# Shared half of the ledger exclusion boundary for long-running readers such as backup.sh. Acquire the lock
# BEFORE inspecting the durable guards: restore takes the exclusive half before it creates/removes its marker,
# so once this shared lock is held no new restore can cross that boundary. The post-lock marker checks also
# reject a half-restored pair left by a crashed restore whose process-lifetime lock naturally disappeared.
acquire_ledger_shared_lock() { # $1=DB directory, $2=operation label
  local db_dir="${1:-/var/lib/nullsink}" operation="${2:-ledger reader}"
  local lock_path restore_guard restore_activation_guard deploy_guard
  lock_path="${NULLSINK_LEDGER_LOCK:-$db_dir/.ledger.lock}"
  restore_guard="${NULLSINK_RESTORE_GUARD:-$db_dir/.restore-in-progress}"
  restore_activation_guard="${NULLSINK_RESTORE_ACTIVATION_GUARD:-$db_dir/.restore-activation-pending}"
  deploy_guard="${NULLSINK_DEPLOY_GUARD:-$db_dir/.deploy-in-progress}"

  command -v flock >/dev/null || {
    echo "!! flock is required to exclude $operation from ledger maintenance" >&2
    return 1
  }
  [ -d "$db_dir" ] && [ ! -L "$db_dir" ] || {
    echo "!! ledger directory is missing or unsafe: $db_dir" >&2
    return 1
  }
  if [ -L "$lock_path" ]; then
    echo "!! unsafe ledger lock path (symlink): $lock_path" >&2
    return 1
  fi

  # backup.service runs as the ledger owner, so it can create this owner-only inode directly. Never truncate or
  # replace it: every CLI/backup/restore participant must contend on the same open file description.
  ( umask 077; : >> "$lock_path" ) || return 1
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || {
    echo "!! unsafe ledger lock path: $lock_path" >&2
    return 1
  }
  chmod 600 "$lock_path" || return 1
  exec {NULLSINK_LEDGER_SHARED_LOCK_FD}<>"$lock_path" || return 1
  if ! flock -s -n "$NULLSINK_LEDGER_SHARED_LOCK_FD"; then
    echo "!! ledger maintenance is active; refusing $operation" >&2
    exec {NULLSINK_LEDGER_SHARED_LOCK_FD}>&-
    return 1
  fi

  if [ -e "$restore_guard" ]; then
    echo "!! an interrupted ledger restore is still gated at $restore_guard; refusing $operation" >&2
    exec {NULLSINK_LEDGER_SHARED_LOCK_FD}>&-
    return 1
  fi
  if [ -e "$restore_activation_guard" ] || [ -L "$restore_activation_guard" ]; then
    echo "!! a validated ledger restore still awaits activation at $restore_activation_guard; refusing $operation" >&2
    exec {NULLSINK_LEDGER_SHARED_LOCK_FD}>&-
    return 1
  fi
  if [ -e "$deploy_guard" ]; then
    echo "!! an interrupted app deploy is still gated at $deploy_guard; refusing $operation" >&2
    exec {NULLSINK_LEDGER_SHARED_LOCK_FD}>&-
    return 1
  fi
}

# Exclusive half of cli/ledger-lock.ts/backup.sh's process-lifetime shared lock. A restore acquires this AFTER the
# host-wide maintenance lock but BEFORE inspecting recovery slots, staging files, stopping services, or
# arming the durable marker. Thus an already-running nsk command or backup makes restore fail before live
# mutation, and once restore holds this lock neither can start reading a pre-/post-restore split pair.
acquire_ledger_maintenance_lock() { # $1=DB directory, $2=service user
  local db_dir="${1:-/var/lib/nullsink}" svc_user="${2:-nullsink}" lock_path current_user
  lock_path="${NULLSINK_LEDGER_LOCK:-$db_dir/.ledger.lock}"

  command -v flock >/dev/null || {
    echo "!! flock is required to exclude operator CLI commands during ledger maintenance" >&2
    return 1
  }
  [ -d "$db_dir" ] || {
    echo "!! ledger directory does not exist: $db_dir" >&2
    return 1
  }
  if [ -L "$lock_path" ]; then
    echo "!! unsafe ledger lock path (symlink): $lock_path" >&2
    return 1
  fi

  # Create/open the same inode as the service user, without truncating or replacing it. That keeps nsk able
  # to acquire future shared locks and avoids an inode-swap that could split contenders across two locks.
  current_user="$(id -un)"
  if [ "$current_user" = "$svc_user" ]; then
    ( umask 077; : >> "$lock_path" ) || return 1
  else
    command -v sudo >/dev/null || {
      echo "!! sudo is required to create the ledger lock as $svc_user" >&2
      return 1
    }
    sudo -u "$svc_user" sh -c 'umask 077; : >> "$1"' sh "$lock_path" || {
      echo "!! could not open ledger lock as $svc_user: $lock_path" >&2
      return 1
    }
  fi
  [ -f "$lock_path" ] && [ ! -L "$lock_path" ] || {
    echo "!! unsafe ledger lock path: $lock_path" >&2
    return 1
  }
  chmod 600 "$lock_path" || return 1

  exec {NULLSINK_LEDGER_LOCK_FD}<>"$lock_path" || return 1
  if ! flock -x -n "$NULLSINK_LEDGER_LOCK_FD"; then
    echo "!! an operator CLI command or backup is using the ledger; wait for it to finish before restore" >&2
    exec {NULLSINK_LEDGER_LOCK_FD}>&-
    return 1
  fi
}

release_ledger_maintenance_lock() {
  # Restore calls this only after the live pair and application readiness have passed, while the durable
  # activation marker still blocks new CLI/backup readers. Releasing before the Persistent backup timer is
  # published complete lets an immediately-due backup run normally instead of failing lock contention.
  if [ -n "${NULLSINK_LEDGER_LOCK_FD:-}" ]; then
    exec {NULLSINK_LEDGER_LOCK_FD}>&- || return 1
    unset NULLSINK_LEDGER_LOCK_FD
  fi
}
