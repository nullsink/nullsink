# `deploy/` — the box's runtime + bootstrap tree

Everything the production box runs that is *not* the app binary itself: the systemd units that
supervise it, the operator scripts those units invoke, the public-edge config, and the firewall.

The box is **source-free**. It runs the two compiled server binaries
(`/usr/local/lib/nullsink/current-proxy` and `current-payments`) plus the scripts in this directory; it has
no `src/`, no `cli/`, and no Bun. This whole directory ships to the box as a release tarball
(`deploy-<tag>.tar.gz`, built by `.github/workflows/release.yml`) and extracts to `/opt/nullsink/deploy/`.
The units' `ExecStart` lines point straight at these paths.

The app is **two processes**, split by privilege rather than by scale: `nullsink-proxy` serves the metered
`/v1` paths and owns `balances.db`; `nullsink-payments` serves `/buy`, `/order-status`, `/rails`, runs the
settlement poller, and owns `pending.db`. A request carrying a prompt never reaches the process that holds
the payment→token link. The only channel between them is a unix socket at `/run/nullsink/credit.sock`, over
which payments delivers credits in one direction. They share one service user today; splitting the uids
waits on the admin-plane redesign (see `nullsink-proxy.service` for why).

See the install docs to stand up a box and the operations docs for day-2 work (redeploys, backups,
alerts, troubleshooting). This file is just the map.

## What's here, by concern

