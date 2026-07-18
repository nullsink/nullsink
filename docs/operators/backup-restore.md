# Back up and restore billing state

Use `backup.sh` and `restore.sh` as a pair. A raw copy of a live SQLite file is not a supported
backup, and restoring the two databases without credit-outbox reconciliation can strand paid credit.

## What does a billing backup contain?

| File | What recovery needs from it |
| --- | --- |
| `balances.db` | Token hashes, spendable balances, open request holds, and the `applied_orders` idempotency ledger |
| `pending.db` | Open payment orders, revenue, and the durable credit outbox, including its payment-to-token links |
| `bitcoin-wallet-labels.json` | Best-effort Bitcoin address/label export when the configured wallet RPC answers |

`backup.sh` snapshots `pending.db` first and `balances.db` second with SQLite's `.backup` command. The
two snapshots are not one simultaneous transaction, but that order makes the possible skew safe: a
credit that lands between snapshots can be redelivered, while the reverse order could preserve an
acknowledgement without the corresponding balance-ledger marker.

The artifact does not contain `/etc/nullsink.env`, provider credentials, age private keys, wallet
files, blockchain data, or application binaries. The Bitcoin label export is recovery evidence; the
restore script does not import it into a wallet.

## When does the scheduled backup run?

`backup.timer` runs daily with up to 30 minutes of random delay. `Persistent=true` causes one missed
run to start after the host returns. Setup also attempts an initial backup.

The service runs as the `nullsink` user so SQLite WAL sidecars remain service-owned. The default
artifact directory is `/var/lib/nullsink/backups`, and every artifact is mode `0600`.

Run an extra backup before a deployment, recovery operation, or payment-node migration:

```sh
sudo systemctl start backup.service
sudo systemctl status backup.service --no-pager
sudo journalctl -u backup.service -n 40 --no-pager
```

A successful unit run means the artifact was created, any configured push command completed, and local
retention ran. It does not prove that a remote system has its own usable retention or that anyone has
tested decryption.

## How do I keep encrypted copies off the host?

Create an age identity on a trusted operator machine, not on the application host:

```sh
age-keygen -o /secure/nullsink-backup.agekey
age-keygen -y /secure/nullsink-backup.agekey
```

The second command prints the public `age1…` recipient. Store only that recipient on the application
host. Keep the identity file offline from the host and protect it like a recovery key.

Set these values in `/etc/nullsink.env`:

```ini
BACKUP_AGE_RECIPIENT=age1REPLACE_WITH_PUBLIC_RECIPIENT
BACKUP_PUSH_CMD=rclone copy "$ARTIFACT" remote:nullsink-backups/
BACKUP_KEEP=14
```

`BACKUP_PUSH_CMD` is an operator-supplied shell command and runs as the `nullsink` service user. Install
and configure its transport separately, then trigger and inspect one real run. Keep comments on separate
lines in `/etc/nullsink.env`.

When a recipient is configured, the on-host artifact is already encrypted. If a push command is set
without encryption, `backup.sh` refuses the push unless `BACKUP_PUSH_ALLOW_PLAINTEXT=1` explicitly
overrides the guard. Do not use that override for ordinary off-host storage: `pending.db` contains the
payment-to-token link.

The push destination must be independent of the application disk. A local artifact protects against a
bad deploy or operator mistake; it does not protect against loss or compromise of the host.

## How long are backups retained?

`BACKUP_KEEP` is a count of local artifacts, not a number of days.

| Location | Current behavior |
| --- | --- |
| Application host | Keeps the newest 14 artifacts by default. With one successful daily run, that is roughly 14 recovery points. |
| Push destination | Not pruned by nullsink. Retention depends entirely on the remote storage policy. |
| Failed push | The newly created local artifact remains, the unit fails, and pruning is deferred until a later successful run. |
| Pre-restore copies | `restore.sh` keeps `*.db.prerestore` outside the normal artifact retention and never removes them automatically. |

Setting `BACKUP_KEEP=7` keeps seven local artifacts; it does not guarantee exactly seven calendar days
and does not delete remote copies.

