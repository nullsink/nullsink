# `deploy/` — the box's runtime + bootstrap tree

Everything the production box runs that is *not* the app binary itself: the systemd units that
supervise it, the operator scripts those units invoke, the public-edge config, and the firewall.

The box is **source-free**. It runs the compiled server binary (`/usr/local/lib/nullsink/current`) plus
the scripts in this directory; it has no `src/`, no `cli/`, and no Bun. This whole directory ships to the
box as a release tarball (`deploy-<tag>.tar.gz`, built by `.github/workflows/release.yml`) and extracts to
`/opt/nullsink/deploy/`. The units' `ExecStart` lines point straight at these paths.

See the install docs to stand up a box and the operations docs for day-2 work (redeploys, backups,
alerts, troubleshooting). This file is just the map.

## What's here, by concern

### Bootstrap & redeploy
| File | Role |
|------|------|
| `setup.sh` | First-boot bootstrap for a fresh Ubuntu box (idempotent). Installs the toolchain, units, Caddy edge, and firewall, fetches + verifies the pinned release, and prints a next-steps checklist. |
| `deploy.sh` | Health-gated redeploy of an *existing* box to a release tag. Atomically swaps the binary symlink, refreshes units + edge from this tree, reconciles the timers, warns if an enabled rail-daemon unit changed (it won't bounce a node mid-sync), and **rolls back** if the new binary doesn't pass `/healthz`. |
| `lib.sh` | Shared "apply repo config" library `source`d by both of the above, so unit install, timer reconcile, and asset fetch live in one place and can't drift between bootstrap and redeploy. |
| `install-nsk.sh` | Installs the optional `nsk` operator CLI on demand (not shipped by default). |
| `setup-nodes.sh` | Bootstrap for a dedicated bitcoind **node box** (WireGuard-reached; no app, no ledger, no alerting). |
| `node-box-runbook.md` | The ordered cutover runbook for moving bitcoind to that node box — sync first, then a minutes-long drain window. |
| `cutover-runbook.md` | The one-time revenue cutover: stop the service, `nsk migrate-revenue --apply`, then deploy. Run once per box. |

### Operator & break-glass scripts (run by units or by hand)
| File | Role |
|------|------|
| `status-check.sh` | Rail + app health check (run every 10 min by `status-check.timer`). Privacy-safe: reads the billing DBs only for an integrity pragma, never row content. |
| `alert.sh` | Pushes a one-line Telegram page. The `OnFailure=` sink for the units, and how `status-check.sh` closes an incident. Sends no request content. |
| `backup.sh` | Daily consistent (`sqlite3 .backup`) snapshot of the billing DBs, optional age-encryption + off-box push. |
| `restore.sh` | Restore from a `backup.sh` artifact. **Safe dry-run by default**; `--apply` to replace the live DBs. |
| `regen-bitcoin-rpcauth.sh` | Break-glass: regenerate bitcoind's `rpcauth` + the proxy's RPC password as one matched pair. The cure for a BTC-rail 401. |

### systemd units & timers
`nullsink.service` (the app) · `bitcoind.service` · `monero-wallet-rpc.service` (the two rail watchers) ·
`tinfoil-proxy.service` (the Tinfoil verifying proxy / enclave attestation; installed when `TINFOIL_API_KEY` is set) ·
`backup.service` + `backup.timer` · `status-check.service` + `status-check.timer` ·
`status-alert@.service` (the templated `OnFailure=` paging sink).

### Public edge & firewall
`Caddyfile` (TLS + reverse proxy + security headers; a host-agnostic `{$NULLSINK_DOMAIN}` template) ·
`nftables.conf` (app box: default-deny inbound; only 22 / 80 / 443) ·
`nftables-nodes.conf` (node box: default-deny inbound; only 22 / WireGuard, bitcoind RPC solely across `wg0`).

## Two things to know

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
