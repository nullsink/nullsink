# `deploy/` — the box's runtime + bootstrap tree

Everything the production box runs that is *not* the app binary itself: the systemd units that
supervise it, the operator scripts those units invoke, the public-edge config, and the firewall.

The app box is **source-free**. It runs the two compiled server binaries
(`/usr/local/lib/nullsink/current-proxy` and `current-payments`) plus the scripts in this directory; it has
no `src/`, no `cli/`, and no Bun. The top-level app files ship as `deploy-<tag>.tar.gz` and extract to
`/opt/nullsink/deploy/`; `node-box/` ships separately and is excluded from that archive. App units'
`ExecStart` lines point straight at the app paths.

The app is **two processes and two OS principals**, split by privilege: `nullsink-proxy` serves the metered
`/v1` paths and owns `balances.db`; `nullsink-payments` serves `/buy`, `/order-status`, `/rails`, runs the
settlement poller, and owns `pending.db`. A request carrying a prompt never reaches the process that holds
the payment→token link. The only channel between them is `/run/nullsink-credit/credit.sock`, where the
`nullsink-credit` group permits only payments to send one-way credit commands.

See setup.sh to stand up a box, and deploy.sh / upgrade-component.sh / backup.sh for day-2 work (app
redeploys, pinned dependency upgrades, backups, alerts, troubleshooting). This file is just the map.

## What's here, by concern

