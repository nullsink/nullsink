# cli/ — operator + dev command-line tools

Two kinds of thing live here: the **operator CLI** (`nsk`, run on the box) and a couple of **dev/buyer
tools** (run with Bun off the box).

## `nsk` — the operator CLI (on the box)

`cli/index.ts` compiles to a single self-contained binary, **`nsk`**, via `bun run build:nsk`
(`bun build --compile … cli/index.ts --outfile nsk-linux-x64`). It bundles the bits of `src/` it needs
(`src/ledger/db`, `src/ledger/orders`, `src/ledger/financials`, `src/rails/catalog`), so it runs with no Bun or source tree present. The release workflow builds it
from the **same tag** as the server binary, so the two can't drift.

```
nsk issue <dollars>             mint a token worth $N, print it once
nsk topup <hash> <dollars>      add $N to an existing token
nsk balance <hash>              print a token's remaining balance
nsk balances [--format table|csv|json]   list every token's hash + remaining balance (largest first)
nsk financials [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--format table|csv|json]
nsk orders [--rail monero|bitcoin] [--format table|csv|json]   in-flight (unpaid) payment orders, oldest first
```

`topup` and `balance` take the full 64-char token hash. `nsk balances --format csv|json` prints hashes in
full (the `table` view abbreviates them for reading); the buyer also gets their hash from the `/buy` flow.

`orders` is the **live** view — the in-flight `pending_orders` (quoted by `/buy`, awaiting payment). It reads
a *different* DB, `pending.db` (the only place the payment↔token-hash link lives), and follows the `balances`
convention: the `table` view abbreviates the hash **and** the pay-to address for reading, while `csv`/`json`
carry both in full for export (rows to stdout, summary to stderr). That link is the operator's to see and is
transient (rows self-clear at the reaper); the isolation guarantee is about a *balances.db* leak, not this
on-box view. It shows what's durable (rail, index, credit, expected coin, age); for one order's live
confirmation depth, query `/order-status` by hash.

It opens the on-disk SQLite ledger (`/var/lib/nullsink/balances.db` by default; override with `DB_PATH`;
`orders` instead reads its sibling `pending.db`),
so it runs **on the box, as the service user**: `sudo -u nullsink nsk issue 17`. A root open would leave
root-owned WAL sidecars the service can't write, so `nsk` **refuses to run as root** (override with
`NSK_ALLOW_ROOT=1` for a deliberate break-glass run).

`nsk` is **optional and opt-in**: the box does not ship it by default. Install it on demand with
`sudo deploy/install-nsk.sh` (defaults to the running server's tag; pass a tag to choose one). Once
installed, `deploy/deploy.sh` keeps it in lockstep with the server on each redeploy. Manual issuance is a
break-glass / bootstrap path — `/buy` is the primary purchasing flow.

| subcommand | source |
|---|---|
| `issue` | `issue.ts` |
| `topup` | `topup.ts` |
| `balance` | `balance.ts` |
| `balances` | `balances.ts` (the listing comes from `src/ledger/db.ts` `listBalances()`; its total reuses `liabilityTotal()`, so it reconciles with `financials`) |
| `financials` | `financials.ts` (per-coin summarisation lives in `src/ledger/financials.ts`, unit-tested) |
| `orders` | `orders.ts` (reads `pending_orders` via `src/ledger/orders.ts` `openOrders()`; renders coin amounts from the pure `src/rails/catalog.ts`; the `age` formatter `cli/age.ts` is unit-tested) |

## Dev / buyer tools (NOT in `nsk`, NOT on the box)

- **`gen-token.ts`** — buyer-side: prints a token + its hash for the hash-only buy flow (the buyer keeps
  the token, sends only the hash to `/buy`). DB-free by design (imports only `cli/mint`). Run with Bun.
- **`sync-prices.ts`** — dev-only: fetches models.dev and rewrites `src/cost/prices.json` (the committed
  price catalog the app reads at startup). Run on a dev checkout, review the diff, commit, then cut a release.
  Never on the box (it needs the network + writes the source tree).

## Shared libraries (not subcommands)

- **`mint.ts`** — token minting (`0sink_` + base64url(32 random bytes) + a 4-char checksum). Kept
  byte-identical to the client's `token.ts` so a CLI-minted token validates in the UI.
- **`money.ts`** — dollar↔micro-dollar conversion + positive-dollar arg validation.
- **`format.ts`** — `--format table|csv|json` parsing (one allow-list) + the `optVal` flag reader, shared by `balances` and `financials`.
