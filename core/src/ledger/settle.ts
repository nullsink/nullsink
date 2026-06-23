// Settlement core, extracted from the poller so it can run on synthetic inbounds and in-memory stores (no
// wallet-rpc, no server). I/O-pure: takes the already-fetched, rail-normalised inbounds plus the two
// stores and credits the matching tokens; the network fetch + retry glue lives in index.ts. Coin-agnostic:
// the rail pre-computes each inbound's finality (`final`) + an opaque idempotencyKey, so this core never
// sees txids or coin-specific finality flags. Idempotent per idempotencyKey via creditOnce(), so
// re-scanning the same deposit (every tick, forever) can't double-credit.
import type { Incoming } from "../rails/types";
import type { OrdersStore } from "./orders";
import type { BalanceStore } from "./db";

export type SettleConfig = {
  scale: number; // rail atomic-units per whole coin (PayRail.scale) — for booking gross USD at the locked rate
  asset: string; // rail name (PayRail.name) — booked on the sale row so the books label + render each coin
  rail?: string; // which rail's orders to settle — scopes every pending_orders read/reap below to one rail,
  // so a concurrent rail's same-index orders are never read or reaped on this rail's tick. Defaults to
  // "monero" (and is normally == asset). The poller passes one settle() call per active rail, each its own.
  backstopMs: number; // absolute safety horizon — reap ANY order older than this (paid-but-stuck included)
  unfundedReapMs?: number; // optional shorter horizon — reap an order NEVER seen with incoming (across
  // ticks, via `seen`); = quoted expires_at + a confirmation grace. Unset → only backstopMs applies.
  seen?: Set<number>; // cross-tick memory of order indices ever seen paying; the poller keeps it persistent
  // so a transient blind tick can't fast-reap an order a prior tick spared. See below.
};

// Match the rail's confirmed inbounds to open orders and credit each exactly once. `now` is injected
// (caller passes Date.now()) so settlement is deterministic under test.
//
// CONCURRENCY INVARIANT — settle() MUST stay synchronous (NO `await` in its body). The poller runs one
// settle() per active rail, all sharing balances.db + pending.db; because settle is await-free, the single-
// threaded event loop runs each rail's settle to completion before the next begins, so two rails can never
// interleave mid-settle on the shared DBs (no double-credit, no lost reap). Adding an await here would break
// that — a regression test asserts settle()'s return is not a thenable.
export function settle(
  inbounds: Incoming[],
  orders: OrdersStore,
  balances: BalanceStore,
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
    // Book the sale in creditOnce's transaction: gross USD at the order's LOCKED rate (cfg.scale = rail
    // atomic scale) so the books don't drift if MARGIN changes. The revenue row carries only {when, coin
    // atomic, usd_credited, usd_gross} — no hash/index.
    const grossMicros = Math.round((g.amount / cfg.scale) * o.rate_usd * 1_000_000);
    balances.creditOnce(o.hash, share, key, now, { asset: cfg.asset, assetAtomic: g.amount, scale: cfg.scale, grossMicros });
    // Pay-once / single-use address: credit this confirmed payment and CLOSE the order (drop the
    // index→hash link) regardless of whether it covered the full quote — a later top-up is a NEW order.
    // The buyer is told to send the full amount in ONE transaction (multiple outputs WITHIN one tx are
    // summed into `g` above). Only a SEPARATE LATER tx to a closed address misses — the documented
    // one-transaction rule.
    //
    // Close on EITHER creditOnce outcome: a false return means this deposit was ALREADY credited — i.e. a
    // crash landed between creditOnce committing (balances.db) and removeOrder (pending.db; two DBs, not
    // atomic) — and the order is a zombie that would otherwise linger to the backstop, keeping the
    // index→hash link alive and misreporting /order-status as "finalizing".
    orders.removeOrder(o.order_index, rail);
  }

  // Absolute safety backstop: drop everything past the long horizon, including a paid-but-never-confirmed
  // order (a dropped pool tx) the fast-reaper would otherwise keep sparing.
  orders.purgeStale(now - cfg.backstopMs, rail);
  // Fast-reap UNFUNDED orders: NEVER seen with incoming (across ticks, via `seen`) AND older than
  // unfundedReapMs → abandoned. unfundedReapMs = quoted expires_at + a confirmation grace, so a buyer
  // paying at the very end of their window still has time for a first sighting (which spares the order).
  // Orders ever seen are spared until they reach finality and close (pay-once) or hit the backstop.
  if (cfg.unfundedReapMs != null) {
    const cutoff = now - cfg.unfundedReapMs;
    for (const o of orders.openOrders(rail))
      if (!seen.has(o.order_index) && o.created_at < cutoff) orders.removeOrder(o.order_index, rail);
  }
  // Forget order indices whose order has since closed (credited or reaped) so an injected `seen` stays
  // bounded by the live open-order count, not the lifetime total. (No-op for the per-tick fallback.)
  if (cfg.seen) {
    const stillOpen = new Set(orders.openOrders(rail).map((o) => o.order_index));
    for (const idx of cfg.seen) if (!stillOpen.has(idx)) cfg.seen.delete(idx);
  }
  balances.purgeApplied(now - cfg.backstopMs);
}
