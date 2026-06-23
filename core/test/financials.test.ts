// Books summarisation (src/financials.ts) under MIXED coins. The money-safety property: amounts of different
// coins are never summed into one figure (you can't add XMR to BTC) — each renders at its own scale — while
// the coin-independent USD figures sum across the whole journal.
import { test, expect } from "bun:test";
import { summarizeRevenue, formatCoin, formatUsd, type RevenueRow } from "../src/ledger/financials";

test("summarizeRevenue keeps coins SEPARATE (never adds XMR to BTC) and sums USD across the journal", () => {
  const rows: RevenueRow[] = [
    { asset: "monero", asset_atomic: 50_000_000_000, scale: 1_000_000_000_000, usd_micros: 15_000_000, gross_micros: 16_500_000 }, // 0.05 XMR, $15
    { asset: "bitcoin", asset_atomic: 57_500, scale: 100_000_000, usd_micros: 30_000_000, gross_micros: 34_500_000 }, // 0.000575 BTC, $30
    { asset: "monero", asset_atomic: 50_000_000_000, scale: 1_000_000_000_000, usd_micros: 15_000_000, gross_micros: 16_500_000 }, // another 0.05 XMR
  ];
  const s = summarizeRevenue(rows);
  expect(s.sales).toBe(3);
  // per-coin received, each at its OWN scale — monero summed only with monero, bitcoin alone:
  expect(s.perCoin.get("monero")).toEqual({ atomic: 100_000_000_000n, scale: 1_000_000_000_000, sales: 2 });
  expect(s.perCoin.get("bitcoin")).toEqual({ atomic: 57_500n, scale: 100_000_000, sales: 1 });
  expect(formatCoin(s.perCoin.get("monero")!.atomic, s.perCoin.get("monero")!.scale)).toBe("0.100000000000");
  expect(formatCoin(s.perCoin.get("bitcoin")!.atomic, s.perCoin.get("bitcoin")!.scale)).toBe("0.00057500");
  // USD figures ARE coin-independent → they sum across the whole journal:
  expect(formatUsd(s.creditMicros)).toBe("60.000000"); // 15 + 30 + 15
  expect(formatUsd(s.grossMicros)).toBe("67.500000"); // 16.5 + 34.5 + 16.5
});

test("formatCoin renders each scale at its own precision; formatUsd is exact fixed-point", () => {
  expect(formatCoin(57_500, 100_000_000)).toBe("0.00057500"); // 8 decimals (sats)
  expect(formatCoin(50_000_000_000, 1_000_000_000_000)).toBe("0.050000000000"); // 12 decimals (piconero)
  expect(formatUsd(16_500_000)).toBe("16.500000");
});
