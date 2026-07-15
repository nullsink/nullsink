#!/usr/bin/env bash
# Sourceable post-restore activation boundary. A narrow, namespaced readiness probe keeps restore independent
# from lib.sh's release-install contract while matching its ENV_FILE ports, /healthz route, and timeout. The
# activation functions still accept a callback so tests can exercise failures without a live systemd host.

# This file is sourced after restore-swap.sh. The application units deliberately do NOT condition-skip the
# activation marker: the restored pair is already validated and must start for readiness. Unrelated readers
# reject it, while timer-launched backup/status jobs condition-skip it to avoid false pages during warmup. The
# original swap marker is re-armed before any interrupted activation is deliberately stopped or resumed.

restore_activation_guard_path() { # $1=DB dir
  printf '%s/.restore-activation-pending\n' "$1"
}

restore_activation_guard_present() { # $1=DB dir; symlinks count as present so validation can reject them
  local marker
  marker="$(restore_activation_guard_path "$1")"
  [ -e "$marker" ] || [ -L "$marker" ]
}

restore_activation_guard_matches() { # $1=DB dir $2=verified artifact pair identity
  local marker expected actual
  marker="$(restore_activation_guard_path "$1")"
  expected="restore-activation-v1 $2"
  [ -f "$marker" ] && [ ! -L "$marker" ] || {
    echo "!! unsafe or missing restore activation marker: $marker" >&2
    return 1
  }
  IFS= read -r actual < "$marker" || true
  [ "$actual" = "$expected" ] || {
    echo "!! pending restore activation belongs to a different/unknown backup pair" >&2
    echo "!! rerun the exact same artifact; activation resume never swaps in another pair" >&2
    return 1
  }
}

restore_arm_activation_guard() { # $1=DB dir $2=pair identity; idempotent only for the same pair
  local db_dir="$1" identity="$2" marker tmp
  marker="$(restore_activation_guard_path "$db_dir")"
  [ -d "$db_dir" ] && [ ! -L "$db_dir" ] || return 1
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    restore_activation_guard_matches "$db_dir" "$identity"
    return
  fi
  tmp="$marker.new.$$"
  ( umask 077; printf 'restore-activation-v1 %s\n' "$identity" > "$tmp" ) || return 1
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  sync -f "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$marker" || { rm -f "$tmp"; return 1; }
  sync -f "$db_dir" || return 1
}

restore_disarm_activation_guard() { # $1=DB dir; only after services/timers pass readiness and active checks
  local db_dir="$1" marker
  marker="$(restore_activation_guard_path "$db_dir")"
  [ ! -L "$marker" ] || {
    echo "!! refusing to remove unsafe restore activation marker: $marker" >&2
    return 1
  }
  rm -f "$marker" || return 1
  sync -f "$db_dir" || return 1
}

restore_recovery_phase() { # $1=DB dir $2=artifact pair ID; print fresh, swap, or activation
  local db_dir="$1" pair_id="$2" swap_marker
  swap_marker="$(restore_guard_path "$db_dir")"
  if restore_activation_guard_present "$db_dir"; then
    restore_activation_guard_matches "$db_dir" "$pair_id" || return 1
    if [ -e "$swap_marker" ] || [ -L "$swap_marker" ]; then
      restore_guard_matches "$db_dir" "$pair_id" || return 1
    fi
    printf 'activation\n'
  elif [ -e "$swap_marker" ] || [ -L "$swap_marker" ]; then
    restore_guard_matches "$db_dir" "$pair_id" || return 1
    printf 'swap\n'
  else
    printf 'fresh\n'
  fi
}

