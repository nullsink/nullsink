# core

The metered proxy service: a privacy-first reverse proxy to Anthropic/OpenAI, metered at the
provider's per-token price against prepaid balances, plus its billing ledger, payment rails,
the `nsk` operator CLI, and the box deploy machinery. Bun + TypeScript, zero runtime dependencies.

See the [root README](../README.md) for monorepo setup, dev commands, and deploy.

## Layout

```
src/
  index.ts        composition root — boot, settlement poller, shutdown
  handler.ts      request-handler factory (injected deps; the metered path)
  hold.ts         pre-flight hold sizing (count_tokens / byte bound)
  providers/      anthropic.ts, openai.ts — upstream forwarding + usage
  cost/           pricing.ts, prices.json, usage/ — meter the response
  ledger/         db.ts, orders.ts, settle.ts, poll.ts, financials.ts
  rails/          monero.ts, bitcoin.ts, rate.ts — on-chain payment backends
  endpoints/      buy.ts, reads.ts — the non-metered nullsink endpoints
  http/           body.ts, errors.ts, headers.ts
  env.ts log.ts metrics.ts ratelimit.ts shutdown.ts token-format.ts

cli/      the nsk operator CLI + dev tools
deploy/   systemd units, Caddyfile, deploy.sh / setup.sh
scripts/  e2e capture/hold, lint, migration rehearsal
test/     bun test (mostly fast-check property tests)
```

## Scripts

| Script | What it does |
| --- | --- |
| `bun test` | run the test suite |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build` | compile the server binary (`nullsink-linux-x64`) |
| `bun run build:nsk` | compile the `nsk` CLI binary |
| `bun run e2e:capture` | real-spend end-to-end + golden-fixture capture (operator-run) |
| `bun run e2e:hold` | live hold-soundness check against real upstreams (operator-run) |

## Docs

- [architecture.md](../docs/architecture.md) — how the pieces fit together
- [trust-model.md](../docs/trust-model.md) — the privacy and money-safety guarantees
- [billing-model.md](../docs/billing-model.md) — holds, settlement, no-overdraft
- [cli/README.md](cli/README.md) — the `nsk` operator CLI
- [deploy/README.md](deploy/README.md) — the box runtime tree
- [../SECURITY.md](../SECURITY.md) — reporting security issues

## Run locally

```sh
cp .env.example .env   # set ANTHROPIC_API_KEY at minimum
bun run dev
```
