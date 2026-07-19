# Find a deployment file

This directory is the source-free production runtime tree: systemd units, edge and firewall configuration,
bootstrap and release scripts, health checks, backup/recovery tools, and pinned component installers. A
release packages it as `deploy-<tag>.tar.gz` under `/opt/nullsink/deploy/`.

For procedures, use the canonical operator guides:

- [Deploy and configure nullsink](../../docs/operators/deploy.md)
- [Back up and restore billing state](../../docs/operators/backup-restore.md)
- [Diagnose nullsink](../../docs/operators/diagnose.md)
- [Move Bitcoin to a node box](node-box-runbook.md)

## Which file bootstraps or updates a host?

| File | Purpose |
| --- | --- |
| `setup.sh` | Bootstrap or reconcile an Ubuntu application host |
| `setup-nodes.sh` | Bootstrap a dedicated WireGuard-reached Bitcoin node host |
| `deploy.sh` | Activate one nullsink release and health-gate both application binaries |
| `upgrade-component.sh` | Upgrade one pinned Bitcoin, Monero-wallet, or Tinfoil dependency with rollback |
| `install-nsk.sh` | Install the optional operator CLI at the application release tag |
| `lib.sh` | Shared pins, release verification, and install helpers |

`deploy.sh` does not upgrade or restart Bitcoin Core, Monero wallet RPC, or `tinfoil-proxy`. Use
`upgrade-component.sh` for one of those components. Use setup scripts for a fresh or incomplete host, not
as a routine dependency upgrade.

## Which file owns day-two operations?

| File | Purpose |
| --- | --- |
| `status-check.sh` | Ten-minute application, database, backup, wallet, and active-rail check |
| `alert.sh` | Minimal Telegram and heartbeat incident notification |
| `backup.sh` | Consistent paired SQLite backup, optional age encryption, and off-host push |
| `restore.sh` | Dry-run validation or explicit replacement of a matched `pending.db`/`balances.db` artifact |
| `regen-bitcoin-rpcauth.sh` | Rotate bitcoind and application RPC credentials as a matched pair |

Restore behavior is defined in the [recovery runbook](../../docs/operators/backup-restore.md). In particular,
current restores validate acknowledged idempotency tombstones against the balance ledger and only re-arm
legacy outbox rows that still contain a complete delivery payload.

## Which units and network files run on the host?

| Concern | Files |
| --- | --- |
| Application | `nullsink-proxy.service`, `nullsink-payments.service` |
| Payment watchers | `monero-wallet-rpc.service`, `bitcoind.service` |
| Tinfoil verification | `tinfoil-proxy.service` |
| Scheduled operations | `backup.*`, `status-check.*`, `status-alert@.service` |
| Public edge | `Caddyfile` |
| Application-host firewall | `nftables.conf` |
| Node-host firewall | `nftables-nodes.conf` |

The proxy and payments programs are separate responsibility and code boundaries, but they currently run as
the same `nullsink` OS user. The enforced and planned boundaries are documented in
[System boundaries](../../docs/architecture.md).

## What layout assumptions must a deployment change preserve?

- Keep unit and script files at the top of `deploy/`: release packaging, install globs, unit paths, and
  operator references rely on the flat layout.
- Keep host-specific domains, addresses, RPC credentials, alert tokens, and backup keys in
  `/etc/nullsink.env` or host-local systemd drop-ins, never in this tree.
- Fetch public release assets over HTTPS and verify them with the release `SHA256SUMS`; production hosts do
  not need GitHub CLI credentials.
- Update `deploy.sh` and the operator guides when a new runtime file changes activation or recovery behavior.