restore_env_val() { grep -E "^$1=" "${ENV_FILE:-/etc/nullsink.env}" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
restore_proxy_port()    { local p; p="$(restore_env_val PORT)";          echo "${p:-8080}"; }
restore_payments_port() { local p; p="$(restore_env_val PAYMENTS_PORT)"; echo "${p:-8081}"; }

restore_health_ok() { # $1=port; poll the localhost-only /healthz using the deploy health convention
  local port="$1" waited=0
  while [ "$waited" -lt "${HEALTH_TIMEOUT:-60}" ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

restore_health_ok_app() {
  restore_health_ok "$(restore_proxy_port)" && restore_health_ok "$(restore_payments_port)"
}

restore_require_active_units() { # $@=units that must all currently be active
  local unit
  for unit in "$@"; do
    if ! systemctl is-active --quiet "$unit"; then
      echo "!! $unit did not remain active after restore activation" >&2
      return 1
    fi
  done
}

restore_start_and_verify_activation() { # $1=readiness callback, $2...=units to start and verify
  local readiness="$1"
  shift
  # One multi-unit systemctl request removes the old caller-owned start loop. The durable activation marker,
  # not an assumption about client-side D-Bus batching, is what makes even a prefix accepted before SIGKILL
  # recoverable by the exact same artifact.
  if ! systemctl start "$@"; then
    echo "!! systemd could not start the complete application/timer set after restore" >&2
    return 1
  fi

  # Type=simple considers ExecStart launched before the application is ready, and a Condition= skip also
  # makes `systemctl start` itself look successful. Require every participant active, then prove both app
  # HTTP servers ready, then require the units active once more to catch an early post-start crash.
  restore_require_active_units "$@" || return 1
  if ! "$readiness"; then
    echo "!! restored application services did not pass /healthz readiness" >&2
    return 1
  fi
  restore_require_active_units "$@" || return 1
}

restore_fail_closed_activation() { # $1=DB dir $2=pair ID $3=proxy $4=payments $5=reason
  local db_dir="$1" pair_id="$2" proxy_unit="$3" payments_unit="$4" reason="$5" recovery_ok=1
  restore_arm_activation_guard "$db_dir" "$pair_id" || recovery_ok=0
  restore_arm_guard "$db_dir" "$pair_id" || recovery_ok=0
  # A Persistent= timer may launch its service immediately. Stop the jobs as well as their timers so a
  # failed readiness check cannot leave a maintenance process running against a deliberately gated stack.
  systemctl stop backup.timer status-check.timer backup.service status-check.service \
    "$payments_unit" "$proxy_unit" >/dev/null 2>&1 || recovery_ok=0
  echo "!! restored ledgers validate, but $reason" >&2
  if [ "$recovery_ok" -eq 1 ]; then
    echo "!! the restore guard is re-armed and the partial stack is stopped; re-run this same artifact" >&2
  else
    echo "!! fail-closed recovery was incomplete; inspect systemd and $db_dir/.restore-in-progress before reboot" >&2
  fi
  return 1
}

restore_activate_or_fail_closed() { # $1=DB dir $2=pair ID $3=proxy $4=payments $5=readiness; $6...=units
  local db_dir="$1" pair_id="$2" proxy_unit="$3" payments_unit="$4" readiness="$5"
  shift 5
  if restore_start_and_verify_activation "$readiness" "$@"; then
    return 0
  fi
  restore_fail_closed_activation "$db_dir" "$pair_id" "$proxy_unit" "$payments_unit" \
    "service/timer activation or readiness verification failed"
}

restore_prepare_activation_resume() { # $1=DB dir $2=pair ID $3=proxy $4=payments
  local db_dir="$1" pair_id="$2" proxy_unit="$3" payments_unit="$4"
  restore_activation_guard_matches "$db_dir" "$pair_id" || return 1
  # Gate the next boot BEFORE stopping anything. An activation-only resume never stages or swaps a DB; it
  # merely returns the already-validated live pair to a quiescent, guarded baseline for another health pass.
  restore_arm_guard "$db_dir" "$pair_id" || return 1
  if ! systemctl stop backup.timer status-check.timer backup.service status-check.service \
    "$payments_unit" "$proxy_unit"; then
    echo "!! could not quiesce the pending restore activation; the durable guards remain armed" >&2
    return 1
  fi
}

RESTORE_ACTIVATION_TRAP_ACTIVE=0

restore_activation_handle_signal() { # $1=HUP/INT/TERM; exits the restore shell after best-effort cleanup
  local signal="$1" status=1
  case "$signal" in HUP) status=129 ;; INT) status=130 ;; TERM) status=143 ;; esac
  trap - HUP INT TERM
  if [ "${RESTORE_ACTIVATION_TRAP_ACTIVE:-0}" -eq 1 ]; then
    RESTORE_ACTIVATION_TRAP_ACTIVE=0
    set +e
    restore_fail_closed_activation \
      "$RESTORE_ACTIVATION_DB_DIR" "$RESTORE_ACTIVATION_PAIR_ID" \
      "$RESTORE_ACTIVATION_PROXY_UNIT" "$RESTORE_ACTIVATION_PAYMENTS_UNIT" \
      "activation was interrupted by $signal" || true
  fi
  exit "$status"
}

