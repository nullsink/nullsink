# `deploy/` — the box's runtime + bootstrap tree

Everything the production box runs that is *not* the app binary itself: the systemd units that
supervise it, the operator scripts those units invoke, the public-edge config, and the firewall.

The box is **source-free**. It runs the two compiled server binaries
(`/usr/local/lib/nullsink/current-proxy` and `current-payments`) plus the scripts in this directory; it has
no `src/`, no `cli/`, and no Bun. This whole directory ships to the box as a release tarball
(`deploy-<tag>.tar.gz`, built by `.github/workflows/release.yml`) and extracts to `/opt/nullsink/deploy/`.
The units' `ExecStart` lines point straight at these paths.

The app is **two processes**, split by privilege: `nullsink-proxy` serves the metered
`/v1` paths and owns `balances.db`; `nullsink-payments` serves `/buy`, `/order-status`, `/rails`, runs the
settlement poller, and owns `pending.db`. A request carrying a prompt never reaches the process that holds
the payment→token link. The only channel between them is a unix socket at `/run/nullsink/credit.sock`, over
which payments delivers credits in one direction. They share one service user today; splitting the uids
waits on the admin-plane redesign (see `nullsink-proxy.service` for why).

See setup.sh to stand up a box, and deploy.sh / upgrade-component.sh / backup.sh / node-box-runbook.md for
day-2 work (app redeploys, pinned dependency upgrades, backups, alerts, troubleshooting). This file is just
the map.

## What's here, by concern

### Bootstrap & redeploy
| File | Role |
|------|------|
| `setup.sh` | First-boot bootstrap for a fresh Ubuntu box (idempotent). Installs the toolchain, units, Caddy edge, and firewall, fetches + verifies the pinned release, and prints a next-steps checklist. |
| `deploy.sh` | Health-gated redeploy of an *existing* box to a release tag. Atomically swaps both binary symlinks in lockstep, refreshes units + edge from this tree, reconciles the timers, warns if an enabled rail-daemon unit changed (it won't bounce a node mid-sync), and **rolls back** if either service fails `/healthz`. It does not install or upgrade Bitcoin Core, Monero, or `tinfoil-proxy`. |
| `upgrade-component.sh` | Narrow day-two upgrade for one pinned external component: `bitcoin` on its dedicated node box, or `monero-wallet` / `tinfoil` on the app box. Downloads and verifies before downtime, restarts only the target, health-gates activation, and automatically restores retained previous binaries on failure. |
| `lib.sh` | Shared library `source`d by bootstrap, app deploy, and component upgrade paths, so pins and asset verification cannot drift. |
| `install-nsk.sh` | Installs the optional `nsk` operator CLI on demand (not shipped by default). |
| `setup-nodes.sh` | Bootstrap for a dedicated bitcoind **node box** (WireGuard-reached; no app, no ledger, no alerting). |
| `node-box-runbook.md` | The ordered runbook for moving bitcoind to that node box — sync first, then a minutes-long drain window. |

### Operator & break-glass scripts (run by units or by hand)
| File | Role |
|------|------|
| `status-check.sh` | Rail + app health check (run every 10 min by `status-check.timer`). Privacy-safe: reads the billing DBs only for an integrity pragma, never row content. |
| `alert.sh` | Pushes a one-line Telegram page. The `OnFailure=` sink for the units, and how `status-check.sh` closes an incident. Sends no request content. |
| `backup.sh` | Daily consistent (`sqlite3 .backup`) snapshot of the billing DBs, optional age-encryption + off-box push. |
| `restore.sh` | Restore from a `backup.sh` artifact. **Safe dry-run by default**; `--apply` to replace the live DBs, re-arm the credit outbox, and restart both services. |
| `regen-bitcoin-rpcauth.sh` | Break-glass: regenerate bitcoind's `rpcauth` + the proxy's RPC password as one matched pair. The cure for a BTC-rail 401. |

### systemd units & timers
`nullsink-proxy.service` + `nullsink-payments.service` (the app's two halves) · `bitcoind.service` ·
`monero-wallet-rpc.service` (the two rail watchers) ·
`tinfoil-proxy.service` (the Tinfoil verifying proxy / enclave attestation; installed when `TINFOIL_API_KEY` is set) ·
`backup.service` + `backup.timer` · `status-check.service` + `status-check.timer` ·
`status-alert@.service` (the templated `OnFailure=` paging sink).

### Public edge & firewall
`Caddyfile` (TLS + reverse proxy + security headers; a host-agnostic `{$NULLSINK_DOMAIN}` template) ·
`nftables.conf` (app box: default-deny inbound; only 22 / 80 / 443) ·
`nftables-nodes.conf` (node box: default-deny inbound; only 22 / WireGuard, bitcoind RPC solely across `wg0`).

## Two things to know

**App releases and pinned runtime dependencies have separate activation paths.** `deploy.sh <tag>` installs
nullsink's two server binaries, optional `nsk`, client UI, and deploy configuration. It never restarts a rail
watcher or attestation sidecar. For an existing box, activate one refreshed dependency pin explicitly:

```sh
# Dedicated node box
sudo /opt/nullsink/deploy/upgrade-component.sh bitcoin

# App box
sudo /opt/nullsink/deploy/upgrade-component.sh monero-wallet
sudo /opt/nullsink/deploy/upgrade-component.sh tinfoil
```

Each command refuses the wrong box role or an inactive/unconfigured target, verifies the download before
downtime, preserves the previous binaries under `/usr/local/lib/nullsink/component-rollbacks/`, restarts
only its target service, and rolls back automatically if the target does not recover. `setup.sh` and
`setup-nodes.sh` remain bootstrap tools for fresh or incomplete boxes, not routine dependency upgraders.

**The flat layout is deliberate.** It looks like it wants subfolders, but the release tarball, the
`install_units` glob (`deploy/*.service`/`*.timer`), every unit's `ExecStart=/opt/nullsink/deploy/...`
path, and ~40 doc references all assume files sit directly under `deploy/`. Keep new units/scripts here at
the top level. (The lint runner lives in [`scripts/lint.sh`](../scripts/lint.sh), *not* here — it's a
dev/CI tool, so it doesn't ride along to the box.)

**Nothing box-specific is committed.** Per-box config (domain, node address, RPC creds, Telegram token,
backup keys) lives only in `/etc/nullsink.env` and systemd drop-ins on the box, never in this tree.

**Release fetch is plain `curl`.** The four fetch helpers in `lib.sh` pull the public GitHub Release assets
over HTTPS and verify them against `SHA256SUMS` — no `gh`, no auth on the box. Build provenance is attested
in CI (`release.yml`); verify off-box with `gh attestation verify <file> --repo nullsink/nullsink`.
