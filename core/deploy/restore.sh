#!/usr/bin/env bash
# Restore the billing DBs from a backup.sh artifact. DEFAULT is a SAFE DRY-RUN: decrypt + extract to a temp
# dir and run PRAGMA integrity_check on each DB, touching NOTHING live. Pass --apply to actually replace the
# live DBs (stops both services, installs the files service-owned, re-arms the credit outbox, restarts). A
# dry-run is also how you TEST artifact integrity and internal pair consistency without risking production;
# --apply performs the remaining target-compatibility preflight before touching live files.
#
# Decryption (.tar.age artifacts) needs your age IDENTITY (private key), which is kept OFFLINE, NOT on the
# box. So verify on your secure machine (dry-run there), and for a real --apply provide the key transiently
# via BACKUP_AGE_IDENTITY. A plain .tar artifact needs no key.
#
# Usage:
#   restore.sh <artifact>                                   # dry-run: verify, change nothing
#   restore.sh --apply <artifact>                           # replace live DBs
#   restore.sh --apply --archive-unreadable-live <artifact> # explicit corrupt-live break glass
# Env: BACKUP_AGE_IDENTITY (age key file, for .tar.age artifacts). Live apply intentionally targets the
# committed /var/lib/nullsink + nullsink systemd units; dry-run verification remains host-independent.
set -euo pipefail
umask 077

# shellcheck source=deploy/restore-swap.sh
source "$(dirname "$0")/restore-swap.sh"
# shellcheck source=deploy/maintenance-lock.sh
source "$(dirname "$0")/maintenance-lock.sh"
# shellcheck source=deploy/restore-activation.sh
source "$(dirname "$0")/restore-activation.sh"

apply=0
archive_unreadable_live=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --archive-unreadable-live) archive_unreadable_live=1; shift ;;
    --) shift; break ;;
    -*) echo "unknown restore option: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done
[ "$archive_unreadable_live" -eq 0 ] || [ "$apply" -eq 1 ] || {
  echo "--archive-unreadable-live is valid only with --apply" >&2
  exit 1
}
artifact="${1:-}"
if [ -z "$artifact" ] || [ ! -f "$artifact" ] || [ "$#" -ne 1 ]; then
  echo "usage: restore.sh [--apply [--archive-unreadable-live]] <artifact>   (default: safe dry-run)" >&2
  exit 1
fi

DB_DIR="${DB_DIR:-/var/lib/nullsink}"
SVC_USER="${SVC_USER:-nullsink}"
PROXY_UNIT="${PROXY_UNIT:-nullsink-proxy}"
PAYMENTS_UNIT="${PAYMENTS_UNIT:-nullsink-payments}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Decrypt an age artifact, else copy the plain tar in.
tarball="$work/backup.tar"
case "$artifact" in
  *.age)
    [ -n "${BACKUP_AGE_IDENTITY:-}" ] || { echo "artifact is age-encrypted — set BACKUP_AGE_IDENTITY to your (offline) key file" >&2; exit 1; }
    command -v age >/dev/null || { echo "'age' is not installed (apt-get install age)" >&2; exit 1; }
    age -d -i "$BACKUP_AGE_IDENTITY" -o "$tarball" "$artifact" ;;
  *)
    cp "$artifact" "$tarball" ;;
esac

tar -C "$work" -xf "$tarball"
[ -f "$work/balances.db" ] || { echo "no balances.db inside the artifact — wrong/corrupt file?" >&2; exit 1; }

# Verify each extracted DB before trusting it (a backup that won't open is no backup). The `|| true` is
# load-bearing: on a not-a-database / truncated / bad-header file, sqlite3 EXITS non-zero (SQLITE_NOTADB=26),
# and under `set -euo pipefail` that exit propagates through the pipe and kills the script AT the assignment —
# before the diagnostic below can print. The operator would see a bare `exit 26` on exactly the corrupt
# artifact this check exists to catch. Swallow sqlite3's exit; judge the artifact by its OUTPUT instead.
for db in "$work/balances.db" "$work/pending.db"; do
  [ -f "$db" ] || continue
  res="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -1 || true)"
  if [ "$res" = "ok" ]; then echo "integrity OK: $(basename "$db")"
  else echo "integrity FAILED: $(basename "$db"): ${res:-sqlite3 could not open it (not a database?)}" >&2; exit 1; fi
done

