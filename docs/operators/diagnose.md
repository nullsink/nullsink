# Diagnose nullsink

Start with the repository's one-shot check. Run it through systemd so it receives `/etc/nullsink.env`;
running `status-check.sh` directly can silently omit configured rail checks.

```sh
sudo systemctl start status-check.service
sudo journalctl -u status-check.service -n 80 --no-pager -o cat
```

The command exits unsuccessfully when any line begins with `WARN`. Read the first warning, fix that
layer, and run the check again.

Journal-based warnings use a 15-minute lookback. After a fault is fixed, an old `POLL BLIND`, rate,
billing, or outbox marker can keep the check red until it leaves that window. Confirm the current unit and
dependency are healthy; do not erase journals to force a green result.

## What does a green check prove?

| Signal | What it proves | What it does not prove |
| --- | --- | --- |
| Proxy `/healthz` | The proxy process answers on its loopback port | A provider key works, model requests succeed, or credits cross the socket |
| Payments `/healthz` | The payments process answers on its loopback port | Rate sources, wallet RPC, deposit polling, or credit delivery work |
| `status-check.service` | Enabled units, local health, database checks, recent error markers, backups, and configured rail probes passed | A new quote can be paid and credited end to end |
| Small real rail payment | Quote, wallet detection, confirmations, settlement, outbox delivery, and balance credit work together | Future availability |

Use both health endpoints when isolating the application halves:

```sh
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8081/healthz
```

Each response includes its build version. Different versions indicate a partial application rollout;
redeploy one release tag with `deploy.sh` rather than changing binary symlinks manually.

## Which journal owns the symptom?

| Symptom | First journal |
| --- | --- |
| Model request, balance, provider, hold, or billing problem | `nullsink-proxy` |
| Quote, rate, order, wallet poll, or credit-outbox problem | `nullsink-payments` |
| Public TLS, static UI, or reverse-proxy problem | `caddy` |
| XMR wallet or scan lag | `monero-wallet-rpc`, then `tor` |
| BTC sync or wallet problem | `bitcoind` on the node host |
| Scheduled health failure | `status-check.service` |
| Backup or remote push failure | `backup.service` |

Read recent warnings without dumping configuration secrets:

```sh
sudo journalctl -u nullsink-proxy -u nullsink-payments \
  --since '30 minutes ago' -p warning --no-pager
sudo systemctl --failed
```

nullsink intentionally has no access log, IP log, request history, or per-request trace. Journals carry
operational events and aggregate counters, not prompts or raw tokens.

## Why is the public service down when both local checks pass?

The fault is outside the two application processes: Caddy, DNS, certificate issuance, or the host
firewall.

```sh
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy --since '30 minutes ago' --no-pager
sudo nft list ruleset
curl -fsS https://example.com/v1/models
curl -fsS https://example.com/rails
```

Confirm that DNS points at this host and ports 80/443 are reachable. Validate the Caddy template with
the same domain the service should receive:

```sh
sudo env NULLSINK_DOMAIN=example.com \
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
```

`/healthz` is intentionally not routed publicly; a public 404 for that path is expected.

## Why is a service stopped or restarting repeatedly?

Inspect the unit result, restart count, and memory envelope before restarting it again:

```sh
sudo systemctl status nullsink-proxy nullsink-payments --no-pager
sudo systemctl show nullsink-proxy nullsink-payments \
  -p Result -p NRestarts -p MemoryCurrent -p MemoryMax
sudo journalctl -u nullsink-proxy -u nullsink-payments -b -p warning --no-pager
sudo journalctl -k --since '30 minutes ago' | grep -i oom
```

Common boot failures are an absent provider, an invalid numeric environment value, an empty/unknown
`PAY_RAILS`, a database permission error, or a non-socket file at `/run/nullsink/credit.sock`.

The units restart automatically, but repeated failure can hit systemd's start limit. After fixing the
cause:

```sh
sudo systemctl reset-failed nullsink-proxy nullsink-payments
sudo systemctl restart nullsink-proxy
sudo systemctl restart nullsink-payments
```

A proxy boot warning such as `recovered N stranded hold(s)` means the previous stop was ungraceful. The
proxy refunded those journaled holds before serving. Repeated recovery warnings point to OOM kills, power
loss, or forced termination and should be investigated rather than treated as routine restarts.

## Why can buyers not create a quote?

Match the public error to the owning dependency:

| Error or log | Likely layer | Safe action |
| --- | --- | --- |
| `rate_unavailable` or `[buy] rate unavailable` | Every configured price source failed or returned an out-of-band value | Test outbound access to the configured sources; keep at least two sources; rerun the health check |
| `wallet_unavailable` or `[buy] createAddress failed` | Selected rail's wallet RPC cannot derive an address | Check the rail watcher and its RPC; do not provide an address manually |
| `busy_try_later` | Global open-order ceiling reached | Inspect open orders and poller health; do not raise the ceiling until stale-order reaping is understood |
| `rate_limited` on `/buy` | Global identity-free quote throttle | Wait for the bucket to refill; investigate bursts before changing limits |
| `payments_error` or edge `payments_error` | Payments process or reverse proxy failed unexpectedly | Check local payments health, then its journal and Caddy |

