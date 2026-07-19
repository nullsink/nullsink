# Core workspace

`core/` contains the two Bun services, their billing stores, payment rails, operator CLI, tests, and
host deployment files. The compiled production binaries have no runtime package dependencies.

See the [root README](../README.md) for repository-wide setup.

## Where does each kind of code live?

```text
src/
  proxy.ts          proxy composition root: metered API, balance store, credit socket, shutdown
  payments.ts       payments composition root: quotes, rails, order pollers, credit sender
  handler.ts        metered request handler and settlement
  payments-handler.ts  payment-route handler
  hold.ts           request hold sizing
  providers/        Anthropic, OpenAI, and Tinfoil request/usage adapters
  cost/             price catalog and usage normalization
  ledger/           balances, orders, revenue, polling, and settlement
  rails/            Monero, Bitcoin, and exchange-rate adapters
  endpoints/        proxy and payment endpoint implementations
  http/             body, error, and header contracts

cli/                nsk operator CLI plus developer/buyer utilities
deploy/             systemd units, edge config, bootstrap, deploy, backup, and recovery scripts
scripts/            developer checks and live-spend probes
test/               unit, property, boundary, and socket tests
```

Read [System boundaries](../docs/architecture.md) before moving code between the proxy and payments
trees. The import boundary is tested and also checked in compiled binaries.

## Which commands check a core change?

| Command | Question it answers |
| --- | --- |
| `bun test` | Do the core tests pass? |
| `bun run typecheck` | Does TypeScript accept the workspace? |
| `bun run build` | Can both service binaries compile without crossing trust domains? |
| `bun run build:nsk` | Can the standalone operator CLI compile? |
| `bun run e2e:capture` | Does a controlled real-spend request still match the golden capture? |
| `bun run e2e:hold` | Does live upstream behavior still respect the hold bound? |

The two end-to-end commands spend real provider credit and are operator-run, not routine test commands.

## When should I use mutation testing?

Use it as an occasional check on billing or ledger tests, not as a per-change gate. Stryker is deliberately
not installed in the repository.

```sh
bunx --package @stryker-mutator/core stryker run
bunx --package @stryker-mutator/core stryker run --mutate "src/ledger/**/*.ts"
```

Reports are written to the ignored `reports/mutation/` directory.

## How do I run both services locally?

Copy the environment template and set at least one provider key. A payment rail also needs its wallet RPC
configuration before the payments service can start.

```sh
cp .env.example .env
bun run dev:proxy
```

In another terminal:

```sh
bun run dev:payments
```

The proxy listens on `127.0.0.1:8080` and payments on `127.0.0.1:8081` by default. For client-only work,
use the mock backend described in [client/README.md](../client/README.md).

## Where are the behavioral documents?

- [Make your first request](../docs/getting-started.md)
- [Buy credit safely](../docs/payments.md)
- [Billing model](../docs/billing-model.md)
- [Money and reliability invariants](../docs/invariants.md)
- [Deploy and configure](../docs/operators/deploy.md)
- [Back up and restore](../docs/operators/backup-restore.md)
- [Diagnose nullsink](../docs/operators/diagnose.md)
- [`nsk` operator CLI](cli/README.md)