### Bootstrap & redeploy
| File | Role |
|------|------|
| `setup.sh` | First-boot bootstrap for a fresh Ubuntu box (idempotent). Installs the toolchain, units, Caddy edge, and firewall, fetches + verifies the pinned release, and prints a next-steps checklist. |
| `deploy.sh` | Health-gated redeploy of an *existing* box to a release tag. Drains the root backup/status one-shots before replacing their scripts, atomically swaps both binary symlinks in lockstep, refreshes units + edge, resumes timers only after health, warns if an enabled rail-daemon unit changed (it won't bounce a node mid-sync), and **rolls back** if either service fails `/healthz`. It does not install or upgrade Bitcoin Core, Monero, or `tinfoil-proxy`. |
| `upgrade-component.sh` | Narrow day-two app-box upgrade for `monero-wallet` or `tinfoil`. Downloads and verifies before downtime, restarts only the target, health-gates activation, and automatically restores retained previous binaries on failure. |
| `lib.sh` | Shared library `source`d by bootstrap, app deploy, and component upgrade paths, so pins and asset verification cannot drift. |
| `migrate-service-isolation.sh` | One-time, quiet-window migration from the legacy shared uid/env/state. `--prepare` is reversible; `--finalize` root-locks the retained rollback copy after recovery proof. |
| `install-nsk.sh` | Installs the optional read-only live balances/financials CLI. |
| `node-box/` | Source for the separately packaged dedicated Bitcoin node day-two bundle. It is excluded from app release archives. Fresh provisioning moves to Ansible (issue #162). |

### Operator & break-glass scripts (run by units or by hand)
| File | Role |
|------|------|
| `status-check.sh` | Rail + app health check (run every 10 min by `status-check.timer`). Privacy-safe: reads the billing DBs only for an integrity pragma, never row content. |
| `alert.sh` | Pushes a one-line Telegram page. The `OnFailure=` sink for the units, and how `status-check.sh` closes an incident. Sends no request content. |
| `backup.sh` | Four-hour coordinated (`sqlite3 .backup`) snapshot of the billing DBs; validates the pair, atomically publishes the recovery artifact, optionally age-encrypts/pushes it, and emits an aggregate-only report. |
| `backup-bitcoin-labels.sh` | Payments-owned, best-effort export of watch-only Bitcoin labels for the next artifact; backup never receives wallet RPC credentials. |
| `backup-report.sh` | Builds the versioned privacy-safe JSON report from backup snapshots: daily/asset revenue, aggregate liability, and open/undelivered-credit health—never token/payment linkage. |
| `restore.sh` | Restore from a `backup.sh` artifact. **Safe dry-run by default**; `--apply` to replace the live DBs, re-arm the credit outbox, and restart both services. |
| `backup-collector/` | Role-specific Raspberry Pi pull collector: restricted production export, hourly systemd pull, ciphertext/report retention and freshness validation, plus the recovery-drill runbook. Its units are deliberately outside the app box's top-level install glob. |
| `node-box/regen-rpcauth.sh` | Node-only break-glass rotation of bitcoind `rpcauth`; prints the matched app password once. |

### systemd units & timers
`nullsink-proxy.service` + `nullsink-payments.service` (the app's two halves) ·
`monero-wallet-rpc.service` (the local XMR watcher) ·
`tinfoil-proxy.service` (the Tinfoil verifying proxy / enclave attestation; installed when `TINFOIL_API_KEY` is set) ·
`nullsink-bitcoin-label-export.service` · `backup.service` + `backup.timer` · `status-check.service` + `status-check.timer` ·
`status-alert@.service` (the templated `OnFailure=` paging sink).

### Public edge & firewall
`Caddyfile` (TLS + reverse proxy + security headers; a host-agnostic `{$NULLSINK_DOMAIN}` template) ·
`nftables.conf` (app box: default-deny inbound; only 22 / 80 / 443) ·
The standalone node-box artifact carries its own firewall: default-deny inbound, with bitcoind RPC only across `wg0`.

## Two things to know

**App releases and pinned runtime dependencies have separate activation paths.** `deploy.sh <tag>` installs
nullsink's two server binaries, optional read-only `nsk`, client UI, and deploy configuration. It never restarts a rail
watcher or attestation sidecar. For an existing box, activate one refreshed dependency pin explicitly:

```sh
# Dedicated node box (from the separately downloaded node-box release bundle)
sudo ./upgrade.sh

# App box
sudo /opt/nullsink/deploy/upgrade-component.sh monero-wallet
sudo /opt/nullsink/deploy/upgrade-component.sh tinfoil
```

Each command refuses the wrong box role or an inactive/unconfigured target, verifies the download before
downtime, requires a healthy rollback baseline both before and after staging, preserves the previous binaries
under `/usr/local/lib/nullsink/component-rollbacks/`, restarts only its target service, and rolls back
automatically if the target does not recover. Concurrent upgrade attempts are rejected. App bootstrap remains
in `setup.sh` until the Ansible replacement is proven; the node bundle deliberately has no bootstrap script.

**The app-box layout is deliberately flat.** `install_units` uses an explicit app-unit allowlist. Keep app
units/scripts directly under `deploy/`; other host roles belong in isolated bundles. `node-box/` is packaged
as `nullsink-node-box-<tag>.tar.gz` and excluded from `deploy-<tag>.tar.gz`, so an app release physically
cannot install or manage bitcoind. (The lint runner lives in
[`scripts/lint.sh`](../scripts/lint.sh), *not* here — it is a dev/CI tool.)

**Nothing box-specific is committed.** Per-box config is split by authority:
`/etc/nullsink-proxy.env`, `/etc/nullsink-payments.env`, `/etc/nullsink-backup.env`, and the root-only
`/etc/nullsink-monitor.env`. Storage and socket paths remain unit-owned.

## One-time shared-layout migration

The installed pre-Step-4 `deploy.sh` cannot contain the new refusal gate retroactively. For this one boundary-
crossing release, verify the new `deploy-<tag>.tar.gz` off-box, copy it to the app box, extract it into a temporary
directory, and run `deploy.sh <tag>` from there — **not** the old `/opt/nullsink/deploy/deploy.sh`. It installs the
verified deploy tree, then exits before changing units because the prepared marker is absent. Subsequent commands
use the newly installed `/opt/nullsink/deploy/` tree normally.

After that boundary-crossing release, the installed deploy script checks the prepared marker before downloading
or activating any release artifact. Routine redeploys also stop and drain `status-check` and `backup` before the
live deploy tree changes, so an old unit can never execute a new script during the transition.

Review and run `migrate-service-isolation.sh --prepare` during a financial quiet window, then immediately
rerun `/opt/nullsink/deploy/deploy.sh <tag>`. Preparation stops the old app and timers, checks that there are
no holds, open orders, or undelivered/partial credits, copies and verifies both databases, splits the root-
owned env files, and leaves the legacy layout and sidecar permissions untouched for rollback.
After the isolated services pass health and access checks, create a new encrypted artifact and prove its
offline dry-run restore. Only then run `migrate-service-isolation.sh --finalize`; this retains the legacy
copy but makes it root-only. Finalization is never automatic.

## Backup and reporting boundary

`backup.timer` runs every four hours. `backup.sh` snapshots `pending.db` first and `balances.db` second,
packages the pair, and runs `restore.sh`'s read-only validation before anything receives a final
`backup-*` name. Encryption and report output are written under hidden partial names in the destination
directory, then atomically renamed. A collector therefore sees a complete final file or no file, never an
in-progress artifact.

Backup, restore, status, and the temporary live readers accept explicit `BALANCES_DB_PATH` and
`PENDING_DB_PATH` values. Installed units pin them to `/var/lib/nullsink-proxy/balances.db` and
`/var/lib/nullsink-payments/pending.db`; `DB_DIR` remains an explicit legacy/test fallback. The archive
format and pending-first snapshot order do not change.

For the production/off-box workflow, set `BACKUP_AGE_RECIPIENT` to an `age` **public recipient** whose
private identity remains offline. The finished recovery artifact is `backup-<UTC>.tar.age`; a production
box or storage host with only the recipient/ciphertext cannot decrypt it. Plain `.tar` remains available for
local development, but must not cross the production box boundary. `BACKUP_KEEP` defaults to 84 completed
artifacts—normally about fourteen days at six runs per day; extra manual runs shorten that time window.

Each validated artifact has a `report-<UTC>.json` generated from the same private snapshots. Its schema is
an explicit allowlist:

- UTC-day/asset revenue counts plus credited/gross micro-dollar totals;
- aggregate outstanding micro-dollar liability;
- open-order count, quoted credit total, and payment-seen count;
- unacknowledged-credit count, total, and oldest age.

The report contains no token hash, per-token balance, payment address, transaction/idempotency key,
individual sale row, or delivered payment→token join. It is still private business data. Files are mode
`0600` by default; the pull-only collector setup changes finalized artifact/report files to `0640` for one
dedicated export group. A report failure pages by failing `backup.service`, but happens after
recovery-artifact publication, so it cannot discard the valid backup.

Test a retained artifact on the trusted machine that holds the offline identity (default is a dry-run and
touches no live database):

```sh
BACKUP_AGE_IDENTITY=/secure/nullsink-age.key \
  core/deploy/restore.sh backup-20260721T120000Z.tar.age
```

Run that check after schema, archive-format, restore-code, or key changes and periodically during normal
operation. The [`backup-collector/`](backup-collector/) bundle collects only finalized encrypted artifacts
and these aggregate reports; it does not need or receive the private `age` identity.

Read finalized financials on a trusted workstation without opening either live database:

```sh
bun run financial-report -- report-20260721T120000Z.json
```

For live investigation, install `nsk` explicitly and run `sudo -u nullsink nsk …`. The operator principal
has group-read access to both stores but no write bit; the wrapper pins both isolated paths. It exposes only
`balances` and `financials`; `/buy` remains the only supported way to create or add token credit.

**Release fetch is plain `curl`.** The release helpers in `lib.sh` pull public GitHub Release assets
over HTTPS and verify them against `SHA256SUMS` — no `gh`, no auth on the box. Build provenance is attested
in CI (`release.yml`); verify off-box with `gh attestation verify <file> --repo nullsink/nullsink`.