### Bootstrap & redeploy
| File | Role |
|------|------|
| `setup.sh` | First-boot bootstrap for a fresh Ubuntu box (idempotent). Installs the toolchain, units, Caddy edge, and firewall, fetches + verifies the pinned release, and prints a next-steps checklist. |
| `deploy.sh` | Health-gated redeploy of an *existing* box to a release tag. Atomically swaps both binary symlinks in lockstep, refreshes units + edge from this tree, reconciles the timers, warns if an enabled rail-daemon unit changed (it won't bounce a node mid-sync), and **rolls back** if either service fails `/healthz`. |
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

## Cutting over to the split

The first deploy of a split release onto a pre-split box needs a bootstrap step. `deploy.sh` fetches the
binaries *before* it refreshes the deploy tree, and the pre-split `install_binary` still on the box asks for
`nullsink-linux-x64` — an asset split releases no longer publish. That fetch 404s and, under `set -e`, the run
aborts on its first step, changing nothing (verified: it exits 22 with the service still serving). Install the
split deploy tree first, then run **its** `deploy.sh`.

Pick a window where the money seam is unambiguous — both counts `0`:

```sh
sudo -u nullsink sqlite3 -readonly /var/lib/nullsink/pending.db \
  'SELECT (SELECT count(*) FROM pending_orders), (SELECT count(*) FROM credit_outbox WHERE acked_at IS NULL);'
```

Take the safety copies, so a rollback never depends on GitHub being reachable:

```sh
cp -a /opt/nullsink/deploy /root/deploy.pre-split
cp /etc/caddy/Caddyfile /root/Caddyfile.pre-split
```

Then, as root:

```sh
TAG=<split-tag>

# 1. Replace the deploy tree with the split release's. REPLACE, don't overlay: a stale nullsink.service left
#    behind in the tree gets copied back into /etc/systemd/system by install_units on every later deploy.
tmp="$(mktemp -d)"
for f in "deploy-$TAG.tar.gz" SHA256SUMS; do
  curl -fsSL "https://github.com/nullsink/nullsink/releases/download/$TAG/$f" -o "$tmp/$f"
done
( cd "$tmp" && sha256sum -c --ignore-missing SHA256SUMS ) || exit 1
tar -xzf "$tmp/deploy-$TAG.tar.gz" -C "$tmp"
rm -rf /opt/nullsink/deploy && mv "$tmp/deploy" /opt/nullsink/deploy

# 2. Now the split deploy.sh runs: verifies both binaries, retires nullsink.service, enables both units,
#    swaps in the :8081 routing, restarts proxy then payments, and health-gates both.
/opt/nullsink/deploy/deploy.sh "$TAG"
```

The split changes no schema, so there is no migration and no `nsk migrate-revenue` — downtime is just the
restart. On the **first** cutover `deploy.sh` has no previous split binaries to fall back on, so a failed health
gate stops at `ROLLBACK IMPOSSIBLE`; recover with the section below.

## Rolling back across the split

`deploy.sh` rolls a failed deploy back by flipping the two version symlinks, which needs a *previous* pair of
split binaries. On the first cutover there is none, so it stops with `ROLLBACK IMPOSSIBLE` and leaves the box
on the split. Every later deploy rolls back on its own.

Going back to a **pre-split tag** is a manual, two-stage job. The split `deploy.sh` cannot install one: its
`install_binary` fetches `nullsink-proxy-linux-x64` and `nullsink-payments-linux-x64`, while a pre-split release
publishes only `nullsink-linux-x64`. That fetch 404s and, under `set -e`, the script aborts on its first step —
safely, having changed nothing, but it will never complete. Restore the target release's deploy tree first, then
run **its** `deploy.sh`.

**Drain the credit outbox first.** `v1.7.0` understands `credit_outbox` and drains it in-process, so rolling
back to it strands nothing. Releases below `v1.7.0` cannot see the table at all: an unacked row there is a paid
credit that sits undelivered until you roll forward. With both services still running, wait for this to read `0`:

```sh
sudo -u nullsink sqlite3 -readonly /var/lib/nullsink/pending.db \
  'SELECT count(*) FROM credit_outbox WHERE acked_at IS NULL;'
```

Then, as root:

```sh
TAG=<pre-split-tag>

# 1. Stop the split and delete its units — install_units would otherwise copy them straight back.
systemctl disable --now nullsink-proxy nullsink-payments
rm -f /etc/systemd/system/nullsink-proxy.service /etc/systemd/system/nullsink-payments.service
systemctl daemon-reload

# 2. Swap in that release's deploy tree: its nullsink.service, its Caddyfile, its deploy.sh.
tmp="$(mktemp -d)"
for f in "deploy-$TAG.tar.gz" SHA256SUMS; do
  curl -fsSL "https://github.com/nullsink/nullsink/releases/download/$TAG/$f" -o "$tmp/$f"
done
( cd "$tmp" && sha256sum -c --ignore-missing SHA256SUMS ) || exit 1
tar -xzf "$tmp/deploy-$TAG.tar.gz" -C "$tmp"          # -> $tmp/deploy/*
rm -rf /opt/nullsink/deploy && mv "$tmp/deploy" /opt/nullsink/deploy

# 3. Run THAT deploy.sh: single binary + `current`, nullsink.service, pre-split Caddyfile, health gate.
/opt/nullsink/deploy/deploy.sh "$TAG"
rm -f /usr/local/lib/nullsink/current-proxy /usr/local/lib/nullsink/current-payments   # split leftovers

# 4. Re-arm it for boot. `retire_legacy_unit` DISABLED nullsink.service during the cutover, and deploy.sh only
#    ever restarts the app — enabling it is setup.sh's job, at bootstrap. Skip this and the rollback looks
#    perfectly healthy until the next reboot comes up with no app at all.
systemctl enable nullsink
```

Confirm before you walk away — `active` is not enough:

```sh
systemctl is-active nullsink && systemctl is-enabled nullsink   # want: active + enabled
```

Keep a local copy before cutting over, so recovery survives GitHub being unreachable:

```sh
cp -a /opt/nullsink/deploy /root/deploy.pre-split
cp /etc/caddy/Caddyfile /root/Caddyfile.pre-split
```

The databases need no migration in either direction: both halves read `/var/lib/nullsink/{balances,pending}.db`,
and the split changes no schema. Below `v1.7.0` the sales book is the exception — `migrate-revenue.ts` *copies*
rather than moves, so `balances.db`'s `revenue` table survives but goes stale, and `nsk financials` on such a
binary undercounts every sale booked after that cutover. Balances themselves are unaffected.
