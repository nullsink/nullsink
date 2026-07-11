// pending_orders store invariants around the composite (rail, order_index) key: two rails allocate their
// integer indexes independently, so the same index must coexist across rails while every mutation stays
// scoped to its own rail — and the open-order cap spans ALL rails (a global DoS bound, not per-rail).
import { test, expect, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { openOrderStore } from "../src/ledger/orders";

const PENDING = "/tmp/nullsink-orders-pending.db";
const rm = (p: string) => {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(p + s);
    } catch {
      /* not present */
    }
  }
};
afterEach(() => {
  rm(PENDING);
});

test("removeOrder returns false when no row matches (rail, order_index)", () => {
  const store = openOrderStore(":memory:");
  store.tryAddOrder({ rail: "monero", order_index: 1, address: "a1", hash: "h", expected_atomic: 1, credit_micros: 1, received_atomic: 0, created_at: 1, rate_usd: 0 }, Number.MAX_SAFE_INTEGER);
  expect(store.removeOrder(2, "monero")).toBe(false); // nonexistent index → nothing deleted
  expect(store.removeOrder(1, "bitcoin")).toBe(false); // right index, wrong rail → composite-PK miss
  expect(store.removeOrder(1, "monero")).toBe(true); // the real row
  store.db.close();
});

test("composite key isolates rails: same index coexists, and removeOrder/openOrders/purgeStale only touch their own rail", () => {
  rm(PENDING);
  const store = openOrderStore(PENDING);
  const mk = (rail: string, idx: number, createdAt: number) => ({ rail, order_index: idx, address: `${rail}${idx}`, hash: `h${rail}${idx}`, expected_atomic: 1, credit_micros: 1, received_atomic: 0, created_at: createdAt, rate_usd: 0 });
  expect(store.tryAddOrder(mk("monero", 5, 1000), Number.MAX_SAFE_INTEGER)).toBe(true);
  expect(store.tryAddOrder(mk("bitcoin", 5, 1000), Number.MAX_SAFE_INTEGER)).toBe(true); // same index, no PK collision
  expect(store.openOrders().length).toBe(2);
  expect(store.openOrders("monero").map((o) => o.address)).toEqual(["monero5"]); // rail-scoped read
  expect(store.openOrders("bitcoin").map((o) => o.address)).toEqual(["bitcoin5"]);

  // THE critical path: removeOrder defaults to monero (what settle calls today) and must NOT touch bitcoin-5:
  expect(store.removeOrder(5)).toBe(true);
  expect(store.openOrders("monero").length).toBe(0);
  expect(store.openOrders("bitcoin").length).toBe(1); // bitcoin-5 survived the monero delete

  // a rail-scoped purge reaps only its own rail:
  store.purgeStale(2000, "monero"); // nothing monero remains; bitcoin-5 (created 1000 < 2000) must stay
  expect(store.openOrders("bitcoin").length).toBe(1);
  store.purgeStale(2000, "bitcoin");
  expect(store.openOrders("bitcoin").length).toBe(0); // now reaped
  store.db.close();
});

test("MAX_OPEN_ORDERS is a GLOBAL cap across rails: interleaved monero+bitcoin claims never overshoot", () => {
  rm(PENDING);
  const store = openOrderStore(PENDING);
  const mk = (rail: string, idx: number) => ({ rail, order_index: idx, address: `${rail}${idx}`, hash: `h${rail}${idx}`, expected_atomic: 1, credit_micros: 1, received_atomic: 0, created_at: 1, rate_usd: 0 });
  const cap = 3;
  expect(store.tryAddOrder(mk("monero", 0), cap)).toBe(true);
  expect(store.tryAddOrder(mk("bitcoin", 0), cap)).toBe(true); // same index, other rail → no PK clash
  expect(store.tryAddOrder(mk("monero", 1), cap)).toBe(true);
  expect(store.tryAddOrder(mk("bitcoin", 1), cap)).toBe(false); // count is 3, not < 3 → rejected (cap spans rails)
  expect(store.tryAddOrder(mk("monero", 2), cap)).toBe(false);
  expect(store.openCount()).toBe(3); // never overshot
  store.db.close();
});
