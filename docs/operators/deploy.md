# Deploy and configure nullsink

This procedure installs a release on one Ubuntu application host. The host runs compiled release
artifacts, not a source checkout or Bun.

## What will run on this host?

| Component | Listens on | Owns |
| --- | --- | --- |
| `nullsink-proxy` | `127.0.0.1:8080` | Model endpoints, `balances.db`, upstream provider keys |
| `nullsink-payments` | `127.0.0.1:8081` | Purchase endpoints, settlement poller, `pending.db` |
| Caddy | Public ports 80 and 443 | TLS, static purchase UI, path routing |
| Payment watchers | Loopback or a private node link | Watch-only payment addresses and deposit detection |

Payments delivers credits to the proxy over `/run/nullsink/credit.sock`. Both databases live under
`/var/lib/nullsink`, but each service opens only its own database.

The standard firewall accepts inbound SSH, HTTP, and HTTPS only. Keep both application processes on
loopback; Caddy is the public edge.

## What must I prepare?

- A fresh x86_64 Ubuntu host with root access. Release binaries and the pinned payment components are
  built for x86_64 Linux.
- A nullsink release tag to install.
- At least one upstream key: Anthropic, OpenAI, or Tinfoil.
- At least one payment rail. Monero needs a view-only wallet plus a reachable node. Bitcoin needs a
  fully synced watch-only wallet and node.
- For a public service, a domain whose A/AAAA records can point at the host and inbound ports 80 and
  443.

Keep cryptocurrency spend keys offline. The application host needs view/watch material to derive
addresses and observe deposits; it never needs authority to spend them.

## How do I bootstrap the host?

Choose the release deliberately, then fetch and verify only its deploy bundle:

```sh
TAG=vX.Y.Z
mkdir -p nullsink-bootstrap
cd nullsink-bootstrap
curl -fsSLO "https://github.com/nullsink/nullsink/releases/download/$TAG/deploy-$TAG.tar.gz"
curl -fsSLO "https://github.com/nullsink/nullsink/releases/download/$TAG/SHA256SUMS"
sha256sum -c --ignore-missing SHA256SUMS
sudo mkdir -p /opt/nullsink
sudo tar -xzf "deploy-$TAG.tar.gz" -C /opt/nullsink
sudo env RELEASE_TAG="$TAG" bash /opt/nullsink/deploy/setup.sh
```

Replace `vX.Y.Z` with the release you intend to run. Do not continue if checksum verification fails.

The first run installs verified release binaries and the static UI, creates the `nullsink` service
user, writes systemd units, enables health and backup timers, installs Caddy and the firewall, and
creates `/etc/nullsink.env`. It deliberately leaves the application stopped when that environment
file is new.

## What must I configure before starting the services?

Edit `/etc/nullsink.env` as root. It is owned by the service user and mode `0600` because it contains
upstream and wallet RPC credentials.

```sh
sudoedit /etc/nullsink.env
```

Keep comments on their own lines. systemd treats everything after `=` as the value, including an
inline `# comment`.

### Which public and provider settings matter?

| Setting | Decision |
| --- | --- |
| `ANTHROPIC_API_KEY` | Set to enable `POST /v1/messages`; remove the generated `replace-me` value if Anthropic is not used. |
| `OPENAI_API_KEY` | Set to enable `POST /v1/chat/completions` and `POST /v1/responses`. |
| `TINFOIL_API_KEY` | Set to enable configured open-weight models on `POST /v1/chat/completions`. A setup rerun installs the local attesting proxy. |
| `NULLSINK_DOMAIN` | Set to the public hostname. Leave empty only for a private, loopback-only deployment. |
| `HOST` | Keep `127.0.0.1` on a deployed host. |
| `PORT`, `PAYMENTS_PORT` | Keep `8080` and `8081` unless you also maintain matching Caddy routes. Release deploys refresh the committed Caddyfile. |
| `DEFAULT_MAX_OUTPUT_TOKENS` | Keep `0` to require an explicit request cap. A positive value is injected when a client omits its cap and must not exceed the smallest output limit of any served model. |

With no provider variable set, `nullsink-proxy` exits at startup. The generated `replace-me` value
does let the process boot, but Anthropic rejects requests made with it; configure at least one real
key before treating the service as ready. When Tinfoil is enabled and `TINFOIL_BASE_URL` is absent,
the setup rerun sets it to the local attesting proxy at `http://127.0.0.1:3301`. An explicit public
Tinfoil URL bypasses that local attestation path.

### Which payment settings matter?

