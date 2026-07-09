// Targeted guard/boundary tests surfaced by mutation testing + the assertion-quality audit.
// These pin behaviors the broad property tests leave unisolated: the divide-by-zero credit guard (a real
// surviving mutant), and three SQL-shaped semantics Stryker can't operator-mutate (most-recent order, the
// strict reap boundary, and the empty/overflow liability sum).
import { test, expect } from "bun:test";
import { openDb } from "../src/ledger/db";
import { openOrderStore, type PendingOrder } from "../src/ledger/orders";
import { settle, type SettleConfig } from "../src/ledger/settle";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const NOW = 1_000_000_000_000;
const CONF = 10;
const SEED_MAX = Number.MAX_SAFE_INTEGER;
const CFG: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: NOW };
const mk = (o: Partial<PendingOrder>): Omit<PendingOrder, "seen_at"> => ({
  rail: "monero", order_index: 0, address: "a0", hash: "h1", expected_atomic: 1_000_000,
  credit_micros: 1_000_000, received_atomic: 0, created_at: NOW, rate_usd: 0, ...o,
});

// settle.ts:68 — `if (!o || o.expected_atomic <= 0) continue;` survived `ConditionalExpression → false`.
// Drop the guard and a 0-`expected` order divides by zero → Infinity credit → a NON-FINITE balance. This is
// the only settle path that can write junk money, so pin that the guard skips such an order entirely.
test("settle SKIPS an order with expected_atomic === 0 (no divide-by-zero, no credit)", () => {
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  store.tryAddOrder(mk({ order_index: 0, hash: "h1", expected_atomic: 0, credit_micros: 5_000_000 }), SEED_MAX);
  settle([{ orderIndex: 0, idempotencyKey: "tx:0", amount: 1_000_000, confirmations: CONF, final: true }], store, NOW, CFG);
  expect(balances.getBalance("h1")).toBeNull(); // not credited (mutant would write Infinity; the 0-expected order is skipped → nothing even enqueued)
  expect(store.openOrders().length).toBe(1); // untouched (mutant would credit + close it)
  store.db.close();
  balances.db.close();
});

// orders.ts:139 — `latestOpenOrderByHash` is `ORDER BY created_at DESC LIMIT 1`. The /order-status path is
// tested through a MOCK store, so the real "most recent wins" semantics are never asserted. (DESC↔ASC isn't a
// Stryker-expressible mutation — a semantic gap, not a survivor.)
test("latestOpenOrderByHash returns the NEWEST open order for a hash (DESC), with its rail", () => {
  const store = openOrderStore(":memory:");
  store.tryAddOrder(mk({ order_index: 1, hash: "h1", created_at: 1000, rail: "monero" }), SEED_MAX);
  store.tryAddOrder(mk({ order_index: 2, hash: "h1", created_at: 2000, rail: "bitcoin" }), SEED_MAX);
  const latest = store.latestOpenOrderByHash("h1");
  expect(latest?.created_at).toBe(2000); // ASC would return the 1000 row
  expect(latest?.order_index).toBe(2);
  expect(latest?.rail).toBe("bitcoin");
  store.db.close();
});

// orders.ts:154 — `purgeStale` deletes `created_at < beforeMs` (STRICT). The `<`↔`<=` boundary lives in a SQL
// string Stryker can't mutate, so pin it: an order created exactly AT the cutoff must SURVIVE (one-tick-early
// reap = lost credit).
test("purgeStale keeps an order created exactly AT the cutoff (strict <, not <=)", () => {
  const store = openOrderStore(":memory:");
  store.tryAddOrder(mk({ order_index: 0, created_at: 2000 }), SEED_MAX); // == cutoff → must survive
  store.tryAddOrder(mk({ order_index: 1, created_at: 1999 }), SEED_MAX); // < cutoff → reaped
  store.purgeStale(2000);
  expect(store.openOrders().map((o) => o.order_index)).toEqual([0]);
  store.db.close();
});

// db.ts:224-226 — liabilityTotal: populated exactness is already pinned (revenue/balances tests); the
// EMPTY-ledger and >2^53 BigInt cases are not. These lock the COALESCE(...,0) + CAST(... AS TEXT) that keep
// the headline liability figure exact at scale (a `number` SUM would silently drop low digits past ~$9B).
test("liabilityTotal on an empty ledger is {tokens:0, micros:0n}", () => {
  const balances = openDb(":memory:");
  expect(balances.liabilityTotal()).toEqual({ tokens: 0, micros: 0n });
  balances.db.close();
});

test("liabilityTotal stays an exact BigInt past Number.MAX_SAFE_INTEGER", () => {
  const balances = openDb(":memory:");
  balances.credit("h1", 9_000_000_000_000_000); // 9e15 each — sum 1.8e16 > 2^53 (a number SUM would mis-round)
  balances.credit("h2", 9_000_000_000_000_000);
  expect(balances.liabilityTotal()).toEqual({ tokens: 2, micros: 18_000_000_000_000_000n });
  balances.db.close();
});
