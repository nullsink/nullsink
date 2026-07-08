// The credit sender: drains credit_outbox into the balance ledger. IN-PROCESS today (a direct creditOnce
// call); stage-2 PR-C moves the creditOnce hop over a peer-authenticated unix socket to the proxy, and this
// function becomes the socket client (same loop, `creditOnce` replaced by a request/response). Idempotent
// end-to-end: creditOnce dedupes on the same idempotency_key the outbox is keyed by, so a redelivery (a crash
// between creditOnce committing and ackCredit) credits AT MOST once. Ack on applied OR already_applied — both
// mean the credit is durably in the ledger — so an already-applied redelivery still clears the outbox row.
//
// Synchronous (no await), like settle(): the in-process creditOnce is a local SQLite transaction, so the
// poller runs a full drain to completion within one tick. If creditOnce throws (e.g. disk full), the row
// stays unacked and is retried next tick — the outbox is durable, so nothing is lost. Returns how many rows
// were delivered this pass (for an aggregate, identity-free log).
import type { OrdersStore } from "./orders";
import type { BalanceStore } from "./db";

export function drainCreditOutbox(orders: OrdersStore, balances: BalanceStore, now: number): { delivered: number } {
  let delivered = 0;
  for (const c of orders.listUnackedCredits()) {
    balances.creditOnce(c.hash, c.micros, c.idempotency_key, now); // true=applied / false=already_applied — both durable
    orders.ackCredit(c.idempotency_key, now);
    delivered++;
  }
  return { delivered };
}
