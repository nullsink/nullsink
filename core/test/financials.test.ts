import { expect, test } from "bun:test";
import { formatCoin, formatUsd, summarizeRevenue, type RevenueRow } from "../src/ledger/financials";

test("revenue summary keeps coin units separate and sums exact USD", () => {
  const rows: RevenueRow[] = [
    { asset: "monero", asset_atomic: 50_000_000_000, scale: 1_000_000_000_000, usd_micros: 15_000_000, gross_micros: 16_500_000 },
    { asset: "bitcoin", asset_atomic: 57_500, scale: 100_000_000, usd_micros: 30_000_000, gross_micros: 34_500_000 },
    { asset: "monero", asset_atomic: 50_000_000_000, scale: 1_000_000_000_000, usd_micros: 15_000_000, gross_micros: 16_500_000 },
  ];
  const summary = summarizeRevenue(rows);
  expect(summary.perCoin.get("monero")).toEqual({
    atomic: 100_000_000_000n,
    scale: 1_000_000_000_000,
    sales: 2,
  });
  expect(summary.perCoin.get("bitcoin")).toEqual({ atomic: 57_500n, scale: 100_000_000, sales: 1 });
  expect(formatUsd(summary.creditMicros)).toBe("60.000000");
  expect(formatUsd(summary.grossMicros)).toBe("67.500000");
});

test("coin and USD fixed-point rendering is exact", () => {
  expect(formatCoin(57_500, 100_000_000)).toBe("0.00057500");
  expect(formatCoin(50_000_000_000, 1_000_000_000_000)).toBe("0.050000000000");
  expect(formatUsd(16_500_000)).toBe("16.500000");
});
