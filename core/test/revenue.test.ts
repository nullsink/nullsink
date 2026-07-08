// Revenue book (cli/financials.ts data source), now PAYMENT-world state in pending.db (D5). settle() books a
// sale in the SAME transaction as the outbox enqueue: booked iff a credit is requested, a re-scan double-counts
// neither, gross (USD paid) is valued at the order's LOCKED rate so it never drifts when MARGIN changes, and
// each row carries its coin (asset + scale) so a multi-rail book renders every coin exactly. The balance credit
// itself lands only once the sender (drainCreditOutbox) delivers the outbox row to the balance ledger.
import { test, expect } from "bun:test";
import { openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { settle } from "../src/ledger/settle";
import { drainCreditOutbox } from "../src/ledger/drain";
import type { Incoming } from "../src/rails/types";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const NOW = 1_700_000_000_000;
const SEED_MAX = Number.MAX_SAFE_INTEGER;

// Seed one order and settle a confirmed deposit of `amount`; returns both stores (credit is only ENQUEUED —
// call drainCreditOutbox to land it in `balances`).
function settleOne(o: { orderIndex: number; hash: string; expected: number; credit: number; rate: number; rail?: string; scale?: number }, amount: number) {
  const rail = o.rail ?? "monero";
  const scale = o.scale ?? ATOMIC_PER_XMR;
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  store.tryAddOrder({ rail, order_index: o.orderIndex, address: `a${o.orderIndex}`, hash: o.hash, expected_atomic: o.expected, credit_micros: o.credit, received_atomic: 0, created_at: NOW, rate_usd: o.rate }, SEED_MAX);
  settle([{ orderIndex: o.orderIndex, idempotencyKey: `tx:${o.orderIndex}`, amount, confirmations: 10, final: true }], store, NOW, { scale, asset: rail, rail, backstopMs: 9_999_999_999_999 });
  return { balances, store };
}

test("settle books the sale in pending.db at the locked rate; the balance lands only after the drain", () => {
  const hash = "f".repeat(64);
  // $15 credit, quoted at a locked 165 USD/XMR → 0.1 XMR expected; buyer pays it in full.
  const { balances, store } = settleOne({ orderIndex: 5, hash, expected: 100_000_000_000, credit: 15_000_000, rate: 165 }, 100_000_000_000);
  // gross = round((1e11 / 1e12) × 165 × 1e6) = 16_500_000 — from the rate, NOT any current MARGIN.
  expect(store.listRevenue()).toEqual([
    { at: NOW, asset: "monero", asset_atomic: 100_000_000_000, scale: ATOMIC_PER_XMR, usd_micros: 15_000_000, gross_micros: 16_500_000 },
  ]);
  expect(balances.getBalance(hash)).toBeNull(); // credit enqueued, not yet delivered
  drainCreditOutbox(store, balances, NOW);
  expect(balances.getBalance(hash)).toBe(15_000_000); // net credit issued
});

test("settle books gross proportional to a PARTIAL payment, still at the locked rate", () => {
  const hash = "0".repeat(64);
  // $20 credit quoted at 200 USD/XMR (a 1.10 margin) → 0.11 XMR; the buyer pays HALF (0.055 XMR).
  const { store } = settleOne({ orderIndex: 9, hash, expected: 110_000_000_000, credit: 20_000_000, rate: 200 }, 55_000_000_000);
  // share = round(20e6 × 0.5) = 10e6; gross = round(0.055 × 200 × 1e6) = 11e6; gross/share = 1.10 (locked margin).
  expect(store.listRevenue()).toEqual([
    { at: NOW, asset: "monero", asset_atomic: 55_000_000_000, scale: ATOMIC_PER_XMR, usd_micros: 10_000_000, gross_micros: 11_000_000 },
  ]);
});

test("a re-scan of the same deposit books the sale exactly once", () => {
  const hash = "b".repeat(64);
  const { store } = settleOne({ orderIndex: 1, hash, expected: 1_000_000_000, credit: 5_000_000, rate: 100 }, 1_000_000_000);
  expect(store.listRevenue()).toHaveLength(1);
  // the poller re-scans the same deposit next tick — but the order is closed, so no second sale is booked:
  const rescan: Incoming = { orderIndex: 1, idempotencyKey: "tx:1", amount: 1_000_000_000, confirmations: 10, final: true };
  settle([rescan], store, NOW, { scale: ATOMIC_PER_XMR, asset: "monero", rail: "monero", backstopMs: 9_999_999_999_999 });
  expect(store.listRevenue()).toHaveLength(1);
});

test("a Bitcoin sale books in sats at its own scale (not mislabelled as XMR)", () => {
  const SATS_PER_BTC = 100_000_000;
  // 0.001 BTC = 100_000 sats, $60 credit at a locked $60k/BTC → gross $60.
  const { store } = settleOne({ orderIndex: 0, hash: "e".repeat(64), expected: 100_000, credit: 60_000_000, rate: 60_000, rail: "bitcoin", scale: SATS_PER_BTC }, 100_000);
  expect(store.listRevenue()).toEqual([
    { at: NOW, asset: "bitcoin", asset_atomic: 100_000, scale: SATS_PER_BTC, usd_micros: 60_000_000, gross_micros: 60_000_000 },
  ]);
});

test("listRevenue filters by [fromMs, toMs) — from inclusive, to exclusive", () => {
  const store = openOrderStore(":memory:");
  for (const at of [100, 200, 300]) store.recordRevenue(at, "monero", 1_000_000_000, ATOMIC_PER_XMR, 1_000_000, 1_100_000);
  expect(store.listRevenue(150, 300).map((r) => r.at)).toEqual([200]); // 100 below `from`, 300 == `to` (exclusive)
});

test("the manual-issuance path (creditOnce) credits but books no sale — revenue is settle's job now", () => {
  const balances = openDb(":memory:");
  const hash = "c".repeat(64);
  expect(balances.creditOnce(hash, 1_000_000, "manual:1", 1)).toBe(true);
  expect(balances.getBalance(hash)).toBe(1_000_000);
  // creditOnce no longer touches any sales book — the balance ledger holds no revenue table (D5).
});
