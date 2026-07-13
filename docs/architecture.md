# Architecture

nullsink is a metered proxy in front of Anthropic and OpenAI. A user prepays with
Monero or Bitcoin, gets a bearer token, and spends it against a balance. Each request
is forwarded upstream with *our* provider key and billed for exact usage. We keep no
identity and no request logs: a token is a bearer secret, and only its SHA-256 hash is
ever stored.

This doc maps how the pieces fit. For the privacy and money-safety guarantees see
[trust-model.md](trust-model.md); for the billing math see [billing-model.md](billing-model.md).

## The shape: two processes over a pure core

nullsink runs as two processes on one box, split by privilege rather than by scale. Each is a
composition root — the only place that binds a port, starts timers, opens a database, and
installs signal handlers.

- **`src/proxy.ts`** (the *prompt world*) serves the metered `/v1` paths and `GET /balance`,
  and owns `balances.db`. It installs the SIGTERM/SIGINT handler that drains in-flight requests
  before exit, force-settling live streams by billing the metered partial and refunding the rest,
  and at boot it refunds holds an ungraceful crash left stranded. Those are the two recovery
  paths: the graceful drain on shutdown, and boot-time hold recovery for the crash that skipped it.
- **`src/payments.ts`** (the *payment world*) serves `/buy`, `/order-status`, `/rails`, runs the
  settlement poller, and owns `pending.db` and the watch-only rail wallets.

A request carrying a prompt is never handled by the process that holds the payment ↔ token link.
The two meet at exactly one place: a unix socket over which payments delivers credits to the
proxy, in one direction, with one verb. Neither router imports the other's code, which
`test/world-isolation.test.ts` enforces at the module level and `scripts/assert-worlds.ts` on
the compiled binaries — the proxy binary is the unit the sealed tier attests, so it must stay
payments-free structurally, not by hoping a bundler tree-shakes.

Everything both roots wire up — the handlers, settlement, pricing, the providers and endpoints —
is pure factories and functions: import-safe and testable in isolation. Nothing opens a database
or binds a port at import time; the roots pass those in.

## Request path

```
client
  │
  ├─ /v1/... /balance ──► nullsink-proxy    :8080 ──┬─ GET  /healthz
  │                                                 ├─ GET  /balance     ┐ endpoints/proxy.ts
  │                                                 ├─ GET  /v1/models   ┘ (not metered)
  │                                                 └─ POST /v1/...  → exact-path provider(s) → handleMetered
  │                                                        │
  │                                                        ▼  balances.db
  │                                            ┌──────────────────────┐
  │                                            │  credit socket       │  payments → proxy, one direction
  │                                            └──────────▲───────────┘
  │                                                       │
  └─ /buy /order-status /rails ──► nullsink-payments :8081 ──┬─ GET  /healthz
                                                             ├─ POST /buy          ┐ endpoints/payments.ts
                                                             ├─ POST /order-status │ (not metered)
                                                             └─ GET  /rails        ┘
                                                                    │
                                                                    ▼  pending.db + the rails
```

Caddy fronts both, routing each public path to exactly one of them. Each router fails closed:
an unmatched path is a 404, so a path routed to the wrong world is a hard error rather than a
silent cross-world call.

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

**Rail seam** (`rails/types.ts`) — what it takes to accept a coin: mint a per-order address
and detect confirmed deposits. A rail is **watch-only**: it observes incoming payments
but never holds spend authority — custody stays cold. Active rails come from `PAY_RAILS`
(comma list, first is the default). Monero is the reference implementation; Bitcoin is the
second. Each keys an order to an integer index (a Monero subaddress, a Bitcoin HD index).

## The ledger: two databases, one per process

- **`balances.db`** (proxy) — `tokens` (hash → balance, in micro-dollars), `applied_orders` (an
  idempotency ledger so a deposit credits exactly once), and `holds` (a crash-recovery journal:
  a row exists while a hold is outstanding, and survivors are refunded at boot).
- **`pending.db`** (payments) — in-flight orders, `revenue` (an append-only sales book), and
  `credit_outbox` (credits owed to the balance ledger). Orders are the **only** place the payment
  ↔ token link lives, in a separate database on purpose: a leak of `balances.db` can't reveal who
  funded which token. The link is dropped when the order settles. Coin amounts, locked rates, and
  transaction-derived keys stay on this side of the wall too.

Neither process opens the other's database. The `nsk` operator CLI (`issue` / `topup` / `balance`
/ `financials`) is the exception and a second writer: it opens both directly on the box, and
SQLite's WAL mode lets that run alongside the servers' reads.

`ledger/settle.ts` is the coin-agnostic settlement core. It closes each confirmed deposit's order,
books the sale, and enqueues the credit — all three in one transaction — and reaps orders that
expire unfunded. It is deliberately **synchronous and await-free** so that settlements across
different rails can't interleave on the shared database — keep it that way.

## The credit crossing

Settlement and crediting now live in different processes, so the hand-off is a **transactional
outbox** rather than a function call. `settle()` writes a `credit_outbox` row in the same
`pending.db` transaction that closes the order: if the row exists, the sale happened. A sender
drains unacked rows over the unix socket, and only marks a row acked once the proxy confirms the
credit is durable.

That gives at-least-once delivery. The receiver makes it exactly-once: `creditOnce` commits the
balance credit and its `applied_orders` marker in a single `balances.db` transaction, keyed by the
rail's idempotency key, so a redelivery is a no-op that still reports a definite outcome. A crash
anywhere — before the ack, mid-socket, during the credit — leaves a durable row that is simply
retried. Delivery stops at the first ambiguous row rather than skipping past it, so credits cannot
be reordered around a stuck one.

Authentication is the filesystem. The socket is a pathname socket bound owner-only, and Linux
checks write permission on the socket file at `connect(2)` — an unspoofable, kernel-enforced gate
that an abstract-namespace socket (no file, no permissions) would not have.

The one failure this creates is silent: a wedged socket means a customer has **paid** and holds no
credit, while both processes answer `/healthz` and every unit reads `active`. So payments emits a
`CREDIT OUTBOX STALLED` error once the oldest undelivered credit ages past
`OUTBOX_AGE_ALERT_MS`, and `deploy/status-check.sh` pages on it.

## The two flows

**Buy** — turning a deposit into balance:

```
POST /buy {hash, credit_usd, rail?}                              [payments]
  → quote the coin's USD rate, lock it
  → mint a per-order address
  → store the pending order (pending.db)
  → return {pay_to, amount, expires_at, ...}
  ─ ─ ─ ─ ─ (user pays on-chain) ─ ─ ─ ─ ─
poller tick → rail.incomingTransfers() → settle()               [payments]
  → one transaction: drop the order, book the sale, enqueue the credit
  → drain the outbox over the credit socket
       → creditOnce(hash) → ack                                 [proxy]
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
