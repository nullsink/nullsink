// Settlement core, extracted from the poller so it can run on synthetic inbounds and an in-memory store (no
// wallet-rpc, no server). I/O-pure and PAYMENT-world only: takes the already-fetched, rail-normalised inbounds
// plus the orders store and, for each confirmed deposit, ENQUEUES a credit + books the sale + closes the order
// in one pending.db transaction (orders.commitSettlement). The actual balance credit is delivered
// asynchronously by the sender (ledger/drain.ts), idempotent per idempotencyKey — so re-scanning the same
// deposit (every tick, forever) can't double-credit. Coin-agnostic: the rail pre-computes each inbound's
// finality (`final`) + an opaque idempotencyKey, so this core never sees txids or coin-specific finality flags.
import type { Incoming } from "../rails/types";
import type { OrdersStore } from "./orders";

export type SettleConfig = {
  scale: number; // rail atomic-units per whole coin (PayRail.scale) — for booking gross USD at the locked rate
  asset: string; // rail name (PayRail.name) — booked on the sale row so the books label + render each coin
  rail?: string; // which rail's orders to settle — scopes every pending_orders read/reap below to one rail,
  // so a concurrent rail's same-index orders are never read or reaped on this rail's tick. Defaults to
  // "monero" (and is normally == asset). The poller passes one settle() call per active rail, each its own.
  backstopMs: number; // absolute safety horizon — reap ANY order older than this (paid-but-stuck included)
  unfundedReapMs?: number; // optional shorter horizon — reap an order NEVER seen with incoming (across
  // ticks, via `seen` AND the durable seen_at); = quoted expires_at + a confirmation grace. Unset → only
  // backstopMs applies.
  seen?: Set<number>; // cross-tick memory of order indices ever seen paying; the poller keeps it persistent
  // so a transient blind tick can't fast-reap an order a prior tick spared. PROCESS-LOCAL — it does not
  // survive a restart; pending_orders.seen_at is the durable half of the same fact. See below.
};

