#!/usr/bin/env bash
# Consistent, optionally-encrypted backup of the billing DBs. Run daily by backup.timer AS THE SERVICE USER
# (User=nullsink in backup.service), so the SQLite sidecars it touches stay service-owned — a root
# `.backup` leaves root-owned -wal/-shm that break the service's billing writes.
#
# Holds the shared ledger-maintenance lock for the run, then uses sqlite3 `.backup`, which snapshots a
# CONSISTENT copy even while the service is writing under WAL (a plain `cp` is NOT safe). Produces ONE
# timestamped artifact in BACKUP_DIR, published only after validation + fsync + atomic rename:
#   - if BACKUP_AGE_RECIPIENT is set: an age-encrypted tar (`.tar.age`) — REQUIRED posture for OFF-BOX
#     copies: the box holds only the public recipient, so a box compromise can't decrypt past backups.
#   - else: a plain tar (fine for an on-box copy; do NOT push an unencrypted tar off-box).
# If BACKUP_PUSH_CMD is set, it's run as a shell snippet with $ARTIFACT = the finished artifact path, to
# ship it off-box (scp/rsync/rclone — your choice; destination-agnostic). Prunes to BACKUP_KEEP newest.
#
# Env (all optional; sane defaults): DB_DIR, BACKUP_DIR, BACKUP_AGE_RECIPIENT, BACKUP_PUSH_CMD, BACKUP_KEEP.
set -euo pipefail
umask 077

# shellcheck source=deploy/backup-safety.sh
source "$(dirname "$0")/backup-safety.sh"
# shellcheck source=deploy/maintenance-lock.sh
source "$(dirname "$0")/maintenance-lock.sh"

command -v sqlite3 >/dev/null || { echo "sqlite3 not found (apt-get install sqlite3)" >&2; exit 1; }

DB_DIR="${DB_DIR:-/var/lib/nullsink}"
BACKUP_DIR="${BACKUP_DIR:-$DB_DIR/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"
acquire_backup_run_lock "$BACKUP_DIR" || exit 1
acquire_ledger_shared_lock "$DB_DIR" "ledger backup" || exit 1
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
artifact_tmp=""
# shellcheck disable=SC2329 # invoked by the EXIT trap below
cleanup_backup() {
  rm -rf "$work"
  if [ -n "$artifact_tmp" ] && { [ -e "$artifact_tmp" ] || [ -L "$artifact_tmp" ]; }; then
    rm -f "$artifact_tmp"
  fi
}
trap cleanup_backup EXIT

# Consistent snapshots via .backup (NOT cp). The CLI opens its OWN connection, so set a busy_timeout (the
# app's PRAGMA doesn't apply here) — else a concurrent settler write lock returns SQLITE_BUSY and aborts the
# run. Both ledgers are mandatory on current installations; a missing pending.db is a page-worthy failure.
#
# ORDER IS LOAD-BEARING: pending.db FIRST, then balances.db. The two hold opposite halves of a credit —
# pending.db's credit_outbox records that a credit was DELIVERED (acked_at), balances.db's applied_orders that
# it was RECEIVED — and the snapshots are seconds apart, so one is always slightly stale. Snapshot pending
# first and the staleness only ever runs the safe way: every ack in the artifact's outbox is backed by a
# marker in the artifact's (later) ledger. Reverse the order and a settle+ack landing between the two writes
# an artifact whose outbox claims a delivery the ledger never saw, and restoring it silently destroys a
# customer's PAID credit — the sender skips acked rows, and nothing else remembers the debt. The opposite
# skew is harmless: a credit applied after pending's snapshot is simply redelivered on the next poll and lands
# as already_applied (creditOnce is idempotent). Restore this matched pair. A one-DB/skewed restore cannot
# reconstruct an acknowledged credit after its outbox payload has been privacy-scrubbed; restore.sh can only
# re-arm legacy acked rows that still retain a real hash and amount.
backup_snapshot_databases "$DB_DIR" "$work"

