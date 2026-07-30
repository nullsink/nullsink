# Local command-line tools

These are workstation-side tools. None is compiled into a release asset, installed on the
production box, or permitted to open either live billing database.

## Financial reports

`financials.ts` renders the finalized, aggregate-only `report-*.json` produced with each
validated backup:

```sh
bun run financials -- report-20260724T080000Z.json
bun run financials -- report-20260724T080000Z.json --since 2026-07-01 --until 2026-08-01
```

It accepts `-` for stdin, validates the report's exact versioned allowlist, and keeps all
micro-dollar arithmetic exact:

```sh
ssh nullsink-production '
  latest=$(find /var/lib/nullsink/backups -maxdepth 1 -type f -name "report-*.json" |
    sort | tail -n 1)
  test -n "$latest"
  cat "$latest"
' | bun run financials -- -
```

That SSH command reads a finalized report, not SQLite. The same command can target the retained
copy on the backup collector.

## Buyer and development tools

- `gen-token.ts` mints a raw token locally and prints it once.
- `sync-prices.ts` refreshes the checked-in public price snapshot used by development.

The normal `/buy` flow creates or funds tokens after confirmed payment. There is deliberately no
operator issue/top-up/balance command and no shipped `nsk` binary: restoring such a command would
reintroduce a second writer or a live per-token read path across the process boundary.