# Integrity alone is not identity: SQLite will happily call an empty/wrong database "ok". Require the
# minimum money schemas before a dry-run may describe an artifact as restorable. Newer optional tables are
# migrated by the app, but these roots identify the two ledgers across every supported backup generation.
restore_require_table sqlite3 "$work/balances.db" tokens "backup balances.db" || exit 1
if [ -f "$work/pending.db" ]; then
  restore_require_table sqlite3 "$work/pending.db" pending_orders "backup pending.db" || exit 1
fi

# Validate the irreversible half of the two-DB protocol BEFORE claiming a dry-run is restorable (and before
# --apply touches live state). An ack tombstone has intentionally erased the hash/amount needed to redeliver;
# therefore its idempotency key MUST already exist in the paired balance ledger. Legacy acked rows with a
# retained payload remain recoverable by the re-arm step below. If the balance ledger predates
# applied_orders, no acknowledged row is safely classifiable, so the pair fails closed.
check_tombstone_pair() { # $1=pending.db $2=balances.db $3=context label $4=sqlite runner (optional)
  local pending="$1" balances="$2" label="$3" runner="${4:-sqlite3}" has_outbox has_applied missing reason
  [ -f "$pending" ] || return 0
  has_outbox="$("$runner" "$pending" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='credit_outbox';" 2>/dev/null || echo check_failed)"
  [ "$has_outbox" = 1 ] || {
    [ "$has_outbox" = 0 ] && return 0
    echo "pair check FAILED ($label): could not inspect credit_outbox" >&2
    return 1
  }
  has_applied="$("$runner" "$balances" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='applied_orders';" 2>/dev/null || echo check_failed)"
  if [ "$has_applied" = 1 ]; then
    missing="$("$runner" "$pending" \
      "ATTACH '$balances' AS bal;
       SELECT count(*) FROM credit_outbox
        WHERE acked_at IS NOT NULL
          AND hash = ''
          AND NOT EXISTS (
            SELECT 1 FROM bal.applied_orders AS applied
             WHERE applied.order_id = credit_outbox.idempotency_key
          );" 2>/dev/null || echo check_failed)"
    reason="ack tombstone(s) have no matching balance-ledger marker"
  elif [ "$has_applied" = 0 ]; then
    missing="$("$runner" "$pending" \
      "SELECT count(*) FROM credit_outbox WHERE acked_at IS NOT NULL;" 2>/dev/null || echo check_failed)"
    reason="acknowledged outbox row(s) cannot be verified because balances.db has no applied_orders ledger"
  else
    echo "pair check FAILED ($label): could not inspect applied_orders" >&2
    return 1
  fi
  case "$missing" in
    0) return 0 ;;
    ''|*[!0-9]*) echo "pair check FAILED ($label): could not compare ack tombstones with the balance ledger" >&2 ;;
    *) echo "pair check FAILED ($label): $missing $reason; their scrubbed delivery payload cannot be re-armed" >&2 ;;
  esac
  return 1
}

check_tombstone_pair "$work/pending.db" "$work/balances.db" "backup artifact" || exit 1

if [ "$apply" -eq 0 ]; then
  echo "--- dry-run OK: the artifact is intact and internally consistent. --apply will also verify target compatibility before restoring. ---"
  exit 0
fi

# --apply: replace the live ledger. Assert root FIRST — the install/chown + systemctl below need it, and we
# must NOT stop the service and then fail before restoring. STAGE the verified snapshots next to the live
# DBs (so a live copy is never deleted before its replacement is in hand); then, service stopped, swap them
# in, keeping the previous live DB as <db>.prerestore for recovery. The snapshots are already checkpointed,
# so the stale -wal/-shm are dropped.
[ "$(id -u)" -eq 0 ] || { echo "--apply must run as root (it installs files + (re)starts the services)" >&2; exit 1; }
[ "$DB_DIR" = /var/lib/nullsink ] || {
  echo "--apply refuses nondefault DB_DIR=$DB_DIR: committed systemd boot guards cover /var/lib/nullsink only" >&2
  exit 1
}
command -v sha256sum >/dev/null || { echo "--apply requires sha256sum to bind recovery to one backup pair" >&2; exit 1; }
command -v curl >/dev/null || { echo "--apply requires curl for post-restore application readiness checks" >&2; exit 1; }
restore_pair_id="$(restore_pair_identity "$work")" || {
  echo "!! could not identify the verified backup pair" >&2
  exit 1
}

acquire_maintenance_lock "ledger restore" 1 || exit 1
acquire_ledger_maintenance_lock "$DB_DIR" "$SVC_USER" || exit 1