One rate-source failure is tolerated when a later configured source succeeds. `rate unavailable` means
the full ordered failover failed for that quote.

## What does `POLL BLIND` mean?

`POLL BLIND` appears after one rail's settlement poller fails repeatedly. New and existing deposits on
that rail are not being detected while it persists. Another configured rail continues polling
independently.

Run the one-shot check to separate the causes:

- XMR: wallet RPC unreachable, Tor/remote node unavailable, remote node unsynced, or the wallet more
  than three blocks behind the node.
- BTC: node/WireGuard unreachable, RPC credentials rejected, initial block download, chain lag, wallet
  not loaded, or `listunspent` failing.

Keep the payments service running while repairing its dependency when possible: it owns `pending.db`,
continues tracking other rails, and will retry the failed rail on later ticks. Do not tell a buyer to pay
again; delayed detection is not evidence that an on-chain transfer failed.

The current XMR node probe always goes through Tor. A staging host configured with an empty
`MONERO_PROXY_ARG` for a direct clearnet node can therefore report a node warning even when the wallet's
direct path works. Verify that staging path separately; this is a monitor limitation, not evidence that a
production Tor configuration should be weakened.

For a confirmed Bitcoin RPC-auth mismatch, use the paired credential tool instead of editing one half:

> **This rotates the RPC password and restarts bitcoind.** On a split node host it prints the new app-side
> password once; schedule the change and update the application host immediately.

```sh
# Same-host Bitcoin deployment
sudo /opt/nullsink/deploy/regen-bitcoin-rpcauth.sh

# Dedicated node host
sudo PRINT_PASSWORD=1 /opt/nullsink/deploy/regen-bitcoin-rpcauth.sh
```

After a split-node rotation, replace `BITCOIN_RPC_PASSWORD` on the application host, restart
`nullsink-payments`, and rerun `status-check.service`. The status check uses the same Basic-auth RPC path
as the application; a successful local `bitcoin-cli` cookie connection alone does not test it.

## What does `CREDIT OUTBOX STALLED` mean?

A payment was settled into `pending.db`, but its credit has remained unacknowledged past
`OUTBOX_AGE_ALERT_MS`—ten minutes by default. This is a money incident even when both HTTP health checks
are green.

Inspect both services and the socket:

```sh
sudo systemctl status nullsink-proxy nullsink-payments --no-pager
sudo ls -ld /run/nullsink
sudo ls -l /run/nullsink/credit.sock
sudo journalctl -u nullsink-proxy -u nullsink-payments \
  --since '30 minutes ago' --no-pager
```

The normal socket is owned by `nullsink:nullsink` and mode `0700`; the runtime directory is service-owned.
Common causes are a down proxy, a missing/stale socket, a mixed-version proxy/payments pair, database write
failure, or a credit-wire version mismatch.

Do not delete, acknowledge, or edit an outbox row, and do not issue a manual top-up while delivery may
still retry. The sender stops at the first ambiguous row and retries later; the receiver's
`applied_orders` marker makes a repeated delivery a no-op. Restore the proxy/socket path or redeploy one
release in lockstep, then confirm the payments journal reports delivered credits and the warning clears.

Stopping `nullsink-payments` also stops deposit detection. If new quotes must be suspended during a long
credit incident, block only new `/buy` traffic at the operational edge while leaving the poller running;
the repository does not currently provide a dedicated maintenance switch for this.

## What do provider and billing warnings require?

The proxy masks operator-side provider failures from API clients, refunds the request hold, and records
the real class in its journal and hourly `[metrics]` line.

| Marker | Meaning | Operator action |
| --- | --- | --- |
| `upstream:billing` or an upstream low-credit message | nullsink's provider account is out of funds | Top up that provider account; client retries alone will not fix it |
| `upstream:auth` | Provider key is invalid or lacks permission | Replace or correct the operator-owned key, then restart the proxy |
| `upstream:throttle` | Genuine provider rate limit | Respect `Retry-After`; reduce concurrency or request more provider capacity |
| `upstream:5xx` | Provider is degraded | Confirm provider recovery; another configured provider is not an automatic substitute for the requested model |
| `upstream:timeout` or `upstream:unreachable` | Timeout, DNS, TLS, or network failure | Test host egress and the configured provider base URL |
| `[bill] … refunded in full` | A successful response had no parseable usage; real usage may have been served without charge | Treat as a metering incident; isolate the affected provider/model before more traffic |
| `[bill] actual cost … exceeded hold` | Measured cost exceeded the reserved upper bound; refund was clamped to zero | No customer overdraft occurred, but pricing or hold sizing must be corrected |