Backup retention is not a safe deletion clock for acknowledged `credit_outbox` rows or
`applied_orders`. Those rows reconcile a restored payment database with a restored balance ledger. A
deletion policy would first need one enforced maximum restore age covering local artifacts, remote
artifacts, copied artifacts, and pre-restore files. No such policy or deletion mechanism exists today;
see the [money and reliability invariants](../invariants.md#should-acknowledged-rows-be-deleted-after-a-fixed-period).

## How do I test an artifact without changing production?

Fetch an encrypted artifact to the trusted machine that holds the age identity, then run the restore
script without `--apply`:

```sh
BACKUP_AGE_IDENTITY=/secure/nullsink-backup.agekey \
  core/deploy/restore.sh backup-YYYYMMDDTHHMMSSZ.tar.age
```

The default dry-run decrypts into a temporary directory, requires `balances.db`, and runs
`PRAGMA integrity_check` on each included database. It does not stop services, replace files, start the
application, or simulate credit-outbox reconciliation. For an on-host plaintext artifact, run the same
command without `BACKUP_AGE_IDENTITY`.

Test a recent artifact on a schedule. Successful encryption and upload are not evidence that the
identity is available or that the databases decrypt intact. The integrity check validates SQLite files,
not artifact provenance; restrict writes to the backup destination and restore only an expected artifact
from trusted storage.

## What will an old restore lose?

Restoring rewinds nullsink to the artifact's state. It cannot reconstruct activity after the snapshot:

- balance debits and refunds from model requests after the snapshot are absent;
- orders created after the snapshot are absent from restored `pending.db`;
- payments first observed or settled after the snapshot may require manual on-chain reconciliation;
- the Bitcoin label JSON, when present, is not automatically imported; and
- configuration, wallet files, and node state must be recovered separately.

Credit-outbox re-arming prevents an acknowledgement inside the restored data from hiding a credit that
the restored balance ledger lacks. It does not recreate orders or credits that never reached the backup.
Choose the newest intact artifact that fits the incident, and retain payment-chain evidence plus the
pre-restore databases until reconciliation is complete.

## How do I apply a restore?

First create a fresh pre-recovery artifact if the live databases are readable, then dry-run the selected
recovery artifact. Plan a public outage: the apply path stops both application services.

To keep the age private key off the application host, decrypt on the trusted machine and send the
plaintext tar over the existing SSH connection:

```sh
age -d -i /secure/nullsink-backup.agekey backup-YYYYMMDDTHHMMSSZ.tar.age |
  ssh root@app-host 'umask 077; cat > /root/nullsink-restore.tar'
```

Dry-run that exact transferred tar on the application host:

```sh
ssh root@app-host \
  'bash /opt/nullsink/deploy/restore.sh /root/nullsink-restore.tar'
```

> **Applying a restore replaces live billing state.** Confirm the artifact timestamp and incident scope
> before adding `--apply`. Orders and balances created after that timestamp will not be in the restored
> databases.

Apply it:

```sh
ssh root@app-host \
  'bash /opt/nullsink/deploy/restore.sh --apply /root/nullsink-restore.tar'
```

The apply path:

1. verifies and stages the extracted databases before touching live files;
2. stops payments, then the proxy;
3. installs the snapshots as service-owned mode-`0600` files and removes stale WAL sidecars;
4. keeps the first replaced databases as `balances.db.prerestore` and `pending.db.prerestore`;
5. re-arms real outbox rows acknowledged by `pending.db` but absent from `balances.db`'s
   `applied_orders`; and
6. starts the proxy and payments services.

If outbox reconciliation fails, the restored databases are already installed and the application
services are deliberately left stopped. Do not start them around the guard. Fix the reported SQLite or
permission problem and rerun the same restore command.

`restore.sh` starts the services but does not health-gate them. Verification is a separate required step.

## How do I verify restored money state?

Check both services, then run the full one-shot monitor:

```sh
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8081/healthz
sudo systemctl start status-check.service
sudo journalctl -u status-check.service -n 60 --no-pager
```

Inspect payments logs for re-delivered credits and new outbox stalls:

```sh
sudo journalctl -u nullsink-payments --since '15 minutes ago' --no-pager
```

If the optional operator CLI is installed, compare liabilities and sales with the incident record:

```sh
sudo -u nullsink nsk financials
sudo -u nullsink nsk balance <64-character-token-hash>
```

Verify affected token balances by hash and reconcile every payment since the snapshot against the live
watch-only wallets. A small real payment on each enabled rail is the final end-to-end check.

After sign-off, remove the transferred plaintext tar. Retain the `*.prerestore` databases until the
reconciliation and rollback window closes; they are sensitive plaintext and are not covered by
`BACKUP_KEEP`.

## What happens when a backup or restore step fails?

| Failure | Durable state | Safe next action |
| --- | --- | --- |
| SQLite snapshot fails | No completed new artifact is promised | Fix disk, permissions, or database health; rerun `backup.service` |
| Encryption fails | Temporary snapshots are removed; no finished encrypted artifact is promised | Fix the recipient or `age` installation; rerun |
| Push fails | The finished local artifact remains; the service reports failure; retention has not run | Restore remote connectivity or credentials, then rerun |
| Dry-run fails | Production is unchanged | Reject that artifact and test another copy or recovery point |
| Apply fails while staging | Live databases and services are unchanged | Fix space or permissions and rerun |
| Apply fails during outbox reconciliation | Restored databases are live on disk; pre-restore copies remain; services stay stopped | Fix the reported cause and rerun the same `--apply`; do not bypass reconciliation |
| A service is unhealthy after restart | Restored databases and pre-restore copies remain; no automatic rollback occurs | Keep payment intake unavailable, inspect both journals, and decide whether to repair or restore the preserved pre-restore state |