# Bitcoin watch-only wallet LABELS (address→order-index map). These are wallet-local metadata — NOT on-chain
# and NOT re-derivable from the descriptor/seed — so a bitcoind datadir loss would orphan the deposit→order
# mapping for any paid-but-unconfirmed BTC order (the spend key being cold-recoverable does NOT recover them).
# pending.db is the authoritative recovery source for open orders' address→index; this duplicates it into
# the same artifact as a belt-and-suspenders. Persist the RPC's RAW JSON (no bash JSON
# assembly) via ONE read-only listreceivedbyaddress call. Skipped unless the BTC rail is configured
# (BITCOIN_RPC_URL set, e.g. via EnvironmentFile in backup.service) and the node answers — a transient
# bitcoind outage must NOT fail the money-DB backup, so this only WARNs.
if [ -n "${BITCOIN_RPC_URL:-}" ] && command -v curl >/dev/null; then
  auth=()
  [ -n "${BITCOIN_RPC_USER:-}" ] && auth=(--user "$BITCOIN_RPC_USER:${BITCOIN_RPC_PASSWORD:-}")
  if curl -fsS --max-time 15 "${auth[@]}" -H 'content-type: application/json' \
      --data '{"jsonrpc":"1.0","id":"backup","method":"listreceivedbyaddress","params":[0,true,true]}' \
      "$BITCOIN_RPC_URL" -o "$work/bitcoin-wallet-labels.json" 2>/dev/null; then
    files+=(bitcoin-wallet-labels.json)
  else
    echo "backup: WARN bitcoind label export skipped (BITCOIN_RPC_URL set but node/wallet unreachable)" >&2
  fi
fi

# Archive the named snapshots only (not `.`), so the in-progress tar can't include itself.
tar -C "$work" -cf "$work/backup.tar" "${files[@]}"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo "BACKUP_AGE_RECIPIENT set but 'age' is not installed (apt-get install age)" >&2; exit 1; }
  artifact="$BACKUP_DIR/backup-$STAMP.tar.age"
  artifact_tmp="$(mktemp "$BACKUP_DIR/.backup-$STAMP.tar.age.partial.XXXXXX")"
  age -r "$BACKUP_AGE_RECIPIENT" "$work/backup.tar" > "$artifact_tmp"
  artifact_format=age
else
  artifact="$BACKUP_DIR/backup-$STAMP.tar"
  artifact_tmp="$(mktemp "$BACKUP_DIR/.backup-$STAMP.tar.partial.XXXXXX")"
  cp "$work/backup.tar" "$artifact_tmp"
  artifact_format=tar
fi
backup_publish_candidate "$artifact_tmp" "$artifact" "$artifact_format"
artifact_tmp=""
echo "backup: $artifact ($(stat -c %s "$artifact" 2>/dev/null || echo '?') bytes)"

# Ship off-box (operator-configured; destination-agnostic). $ARTIFACT is the finished file. REFUSE to push
# an UNENCRYPTED artifact: pending.db carries the subaddr→token link the two-DB split exists to isolate, so
# a plaintext off-box copy is the worst privacy regression in the system. There is deliberately no override:
# transport encryption does not protect the destination's at-rest copy.
backup_push_artifact "$artifact" "${BACKUP_PUSH_CMD:-}" || exit 1

# Retention: keep the BACKUP_KEEP most-recent artifacts, prune older ones. Collect via mapfile (NOT a
# bare `ls | tail` pipeline): under `set -euo pipefail`, one of the two globs is ALWAYS unmatched (a box has
# only .tar OR .tar.age), so `ls` exits non-zero and pipefail would abort the whole script AFTER a perfectly
# good backup — a false page on every run. The process substitution swallows ls's exit; mapfile returns 0.
arts=()
while IFS= read -r f; do arts+=("$f"); done < <(ls -1t "$BACKUP_DIR"/backup-*.tar "$BACKUP_DIR"/backup-*.tar.age 2>/dev/null)
if [ "${#arts[@]}" -gt "$BACKUP_KEEP" ]; then
  for old in "${arts[@]:$BACKUP_KEEP}"; do rm -f "$old" && echo "pruned: $(basename "$old")"; done
fi
exit 0