restore_run_activation_phase() { # $1=DB dir $2=pair ID $3=proxy $4=payments $5=readiness; $6...=units
  local db_dir="$1" pair_id="$2" proxy_unit="$3" payments_unit="$4" readiness="$5" result=0
  shift 5

  # Persist the exact-pair resume proof BEFORE removing the systemd boot gate. SIGKILL/power loss at every
  # later instruction therefore leaves either the swap guard, the activation marker, or both.
  restore_arm_activation_guard "$db_dir" "$pair_id" || return 1
  RESTORE_ACTIVATION_DB_DIR="$db_dir"
  RESTORE_ACTIVATION_PAIR_ID="$pair_id"
  RESTORE_ACTIVATION_PROXY_UNIT="$proxy_unit"
  RESTORE_ACTIVATION_PAYMENTS_UNIT="$payments_unit"
  RESTORE_ACTIVATION_TRAP_ACTIVE=1
  trap 'restore_activation_handle_signal HUP' HUP
  trap 'restore_activation_handle_signal INT' INT
  trap 'restore_activation_handle_signal TERM' TERM

  if ! restore_disarm_guard "$db_dir"; then
    restore_fail_closed_activation "$db_dir" "$pair_id" "$proxy_unit" "$payments_unit" \
      "the swap guard could not be removed for activation" || true
    result=1
  elif ! restore_activate_or_fail_closed \
    "$db_dir" "$pair_id" "$proxy_unit" "$payments_unit" "$readiness" "$@"; then
    result=1
  fi

  # Wait out any immediately-triggered, condition-skipped oneshot job while the marker still exists. Without
  # this drain, the post-marker `start` could merely join the tail of that skipped job and never execute the
  # intended real status check/backup.
  if [ "$result" -eq 0 ] && ! systemctl stop status-check.service backup.service; then
    restore_fail_closed_activation "$db_dir" "$pair_id" "$proxy_unit" "$payments_unit" \
      "timer-launched jobs could not be drained before activation handoff" || true
    result=1
  fi

  # Stop catchable-signal cleanup before publishing completion. A signal/power loss after this point but
  # before marker removal simply leaves activation pending for an exact-artifact resume; after durable marker
  # removal the complete stack has already passed both readiness and post-readiness active checks.
  RESTORE_ACTIVATION_TRAP_ACTIVE=0
  trap - HUP INT TERM
  [ "$result" -eq 0 ] || return "$result"
  if declare -F release_ledger_maintenance_lock >/dev/null && ! release_ledger_maintenance_lock; then
    restore_fail_closed_activation "$db_dir" "$pair_id" "$proxy_unit" "$payments_unit" \
      "the exclusive ledger lock could not be released after readiness" || true
    return 1
  fi
  if ! restore_disarm_activation_guard "$db_dir"; then
    restore_fail_closed_activation "$db_dir" "$pair_id" "$proxy_unit" "$payments_unit" \
      "activation completion could not be made durable" || true
    return 1
  fi
  # Either timer may have attempted a condition-skipped launch while activation was pending (backup.timer is
  # Persistent; status-check may already be past OnBootSec). Run both jobs for real now that the markers and
  # exclusive ledger lock are gone, so no occurrence is silently consumed and any alert is genuine.
  if ! systemctl start status-check.service backup.service; then
    echo "!! WARN: restore activation succeeded, but a post-restore status/backup job failed (OnFailure will alert)" >&2
  fi
}
