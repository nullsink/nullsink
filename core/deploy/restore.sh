#!/usr/bin/env bash
# Restore the billing DBs from a backup.sh artifact. DEFAULT is a SAFE DRY-RUN: decrypt + extract to a temp
# dir and run PRAGMA integrity_check on each DB, touching NOTHING live. Pass --apply to actually replace the
# live DBs (stops both services, installs the files service-owned, re-arms the credit outbox, restarts). A
# dry-run is also how you TEST a backup is restorable without risking production.
#
# Decryption (.tar.age artifacts) needs your age IDENTITY (private key), which is kept OFFLINE, NOT on the
# box. So verify on your secure machine (dry-run there), and for a real --apply provide the key transiently
# via BACKUP_AGE_IDENTITY. A plain .tar artifact needs no key.
#
# Usage:
#   restore.sh <artifact>            # dry-run: verify integrity, report, change nothing
#   restore.sh --apply <artifact>    # DESTRUCTIVE: replace the live DBs (stops/starts both services)
# Env: DB_DIR, SVC_USER, PROXY_UNIT, PAYMENTS_UNIT, BACKUP_AGE_IDENTITY (age key file, for .tar.age artifacts).
set -euo pipefail

apply=0
if [ "${1:-}" = "--apply" ]; then apply=1; shift; fi
artifact="${1:-}"
if [ -z "$artifact" ] || [ ! -f "$artifact" ]; then
  echo "usage: restore.sh [--apply] <artifact>   (default is a safe dry-run)" >&2
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

# Verify each extracted DB before trusting it (a backup that won't open is no backup).
for db in "$work/balances.db" "$work/pending.db"; do
  [ -f "$db" ] || continue
  res="$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -1)"
  if [ "$res" = "ok" ]; then echo "integrity OK: $(basename "$db")"
  else echo "integrity FAILED: $(basename "$db"): $res" >&2; exit 1; fi
done

if [ "$apply" -eq 0 ]; then
  echo "--- dry-run OK: the artifact is intact and restorable. Re-run with --apply to restore for real. ---"
  exit 0
fi

# --apply: replace the live ledger. Assert root FIRST — the install/chown + systemctl below need it, and we
# must NOT stop the service and then fail before restoring. STAGE the verified snapshots next to the live
# DBs (so a live copy is never deleted before its replacement is in hand); then, service stopped, swap them
# in, keeping the previous live DB as <db>.prerestore for recovery. The snapshots are already checkpointed,
# so the stale -wal/-shm are dropped.
[ "$(id -u)" -eq 0 ] || { echo "--apply must run as root (it installs files + (re)starts the services)" >&2; exit 1; }

staged=()
for db in balances.db pending.db; do
  [ -f "$work/$db" ] || continue
  install -o "$SVC_USER" -g "$SVC_USER" -m 600 "$work/$db" "$DB_DIR/.$db.restoring"   # fails here = live DBs untouched
  staged+=("$db")
done

# Payments first, proxy second: payments is the only writer of pending.db, and the proxy owns the credit
# socket it delivers over. Stopping the sender before its receiver avoids a burst of doomed connects.
echo "STOPPING $PAYMENTS_UNIT + $PROXY_UNIT to swap in the restored ledger…"
systemctl stop "$PAYMENTS_UNIT" "$PROXY_UNIT"
for db in "${staged[@]}"; do
  [ -e "$DB_DIR/$db" ] && mv -f "$DB_DIR/$db" "$DB_DIR/$db.prerestore"   # keep the old copy, recoverable
  mv -f "$DB_DIR/.$db.restoring" "$DB_DIR/$db"
  rm -f "$DB_DIR/$db-wal" "$DB_DIR/$db-shm"
  echo "restored $db (previous kept as $db.prerestore)"
done