| Setting | Decision |
| --- | --- |
| `PAY_RAILS` | Comma-separated active rails: `monero`, `bitcoin`, or both. The first rail is the default returned by `/rails`. Do not leave it empty while running `nullsink-payments`. |
| `MONERO_WALLET_RPC_URL` | Local view-only wallet RPC endpoint; the standard unit uses `http://127.0.0.1:18083/json_rpc`. |
| `MONERO_CONFIRMATIONS` | Required XMR confirmation depth. The code default is 10. |
| `BITCOIN_RPC_URL` | Wallet-scoped watch-only RPC endpoint, for example `http://127.0.0.1:8332/wallet/nullsink`. |
| `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASSWORD` | The credentials paired with bitcoind's `rpcauth` entry. |
| `BITCOIN_CONFIRMATIONS` | Required BTC confirmation depth. The code default is 3. |

Removing a rail from `PAY_RAILS` prevents new quotes for it **and stops polling its existing orders**.
Keep the rail enabled while repairing a wallet or node when possible. To pause only new purchases while
payment monitoring continues, block `/buy` at the edge; there is no dedicated purchase-maintenance switch.

Do not add `bitcoin` to `PAY_RAILS` until the live node reports a complete sync and its watch-only
wallet is loaded. For a dedicated Bitcoin node, follow the ordered
[node-box runbook](../../core/deploy/node-box-runbook.md); its drain and wallet-migration order is part
of the money-safety design.

For Monero, create `/var/lib/nullsink-wallet/prview` and `/etc/monero-wallet-rpc.env` as directed by
the setup checklist, then enable `monero-wallet-rpc`. That file supplies the remote node and optional
network/proxy arguments consumed by the hardened service unit. The wallet must be view-only.

Pricing and order controls such as `MARGIN`, `BUY_MIN_USD`, `BUY_MAX_USD`, `RATE_SOURCES`, and the
order lifetimes have validated defaults. Change them only as an explicit product decision; the complete
supported variable list and bounds are in [`core/.env.example`](../../core/.env.example).

Do not copy `core/.env.example` wholesale into `/etc/nullsink.env`. Its development-only `DB_PATH`,
`PENDING_DB_PATH`, and `CREDIT_SOCK` values would override the safe paths in the systemd units and stop
the services from booting.

## How do I apply the configuration?

Rerun setup after configuring providers, rails, and the domain:

```sh
TAG=vX.Y.Z
sudo env RELEASE_TAG="$TAG" bash /opt/nullsink/deploy/setup.sh
```

The rerun preserves `/etc/nullsink.env`, installs any newly enabled pinned sidecars, refreshes the
units, and starts the proxy before payments. Follow every item in the printed `Next steps` list; setup
does not start an incomplete wallet watcher.

After DNS points at the host, activate the public edge:

```sh
sudo systemctl restart caddy
```

A later change limited to application environment values takes effect after restarting the owning
service. Restart the proxy first when both are affected:

```sh
sudo systemctl restart nullsink-proxy
sudo systemctl restart nullsink-payments
```

Rerun setup instead when enabling a rail, changing the public domain, or adding Tinfoil, because those
changes also install or update units, binaries, or Caddy's systemd environment.

## How do I verify the deployment?

Check both trust domains directly on loopback:

```sh
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8081/healthz
curl -fsS http://127.0.0.1:8080/v1/models
curl -fsS http://127.0.0.1:8081/rails
```

Then run the same one-shot check used by the ten-minute monitor:

```sh
sudo systemctl start status-check.service
sudo journalctl -u status-check.service -n 60 --no-pager
```

Do not accept a green `/healthz` alone as proof that payments work. For configured components, the
one-shot check also covers database integrity, backup freshness, wallet/node reachability, poller
errors, and a stalled credit outbox. Finish the rollout with a small real payment on every enabled rail
and confirm that the token's balance increases.

For a public deployment, verify the routes Caddy exposes. `/healthz` is intentionally not public.

```sh
DOMAIN=example.com
curl -fsS "https://$DOMAIN/v1/models"
curl -fsS "https://$DOMAIN/rails"
```

## How do I deploy a later application release?

On an existing host, pass one release tag to the health-gated deploy script:

```sh
sudo /opt/nullsink/deploy/deploy.sh vX.Y.Z
```

The script downloads and checksum-verifies both service binaries, the deploy tree, and the UI. It
switches both application binaries together, restarts proxy then payments, and checks both local
`/healthz` endpoints. If either application service stays unhealthy, it restores the previous binary
and UI symlinks when a previous release exists.

This command does not install or restart Bitcoin Core, Monero wallet software, or the Tinfoil proxy.
Use `upgrade-component.sh` for an intentional component upgrade; the command verifies and health-gates
only the selected component:

```sh
sudo /opt/nullsink/deploy/upgrade-component.sh monero-wallet
sudo /opt/nullsink/deploy/upgrade-component.sh tinfoil
```

Bitcoin upgrades run on the dedicated node host:

```sh
sudo /opt/nullsink/deploy/upgrade-component.sh bitcoin
```

For recovery configuration and drills, continue with
[Back up and restore billing state](backup-restore.md). For health warnings and live failures, use
[Diagnose nullsink](diagnose.md). Do not substitute raw database file copies for `backup.sh` or
`restore.sh`.