Do not dismiss repeated billing markers because customers were refunded. They represent provider cost or
a broken upper-bound assumption.

## What do the aggregate metrics say?

The `[metrics]` line is an in-memory window, emitted hourly by default and at clean shutdown. It contains
counts and peaks only; a restart resets the window.

| Field | Read it as |
| --- | --- |
| `served=N req=M` | Forwarded requests versus cleanly billed successes; the remaining requests are itemized by adjacent outcome counters |
| `bill:refunded`, `bill:holdexceeded` | Money-path anomalies requiring investigation |
| `credit:enqueued`, `credit:acked`, `credit:dedup` | Credit-outbox throughput and safe repeat deliveries |
| `credit:blocked`, `peak:outbox`, `max:outbox-age-s` | Credit crossing is ambiguous, queued, or aging |
| `reject:buy`, `reject:read`, `reject:orders` | Local rate/capacity shedding |
| `gate:auth`, `gate:request`, `gate:model`, `gate:premium`, `gate:funds` | Client requests rejected before forwarding; usually not an operator outage |
| `recovered:holds` | Holds refunded after an ungraceful proxy stop |
| `peak:streams`, `peak:orders` | Concurrency/open-order high-water marks for capacity review |

View recent windows with:

```sh
sudo journalctl -u nullsink-proxy -u nullsink-payments \
  --since '24 hours ago' --no-pager | grep '\[metrics\]'
```

## What should I do about database, disk, or backup warnings?

| Warning | Immediate action |
| --- | --- |
| Disk or inode use at/above 85% | Add capacity or remove known non-billing files. Do not delete SQLite WAL files or unverified backups to make room. |
| `db-wal`/`db-shm` owned by root | Stop using root SQLite/CLI access and restore ownership to `nullsink`; rerun both service checks. |
| `PRAGMA quick_check` failure | Treat as a recovery incident. Stop payments then proxy, preserve evidence, and follow the backup/restore runbook. |
| No backup or newest backup older than 28 hours | Run `backup.service`, inspect its journal, and repair encryption/push/storage before accepting another green check. |

Repair sidecar ownership without opening the databases as root:

```sh
sudo find /var/lib/nullsink -maxdepth 1 \
  \( -name '*.db-wal' -o -name '*.db-shm' \) \
  -exec chown nullsink:nullsink {} +
```

For integrity failures or restore decisions, use
[Back up and restore billing state](backup-restore.md). Do not run SQLite repair commands against the live
ledger as an experiment.

## How do I investigate a paid-but-uncredited report?

Ask for the rail, payment address, amount, transaction id, approximate UTC time, and the 64-character
token hash. Never ask for or accept the raw `0sink_…` bearer token.

1. Confirm the payment on the appropriate chain and compare its confirmations with the quote.
2. Run `status-check.service`; look first for `POLL BLIND` and `CREDIT OUTBOX STALLED`.
3. Check the live balance by hash and the open-order view if the optional CLI is installed:

   ```sh
   sudo -u nullsink nsk balance <64-character-token-hash>
   sudo -u nullsink nsk orders --format table
   ```

4. Inspect a verified backup copy for deeper payment/outbox/applied-ledger reconciliation. Avoid ad-hoc
   root queries against live SQLite files.
5. Do not use `nsk topup` until the original payment is proven unable to deliver automatically. A queued
   outbox credit can arrive later and turn an early manual correction into a double credit.

`closed` payment status is not proof of credit. The balance ledger is authoritative for spendable credit;
the chain and retained payment/outbox evidence establish what should have been credited.

## How do alerts fail safely?

`status-check.timer` runs five minutes after boot and every ten minutes afterward. Enabled application,
wallet, backup, and health units use `OnFailure` to invoke the Telegram alert unit.

- With no Telegram bot token/chat id, alerts are a logged no-op.
- Health-check alerts include only `WARN` lines and an OK count. Other unit alerts include only unit and
  host names—not journal content.
- A successful check after a failed one sends a recovery message unless a reboot cleared the transient
  incident marker.
- `HEARTBEAT_URL` is pinged on success and `/fail` on a failed check. The off-host monitor must alert when
  pings stop; Telegram on the application host cannot report a dead host or network.

Send a deliberate Telegram test without failing an application service:

```sh
sudo systemctl start status-alert@manual-test.service
sudo journalctl -u status-alert@manual-test.service -n 20 --no-pager
```

Then run a healthy `status-check.service` and confirm the heartbeat receiver saw the ping.

## What evidence should I save for an incident?

Record UTC start/end times, affected public endpoints/rails/providers, the first `WARN`, unit versions,
restart counts, relevant aggregate metrics, and the recovery action. For payment incidents, record the
transaction id, address, amount, token hash, and confirmation depth—but never the raw token or request
content.

Preserve journal output and a fresh encrypted billing backup before destructive recovery. State clearly
which facts are direct observations and which are inferences; nullsink deliberately cannot reconstruct a
per-user request history it never stored.
