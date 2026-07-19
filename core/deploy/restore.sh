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

# Validate the cross-database money invariant, not just each SQLite file in isolation. A delivered tombstone
# has intentionally forgotten its hash + amount, so unlike a legacy acknowledged payload it CANNOT be re-armed
# to repair an older/mismatched balances.db. Every tombstone in the artifact must therefore have the matching
# applied_orders marker in the SAME artifact. Refuse poison/half-scrubbed rows too: an unacked tombstone would
# head-of-line block every real credit behind it.
if [ -f "$work/pending.db" ]; then
  artifact_has_outbox="$(sqlite3 "$work/pending.db" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='credit_outbox';")"
  if [ "$artifact_has_outbox" = 1 ]; then
    invalid_rows="$(sqlite3 "$work/pending.db" \
      "SELECT COUNT(*) FROM credit_outbox
        WHERE (acked_at IS NULL AND (hash = '' OR micros < 0))
           OR (acked_at IS NOT NULL AND ((hash = '' AND micros <> 0) OR (hash <> '' AND micros < 0))); ")"
    [ "$invalid_rows" = 0 ] || {
      echo "billing invariant FAILED: pending.db has $invalid_rows poison or partially scrubbed credit-outbox row(s)" >&2
      exit 1
    }

    tombstones="$(sqlite3 "$work/pending.db" \
      "SELECT COUNT(*) FROM credit_outbox WHERE acked_at IS NOT NULL AND hash = '' AND micros = 0;")"
    if [ "$tombstones" -gt 0 ]; then
      artifact_has_applied="$(sqlite3 "$work/balances.db" \
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='applied_orders';")"
      [ "$artifact_has_applied" = 1 ] || {
        echo "billing invariant FAILED: pending.db has scrubbed delivery tombstones but balances.db has no applied_orders table" >&2
        exit 1
      }
      missing_markers="$(sqlite3 "$work/pending.db" \
        "ATTACH '$work/balances.db' AS bal;
         SELECT COUNT(*) FROM credit_outbox AS outbox
          WHERE outbox.acked_at IS NOT NULL AND outbox.hash = '' AND outbox.micros = 0
            AND NOT EXISTS (SELECT 1 FROM bal.applied_orders AS applied
                             WHERE applied.order_id = outbox.idempotency_key);")"
      [ "$missing_markers" = 0 ] || {
        echo "billing invariant FAILED: $missing_markers scrubbed credit tombstone(s) have no matching ledger marker — DB snapshots are mismatched" >&2
        exit 1
      }
      echo "billing pair OK: $tombstones scrubbed delivery tombstone(s) backed by ledger markers"
    fi
  fi
fi

if [ "$apply" -eq 0 ]; then
  echo "--- dry-run OK: the artifact is intact and internally consistent. Re-run with --apply to restore for real. ---"
  exit 0
fi

# --apply: replace the live ledger. Assert root FIRST — the install/chown + systemctl below need it, and we
# must NOT stop the service and then fail before restoring. STAGE the verified snapshots next to the live
# DBs (so a live copy is never deleted before its replacement is in hand); then, service stopped, swap them
# in, keeping the previous live DB as <db>.prerestore for recovery. The snapshots are already checkpointed,
# so the stale -wal/-shm are dropped.
[ "$(id -u)" -eq 0 ] || { echo "--apply must run as root (it installs files + (re)starts the services)" >&2; exit 1; }

# A balances-only restore over a scrub-era pending.db can rewind the receiver below acknowledgements whose
# payloads no longer exist. There is nothing safe to redeliver, so prohibit that partial restore. Historical
# balances-only artifacts remain applicable only to installations that do not yet have pending.db.
if [ ! -f "$work/pending.db" ] && [ -f "$DB_DIR/pending.db" ]; then
  echo "unsafe partial restore refused: artifact has balances.db but no pending.db; scrub-era billing DBs must be restored as a matched pair" >&2
  exit 1
fi

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
  # Keep the pre-restore ledger, recoverable — but NEVER clobber an existing .prerestore. A failed re-arm tells
  # the operator to re-run this script; on that second --apply the live DB is already the RESTORED one, so a
  # plain `mv -f` would overwrite the ORIGINAL pre-restore copy with restored data and lose the real ledger.
  # `-n` (no-clobber) preserves the first, true pre-restore snapshot across re-runs.
  [ -e "$DB_DIR/$db" ] && mv -n "$DB_DIR/$db" "$DB_DIR/$db.prerestore" && rm -f "$DB_DIR/$db"
  mv -f "$DB_DIR/.$db.restoring" "$DB_DIR/$db"
  rm -f "$DB_DIR/$db-wal" "$DB_DIR/$db-shm"
  echo "restored $db (previous kept as $db.prerestore)"
done

# --- Re-arm the credit outbox. Any restore rewinds ONE database relative to the other, and the two carry
# opposite halves of a credit: pending.db's credit_outbox says "this credit was delivered" (acked_at set),
# balances.db's applied_orders says "this credit was received". Restore a pair where the outbox claims a
# delivery the ledger never saw and that customer's PAID credit is silently gone forever — the sender skips
# acked rows, and nothing else remembers the debt. backup.sh now orders its snapshots so a single artifact
# can't be skewed that way, but a partial restore (one DB, not the other) or an artifact written by an older
# backup.sh still can be.
#
# So un-ack exactly the rows the RESTORED ledger has not applied, and the poller redelivers them on its next
# tick. Safe by construction: applied_orders is never purged in the outbox era, and creditOnce is idempotent
# on the same idempotency_key — a redelivery of an already-applied credit is a no-op. We scope it with a
# cross-DB ATTACH rather than un-acking everything, so a box with a long history redelivers only what is
# genuinely missing instead of its entire lifetime of credits.
#
# NEVER un-ack a TOMBSTONE. Current releases intentionally turn definitely delivered rows into hash='' and
# micros=0; older migrations may also contain marker-only rows. Un-acking one hands the sender an empty,
# undeliverable payload, wedging every genuine credit queued behind it. Artifact validation above already
# proved each scrubbed tombstone has a matching ledger marker. `hash <> ''` selects real credits only:
# settle() always enqueues a 64-hex token hash and nothing else writes ''.
#
# Run as the SERVICE USER: root would open these WAL databases and strand root-owned -wal/-shm sidecars that
# break the services' billing writes (the same trap cli/guard.ts exists to prevent).
if [ -f "$DB_DIR/pending.db" ] && command -v sqlite3 >/dev/null; then
  # This is the ONLY thing standing between a rewound ledger and a permanently-skipped paid credit, so it must
  # never fail quietly. The service is stopped and the databases are already swapped: abort LOUDLY and leave it
  # stopped rather than starting a box whose outbox still claims undelivered credits were delivered.
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

  has_outbox="$(sudo -u "$SVC_USER" sqlite3 "$DB_DIR/pending.db" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='credit_outbox';" 2>/dev/null || echo 0)"
  has_applied=0
  if [ -f "$DB_DIR/balances.db" ]; then
    has_applied="$(sudo -u "$SVC_USER" sqlite3 "$DB_DIR/balances.db" \
      "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='applied_orders';" 2>/dev/null || echo 0)"
  fi

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
  else
    echo "skip credit-outbox re-arm (this pending.db predates the outbox)"
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