# Read the durable phase only after both exclusion locks are held. The activation marker proves this exact
# artifact's live pair was already reconciled and validated; that phase resumes activation only and MUST NOT
# stage/swap the artifact again or overwrite the first pre-restore recovery copies.
restore_phase="$(restore_recovery_phase "$DB_DIR" "$restore_pair_id")" || exit 1
restore_resuming=0
restore_activation_resuming=0
case "$restore_phase" in
  fresh) ;;
  swap) restore_resuming=1 ;;
  activation) restore_activation_resuming=1 ;;
  *) echo "!! invalid durable restore phase: $restore_phase" >&2; exit 1 ;;
esac
if [ "$restore_activation_resuming" -eq 0 ]; then
  restore_require_recovery_slots "$DB_DIR" "$restore_resuming" || exit 1
fi

# Do not trust that the operator already deployed the guarded units. The marker only protects a reboot if
# systemd actually consults it; validate all money-state participants before staging or stopping anything.
# `systemctl cat` emits the base unit and drop-ins in effective order. Parse Condition*= reset semantics rather
# than grepping for a stale base-unit line that a later empty assignment may have cleared.
for guarded_unit in "$PROXY_UNIT" "$PAYMENTS_UNIT" backup status-check; do
  if ! guarded_unit_text="$(systemctl --no-pager cat "$guarded_unit" 2>/dev/null)" ||
     ! restore_has_effective_negative_path_condition \
       /var/lib/nullsink/.restore-in-progress <<< "$guarded_unit_text"; then
    echo "!! $guarded_unit lacks an effective durable restore guard (it may be reset by a later drop-in)" >&2
    echo "!! deploy current units before --apply" >&2
    exit 1
  fi
  if { [ "$guarded_unit" = backup ] || [ "$guarded_unit" = status-check ]; } &&
     ! restore_has_effective_negative_path_condition \
       /var/lib/nullsink/.restore-activation-pending <<< "$guarded_unit_text"; then
    echo "!! $guarded_unit.service lacks the effective activation-pending skip guard" >&2
    echo "!! deploy current units before --apply (an immediately-due timer could otherwise false-page)" >&2
    exit 1
  fi
done

# Every live-ledger SQLite command runs as the service user. Besides ownership, this is important in WAL
# mode: a root SELECT/.backup can create root-owned -shm/-wal sidecars and break the next service write.
service_sqlite() { sudo -u "$SVC_USER" sqlite3 "$@"; }
# shellcheck disable=SC2329 # invoked indirectly by name from restore_swap_db
service_preserve_db() {
  local live="$1" previous="$2" quick
  if restore_preserve_sqlite service_sqlite "$live" "$previous"; then return 0; fi
  [ "$archive_unreadable_live" -eq 1 ] || return 1

  # The break-glass flag is for an unreadable/corrupt live database, not a convenient way around a failed
  # destination write. If SQLite can still prove the source healthy, require the logical .backup path to be
  # repaired instead of replacing a recoverable ledger with a raw forensic tar.
  quick="$(service_sqlite "$live" 'PRAGMA quick_check;' 2>&1 | head -1 || true)"
  if [ "$quick" = ok ]; then
    echo "!! $live is readable; logical preservation failed for another reason" >&2
    echo "!! refusing --archive-unreadable-live — repair space/permissions/sqlite and retry normally" >&2
    return 1
  fi
  echo "!! BREAK GLASS: SQLite cannot preserve $(basename "$live"); archiving raw main/WAL/SHM bytes" >&2
  echo "!! the raw archive is forensic material, not a validated recovery database" >&2
  restore_archive_unreadable_db "$live" "$previous-unreadable.tar"
}

if [ "$restore_activation_resuming" -eq 1 ]; then
  echo "RESUMING activation of the already-validated restored pair (no ledger files will be replaced)…"
  restore_prepare_activation_resume \
    "$DB_DIR" "$restore_pair_id" "$PROXY_UNIT" "$PAYMENTS_UNIT" || exit 1
else
  # A balances-only artifact is valid for a box that never had payments, but applying it over a live
  # pending.db would be a one-DB rewind. Current ack tombstones make that partial restore unrecoverable.
  restore_require_matched_pair "$work" "$DB_DIR" || exit 1

  staged=()
  for db in balances.db pending.db; do
    [ -f "$work/$db" ] || continue
    install -o "$SVC_USER" -g "$SVC_USER" -m 600 "$work/$db" "$DB_DIR/.$db.restoring"   # fails here = live DBs untouched
    staged+=("$db")
  done

