# nullsink

An anonymous, account-less metered reverse proxy for Anthropic and OpenAI, paid in
Monero or Bitcoin. Mint a bearer key in your browser,
fund it on-chain, and call it from the official Anthropic/OpenAI SDKs by overriding the
base URL. No account, no IP, no request logs.

Two Bun + TypeScript workspaces:

| Package | What it is |
| --- | --- |
| [`core/`](core/) | The metered proxy, payment rails, the `nsk` operator CLI, the box deploy machinery, and the billing ledger. Zero runtime dependencies. |
| [`client/`](client/) | The purchase UI (Vite + React), served at the edge as static files. |

## Docs

- [docs/architecture.md](docs/architecture.md) — how the pieces fit together
- [docs/trust-model.md](docs/trust-model.md) — the privacy and money-safety guarantees (and what's *not* covered)
- [docs/billing-model.md](docs/billing-model.md) — pricing, holds, settlement, no-overdraft

## Develop

Requires [Bun](https://bun.sh) 1.3.14 (the version CI builds and tests with).

```sh
bun install        # one hoisted node_modules + one root bun.lock for both packages

bun run dev        # run core (watch) and the client (vite) together
bun run typecheck  # tsc across both packages
bun run test       # bun test across both packages
bun run lint       # shellcheck deploy scripts + validate/fmt the Caddyfile (needs shellcheck + caddy)
bun run build      # core single-binary + client static bundle
bun run build:nsk  # the nsk operator-CLI binary
```

Target one package with `bun --filter`, e.g. `bun --filter './client' dev`. To preview just the
purchase UI with no backend, run `bun --filter './client' dev:mock`.

Install the pre-push hook so the checks CI runs happen locally first:

```sh
git config core.hooksPath .githooks
```

## Deploy

Boxes run only verified release artifacts — no source, no Bun on the box. A git tag
(`vX.Y.Z`) triggers `.github/workflows/release.yml`, which builds the self-contained linux-x64
artifacts and publishes them as a GitHub Release:

- **`nullsink-linux-x64`** — the proxy server: the metered `/v1` proxy and the payment-settlement poller.
- **`nsk-linux-x64`** — the operator CLI (`issue` / `topup` / `balance` / `financials`).
- **`deploy-<tag>.tar.gz`** — the `core/deploy/` tree (systemd units, Caddyfile, deploy + backup scripts); the box extracts this instead of cloning source.
- **`nullsink-ui-<tag>.tar.gz`** — the static purchase UI (`client/dist`); Caddy serves it at the edge.
- **`SHA256SUMS`** — checksums over the four artifacts; the box verifies with `sha256sum -c` before installing.

On a box, `core/deploy/deploy.sh <tag>` fetches and checksum-verifies those artifacts,
atomically swaps the binary and UI symlinks, refreshes the systemd units and Caddy
config, restarts, and health-gates on `/healthz` — rolling **both** symlinks back to the
previous release if the new one is unhealthy. First-time bootstrap is `core/deploy/setup.sh`.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE) (each package carries a copy). As a hosted
network service, AGPL §13 applies: run a **modified** nullsink for others and you must
offer them your source.

See [TRADEMARK.md](TRADEMARK.md) for the name and marks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
Report security issues privately via [SECURITY.md](SECURITY.md).
