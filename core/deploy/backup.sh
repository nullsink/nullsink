#!/usr/bin/env bash
# Consistent, optionally-encrypted backup of the billing DBs. Run every four hours by backup.timer AS THE SERVICE USER
# (User=nullsink in backup.service), so the SQLite sidecars it touches stay service-owned — a root
# `.backup` leaves root-owned -wal/-shm that break the service's billing writes.
#
# Uses sqlite3 `.backup`, which snapshots a CONSISTENT copy even while the service is writing under WAL (a
# plain `cp` is NOT safe). Validates the matched pair, then atomically publishes ONE timestamped recovery
# artifact and ONE aggregate-only JSON report in BACKUP_DIR:
#   - if BACKUP_AGE_RECIPIENT is set: an age-encrypted tar (`.tar.age`) — REQUIRED posture for OFF-BOX
#     copies: the box holds only the public recipient, so a box compromise can't decrypt past backups.
#   - else: a plain tar (fine for an on-box copy; do NOT push an unencrypted tar off-box).
# If BACKUP_PUSH_CMD is set, it's run as a shell snippet with $ARTIFACT = the finished artifact path, to
# ship it off-box (scp/rsync/rclone — your choice; destination-agnostic). Prunes to BACKUP_KEEP newest.
#
# Env (all optional; sane defaults): DB_DIR, BACKUP_DIR, BACKUP_AGE_RECIPIENT, BACKUP_PUSH_CMD,
# BACKUP_PUSH_ALLOW_PLAINTEXT, BACKUP_KEEP, BACKUP_EXPORT_GROUP.
set -euo pipefail

command -v sqlite3 >/dev/null || { echo "sqlite3 not found (apt-get install sqlite3)" >&2; exit 1; }

DB_DIR="${DB_DIR:-/var/lib/nullsink}"
BACKUP_DIR="${BACKUP_DIR:-$DB_DIR/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-84}"   # six four-hour snapshots/day ≈ fourteen days
BACKUP_EXPORT_GROUP="${BACKUP_EXPORT_GROUP:-}"
[[ "$BACKUP_KEEP" =~ ^[0-9]+$ ]] && [ "$BACKUP_KEEP" -gt 0 ] || {
  echo "BACKUP_KEEP must be a positive integer" >&2
  exit 1
}
[[ -z "$BACKUP_EXPORT_GROUP" || "$BACKUP_EXPORT_GROUP" =~ ^[a-z_][a-z0-9_-]*$ ]] || {
  echo "BACKUP_EXPORT_GROUP is not a valid system group name" >&2
  exit 1
}
if [ -n "$BACKUP_EXPORT_GROUP" ] && command -v getent >/dev/null; then
  getent group "$BACKUP_EXPORT_GROUP" >/dev/null || {
    echo "BACKUP_EXPORT_GROUP does not exist: $BACKUP_EXPORT_GROUP" >&2
    exit 1
  }
