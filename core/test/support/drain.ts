// TEST-ONLY in-process outbox drain: credit_outbox -> the balance ledger via a direct creditOnce call.
// The money-property tests (settle.property, outbox, revenue) drive outbox -> balance crediting
// synchronously and deterministically, without standing up the unix socket. The production path is
// drainCreditOutboxOverSocket in src/credit-sender.ts: genuinely different code (async, ambiguity-aware,
// fail-closed), NOT a copy of this loop.
//
// It encodes the crediting CONTRACT those tests assert. Idempotent end-to-end: creditOnce dedupes on the
// same idempotency_key the outbox is keyed by, so a redelivery (a crash between creditOnce committing and
// ackCredit) credits AT MOST once. Ack on applied OR already_applied — both mean the credit is durably in
// the ledger — so an already-applied redelivery still clears the row from the work list and scrubs its payload.
//
// Synchronous (no await), like settle(): creditOnce is a local SQLite transaction, so a full drain runs to
// completion within one tick. If creditOnce throws (e.g. disk full), the row stays unacked and is retried —
// the outbox is durable, so nothing is lost. Returns how many rows were delivered this pass (identity-free count).
import type { OrdersStore } from "../../src/ledger/orders";
import type { BalanceStore } from "../../src/ledger/db";

export function drainCreditOutbox(orders: OrdersStore, balances: BalanceStore, now: number): { delivered: number } {
  let delivered = 0;
  for (const c of orders.listUnackedCredits()) {
    balances.creditOnce(c.hash, c.micros, c.idempotency_key, now); // true=applied / false=already_applied — both durable
    orders.ackCredit(c.idempotency_key, now);
    delivered++;
  }
  return { delivered };
}
