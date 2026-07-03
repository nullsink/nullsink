# Architecture

nullsink is a metered proxy in front of Anthropic and OpenAI. A user prepays with
Monero or Bitcoin, gets a bearer token, and spends it against a balance. Each request
is forwarded upstream with *our* provider key and billed for exact usage. We keep no
identity and no request logs: a token is a bearer secret, and only its SHA-256 hash is
ever stored.

This doc maps how the pieces fit. For the privacy and money-safety guarantees see
[trust-model.md](trust-model.md); for the billing math see [billing-model.md](billing-model.md).

## The shape: a composition root over a pure core

`src/index.ts` is the composition root — the only place that binds the port, starts the two
timers (the settlement poller and the metrics flush), and installs the SIGTERM/SIGINT handler
that drains in-flight requests before exit — force-settling any live streams, billing the metered
partial and refunding the rest. At startup it also validates the environment, selects the rails,
builds the request handler, and refunds holds an ungraceful crash left stranded. Those are the two
recovery paths: the graceful drain on shutdown, and boot-time hold recovery for the crash that
skipped it.

The request core it wires up — `handler.ts`, settlement, pricing, the providers and endpoints
— is pure factories and functions: import-safe and testable in isolation. The two SQLite
stores (`ledger/`) and the rail and rate clients (`rails/`) are the exception: they're
module-load singletons that open their database handle or read their config the moment
they're imported.

## Request path

```
client
  │
  ▼
Bun.serve ── handle() router ──┬─ GET  /healthz
                               ├─ POST /buy           ┐
                               ├─ POST /order-status  │
                               ├─ GET  /rails         ├─ endpoints/ (not metered)
                               ├─ GET  /balance       │
                               ├─ GET  /v1/models     ┘
                               └─ POST /v1/...  → exact-path provider(s) → handleMetered
```

The `/v1` branch matches an **exact-path** registry, not a prefix (so
`/v1/messages/batches` isn't silently admitted); an unmatched path is denied — the router
fails closed. `GET /v1/models` is the one non-metered `/v1` path: it lists the served
models (those an active provider owns) with their prices, read straight from the price
book with no upstream call, so an SDK or agent framework can enumerate models the standard way. A path can map to more than one provider (OpenAI + Tinfoil both speak
`/v1/chat/completions`); `handleMetered` then resolves the one a request means by its model.

## The two seams

**Provider seam** (`providers/types.ts`) — what it takes to forward to an upstream LLM:
read the token, reject premium features outside the flat per-token card, resolve the
output cap, check the model is ours, inject our key, normalize usage from both buffered and
streaming responses. Each provider is registered only when its key is set — Anthropic
(`/v1/messages`) on `ANTHROPIC_API_KEY`, the OpenAI pair (`/v1/chat/completions`,
`/v1/responses`) on `OPENAI_API_KEY`, and Tinfoil (open-weight models, OpenAI-compatible) on
`TINFOIL_API_KEY` — and at least one is required. Tinfoil shares `/v1/chat/completions` with
OpenAI, so that path holds more than one provider: a request resolves to the provider that owns
its model, or to an explicit `provider/model` prefix (stripped before forwarding upstream).

Optionally (`ANTHROPIC_OPENAI_COMPAT=1`), Anthropic also registers on `/v1/chat/completions`
via its own OpenAI-compatible endpoint, so `claude-*` is reachable from OpenAI-only clients
through that one path — a forward, not a translation. It reuses the OpenAI usage adapters and
bills the Anthropic rate. Off by default (Anthropic labels that endpoint non-production); the
native `/v1/messages` path stays the full-fidelity Claude route.

**Rail seam** (`rails/types.ts`) — what it takes to accept a coin: mint a per-order address
and detect confirmed deposits. A rail is **watch-only**: it observes incoming payments
but never holds spend authority — custody stays cold. Active rails come from `PAY_RAILS`
(comma list, first is the default). Monero is the reference implementation; Bitcoin is the
second. Each keys an order to an integer index (a Monero subaddress, a Bitcoin HD index).

## The ledger: two databases, kept separate

- **`balances.db`** — `tokens` (hash → balance, in micro-dollars), `applied_orders` (an
  idempotency ledger so a deposit credits exactly once), `holds` (a crash-recovery journal:
  a row exists while a hold is outstanding, and survivors are refunded at boot), and
  `revenue` (an append-only sales book).
- **`pending.db`** — in-flight orders. This is the **only** place the payment ↔ token link
  lives, in a separate database on purpose: a leak of `balances.db` can't reveal who funded
  which token. The link is dropped when the order settles.

The `nsk` operator CLI (`issue` / `topup` / `balance` / `financials`) is a second writer to
`balances.db`: it opens the database directly on the box, and SQLite's WAL mode lets that run
alongside the server's reads.

`ledger/settle.ts` is the coin-agnostic settlement core. It credits each confirmed deposit
exactly once and reaps orders that expire unfunded. It is deliberately **synchronous and
await-free** so that settlements across different rails can't interleave on the shared
databases — keep it that way.

## The two flows

**Buy** — turning a deposit into balance:

```
POST /buy {hash, credit_usd, rail?}
  → quote the coin's USD rate, lock it
  → mint a per-order address
  → store the pending order (pending.db)
  → return {pay_to, amount, expires_at, ...}
  ─ ─ ─ ─ ─ (user pays on-chain) ─ ─ ─ ─ ─
poller tick → rail.incomingTransfers() → settle()
  → creditOnce(hash) once the deposit is final → drop the order
```

**Spend** — billing a request:

```
POST /v1/... with token
  → gate: token present? model ours? premium rejected? balance covers it?
  → size a hold (an upper bound on the cost) and debit it atomically
  → forward upstream with our injected key
  → meter actual usage (buffered response, or a streaming scanner)
  → settle the hold: charge actual, refund the rest
```

The client confirms a buy via `POST /order-status` and checks a balance via `GET /balance`.

## Money and metering

`cost/` reads the price book (`prices.json`) at startup and does all billing in integer
micro-dollars, truncating in the user's favor. `hold.ts` sizes the up-front hold either from
a deterministic byte bound or from the provider's free token counter (falling back to the
byte bound on any error). The hold is a sound upper bound and settle clamps the refund to
`[0, hold]`, so a balance can't go negative — the heart of
[billing-model.md](billing-model.md); upstream errors are relayed or masked per the rules in
[trust-model.md](trust-model.md).
