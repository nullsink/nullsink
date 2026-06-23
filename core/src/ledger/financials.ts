// Pure book-summarisation for cli/financials.ts — extracted so the per-coin grouping is unit-testable. The
// money-safety property this pins: amounts of DIFFERENT coins are NEVER summed into one figure (you can't add
// XMR to BTC); only the coin-independent USD figures sum across the whole journal, and each row renders at
// its OWN scale. All sums are BigInt so a going concern's lifetime total can't overflow Number.

// The revenue-row fields this module needs (a subset of db.ts listRevenue()'s shape).
export type RevenueRow = { asset: string; asset_atomic: number; scale: number; usd_micros: number; gross_micros: number };

// Exact fixed-point USD from micros.
export function formatUsd(micros: number | bigint): string {
  const m = BigInt(micros);
  return `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
}

// Render an atomic coin amount at its scale (a power of ten → decimals = digits of the scale minus 1).
export function formatCoin(atomic: number | bigint, scale: number | bigint): string {
  const s = BigInt(scale);
  const a = BigInt(atomic);
  const decimals = s.toString().length - 1;
  return `${a / s}.${(a % s).toString().padStart(decimals, "0")}`;
}

export type CoinTotal = { atomic: bigint; scale: number; sales: number };
export type RevenueSummary = {
  perCoin: Map<string, CoinTotal>; // received, kept SEPARATE per coin (never cross-summed)
  sales: number;
  creditMicros: bigint; // USD credit issued, summed across the journal (coin-independent)
  grossMicros: bigint; // USD gross paid at each sale's locked rate, summed across the journal
};

// Group the journal by coin (separate received totals, each at its own scale) and sum the coin-independent
// USD figures across all rows.
export function summarizeRevenue(rows: RevenueRow[]): RevenueSummary {
  const perCoin = new Map<string, CoinTotal>();
  for (const r of rows) {
    const cur = perCoin.get(r.asset) ?? { atomic: 0n, scale: r.scale, sales: 0 };
    cur.atomic += BigInt(r.asset_atomic);
    cur.sales += 1;
    perCoin.set(r.asset, cur);
  }
  return {
    perCoin,
    sales: rows.length,
    creditMicros: rows.reduce((s, r) => s + BigInt(r.usd_micros), 0n),
    grossMicros: rows.reduce((s, r) => s + BigInt(r.gross_micros), 0n),
  };
}
