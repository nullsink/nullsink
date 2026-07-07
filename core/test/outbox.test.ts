// credit_outbox + payment-world revenue accessors on the orders store (stage-2 D3/D5). These are the
// durable-crossing primitives the settle() rewrite builds on: enqueue is at-most-once per idempotency_key
// (INSERT OR IGNORE, never throws), the sender drains unacked rows oldest-first and acks them, and revenue
// now books here in pending.db instead of balances.db.
import { test, expect } from "bun:test";
import { openOrderStore } from "../src/ledger/orders";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const HASH = "a".repeat(64);

test("enqueueCredit is idempotent per idempotency_key (INSERT OR IGNORE): first wins, repeat is a no-op", () => {
  const o = openOrderStore(":memory:");
  expect(o.enqueueCredit("tx:1", HASH, 5_000_000, 100)).toBe(true); // fresh
  expect(o.enqueueCredit("tx:1", HASH, 9_999_999, 200)).toBe(false); // same key → ignored, NOT overwritten
  const rows = o.listUnackedCredits();
  expect(rows).toEqual([{ idempotency_key: "tx:1", hash: HASH, micros: 5_000_000 }]); // original amount kept
});

test("listUnackedCredits returns unacked rows oldest-first; ackCredit removes a row from the work list", () => {
  const o = openOrderStore(":memory:");
  o.enqueueCredit("tx:b", HASH, 2_000_000, 200);
  o.enqueueCredit("tx:a", HASH, 1_000_000, 100); // enqueued later but older created_at → sorts FIRST
  expect(o.listUnackedCredits().map((r) => r.idempotency_key)).toEqual(["tx:a", "tx:b"]);
  o.ackCredit("tx:a", 500);
  expect(o.listUnackedCredits().map((r) => r.idempotency_key)).toEqual(["tx:b"]); // acked row drops out
  o.ackCredit("tx:a", 999); // re-ack is harmless
  expect(o.listUnackedCredits().map((r) => r.idempotency_key)).toEqual(["tx:b"]);
});

test("acking every row leaves an empty work list (the drained-clean state)", () => {
  const o = openOrderStore(":memory:");
  o.enqueueCredit("k1", HASH, 1, 1);
  o.enqueueCredit("k2", HASH, 2, 2);
  o.ackCredit("k1", 10);
  o.ackCredit("k2", 10);
  expect(o.listUnackedCredits()).toEqual([]);
});

test("recordRevenue books a sale row; listRevenue round-trips it with the coin's own scale", () => {
  const o = openOrderStore(":memory:");
  o.recordRevenue(1000, "monero", 50_000_000_000, ATOMIC_PER_XMR, 7_500_000, 8_250_000);
  expect(o.listRevenue()).toEqual([
    { at: 1000, asset: "monero", asset_atomic: 50_000_000_000, scale: ATOMIC_PER_XMR, usd_micros: 7_500_000, gross_micros: 8_250_000 },
  ]);
});

test("listRevenue filters by [fromMs, toMs) — from inclusive, to exclusive", () => {
  const o = openOrderStore(":memory:");
  for (const at of [100, 200, 300]) o.recordRevenue(at, "monero", 1_000_000_000, ATOMIC_PER_XMR, 1_000_000, 1_100_000);
  expect(o.listRevenue(150, 300).map((r) => r.at)).toEqual([200]); // 100 below `from`, 300 == `to` (excluded)
});

test("a bitcoin sale books in sats at its own scale (not mislabelled as XMR)", () => {
  const o = openOrderStore(":memory:");
  const SATS_PER_BTC = 100_000_000;
  o.recordRevenue(500, "bitcoin", 100_000, SATS_PER_BTC, 60_000_000, 60_000_000);
  expect(o.listRevenue()).toEqual([
    { at: 500, asset: "bitcoin", asset_atomic: 100_000, scale: SATS_PER_BTC, usd_micros: 60_000_000, gross_micros: 60_000_000 },
  ]);
});
