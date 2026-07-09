# Revenue cutover runbook

The one-time migration that moves the `revenue` sales book out of `balances.db` and into `pending.db`, and
seeds the outbox tombstones that stop a pre-cutover order from double-booking its sale.

Run it **once per box**, with the service stopped. Forward migration; the rollback story is at the bottom.

Customer balances are never touched — `applied_orders` still makes every credit exactly-once. What is at risk
is the **accounting**: skip this and `nsk financials` silently undercounts every pre-cutover sale, because it
now reads the journal from `pending.db`.

Downtime is about two minutes: the service is stopped for the migration and restarted by `deploy.sh`.

## 1. Pre-flight (read-only)

Read the databases as the service user with `-readonly`. A root open of a WAL database strands root-owned
`-wal`/`-shm` sidecars the service then cannot write, which breaks billing.

```sh
r() { sudo -u nullsink sqlite3 -readonly -cmd '.timeout 5000' "$1" "$2"; }

cat /opt/nullsink/REVISION
systemctl is-active nullsink && curl -fsS localhost:8080/healthz

r /var/lib/nullsink/balances.db 'SELECT COUNT(*) FROM revenue;'          # sales rows to copy
r /var/lib/nullsink/balances.db 'SELECT COUNT(*) FROM applied_orders;'   # tombstones to seed
r /var/lib/nullsink/pending.db  'SELECT COUNT(*) FROM pending_orders;'   # in-flight payments
stat -c '%U' /var/lib/nullsink/*.db-wal                                  # must all be `nullsink`
/opt/nullsink/deploy/status-check.sh                                     # expect exit 0
```

Note the `applied_orders` count. The dry run in step 5 must report exactly that many tombstones; a different
number means stop and investigate.

**Look at the in-flight orders.** The one case worth waiting out is an order already being paid that sits close
to the 4h30m unfunded-reap horizon. After a restart the wallet may briefly rescan and report an empty inbound
list as a *success*, and a paid order is spared only once the poller has recorded a sighting. Prefer a window
where the open orders are unpaid, or young enough that a sighting lands long before the horizon.

`status-check.sh` skipping `bitcoind` is expected on a box whose Bitcoin node lives on a separate node box.

## 2. Baseline, with the nsk that is already installed

Do this **before** installing the new `nsk`. The new binary's `financials` and `orders` open the databases
read-write and run the additive `seen_at` migration, taking a write lock under a live service for no reason.
From the new binary, only `nsk version` and `nsk migrate-revenue` (the dry run, which opens read-only) are safe
to run before the stop.

```sh
sudo -u nullsink nsk financials --format json > /tmp/before.json
```

## 3. Back up, and prove the artifact restores

```sh
sudo systemctl start backup.service
ls -lt /var/lib/nullsink/backups | head -3
```

Copy the artifact **off-box**.

When `BACKUP_AGE_RECIPIENT` is set the artifact is age-encrypted and the private key stays offline by design.
Verify it on your secure machine, where that key lives:

```sh
BACKUP_AGE_IDENTITY=/path/to/key restore.sh backup-<stamp>.tar.age    # dry-run; changes nothing
```

A plaintext `.tar` artifact dry-runs on the box directly: `deploy/restore.sh <artifact>`.

## 4. Rehearse on copies of these exact databases

Off-box, with the repo checked out. `rehearse-migration.ts` runs the real migration against scratch copies and
reconciles the figures:

```sh
bun run scripts/rehearse-migration.ts /path/to/copy-of-balances.db /path/to/copy-of-pending.db
```

A box with **zero** `applied_orders` rows seeds zero tombstones, so its rehearsal never exercises the
double-book defence. If that is your box, seed a synthetic zombie into the copies — an open `pending_orders` row
whose idempotency key is already present in `applied_orders` — settle it, and confirm the sale is booked exactly
once. Without the tombstone the revenue book gains a phantom sale.

## 5. The cutover

The migration must land **before** the settlement poller's first tick. The app polls immediately on start, so a
service that comes up pre-migration can re-settle an order a prior crash left open, find its key absent from the
fresh `credit_outbox`, and book its sale a second time. That is exactly what `reconcileOutbox`'s tombstones
prevent, so they have to exist first. Hence: stop, migrate, then deploy.

