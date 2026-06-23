// Revenue book (cli/financials.ts data source). Load-bearing properties: a sale is booked iff the credit
// lands and a re-scan double-counts neither; "gross" (USD paid) is valued at the order's LOCKED rate, so
// it never drifts when MARGIN changes; and each row carries its coin (`asset` + `scale`) so a multi-rail
// book renders every coin exactly instead of mislabelling it as XMR.
import { test, expect } from "bun:test";
import { openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { settle } from "../src/ledger/settle";
import type { Incoming } from "../src/rails/types";
import { ATOMIC_PER_XMR } from "../src/rails/units";

test("creditOnce books {asset, coin atomic, net credit, gross} atomically with the credit, holding no identity", () => {
  const { creditOnce, getBalance, listRevenue, liabilityTotal } = openDb(":memory:");
  const hash = "a".repeat(64);
  expect(creditOnce(hash, 7_500_000, "txid:3", 1000, { asset: "monero", assetAtomic: 50_000_000_000, scale: ATOMIC_PER_XMR, grossMicros: 8_250_000 })).toBe(true);
  expect(getBalance(hash)).toBe(7_500_000);
  expect(listRevenue()).toEqual([{ at: 1000, asset: "monero", asset_atomic: 50_000_000_000, scale: ATOMIC_PER_XMR, usd_micros: 7_500_000, gross_micros: 8_250_000 }]);
  expect(liabilityTotal()).toEqual({ tokens: 1, micros: 7_500_000n }); // micros is exact BigInt
});

test("a re-scan of the same deposit double-counts neither the credit nor the revenue", () => {
  const { creditOnce, getBalance, listRevenue } = openDb(":memory:");
  const hash = "b".repeat(64);
  const rev = { asset: "monero", assetAtomic: 10_000_000_000, scale: ATOMIC_PER_XMR, grossMicros: 5_500_000 };
  expect(creditOnce(hash, 5_000_000, "txid:1", 1, rev)).toBe(true);
  expect(creditOnce(hash, 5_000_000, "txid:1", 2, rev)).toBe(false); // same orderId → no-op
  expect(getBalance(hash)).toBe(5_000_000); // credited exactly once
  expect(listRevenue()).toHaveLength(1); // ...and booked exactly once
});

test("creditOnce without a revenue arg credits but books no sale (manual-issuance path)", () => {
  const { creditOnce, getBalance, listRevenue } = openDb(":memory:");
  const hash = "c".repeat(64);
  expect(creditOnce(hash, 1_000_000, "manual:1", 1)).toBe(true);
  expect(getBalance(hash)).toBe(1_000_000);
  expect(listRevenue()).toHaveLength(0);
});

test("listRevenue filters by [fromMs, toMs)", () => {
  const { creditOnce, listRevenue } = openDb(":memory:");
  const h = "d".repeat(64);
  const rev = { asset: "monero", assetAtomic: 1_000_000_000, scale: ATOMIC_PER_XMR, grossMicros: 1_100_000 };
  creditOnce(h, 1_000_000, "k1", 100, rev);
  creditOnce(h, 1_000_000, "k2", 200, rev);
  creditOnce(h, 1_000_000, "k3", 300, rev);
  expect(listRevenue(150, 300).map((r) => r.at)).toEqual([200]); // 100 below `from`, 300 == `to` (exclusive)
});

test("a Bitcoin sale books in sats at its own scale (not mislabelled as XMR)", () => {
  const { creditOnce, listRevenue } = openDb(":memory:");
  const SATS_PER_BTC = 100_000_000;
  // 0.001 BTC = 100_000 sats, credited $60 at a locked $60k/BTC → gross $60.
  expect(creditOnce("e".repeat(64), 60_000_000, "btctx:0", 500, { asset: "bitcoin", assetAtomic: 100_000, scale: SATS_PER_BTC, grossMicros: 60_000_000 })).toBe(true);
  expect(listRevenue()).toEqual([{ at: 500, asset: "bitcoin", asset_atomic: 100_000, scale: SATS_PER_BTC, usd_micros: 60_000_000, gross_micros: 60_000_000 }]);
});

test("settle books gross from the order's LOCKED rate (margin-independent)", () => {
  const balances = openDb(":memory:");
  const orders = openOrderStore(":memory:");
  const hash = "f".repeat(64);
  const NOW = 1_700_000_000_000;
  // $15 credit, quoted at a locked rate of 165 USD/XMR → expect 0.1 XMR (gross = 0.1 × 165 = $16.50).
  orders.tryAddOrder(
    { rail: "monero", order_index: 5, address: "addr5", hash, expected_atomic: 100_000_000_000, credit_micros: 15_000_000, received_atomic: 0, created_at: NOW, rate_usd: 165 },
    Number.MAX_SAFE_INTEGER,
  );
  const transfers: Incoming[] = [
    { orderIndex: 5, idempotencyKey: "tx:5", amount: 100_000_000_000, confirmations: 10, final: true },
  ];
  settle(transfers, orders, balances, NOW, { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: 9_999_999_999_999 });
  expect(balances.getBalance(hash)).toBe(15_000_000); // net credit issued
  // gross = round((1e11 / 1e12) × 165 × 1e6) = 16_500_000 — from the rate, NOT any current MARGIN.
  expect(balances.listRevenue()).toEqual([
    { at: NOW, asset: "monero", asset_atomic: 100_000_000_000, scale: ATOMIC_PER_XMR, usd_micros: 15_000_000, gross_micros: 16_500_000 },
  ]);
});

test("settle books gross proportional to a PARTIAL payment, still at the locked rate", () => {
  const balances = openDb(":memory:");
  const orders = openOrderStore(":memory:");
  const hash = "0".repeat(64);
  const NOW = 1_700_000_000_000;
  // $20 credit quoted at 200 USD/XMR (a 1.10 margin) → expect 0.11 XMR; the buyer pays HALF (0.055 XMR).
  orders.tryAddOrder(
    { rail: "monero", order_index: 9, address: "addr9", hash, expected_atomic: 110_000_000_000, credit_micros: 20_000_000, received_atomic: 0, created_at: NOW, rate_usd: 200 },
    Number.MAX_SAFE_INTEGER,
  );
  const transfers: Incoming[] = [
    { orderIndex: 9, idempotencyKey: "tx:9", amount: 55_000_000_000, confirmations: 10, final: true },
  ];
  settle(transfers, orders, balances, NOW, { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: 9_999_999_999_999 });
  // Both scale to half: share = round(20e6 × 0.5) = 10e6; gross = round(0.055 × 200 × 1e6) = 11e6.
  // gross/share = 1.10 (the locked margin) holds on a partial just as on a full payment.
  expect(balances.getBalance(hash)).toBe(10_000_000);
  expect(balances.listRevenue()).toEqual([
    { at: NOW, asset: "monero", asset_atomic: 55_000_000_000, scale: ATOMIC_PER_XMR, usd_micros: 10_000_000, gross_micros: 11_000_000 },
  ]);
});
