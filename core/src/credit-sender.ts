// Payments side of the credit crossing: drain the durable outbox into the proxy over the unix socket.
// PAYMENTS TRUST DOMAIN module — imports the order store, never the balance store, providers, or the metered path.
//
// A test-only in-process drain exists too (test/support/drain.ts, driven by the settle property tests). It is
// NOT a duplicate of this loop: delivery over a socket is ASYNC and can be AMBIGUOUS (a timeout may or may not
// have credited), whereas the in-process delivery there is synchronous and always definite. This is the only
// production path.
import { CREDIT_PATH, CREDIT_WIRE_HEADER, CREDIT_WIRE_VERSION, type CreditRequest, type DeliveryResult } from "./credit-wire";
import * as log from "./log";
import type { OrdersStore } from "./ledger/orders";

export type CreditSender = (c: CreditRequest) => Promise<DeliveryResult>;

// Send ONE credit over the socket. Every non-definite result is AMBIGUOUS — the proxy may have committed the
// credit and lost the response — so the caller must NOT ack, and will retry; applied_orders makes the redelivery
// a no-op. In particular a 2xx whose body we don't recognise is ambiguous, NEVER an ack.
export function makeSocketSender(sockPath: string, timeoutMs = 5_000): CreditSender {
  return async (c) => {
    try {
      const res = await fetch(`http://localhost${CREDIT_PATH}`, {
        unix: sockPath, // the URL host is ignored for a unix socket; the path is what routes
        method: "POST",
        headers: { "content-type": "application/json", [CREDIT_WIRE_HEADER]: String(CREDIT_WIRE_VERSION) },
        body: JSON.stringify(c),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
      if (body?.result === "applied" || body?.result === "already_applied") return { ok: true, outcome: body.result };
      return { ok: false, reason: "unrecognized_response" }; // a 2xx we don't understand is not an ack
    } catch (err) {
      // Connect refused (proxy not up yet), timeout, reset — all ambiguous. Never a boot failure: the outbox is
      // durable, so the next tick retries.
      return { ok: false, reason: log.errMsg(err) };
    }
  };
}

// Drain unacked outbox rows, oldest first, through `send`. Ack ONLY on a definite outcome. Stop at the FIRST
// ambiguous result and leave the rest for the next tick — the rows are durable, and stopping avoids hammering a
// down socket once per row. Consequence, deliberate: a persistently-failing head row (poison payload, wire skew)
// BLOCKS the queue. That is fail-closed — no credit is lost, and the oldest-unacked-age alert is what surfaces it.
//
// MUST NOT run concurrently with itself: the caller invokes it at the tail of the poll tick, under the poller's
// existing single-flight guard. (A standalone interval would need its own re-entrancy guard.)
export async function drainCreditOutboxOverSocket(
  orders: OrdersStore,
  send: CreditSender,
  now: number,
): Promise<{ delivered: number; blocked?: string }> {
  let delivered = 0;
  for (const c of orders.listUnackedCredits()) {
    const r = await send({ hash: c.hash, micros: c.micros, idempotency_key: c.idempotency_key });
    if (!r.ok) return { delivered, blocked: r.reason }; // ambiguous → leave unacked, retry next tick
    orders.ackCredit(c.idempotency_key, now);
    delivered++;
  }
  return { delivered };
}

// Age of the oldest unacked credit, in ms (0 when the outbox is drained). The real "is money still crossing?"
// signal: two /healthz probes cannot see a wedged socket server or a stalled sender, but credits piling up here
// can. The payments root logs/alerts on this.
export function oldestUnackedAgeMs(orders: OrdersStore, now: number): number {
  const at = orders.oldestUnackedCreditAt();
  return at === null ? 0 : Math.max(0, now - at);
}
