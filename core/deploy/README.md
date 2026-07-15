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

See setup.sh to stand up a box, and deploy.sh / backup.sh / node-box-runbook.md for day-2 work (redeploys, backups,
alerts, troubleshooting). This file is just the map.

## Upgrade an existing box

Always run the **target release's** deployer. `/opt/nullsink/deploy/deploy.sh` belongs to the release that is
already live; it cannot retroactively provide rollback rules introduced by the target. This matters most for
the first upgrade from an older, non-transactional deployer, but the rule applies to every release. The current
deployer refuses to activate a target when invoked from the installed tree.

Fetch one target `SHA256SUMS` snapshot, verify the target deploy bundle against it, extract off to the side,
then run that bundle's script:

```bash
set -euo pipefail
tag=v1.8.3
[[ "$tag" =~ ^v[0-9][0-9A-Za-z._-]*$ ]]
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/nullsink/nullsink/releases/download/$tag"
asset="deploy-${tag}.tar.gz"

curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
(
  cd "$tmp"
  awk -v required="$asset" '
    NF >= 2 {
      name=$2; sub(/^\*/, "", name)
      if (name == required) { print; matches++ }
    }
    END { exit(matches == 1 ? 0 : 1) }
  ' SHA256SUMS > deploy.SHA256SUMS
  sha256sum -c deploy.SHA256SUMS
)
mkdir "$tmp/target"
tar -xzf "$tmp/$asset" -C "$tmp/target"
test -x "$tmp/target/deploy/deploy.sh"
sudo "$tmp/target/deploy/deploy.sh" "$tag" "$tmp/SHA256SUMS"
```

The target deployer copies that exact `SHA256SUMS` snapshot into its transaction, then verifies the two server
binaries, optional `nsk`, deploy tree, and UI against it before stopping anything. It accepts a rollback
baseline only when proxy, payments, and UI all name the same release and the served `index.html` is readable.
On failure it restores that complete baseline and requires both old services to report the old version before
timers resume. Before its first mixed-release mutation it installs persistent boot-gate drop-ins and fsyncs
`/var/lib/nullsink/.deploy-in-progress`; the marker keeps both app services and backups stopped after a host
loss until the release is made consistent again.

## What's here, by concern

### Bootstrap & redeploy
| File | Role |
|------|------|
| `setup.sh` | First-boot bootstrap for a fresh Ubuntu box, plus same-release host/toolchain reconciliation. It stages binaries + UI before activating either and can repair an interrupted same-target first activation; mixed/other-tag pointers are refused. Existing app/UI upgrades must use the target release's deploy transaction. |
| `deploy.sh` | Target-release, health-gated transaction for an *existing* box. It stages every artifact first, quiesces app + maintenance jobs, activates binaries/config/UI while the reboot gate is armed, flushes every touched filesystem before committing, and **rolls back the whole previous matching release** on any failure. It does not install or upgrade Bitcoin Core, Monero, or `tinfoil-proxy`. |
| `deploy-transaction.sh` / `deploy-guard.sh` | Sourceable activation sequence plus the durable reboot gate used by `deploy.sh`; kept separate so every failure boundary is fault-tested without touching a real box. |
| `lib.sh` | Shared "apply repo config" library `source`d by both of the above, so unit install, timer reconcile, and asset fetch live in one place and can't drift between bootstrap and redeploy. |
| `install-nsk.sh` | Installs the optional `nsk` operator CLI on demand (not shipped by default). |
| `setup-nodes.sh` | Bootstrap for a dedicated bitcoind **node box** (WireGuard-reached; no app, no ledger, no alerting). |
| `node-box-runbook.md` | The ordered runbook for moving bitcoind to that node box — sync first, then a minutes-long drain window. |

### Operator & break-glass scripts (run by units or by hand)
| File | Role |
|------|------|
| `status-check.sh` | Rail + app health check (run every 10 min by `status-check.timer`). Privacy-safe: reads the billing DBs only for an integrity pragma, never row content. |
| `alert.sh` | Pushes a one-line Telegram page. The `OnFailure=` sink for the units, and how `status-check.sh` closes an incident. Sends no request content. |
| `backup.sh` / `backup-safety.sh` | Daily matched-pair (`sqlite3 .backup`) snapshot of `pending.db` then `balances.db`. It holds restore-exclusion and single-writer locks, then publishes only a validated, fsynced, atomically renamed artifact; missing/wrong-schema ledgers fail the run and off-box push requires age encryption. |
| `restore.sh` / restore helpers | Restore a matched artifact. **Safe dry-run by default**; `--apply` binds an interrupted run to that exact pair, gates boot, preserves WAL-backed live state, replaces/reconciles/validates, then starts and readiness-checks the stack. |
| `maintenance-lock.sh` | Host-wide setup/deploy/restore exclusion, backup single-writer exclusion, and the shared-reader/exclusive-restore ledger lock used by `nsk`, backup, and restore. |
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

## Things to know

**App releases and pinned runtime dependencies have separate activation paths.** The verified target
`deploy.sh <tag> <manifest>` installs
nullsink's two server binaries, optional `nsk`, client UI, and deploy configuration. Although that refreshed
deploy tree contains the current Bitcoin Core, Monero, and `tinfoil-proxy` pins, `deploy.sh` never runs their
installers. Pinned runtime dependency updates take effect only during a fresh setup or an applicable setup
rerun: `setup.sh` updates dependencies for enabled app-box rails (and a local Bitcoin node), while
`setup-nodes.sh` updates Bitcoin Core on a dedicated node box. This separation avoids silently restarting a
rail daemon during an ordinary application deploy.

