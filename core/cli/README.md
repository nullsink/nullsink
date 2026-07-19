# Use the operator CLI

`nsk` is an optional, standalone binary for deliberate ledger inspection and manual credit operations on
the application host. CI builds it from the same release tag as both services; production hosts do not need
Bun or a source checkout to run it.

## Which command answers my question?

| Task | Command |
| --- | --- |
| Create a funded token and print it once | `nsk issue <dollars>` |
| Add credit to an existing token hash | `nsk topup <hash> <dollars>` |
| Read one balance | `nsk balance <hash>` |
| List token hashes and balances | `nsk balances [--format table\|csv\|json]` |
| Reconcile sales and liability | `nsk financials [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--format table\|csv\|json]` |
| List open, unpaid payment orders | `nsk orders [--rail monero\|bitcoin] [--format table\|csv\|json]` |
| Check the CLI build | `nsk version` |

`topup` and `balance` require the full 64-character lowercase token hash. Table output abbreviates hashes
and payment addresses for reading; CSV and JSON preserve full values.

## How do I run it without damaging database ownership?

Run `nsk` as the service user:

```sh
sudo -u nullsink nsk balance <64-character-token-hash>
```

The CLI refuses root because opening SQLite as root can leave `-wal` or `-shm` files that the services
cannot write. `NSK_ALLOW_ROOT=1` is a break-glass override, not a routine shortcut.

`issue`, `topup`, `balance`, `balances`, and `financials` open `balances.db`. `orders` opens its sibling
`pending.db`. Override the balance path with `DB_PATH`; the orders command derives the pending-store path
the same way the service does.

## What does `nsk orders` include?

It lists only open `pending_orders`: quotes that are still being watched for payment. It does not show
settled revenue, acknowledged idempotency tombstones, or credit-outbox rows.

An open row contains its rail, derivation index, address, token hash, quoted credit, expected coin amount,
and creation time. The row is sensitive because it directly links a payment address to a token hash. That
link may also remain in an unacknowledged credit-outbox payload after settlement; it is scrubbed only after
the balance ledger returns a definite acknowledgement. See
[What remains after credit delivery](../../docs/invariants.md#what-remains-after-definite-credit-delivery).

For current confirmation progress, call `/order-status` with the token hash and exact quote address.

## When is manual credit safe?

`nsk topup` bypasses on-chain settlement. Use it only after proving that no original outbox delivery can
still arrive; otherwise a later retry can double-credit the buyer. The paid-but-uncredited procedure is in
[Diagnose nullsink](../../docs/operators/diagnose.md#how-do-i-investigate-a-paid-but-uncredited-report).

`nsk issue` and `nsk topup` are bootstrap or incident tools. The public `/buy` flow is the normal purchase
path.

## How do I install or update `nsk`?

Install it explicitly on a host:

```sh
sudo /opt/nullsink/deploy/install-nsk.sh
```

The installer defaults to the running application tag. Once installed, later `deploy.sh` runs keep the CLI
at the same release tag as the two services.

## Which utilities are not part of `nsk`?

| File | Use |
| --- | --- |
| `gen-token.ts` | Generate a buyer-side token and SHA-256 hash without opening a database |
| `sync-prices.ts` | Refresh the committed provider/model price catalog for developer review |

Run those files with Bun from a development checkout. Do not install or run `sync-prices.ts` on a production
host.
