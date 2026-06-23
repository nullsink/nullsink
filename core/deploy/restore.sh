#!/usr/bin/env bash
# Restore the billing DBs from a backup.sh artifact. DEFAULT is a SAFE DRY-RUN: decrypt + extract to a temp
# dir and run PRAGMA integrity_check on each DB, touching NOTHING live. Pass --apply to actually replace the
# live DBs (stops the service, installs the files service-owned, restarts). A dry-run is also how you TEST a
# backup is restorable without risking production.
#
# Decryption (.tar.age artifacts) needs your age IDENTITY (private key), which is kept OFFLINE, NOT on the
# box. So verify on your secure machine (dry-run there), and for a real --apply provide the key transiently
# via BACKUP_AGE_IDENTITY. A plain .tar artifact needs no key.
#
# Usage:
#   restore.sh <artifact>            # dry-run: verify integrity, report, change nothing
#   restore.sh --apply <artifact>    # DESTRUCTIVE: replace the live DBs (stops/starts the service)
# Env: DB_DIR, SVC_USER, SVC_UNIT, BACKUP_AGE_IDENTITY (age key file, for .tar.age artifacts).
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
SVC_UNIT="${SVC_UNIT:-nullsink}"

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
[ "$(id -u)" -eq 0 ] || { echo "--apply must run as root (it installs files + (re)starts the service)" >&2; exit 1; }

staged=()
for db in balances.db pending.db; do
  [ -f "$work/$db" ] || continue
  install -o "$SVC_USER" -g "$SVC_USER" -m 600 "$work/$db" "$DB_DIR/.$db.restoring"   # fails here = live DBs untouched
  staged+=("$db")
done

echo "STOPPING $SVC_UNIT to swap in the restored ledger…"
systemctl stop "$SVC_UNIT"
for db in "${staged[@]}"; do
  [ -e "$DB_DIR/$db" ] && mv -f "$DB_DIR/$db" "$DB_DIR/$db.prerestore"   # keep the old copy, recoverable
  mv -f "$DB_DIR/.$db.restoring" "$DB_DIR/$db"
  rm -f "$DB_DIR/$db-wal" "$DB_DIR/$db-shm"
  echo "restored $db (previous kept as $db.prerestore)"
done
systemctl start "$SVC_UNIT"
echo "--- restored + $SVC_UNIT restarted. Verify with the financials CLI + curl localhost:8080/healthz,"
echo "    then remove the $DB_DIR/*.prerestore safety copies once you're happy. ---"
exit 0