// Match the rail's confirmed inbounds to open orders and enqueue each credit exactly once. `now` is injected
// (caller passes Date.now()) so settlement is deterministic under test.
//
// CONCURRENCY INVARIANT — settle() MUST stay synchronous (NO `await` in its body). The poller runs one
// settle() per active rail, all sharing pending.db; because settle is await-free, the single-threaded event
// loop runs each rail's settle to completion before the next begins, so two rails can never interleave
// mid-settle on the shared store (no double-enqueue, no lost reap). Adding an await here would break that —
// a regression test asserts settle()'s return is not a thenable.
export function settle(
  inbounds: Incoming[],
  orders: OrdersStore,
  now: number,
  cfg: SettleConfig,
): void {
  const rail = cfg.rail ?? "monero"; // rail-scope all reads/reaps below (see SettleConfig.rail)
  const open = new Map(orders.openOrders(rail).map((o) => [o.order_index, o]));

  // Order indices ever seen with incoming activity. cfg.seen is a PERSISTENT set so a sighting on one tick
  // still spares the order on LATER ticks — crucially a tick where the wallet transiently reports NOTHING
  // (mid-rescan / node resync), which the rail can't distinguish from "nobody has paid yet". Without this
  // cross-tick memory, one blind tick past the unfunded horizon would fast-reap a PAYING order and drop
  // its irreplaceable index→hash link. Gates REAPING only — crediting still requires `final` — so `seen`
  // can't be abused into a credit; worst a dust send buys is one order lingering to the backstop.
  // Populated below from EVERY inbound regardless of finality (a still-confirming output still counts as
  // "someone is paying"). Falls back to per-tick scope when no set is injected.
  const seen = cfg.seen ?? new Set<number>();

  // Aggregate creditable inbounds by the rail's idempotency key. The rail returns one entry per output,
  // and several can share a key (Monero: outputs of one tx to the same subaddress), so we sum per key and
  // use THAT for crediting — one tx paying two of our addresses keeps two distinct keys (the money-loss
  // guard). Only `final` inbounds for an open order are credited; the rest still count as activity above.
  const groups = new Map<string, { orderIndex: number; amount: number }>();
  for (const t of inbounds) {
    seen.add(t.orderIndex);
    // Persist the sighting BEFORE anything can reap. cfg.seen is process memory and dies with the process;
    // seen_at is the same fact on disk, so a restart can't forget that this order is being paid. Write-once,
    // so re-observing the same deposit every tick costs nothing.
    orders.markSeen(t.orderIndex, rail, now);
    if (!t.final) continue;
    if (!open.has(t.orderIndex)) continue; // no open order for this index (settled/unknown)
    const g = groups.get(t.idempotencyKey);
    if (g) g.amount += t.amount;
    else groups.set(t.idempotencyKey, { orderIndex: t.orderIndex, amount: t.amount });
  }

  for (const [key, g] of groups) {
    const o = open.get(g.orderIndex);
    if (!o || o.expected_atomic <= 0) continue;
    // Credit proportional to coin received vs. the locked expectation. Multiply credit_micros by the
    // ratio — never amount × credit_micros, which would overflow Number for large atomics.
    const share = Math.round(o.credit_micros * (g.amount / o.expected_atomic));
    // Gross USD at the order's LOCKED rate (cfg.scale = rail atomic scale) so the books don't drift if MARGIN
    // changes. The revenue row carries only {when, coin atomic, usd_credited, usd_gross} — no hash/index.
    const grossMicros = Math.round((g.amount / cfg.scale) * o.rate_usd * 1_000_000);
    // Enqueue the credit + book the sale + close the order in ONE pending.db transaction (see
    // orders.commitSettlement). The credit is delivered to the balance ledger asynchronously by the sender
    // (ledger/drain.ts), idempotent per `key` — so this stays synchronous and the money-critical step is a
    // single atomic write on one DB (the old two-DB credit→remove zombie window is gone). Pay-once: the order
    // closes on this first confirmed payment regardless of coverage — a later top-up is a NEW order.
    orders.commitSettlement(key, o.hash, share, now, { asset: cfg.asset, assetAtomic: g.amount, scale: cfg.scale, grossMicros }, o.order_index, rail);
  }

  // Absolute safety backstop: drop everything past the long horizon, including a paid-but-never-confirmed
  // order (a dropped pool tx) the fast-reaper would otherwise keep sparing.
  orders.purgeStale(now - cfg.backstopMs, rail);
  // Fast-reap UNFUNDED orders: NEVER seen with incoming AND older than unfundedReapMs → abandoned.
  // unfundedReapMs = quoted expires_at + a confirmation grace, so a buyer paying at the very end of their
  // window still has time for a first sighting (which spares the order). Orders ever seen are spared until
  // they reach finality and close (pay-once) or hit the backstop.
  //
  // "Ever seen" is read from BOTH memories and an order is reaped only if neither has heard of it — the
  // conservative direction, since a wrong reap destroys the irreplaceable index→hash link of a PAID order.
  // The durable `seen_at` is what makes this correct across a restart: cfg.seen is rebuilt empty on every
  // process start, and the poller's first tick fires immediately, exactly when the local wallet/node is most
  // likely still resyncing — and a resyncing wallet reports an empty inbound list as a SUCCESS, not an error
  // (rails/monero.ts), so that first tick is indistinguishable from "nobody paid". Without seen_at, a
  // restart during a slow confirmation would fast-reap an order the customer had already paid.
  // openOrders is re-read here, so it sees the seen_at this very tick just wrote.
  if (cfg.unfundedReapMs != null) {
    const cutoff = now - cfg.unfundedReapMs;
    for (const o of orders.openOrders(rail))
      if (!seen.has(o.order_index) && o.seen_at == null && o.created_at < cutoff) orders.removeOrder(o.order_index, rail);
  }
  // Forget order indices whose order has since closed (credited or reaped) so an injected `seen` stays
  // bounded by the live open-order count, not the lifetime total. (No-op for the per-tick fallback.)
  if (cfg.seen) {
    const stillOpen = new Set(orders.openOrders(rail).map((o) => o.order_index));
    for (const idx of cfg.seen) if (!stillOpen.has(idx)) cfg.seen.delete(idx);
  }
  // NO applied_orders purge here. applied_orders lives with the balance ledger (proxy-side) and is NOT purged
  // in stage 2 (D4): purging on the payments-side clock could drop a marker while an outbox retry is still in
  // flight → double-credit. It is ~50 bytes/sale; a payments→proxy safe-point watermark can prune it later.
}
