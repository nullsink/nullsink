# nullsink

An account-less, prepaid reverse proxy for Anthropic, OpenAI, and Tinfoil models. A user creates a
bearer token in the browser, funds it with Monero or Bitcoin, and calls the provider-compatible API.
nullsink keeps no IP or request logs.

| Package | What it owns |
| --- | --- |
| [`core/`](core/) | Metered model proxy, payment rails, billing stores, operator CLI, and host deployment files |
| [`client/`](client/) | Static purchase UI, API reference, model catalog, privacy policy, and terms |

## How do I start using the API?

- [Make your first request](docs/getting-started.md) — create and fund a token, check its balance, and run `curl`
- [Connect a client](docs/client-integrations.md) — configure Claude Code, Hermes, OpenClaw, Pi, or Open WebUI
- [Use the live API reference](https://nullsink.is/api/) — look up endpoints, authentication, limits, and error shapes
- [Choose a model](https://nullsink.is/models/) — copy a model id supported by the live service

## How do I buy and protect credit?

- [Buy credit safely](docs/payments.md) — quote safety, payment status, failures, and automated top-ups
- [Read the billing model](docs/billing-model.md) — pricing, request holds, settlement, and disconnects
- [Read the trust model](docs/trust-model.md) — privacy and money-safety claims, including their limits

## How do I operate nullsink?

- [Deploy and configure](docs/operators/deploy.md) — bootstrap a host, configure providers and rails, and deploy releases
- [Back up and restore](docs/operators/backup-restore.md) — create, test, retain, and apply billing-state backups
- [Diagnose a live service](docs/operators/diagnose.md) — isolate edge, provider, payment, ledger, and monitoring failures

## How do I understand or change the system?

- [System boundaries](docs/architecture.md) — current processes, stores, routes, and enforced boundaries
- [Target architecture](docs/architecture-roadmap.md) — what issue #58 still proposes and what has already changed
- [Money and reliability invariants](docs/invariants.md) — the review gates that must survive any redesign
- [Core workspace](core/README.md) and [client workspace](client/README.md) — source layout and package-specific commands

## How do I run the repository locally?

Use [Bun](https://bun.sh) 1.3.14, the version CI builds and tests with.

```sh
bun install
bun run dev
bun run typecheck
bun run test
bun run lint
bun run build
```

`bun run dev` starts the client. Run the two core processes separately with `bun run dev:proxy` and
`bun run dev:payments` from `core/`. Preview the client without a backend with
`bun --filter './client' dev:mock`.

Install the repository's pre-push checks with:

```sh
git config core.hooksPath .githooks
```

## What license and contribution rules apply?

nullsink is AGPL-3.0-or-later; see [LICENSE](LICENSE). AGPL §13 applies when a modified version is
offered as a network service. The name and marks are covered by [TRADEMARK.md](TRADEMARK.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending a change. Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).
