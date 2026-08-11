# Command-line tools

## Read-only `nsk`

`nsk` is an optional on-box reader with exactly two live commands:

```sh
sudo -u nullsink nsk balances [--format table|csv|json]
sudo -u nullsink nsk financials [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--format table|csv|json]
```

`balances` lists token hashes and current balances. `financials` combines the payment-side sales journal
with current aggregate liability. Both open SQLite read-only at the application level and refuse root by
default so SQLite cannot leave root-owned sidecars. They remain a temporary read-group exception; a focused
follow-up will replace them with service-owned reads and retire live database access.

Table output abbreviates token hashes. CSV and JSON contain full stable hashes; keep those exports on the
app box. `nsk` cannot issue credit, top up a token, inspect open orders, or perform recovery.

Install it explicitly with `sudo deploy/install-nsk.sh`. Subsequent releases keep an installed copy aligned
with the service version.

## Aggregate financial reports

`report-financials.ts` is the DB-free, workstation-side view of a finalized `report-*.json`:

```sh
bun run financial-report -- report-20260724T080000Z.json
ssh production 'cat /path/to/report.json' | bun run financial-report -- -
```

Reports contain daily/asset sales totals, aggregate liability, and open/undelivered-credit diagnostics—no
token hashes, exact payment rows, or live database access.

## Buyer and development tools

- `gen-token.ts` mints a raw token locally and prints it once.
- `sync-prices.ts` refreshes the checked-in public price snapshot used by development.