```sh
sudo deploy/install-nsk.sh <tag>     # the migration exists only in the new nsk
sudo systemctl stop nullsink

sudo -u nullsink nsk migrate-revenue          # dry run: figures must match step 1
sudo -u nullsink nsk migrate-revenue --apply  # expect: RESULT: ✓

sudo deploy/deploy.sh <tag>          # binary + units + edge + health gate, then restart
```

`--apply` reconciles the row count and the gross sum and exits non-zero on any mismatch. The source table in
`balances.db` is left in place, so a divergence is diagnosable with both books side by side. Stop there.

Run `nsk` as the **service user**. It refuses to run as root, for the WAL-sidecar reason above.

An interrupted `--apply` is safe: both halves commit in one transaction, and a re-run repairs a partial state.

## 6. Verify

The check that matters is that the books reconcile. The migration copies rather than moves, so a divergence is
recoverable — provided you notice it.

```sh
sudo -u nullsink nsk financials --format json > /tmp/after.json
python3 - /tmp/before.json /tmp/after.json <<'PY'
import json, sys
b, a = (json.load(open(p)) for p in sys.argv[1:3])
rows = [("sales",       b["totals"]["sales"],            a["totals"]["sales"]),
        ("gross_usd",   b["totals"]["gross_usd"],        a["totals"]["gross_usd"]),
        ("prepaid_usd", b["outstanding"]["prepaid_usd"], a["outstanding"]["prepaid_usd"]),
        ("tokens",      b["outstanding"]["tokens"],      a["outstanding"]["tokens"])]
ok = all(x == y for _, x, y in rows)
for k, x, y in rows:
    print(f"  {k:<12} {x} -> {y}  {'OK' if x == y else 'MISMATCH'}")
print("RECONCILED" if ok else "INVESTIGATE — do not roll forward")
PY
```

All four figures must be identical. `jq` is absent on some boxes; `python3` is present on all of them.

Then:

```sh
r() { sudo -u nullsink sqlite3 -readonly -cmd '.timeout 5000' "$1" "$2"; }

r /var/lib/nullsink/pending.db "SELECT name FROM sqlite_master WHERE type='table';"        # + credit_outbox, revenue
r /var/lib/nullsink/pending.db "SELECT COUNT(*) FROM pragma_table_info('pending_orders') WHERE name='seen_at';"
r /var/lib/nullsink/pending.db 'SELECT COUNT(*) FROM credit_outbox WHERE acked_at IS NULL;'  # 0 within a poll tick
stat -c '%U' /var/lib/nullsink/*.db-wal          # still `nullsink` — nothing ran as root
curl -fsS localhost:8080/healthz
journalctl -u nullsink -n 50 | grep -i credit
/opt/nullsink/deploy/status-check.sh
```

Take a fresh backup afterwards and dry-run its restore. The schema gained two tables and a column, and this is
the first artifact written by the `backup.sh` that snapshots `pending.db` before `balances.db`.

Between the migration and the deploy the `-wal`/`-shm` files vanish. That is a clean close.

## 7. Rolling back

`deploy.sh` health-gates the restart and rolls the **binary** back on failure. The migration stays applied.
Immediately after the cutover that is harmless: `balances.db` still holds its `revenue` copy, no new sales have
landed, and the two books are identical. The longer the new binary serves, the further the `balances.db` copy
falls behind — sales booked after the cutover live only in `pending.db`, so `nsk financials` on an old binary
undercounts until you roll forward again.

Before rolling back, **drain the credit outbox.** Any release older than the outbox cannot see `credit_outbox`
at all, so a row still unacked at rollback is a paid credit that will sit undelivered. With the service running,
wait for this to read `0`:

```sh
sudo -u nullsink sqlite3 -readonly /var/lib/nullsink/pending.db \
  'SELECT count(*) FROM credit_outbox WHERE acked_at IS NULL;'
```

Then `sudo deploy/deploy.sh <older-tag>`.
