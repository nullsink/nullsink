#!/usr/bin/env bash
# Build the privacy-safe, off-box financial/health view for ONE coordinated backup pair. The inputs are
# backup.sh's private SQLite snapshots, never the live WAL databases. Output is deliberately aggregate-only:
# no token hash, address, transaction/idempotency key, per-token balance, or individual sale row crosses this
# control-plane boundary.
#
# Usage: backup-report.sh PENDING_DB_OR_DASH BALANCES_DB OUTPUT STAMP ARTIFACT_NAME SNAPSHOT_EPOCH_MS
#   STAMP is backup.sh's UTC YYYYMMDDTHHMMSSZ value. PENDING_DB_OR_DASH is '-' when the payment DB does not
#   exist (for example, a provider-only installation with no buy rail yet).
set -euo pipefail

die() { echo "backup-report: $*" >&2; exit 1; }

[ "$#" -eq 6 ] || die "usage: backup-report.sh PENDING_DB_OR_DASH BALANCES_DB OUTPUT STAMP ARTIFACT_NAME SNAPSHOT_EPOCH_MS"
pending="$1"
balances="$2"
output="$3"
stamp="$4"
artifact_name="$5"
snapshot_epoch_ms="$6"

command -v sqlite3 >/dev/null || die "sqlite3 not found"
[ -f "$balances" ] || die "balances snapshot not found: $balances"
[ "$pending" = - ] || [ -f "$pending" ] || die "pending snapshot not found: $pending"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "invalid snapshot stamp"
[[ "$artifact_name" =~ ^backup-[0-9]{8}T[0-9]{6}Z\.tar(\.age)?$ ]] || die "invalid artifact name"
[[ "$snapshot_epoch_ms" =~ ^[0-9]+$ ]] || die "invalid snapshot epoch"
[ ! -e "$output" ] || die "refusing to overwrite report output: $output"

# Exact money values are JSON strings. JavaScript and many JSON consumers cannot represent arbitrary integer
# micro-dollar totals exactly; rendering them as decimal text keeps the report lossless without inventing a
# floating-point financial interface.
liability_micros="$(sqlite3 -batch -noheader "$balances" \
  "SELECT CAST(COALESCE(SUM(balance), 0) AS TEXT) FROM tokens;")"

revenue='[]'
open_count=0
open_credit_micros=0
open_seen=0
undelivered_count=0
undelivered_micros=0
oldest_age_json=null

if [ "$pending" != - ]; then
  # One row per UTC day + asset is the finest routine finance view. It cannot be joined back to a token or
  # payment identifier, and unlike raw revenue rows it does not export an individual sale timestamp.
  revenue="$(sqlite3 -batch -noheader "$pending" \
    "SELECT COALESCE(json_group_array(json_object(
              'date', day,
              'asset', asset,
              'sales', sales,
              'credited_micros', credited_micros,
              'gross_micros', gross_micros
            )), '[]')
       FROM (
         SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day,
                asset,
                COUNT(*) AS sales,
                CAST(COALESCE(SUM(usd_micros), 0) AS TEXT) AS credited_micros,
                CAST(COALESCE(SUM(gross_micros), 0) AS TEXT) AS gross_micros
           FROM revenue
          GROUP BY day, asset
          ORDER BY day, asset
       );")"

  IFS='|' read -r open_count open_credit_micros open_seen < <(
    sqlite3 -batch -noheader -separator '|' "$pending" \
      "SELECT COUNT(*),
              CAST(COALESCE(SUM(credit_micros), 0) AS TEXT),
              COALESCE(SUM(CASE WHEN seen_at IS NULL THEN 0 ELSE 1 END), 0)
         FROM pending_orders;"
  )

  IFS='|' read -r undelivered_count undelivered_micros oldest_age_json < <(
    sqlite3 -batch -noheader -separator '|' "$pending" \
      "SELECT COUNT(*),
              CAST(COALESCE(SUM(micros), 0) AS TEXT),
              CASE WHEN COUNT(*) = 0 THEN 'null'
                   ELSE CAST(MAX(0, ($snapshot_epoch_ms - MIN(created_at)) / 1000) AS TEXT)
               END
         FROM credit_outbox
        WHERE acked_at IS NULL;"
  )
fi

created_at="${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z"
umask 077
printf '%s\n' \
  "{\"schema_version\":1,\"snapshot\":{\"created_at\":\"$created_at\",\"artifact\":\"$artifact_name\",\"validation\":\"restore-dry-run-ok\"},\"finance\":{\"revenue_by_day_asset\":$revenue,\"liability\":{\"outstanding_micros\":\"$liability_micros\"}},\"operations\":{\"open_orders\":{\"count\":$open_count,\"credit_micros\":\"$open_credit_micros\",\"payment_seen\":$open_seen},\"undelivered_credits\":{\"count\":$undelivered_count,\"micros\":\"$undelivered_micros\",\"oldest_age_seconds\":$oldest_age_json}}}" \
  > "$output"
