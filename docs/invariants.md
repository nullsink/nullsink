# Money and reliability invariants

Use these rules when changing billing, payment settlement, credit delivery, or recovery. They are
review gates: if a change breaks one, it needs a new design rather than a documentation exception.

## Can a model request overdraw a balance?

No. The proxy must preserve all three parts of the hold protocol:

1. Open the hold before forwarding. The balance debit is conditional and the debit plus hold-journal
   entry commit in one transaction.
2. Settle once. The refund is clamped to the range from zero to the original hold. If measured cost is
   higher than the hold, nullsink absorbs the difference.
3. Recover after a crash. Before serving traffic, the proxy refunds journaled holds left by an
   ungraceful stop.

The implementation lives in
[`ledger/db.ts`](../core/src/ledger/db.ts) and [`handler.ts`](../core/src/handler.ts).

## Can a confirmed payment disappear between services?

The credit crossing is designed so a delivered credit may be retried, but not lost or applied twice:

- Payments closes the order, books revenue, and creates a `credit_outbox` row in one `pending.db`
  transaction.
- The sender retries the oldest unacknowledged row and acknowledges it only after the proxy reports a
  durable result. A missing or ambiguous response is not an acknowledgement.
- The proxy commits the balance increase and its `applied_orders` marker in one `balances.db`
  transaction. Repeating the same idempotency key is a successful no-op.
- The sender stops at an ambiguous row. Later credits wait rather than pass an uncertain earlier credit.

This gives at-least-once delivery across the socket and one balance effect at the receiver. See
[`ledger/orders.ts`](../core/src/ledger/orders.ts),
[`credit-sender.ts`](../core/src/credit-sender.ts), and
[`credit-server.ts`](../core/src/credit-server.ts).

## What must a backup preserve?

`pending.db` and `balances.db` contain opposite halves of credit delivery. A backup must snapshot
`pending.db` first and `balances.db` second. On restore, acknowledged outbox rows missing from the
restored `applied_orders` ledger must be re-armed before the services start.

Use the repository's [`backup.sh`](../core/deploy/backup.sh) and
[`restore.sh`](../core/deploy/restore.sh). Do not replace their SQLite snapshots, ordering, or
reconciliation with file copies.

## Why are acknowledged outbox rows kept?

The current implementation marks a delivered row with `acked_at`; it never deletes or redacts that
row. The retained row lets restore compare payment-side delivery history with the restored balance
ledger and redeliver a paid credit that the older ledger does not contain.

There is a privacy cost: each acknowledged row still contains the token hash, credited amount, and a
transaction-derived idempotency key. The durable payment-to-token link therefore outlives the pending
order. Documentation must not claim that the link disappears at settlement while this remains true.

### Should acknowledged rows be deleted after a fixed period?

Elapsed time alone is not a safe deletion condition. If an operator can restore a `balances.db`
backup older than the deletion cutoff, the matching outbox row may be the only record that tells the
system to restore the customer's paid credit.

| Policy | Benefit | Cost or risk | Required decision or mechanism |
| --- | --- | --- | --- |
| Keep rows indefinitely (current behavior) | Preserves payment-side delivery history for reconciliation with a restored balance database | Retains the payment-to-token link; table and backups grow with sales | Accept the privacy and storage cost |
| Delete after _N_ days | Simple; bounds link retention and storage | Silently limits recovery: restoring older or independently retained backups can lose paid credit | Define and enforce a maximum restore window; ensure every usable backup pair is newer than the cutoff |
| Redact after a cross-service safe point | Can remove the token hash and amount without relying on age alone | Requires a protocol, schema, restore changes, and failure tests | Have the proxy prove that credits through a durable watermark are present in every supported recovery state |

No retention period or safe-point protocol exists today. Choosing a restore window and acceptable
privacy exposure is a product/operations decision; implementing deletion before that decision would
change recovery behavior.

The proxy's `applied_orders` markers are also retained indefinitely. They contain the idempotency key
and timestamp, but no token hash or amount. Removing them without a coordinated safe point can turn a
late outbox retry into a double credit.

## What should a money-path review reject?

- Forwarding before a hold commits.
- Splitting a hold debit from its journal entry, or a settlement from its refund.
- Acknowledging an ambiguous credit delivery.
- Deleting or redacting outbox rows or `applied_orders` markers without a recovery-safe boundary.
- Backing up `balances.db` before `pending.db`.
- Starting services after restore reconciliation fails.