fi
if [ -n "$BACKUP_EXPORT_GROUP" ] && [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
  echo "BACKUP_EXPORT_GROUP requires BACKUP_AGE_RECIPIENT — plaintext archives must not enter the export boundary" >&2
  exit 1
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_EPOCH_MS="$(( $(date -u +%s) * 1000 ))"
script_dir="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$BACKUP_DIR"
work="$(mktemp -d)"
artifact_tmp=""
report_tmp=""
# Invoked indirectly by trap.
# shellcheck disable=SC2329
cleanup() {
  status=$?
  rm -rf -- "$work"
  [ -z "$artifact_tmp" ] || rm -f -- "$artifact_tmp"
  [ -z "$report_tmp" ] || rm -f -- "$report_tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Default publication is owner-only. A pull collector can instead receive finalized files through one
# dedicated supplementary group; setup-export.sh gives that group only to backup.service and the restricted
# rsync account. Apply permissions to the hidden partial before the atomic rename, so a final name never
# appears with broader or incomplete permissions.
publish_permissions() {
  local path="$1"
  chmod 600 "$path"
  if [ -n "$BACKUP_EXPORT_GROUP" ]; then
    chgrp "$BACKUP_EXPORT_GROUP" "$path"
    chmod 640 "$path"
  fi
}

# Consistent snapshots via .backup (NOT cp). The CLI opens its OWN connection, so set a busy_timeout (the
# app's PRAGMA doesn't apply here) — else a concurrent settler write lock returns SQLITE_BUSY and aborts the
# run. pending.db may be absent (Anthropic-only / rail off) — skip it.
#
# ORDER IS LOAD-BEARING: pending.db FIRST, then balances.db. The two hold opposite halves of a credit —
# pending.db's credit_outbox records that a credit was DELIVERED (acked_at), balances.db's applied_orders that
# it was RECEIVED — and the snapshots are seconds apart, so one is always slightly stale. Snapshot pending
# first and the staleness only ever runs the safe way: every ack in the artifact's outbox is backed by a
# marker in the artifact's (later) ledger. Reverse the order and a settle+ack landing between the two writes
# an artifact whose outbox claims a delivery the ledger never saw, and restoring it silently destroys a
# customer's PAID credit — the sender skips acked rows, and nothing else remembers the debt. The opposite
# skew is harmless: a credit applied after pending's snapshot is simply redelivered on the next poll and lands
# as already_applied (creditOnce is idempotent). After delivery acknowledgement, the outbox scrubs hash/micros;
# those tombstones cannot reconstruct a credit. restore.sh therefore validates that every tombstone is backed
# by the later ledger snapshot, and a scrub-era restore must treat these two DBs as one matched artifact.
files=()
if [ -f "$DB_DIR/pending.db" ]; then
  sqlite3 -cmd '.timeout 10000' "$DB_DIR/pending.db" ".backup '$work/pending.db'"
  files+=(pending.db)
fi
sqlite3 -cmd '.timeout 10000' "$DB_DIR/balances.db" ".backup '$work/balances.db'"
files+=(balances.db)

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

# Validate the exact artifact we are about to encrypt. This checks each SQLite snapshot AND the cross-database
# delivered-credit invariant. A corrupt or mismatched pair must never acquire a final backup-* name for an
# off-box collector to trust. restore.sh's default is read-only and extracts into its own private temp dir.
"$script_dir/restore.sh" "$work/backup.tar" >/dev/null
echo "backup: coordinated snapshots validated"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo "BACKUP_AGE_RECIPIENT set but 'age' is not installed (apt-get install age)" >&2; exit 1; }
  artifact="$BACKUP_DIR/backup-$STAMP.tar.age"
  artifact_tmp="$BACKUP_DIR/.backup-$STAMP.tar.age.partial.$$"
  age -r "$BACKUP_AGE_RECIPIENT" -o "$artifact_tmp" "$work/backup.tar"
else
  artifact="$BACKUP_DIR/backup-$STAMP.tar"
  artifact_tmp="$BACKUP_DIR/.backup-$STAMP.tar.partial.$$"
  cp "$work/backup.tar" "$artifact_tmp"
fi
publish_permissions "$artifact_tmp"
[ ! -e "$artifact" ] || { echo "refusing to replace existing backup artifact: $artifact" >&2; exit 1; }
# A same-directory rename is atomic: pullers see either no final name or the complete closed artifact, never
# age's in-progress output. `-n` closes the check→rename race with an accidental concurrent manual run.
mv -n "$artifact_tmp" "$artifact"
[ ! -e "$artifact_tmp" ] || { echo "backup artifact name collision: $artifact" >&2; exit 1; }
artifact_tmp=""
echo "backup: $artifact ($(stat -c %s "$artifact" 2>/dev/null || echo '?') bytes)"

# Ship off-box (operator-configured; destination-agnostic). $ARTIFACT is the finished file. REFUSE to push
# an UNENCRYPTED artifact: pending.db carries the subaddr→token link the two-DB split exists to isolate, so
# a plaintext off-box copy is the worst privacy regression in the system. Set BACKUP_AGE_RECIPIENT, or
# BACKUP_PUSH_ALLOW_PLAINTEXT=1 to override (e.g. an encrypted-transport on-box→on-box hop).
if [ -n "${BACKUP_PUSH_CMD:-}" ]; then
  if [ -z "${BACKUP_AGE_RECIPIENT:-}" ] && [ "${BACKUP_PUSH_ALLOW_PLAINTEXT:-0}" != 1 ]; then
    echo "refusing to push an UNENCRYPTED artifact off-box — set BACKUP_AGE_RECIPIENT (or BACKUP_PUSH_ALLOW_PLAINTEXT=1)" >&2
    exit 1
  fi
  echo "push: shipping $(basename "$artifact") off-box"
  ARTIFACT="$artifact" bash -c "$BACKUP_PUSH_CMD"
fi

# The routine off-box view is generated from the same private snapshots as the validated artifact—not from
# live DBs—and is an explicit aggregate allowlist. Publish it only after the recovery artifact is durable.
# If reporting fails, set -e makes the service page while leaving the valid recovery artifact in place.
report="$BACKUP_DIR/report-$STAMP.json"
report_tmp="$BACKUP_DIR/.report-$STAMP.json.partial.$$"
pending_arg="-"
[ -f "$work/pending.db" ] && pending_arg="$work/pending.db"
"$script_dir/backup-report.sh" "$pending_arg" "$work/balances.db" "$report_tmp" \
  "$STAMP" "$(basename "$artifact")" "$SNAPSHOT_EPOCH_MS"
publish_permissions "$report_tmp"
[ ! -e "$report" ] || { echo "refusing to replace existing backup report: $report" >&2; exit 1; }
mv -n "$report_tmp" "$report"
[ ! -e "$report_tmp" ] || { echo "backup report name collision: $report" >&2; exit 1; }
report_tmp=""
echo "report: $report ($(stat -c %s "$report" 2>/dev/null || echo '?') bytes)"

# Retention: keep the BACKUP_KEEP most-recent artifacts, prune older ones. Collect via mapfile (NOT a
# bare `ls | tail` pipeline): under `set -euo pipefail`, one of the two globs is ALWAYS unmatched (a box has
# only .tar OR .tar.age), so `ls` exits non-zero and pipefail would abort the whole script AFTER a perfectly
# good backup — a false page on every run. The process substitution swallows ls's exit; mapfile returns 0.
arts=()
while IFS= read -r f; do arts+=("$f"); done < <(ls -1t "$BACKUP_DIR"/backup-*.tar "$BACKUP_DIR"/backup-*.tar.age 2>/dev/null)
if [ "${#arts[@]}" -gt "$BACKUP_KEEP" ]; then
  for old in "${arts[@]:$BACKUP_KEEP}"; do
    old_name="$(basename "$old")"
    old_stamp="${old_name#backup-}"
    old_stamp="${old_stamp%.tar.age}"
    old_stamp="${old_stamp%.tar}"
    rm -f -- "$old" "$BACKUP_DIR/report-$old_stamp.json" && echo "pruned: $old_name (+ matching report, if present)"
  done
fi
exit 0