**Restore is fail-closed across interruption.** Live apply targets only the committed
`/var/lib/nullsink`/systemd layout. Before either ledger moves, `restore.sh --apply` fsyncs a
`.restore-in-progress` marker containing the verified pair's digest; the proxy, payments, backup, and status
jobs cannot start while it exists. It preserves each live database through SQLite's backup API (including
committed WAL frames), swaps the staged pair, reconciles the outbox, and validates the live pair while gated.

Before opening that boot gate, restore durably writes a second pair-bound
`.restore-activation-pending` marker. It requests both applications and both timers in one multi-unit start,
requires all four units active, probes both local application `/healthz` endpoints, then rechecks activity.
Unrelated setup/deploy, backup, and `nsk` work rejects the activation marker. An immediately-due backup or
status timer condition-skips its job successfully during warmup, avoiding a false `OnFailure` page. Once
readiness passes, restore waits out those skipped one-shot jobs, releases the exclusive ledger lock while the
marker still blocks readers, removes the marker durably, and starts distinct real status-check and backup jobs.

`HUP`/`INT`/`TERM`, a failed start/probe, or an inactive unit re-arms the first guard and stops the complete
stack. `SIGKILL`/power loss can leave the activation marker without the first guard, but the live ledger is
already validated and any partial multi-unit start is explicitly resumable. Rerun the **same artifact**: restore
recognizes its digest, re-gates/quiesces the stack, revalidates the live invariant, and retries activation
without staging or replacing either database. This preserves any post-restore writes and the original
`*.prerestore*` recovery material. A different artifact is rejected. Never remove either marker by hand;
after successful activation, remove `*.prerestore*` only once the restored state is independently accepted.

Setup, deploy, and restore also share a non-blocking maintenance lock. Before inspecting recovery slots or
touching live state, restore takes an exclusive `/var/lib/nullsink/.ledger.lock`; every ledger-opening `nsk`
command and every backup holds the shared side for its process lifetime. An active operator command or backup
therefore makes restore refuse before services stop, and a direct backup refuses either restore-phase marker.
Backups also take a non-blocking single-writer lock, so concurrent/same-second manual runs cannot clobber one
name. Artifacts are built under a dot-prefixed partial name, validated, filesystem-synced, atomically renamed
to `backup-*`, and synced again before freshness monitoring or off-box push can observe them.

If the verified backup is sound but the stopped live database is corrupt enough that SQLite cannot make its
required `.prerestore` copy, normal apply fails closed. The explicit last-resort form is
`restore.sh --apply --archive-unreadable-live <artifact>`. It first refuses the bypass when `quick_check`
still says the live source is readable; otherwise it stores owner-only raw main/WAL/SHM bytes as
`*.prerestore-unreadable.tar` and proceeds. That tar is sensitive forensic material, **not** a validated
recovery database; retain/move it securely and remove it only after the restored pair is verified.

**Handled deploy failures roll back; interrupted deploys boot fail-closed.** The deploy transaction covers
ordinary failures plus `INT`/`TERM`. During the non-atomic multi-directory/systemd/Caddy interval, a durable
`.deploy-in-progress` condition keeps proxy, payments, and backup from auto-starting after `SIGKILL` or host
loss. The marker is removed only after target binaries, pointers, deploy/config state, and UI all form one
release and every touched filesystem has been flushed, or after the same durability proof for a completely
restored old release. The committed target is then restarted and version-health-checked. A leftover marker
therefore means availability requires an operator: keep services stopped,
inspect the retained `.deploy-txn-*`/`.deploy-ui-*` material, complete one release or restore the matching
baseline, health-check both services, and only then clear the gate. Exercise both forward and rollback crash
boundaries on staging; never delete the marker merely to make systemd start a mixed tree.

**App releases and pinned runtime dependencies have separate activation paths.** `deploy.sh <tag>` installs
nullsink's two server binaries, optional `nsk`, client UI, and deploy configuration. Although that refreshed
deploy tree contains the current Bitcoin Core, Monero, and `tinfoil-proxy` pins, `deploy.sh` never runs their
installers. Pinned runtime dependency updates take effect only during a fresh setup or an applicable setup
rerun: `setup.sh` updates dependencies for enabled app-box rails (and a local Bitcoin node), while
`setup-nodes.sh` updates Bitcoin Core on a dedicated node box. This separation avoids silently restarting a
rail daemon during an ordinary application deploy.

**The flat layout is deliberate.** It looks like it wants subfolders, but the release tarball, the
`install_units` glob (`deploy/*.service`/`*.timer`), every unit's `ExecStart=/opt/nullsink/deploy/...`
path, and ~40 doc references all assume files sit directly under `deploy/`. Keep new units/scripts here at
the top level. (The lint runner lives in [`scripts/lint.sh`](../scripts/lint.sh), *not* here — it's a
dev/CI tool, so it doesn't ride along to the box.)

**Nothing box-specific is committed.** Per-box config (domain, node address, RPC creds, Telegram token,
backup keys) lives only in `/etc/nullsink.env` and systemd drop-ins on the box, never in this tree.

**Release fetch is plain `curl`.** The helpers in `lib.sh` pull the public GitHub Release assets over HTTPS;
each setup or deploy run verifies all required nullsink assets against one local `SHA256SUMS` snapshot — no
`gh`, no auth on the box. Build provenance is attested
in CI (`release.yml`); verify off-box with `gh attestation verify <file> --repo nullsink/nullsink`.
