# Revenue cutover runbook

The one-time migration that moves the `revenue` sales book out of `balances.db` and into `pending.db`, and
seeds the outbox tombstones that stop a pre-cutover order from double-booking its sale.

Run it **once per box**, with the service stopped. Forward migration; the rollback story is at the bottom.

Customer balances are never touched — `applied_orders` still makes every credit exactly-once. What is at risk
is the **accounting**: skip this and `nsk financials` silently undercounts every pre-cutover sale, because it
now reads the journal from `pending.db`.

## Before you touch anything

The box is source-free, so the migration runs through `nsk`, not `bun`. Install the operator CLI at the tag
you are deploying:

```sh
sudo deploy/install-nsk.sh <tag>
```

Take a backup and copy it **off-box**:

```sh
sudo systemctl start backup.service
ls -lt /var/lib/nullsink/backups | head -3
```

Rehearse on copies, on your own machine, with the repo checked out. `rehearse-migration.ts` runs the real
migration against scratch copies and reconciles the figures:

```sh
bun run scripts/rehearse-migration.ts /path/to/copy-of-balances.db /path/to/copy-of-pending.db
```

## The cutover

The migration must land **before** the settlement poller's first tick. The app polls immediately on start, so
a service that comes up pre-migration can re-settle an order a prior crash left open, find its key absent from
the fresh `credit_outbox`, and book its sale a second time. That is exactly what `reconcileOutbox`'s tombstones
prevent — so they have to exist first. Hence: stop, migrate, then deploy.

```sh
# 1. stop the app (the rail daemons keep running; they hold no app state)
sudo systemctl stop nullsink

# 2. dry run — writes nothing, prints what would move
sudo -u nullsink nsk migrate-revenue

# 3. apply
sudo -u nullsink nsk migrate-revenue --apply

# 4. deploy the new binary; this restarts the service and health-gates it
sudo deploy/deploy.sh <tag>
```

Step 3 prints `RESULT: ✓ revenue moved, counts + gross reconcile.` and exits non-zero on any mismatch. If a
figure diverges, **stop**. The source table in `balances.db` is left in place, so nothing is lost and you can
investigate with both books side by side.

Run `nsk migrate-revenue` as the **service user**, never as root. A root open of these WAL databases strands
root-owned `-wal`/`-shm` sidecars the service then cannot write; `nsk` refuses root for exactly this reason.

## Afterwards

```sh
sudo -u nullsink nsk financials        # lifetime totals should match your pre-cutover figures
curl -fsS localhost:8080/healthz
journalctl -u nullsink -n 50 | grep -i credit
```

Re-running `nsk migrate-revenue --apply` is safe: it refuses once `pending.db` already holds revenue rows.

## Rolling back

`migrate-revenue` **copies**; it never drops the source table. A pre-cutover binary therefore still finds its
`revenue` table in `balances.db` and reads it. That copy is **stale** — sales booked after the cutover live
only in `pending.db` — so `nsk financials` on the old binary undercounts until you roll forward again.

First, **drain the credit outbox.** Any release older than the outbox cannot see `credit_outbox` at all, so a
row still unacked when you roll back is a paid credit that will sit undelivered until you roll forward. With
the service running, wait for this to read `0`:

```sh
sudo -u nullsink sqlite3 /var/lib/nullsink/pending.db \
  'SELECT count(*) FROM credit_outbox WHERE acked_at IS NULL;'
```

Then `sudo deploy/deploy.sh <older-tag>` as usual.
