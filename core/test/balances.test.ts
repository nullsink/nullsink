// Per-token balance listing (cli/balances.ts data source). Properties: every token appears with its exact
// stored balance, ordered biggest-first; and the listing's total equals liabilityTotal() — the SAME figure
// `nsk financials` reports as outstanding — so the per-token and aggregate operator views can't disagree.
import { test, expect } from "bun:test";
import { openDb } from "../src/ledger/db";

test("listBalances returns every token (hash, balance), largest balance first", () => {
  const { credit, listBalances } = openDb(":memory:");
  credit("a".repeat(64), 3_000_000);
  credit("b".repeat(64), 1_000_000);
  credit("c".repeat(64), 2_000_000);
  expect(listBalances()).toEqual([
    { hash: "a".repeat(64), balance: 3_000_000 },
    { hash: "c".repeat(64), balance: 2_000_000 },
    { hash: "b".repeat(64), balance: 1_000_000 },
  ]);
});

test("listBalances is empty on a fresh ledger", () => {
  expect(openDb(":memory:").listBalances()).toEqual([]);
});

test("the listing reconciles with liabilityTotal (financials' OUTSTANDING figure)", () => {
  const { credit, listBalances, liabilityTotal } = openDb(":memory:");
  credit("a".repeat(64), 3_000_000);
  credit("b".repeat(64), 1_500_000);
  const rows = listBalances();
  const agg = liabilityTotal();
  expect(agg.tokens).toBe(rows.length);
  expect(agg.micros).toBe(rows.reduce((s, r) => s + BigInt(r.balance), 0n)); // micros is exact BigInt
});
