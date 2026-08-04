// Exact, DB-free book summarisation shared by the live and snapshot financial views.
export type RevenueRow = {
  asset: string;
  asset_atomic: number;
  scale: number;
  usd_micros: number;
  gross_micros: number;
};

export function formatUsd(micros: number | bigint): string {
  const m = BigInt(micros);
  return `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
}

export function formatCoin(atomic: number | bigint, scale: number | bigint): string {
  const unit = BigInt(scale);
  const amount = BigInt(atomic);
  const decimals = unit.toString().length - 1;
  return `${amount / unit}.${(amount % unit).toString().padStart(decimals, "0")}`;
}

export type CoinTotal = { atomic: bigint; scale: number; sales: number };

export function summarizeRevenue(rows: RevenueRow[]): {
  perCoin: Map<string, CoinTotal>;
  sales: number;
  creditMicros: bigint;
  grossMicros: bigint;
} {
  const perCoin = new Map<string, CoinTotal>();
  for (const row of rows) {
    const current = perCoin.get(row.asset) ?? { atomic: 0n, scale: row.scale, sales: 0 };
    current.atomic += BigInt(row.asset_atomic);
    current.sales += 1;
    perCoin.set(row.asset, current);
  }
  return {
    perCoin,
    sales: rows.length,
    creditMicros: rows.reduce((sum, row) => sum + BigInt(row.usd_micros), 0n),
    grossMicros: rows.reduce((sum, row) => sum + BigInt(row.gross_micros), 0n),
  };
}