# Payments first, proxy second: payments is the only writer of pending.db, and the proxy owns the credit
# socket it delivers over. Stopping the sender before its receiver avoids a burst of doomed connects.
  echo "STOPPING $PAYMENTS_UNIT + $PROXY_UNIT to swap in the restored ledger…"
# The marker is fsynced before either service stops or either DB moves. Both committed service units carry a
# matching ConditionPathExists= guard, so SIGKILL/power loss at ANY later boundary boots fail-closed instead
# of pairing one restored ledger with one old ledger.
  restore_arm_guard "$DB_DIR" "$restore_pair_id" || exit 1

# A quiesce failure happens before either ledger moves. Remove the boot gate first (otherwise the Condition=
# on each app/backup unit makes a "start" look successful while leaving it skipped), then restore the normal
# app + timer posture best-effort. Never leave monitoring/payments silently down after reporting "no ledger
# was changed". A failure to remove the marker stays fail-closed and requires operator recovery.
restore_abort_before_swap() { # $1=reason
  local reason="$1" recovery_ok=1
  if ! restore_disarm_guard "$DB_DIR"; then
    echo "!! $reason; no ledger was changed, but the restore guard could not be removed" >&2
    echo "!! services remain gated; recover $DB_DIR/.restore-in-progress before starting them" >&2
    return 0
  fi
  systemctl start "$PROXY_UNIT" >/dev/null 2>&1 || recovery_ok=0
  systemctl start "$PAYMENTS_UNIT" >/dev/null 2>&1 || recovery_ok=0
  systemctl start status-check.timer >/dev/null 2>&1 || recovery_ok=0
  systemctl start backup.timer >/dev/null 2>&1 || recovery_ok=0
  echo "!! $reason; no ledger was changed" >&2
  if [ "$recovery_ok" -ne 1 ]; then
    echo "!! pre-restore service/timer recovery was incomplete; inspect systemd before retrying" >&2
  fi
}

if ! systemctl stop backup.timer || ! systemctl stop status-check.timer ||
   ! systemctl stop backup.service || ! systemctl stop status-check.service; then
  restore_abort_before_swap "could not quiesce backup/status jobs"
  exit 1
fi
if ! systemctl stop "$PAYMENTS_UNIT"; then
  restore_abort_before_swap "could not stop $PAYMENTS_UNIT"
  exit 1
fi
if ! systemctl stop "$PROXY_UNIT"; then
  restore_abort_before_swap "could not stop $PROXY_UNIT"
  exit 1
fi
for db in "${staged[@]}"; do
  # Keep the first true pre-restore ledger across re-runs. The preservation callback uses SQLite .backup,
  # producing a standalone recovery DB that includes committed WAL frames before activation can proceed.
  restore_swap_db "$DB_DIR" "$db" service_preserve_db || {
    echo "!! failed to preserve/swap $db — services remain stopped; live/staged files left for recovery" >&2
    exit 1
  }
  if [ -e "$DB_DIR/$db.prerestore" ]; then
    echo "restored $db (previous kept as $db.prerestore)"
  else
    echo "restored $db (unreadable previous bytes kept as $db.prerestore-unreadable.tar)"
  fi
done