# --- Re-arm the credit outbox. Any restore rewinds ONE database relative to the other, and the two carry
# opposite halves of a credit: pending.db's credit_outbox says "this credit was delivered" (acked_at set),
# balances.db's applied_orders says "this credit was received". backup.sh snapshots balances.db BEFORE
# pending.db, so a settle+ack landing between the two writes an artifact whose outbox claims a delivery the
# ledger never saw. Restore it verbatim and that customer's PAID credit is silently gone forever — the sender
# skips acked rows.
#
# So un-ack exactly the rows the RESTORED ledger has not applied, and the poller redelivers them on its next
# tick. Safe by construction: applied_orders is never purged, and creditOnce is idempotent on the same
# idempotency_key — a redelivery of an already-applied credit is a no-op that reports already_applied. We
# scope it with a cross-DB ATTACH rather than un-acking everything, so a box with a long history redelivers
# only what is genuinely missing instead of its entire lifetime of credits.
#
# Run as the SERVICE USER: root would open these WAL databases and strand root-owned -wal/-shm sidecars that
# break the services' billing writes (the same trap cli/guard.ts exists to prevent).
if [ -f "$DB_DIR/pending.db" ] && command -v sqlite3 >/dev/null; then
  has_outbox="$(sudo -u "$SVC_USER" sqlite3 "$DB_DIR/pending.db" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='credit_outbox';" 2>/dev/null || echo 0)"
  has_applied=0
  if [ -f "$DB_DIR/balances.db" ]; then
    has_applied="$(sudo -u "$SVC_USER" sqlite3 "$DB_DIR/balances.db" \
      "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='applied_orders';" 2>/dev/null || echo 0)"
  fi
  # NEVER un-ack a TOMBSTONE. reconcileOutbox (the D5 cutover) seeds one acked row per already-applied key with
  # hash='' and micros=0, purely to stop a pre-cutover zombie double-booking its sale; the real credit landed
  # before the cutover and its values were never recorded here. Un-acking one hands the sender a row whose empty
  # hash fails parseCreditRequest's 64-hex check, so the proxy 400s it, the sender treats that as ambiguous and
  # stops at the head -- wedging every genuine credit queued behind it until an operator intervenes. Restoring a
  # balances.db OLDER than the tombstones (a partial restore, or mixed artifacts) is exactly when their keys go
  # missing from applied_orders, which is exactly when the re-arm would grab them. `hash <> ''` selects real
  # credits only: settle() always enqueues a 64-hex token hash, and nothing but reconcileOutbox writes ''.
  # The re-arm is the ONLY thing standing between a rewound ledger and a permanently-skipped paid credit, so it
  # must never fail quietly. The services are already stopped and the databases already swapped at this point:
  # abort LOUDLY and leave them stopped rather than starting a box whose outbox still claims undelivered credits
  # were delivered. (Discarding stderr here would turn a lock/ATTACH/disk error into a bare non-zero exit.)
  rearm_or_abort() {  # $1=sql — run as the service user; echo the last output line; abort with the error on failure
    local out
    if ! out="$(sudo -u "$SVC_USER" sqlite3 "$DB_DIR/pending.db" "$1" 2>&1)"; then
      echo "!! credit-outbox re-arm FAILED — sqlite3 said:" >&2
      printf '%s\n' "$out" >&2
      echo "!! The databases ARE restored but the outbox was NOT re-armed, so a paid credit may be marked" >&2
      echo "!! delivered while the restored ledger never received it. $PROXY_UNIT + $PAYMENTS_UNIT are left" >&2
      echo "!! STOPPED on purpose. Fix the cause, re-run this script, and only then start them." >&2
      exit 1
    fi
    printf '%s\n' "$out" | tail -1
  }

  if [ "$has_outbox" = 1 ] && [ "$has_applied" = 1 ]; then
    rearmed="$(rearm_or_abort \
      "ATTACH '$DB_DIR/balances.db' AS bal;
       UPDATE credit_outbox SET acked_at = NULL
        WHERE acked_at IS NOT NULL
          AND hash <> ''
          AND idempotency_key NOT IN (SELECT order_id FROM bal.applied_orders);
       SELECT changes();")"
    echo "credit outbox re-armed: ${rearmed:-0} credit(s) acked in pending.db but absent from the restored ledger — the poller will redeliver them"
  elif [ "$has_outbox" = 1 ]; then
    # An old balances.db with no applied_orders can't tell us what it already has. Un-ack every REAL credit:
    # each redelivery is idempotent, so the cost is a slow first tick, never a double credit.
    rearm_or_abort "UPDATE credit_outbox SET acked_at = NULL WHERE hash <> '';" >/dev/null
    echo "credit outbox re-armed: ALL real credits (restored balances.db has no applied_orders table to reconcile against)"
  fi
else
  echo "skip credit-outbox re-arm (no pending.db, or sqlite3 not installed — apt-get install sqlite3)"
fi

systemctl start "$PROXY_UNIT" "$PAYMENTS_UNIT"
echo "--- restored + both services restarted. Verify with the financials CLI + curl localhost:8080/healthz"
echo "    and localhost:8081/healthz; watch for '[credit] delivered N credit(s)' in:"
echo "      journalctl -u $PAYMENTS_UNIT -f"
echo "    then remove the $DB_DIR/*.prerestore safety copies once you're happy. ---"
exit 0
