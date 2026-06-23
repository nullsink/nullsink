// Ephemeral, in-memory per-order payment progress for the /order-status endpoint. This is NOT
// money-critical and NOT durable: it exists only to animate the buyer's wait ("payment seen — confirming
// 3/10") on a manual re-check, derived from the data the settlement poller already fetches every tick.
// The authoritative "credited" signal is always /balance (the durable ledger), so a restart can start
// blank and let the next poll tick repopulate it — losing this progress costs nothing.
//
// Deliberately separate from settle(): settle aggregates ONLY `final` inbounds for crediting, whereas here
// we want to surface a payment the moment the wallet sees it (still-confirming and locked outputs included
// — a real payment is locked ~10 blocks while confirming, exactly the state to show) — that's the whole
// point of the live indicator. So we keep our own per-order fold. (Outputs that can never credit — e.g.
// Monero double-spend-flagged — are already dropped by the rail, so they never reach us to animate.)
//
// Update semantics mirror settle()'s cross-tick `seen` set, for the same reason (see rails/monero.ts): the
// view-only wallet's get_transfers can transiently report an empty `in` mid-rescan, indistinguishable
// from "no payment yet". So we MERGE each tick — an order NOT mentioned this tick keeps its last-known
// progress — and only forget an entry once its order has closed (credited or reaped). That stops a
// mid-confirming order from flickering back to "waiting" on a blind tick. An order that IS mentioned this
// tick is overwritten with the fresh aggregate (on-chain confirmations only rise).

export type OrderProgress = {
  received_atomic: number; // total incoming seen for this order (confirmed or not) — "we see it"
  confirmations: number; // max confirmations across this order's inbounds — the n in "n/N"
};

// Minimal inbound shape (rails/types Incoming is assignable) so tests can drive it with plain objects.
type Inbound = { orderIndex: number; amount: number; confirmations: number };

export function makeOrderStatus() {
  // Keyed by `${rail}:${orderIndex}` so two rails' same integer index never collide. `rail` trails with a
  // default on update()/get() so single-rail callers + the unit tests need not pass it; the poller passes
  // rail.name per tick and the handler passes the looked-up order's rail.
  const byKey = new Map<string, OrderProgress>();
  const keyOf = (rail: string, idx: number) => `${rail}:${idx}`;

  // Fold this tick's inbounds for ONE rail into the map, then drop THAT rail's entries whose order is no
  // longer open. `openIndices` is the post-settle open set for this rail (settle already removed closed ones).
  function update(inbounds: Inbound[], openIndices: Iterable<number>, rail = "default"): void {
    // Aggregate this tick first (an order can have several outputs): sum amounts, take the max
    // confirmations. Only orders present in THIS tick are recomputed.
    const perTick = new Map<string, OrderProgress>();
    for (const t of inbounds) {
      const key = keyOf(rail, t.orderIndex);
      const cur = perTick.get(key) ?? { received_atomic: 0, confirmations: 0 };
      cur.received_atomic += t.amount;
      cur.confirmations = Math.max(cur.confirmations, t.confirmations);
      perTick.set(key, cur);
    }
    // Merge: overwrite the entries we have fresh data for; leave the rest untouched (transient-empty guard).
    for (const [key, p] of perTick) byKey.set(key, p);
    // Forget THIS rail's closed orders only — another rail's entries are managed by its own ticks. The ":"
    // delimiter in the prefix stops one rail name from matching another that extends it (e.g. "btc"/"btcln").
    const openKeys = new Set<string>();
    for (const i of openIndices) openKeys.add(keyOf(rail, i));
    const prefix = `${rail}:`;
    for (const key of byKey.keys()) if (key.startsWith(prefix) && !openKeys.has(key)) byKey.delete(key);
  }

  function get(orderIndex: number, rail = "default"): OrderProgress | undefined {
    return byKey.get(keyOf(rail, orderIndex));
  }

  return { update, get };
}