# --- Re-arm the credit outbox. Any restore rewinds ONE database relative to the other, and the two carry
# opposite halves of a credit: pending.db's credit_outbox says "this credit was delivered" (acked_at set),
# balances.db's applied_orders says "this credit was received". Restore a pair where the outbox claims a
# delivery the ledger never saw and that customer's PAID credit is silently gone forever — the sender skips
# acked rows, and nothing else remembers the debt. backup.sh now orders its snapshots so a single artifact
# can't be skewed that way, but a partial restore (one DB, not the other) or an artifact written by an older
# backup.sh still can be.
#
# For LEGACY acked rows that still retain their payload, un-ack exactly those the RESTORED ledger has not
# applied; the poller redelivers them next tick. Safe by construction: applied_orders is never purged in the
# outbox era, and creditOnce is idempotent on the same key. Current ack tombstones are irreversible, so a
#
# NEVER un-ack a TOMBSTONE. Every definite delivery ack now scrubs hash/micros to ''/0; older databases may
# also contain marker rows with that shape. Un-acking one hands the sender an undeliverable empty hash and
# wedges every genuine credit queued behind it. `hash <> ''` selects only legacy acked rows whose delivery
# payload is still recoverable.
#
# This means a partial/skewed restore cannot reconstruct a credit when pending.db contains an ack tombstone
# but the restored balances.db predates that credit: the privacy deletion is intentionally irreversible.
# Restore the matched backup pair (backup.sh snapshots pending before balances) or recover the original DB
# pair kept as *.prerestore; never treat re-arming legacy rows as a substitute for a consistent pair.
#
# Run as the SERVICE USER: root would open these WAL databases and strand root-owned -wal/-shm sidecars that
# break the services' billing writes (the same trap cli/guard.ts exists to prevent).
if [ -f "$DB_DIR/pending.db" ]; then
  command -v sqlite3 >/dev/null || {
    echo "!! sqlite3 disappeared after staging — cannot verify/re-arm the restored outbox; services remain stopped" >&2
    exit 1
  }
  # This is the ONLY thing standing between a rewound ledger and a permanently-skipped paid credit, so it must
  # never fail quietly. The service is stopped and the databases are already swapped: abort LOUDLY and leave it
  # stopped rather than starting a box whose outbox still claims undelivered credits were delivered.
  rearm_or_abort() {  # $1=sql — run as the service user; echo the last output line; abort with the error on failure
    local out
    if ! out="$(service_sqlite "$DB_DIR/pending.db" "$1" 2>&1)"; then
      echo "!! credit-outbox re-arm FAILED — sqlite3 said:" >&2
      printf '%s\n' "$out" >&2
      echo "!! The databases ARE restored but the outbox was NOT re-armed, so a paid credit may be marked" >&2
      echo "!! delivered while the restored ledger never received it. $PROXY_UNIT + $PAYMENTS_UNIT are left" >&2
      echo "!! STOPPED on purpose. Fix the cause, re-run this script, and only then start them." >&2
      exit 1
    fi
    printf '%s\n' "$out" | tail -1
  }

  if ! has_outbox="$(restore_probe_table service_sqlite "$DB_DIR/pending.db" credit_outbox)"; then
    echo "!! restored outbox compatibility is unknown; $PROXY_UNIT + $PAYMENTS_UNIT remain stopped" >&2
    exit 1
  fi
  has_applied=0
  if [ -f "$DB_DIR/balances.db" ]; then
    if ! has_applied="$(restore_probe_table service_sqlite "$DB_DIR/balances.db" applied_orders)"; then
      echo "!! restored ledger compatibility is unknown; $PROXY_UNIT + $PAYMENTS_UNIT remain stopped" >&2
      exit 1
    fi
  fi

  if [ "$has_outbox" = 1 ] && [ "$has_applied" = 1 ]; then
    # The extracted pair passed check_tombstone_pair before any live mutation. Reconcile only retained legacy
    # payloads; current tombstones already have matching applied markers by that preflight proof.
    rearmed="$(rearm_or_abort "$(restore_legacy_rearm_sql "$DB_DIR/balances.db")")"
    echo "credit outbox re-armed: ${rearmed:-0} credit(s) acked in pending.db but absent from the restored ledger — the poller will redeliver them"
  elif [ "$has_outbox" = 1 ]; then
    # The preflight check proved there are no ACKNOWLEDGED rows at all. Unacked work is already live, so there
    # is nothing to re-arm; starting the service creates the receiver table before delivery begins.
    echo "credit outbox needs no re-arm (restored balances.db predates applied_orders; all outbox rows are unacked)"
  else
    echo "skip credit-outbox re-arm (this pending.db predates the outbox)"
  fi
else
  echo "skip credit-outbox re-arm (no pending.db)"
fi
fi # fresh/swap phase; activation-only resume deliberately skips every staging and ledger mutation above

# Re-check the now-live pair after every swap/re-arm and before every activation retry. This runs as the
# service user while the swap guard is armed and the participants are stopped. An activation-only resume
# preserves post-restore writes and the original *.prerestore material; it never copies the artifact again.
check_tombstone_pair "$DB_DIR/pending.db" "$DB_DIR/balances.db" "restored live pair" service_sqlite || exit 1
if ! restore_run_activation_phase \
  "$DB_DIR" "$restore_pair_id" "$PROXY_UNIT" "$PAYMENTS_UNIT" restore_health_ok_app \
  "$PROXY_UNIT" "$PAYMENTS_UNIT" status-check.timer backup.timer; then
  exit 1
fi
echo "--- restored + both services and timers active; both application /healthz checks passed."
echo "    Verify restored balances with the financials CLI; watch for '[credit] delivered N credit(s)' in:"
echo "      journalctl -u $PAYMENTS_UNIT -f"
echo "    then remove the $DB_DIR/*.prerestore* safety material once you're happy. ---"
exit 0
