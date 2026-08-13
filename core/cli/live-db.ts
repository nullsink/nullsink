// The complete live-database exception for operator tooling. Both handles are opened with SQLite's enforced
// read-only flag; no service store constructor, schema migration, or write method enters the nsk binary.
import { Database } from "bun:sqlite";

export const BALANCES_DB_PATH =
  process.env.BALANCES_DB_PATH ?? process.env.DB_PATH ?? "/var/lib/nullsink-ledger/balances.db";
export const PENDING_DB_PATH =
  process.env.PENDING_DB_PATH ?? "/var/lib/nullsink-payments/pending.db";

export type LiveRevenueRow = {
  at: number;
  asset: string;
  asset_atomic: number;
  scale: number;
  usd_micros: number;
  gross_micros: number;
};

function openReadonly(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

export function readBalances(path = BALANCES_DB_PATH): {
  rows: { hash: string; balance: number }[];
  tokens: number;
  micros: bigint;
} {
  const db = openReadonly(path);
  try {
    const rows = db
      .query<{ hash: string; balance: number }, []>(
        "SELECT hash, balance FROM tokens ORDER BY balance DESC, hash ASC",
      )
      .all();
    const total = db
      .query<{ tokens: number; micros: string }, []>(
        "SELECT COUNT(*) AS tokens, CAST(COALESCE(SUM(balance), 0) AS TEXT) AS micros FROM tokens",
      )
      .get();
    return { rows, tokens: total?.tokens ?? 0, micros: BigInt(total?.micros ?? "0") };
  } finally {
    db.close();
  }
}

export function readFinancials(
  fromMs: number,
  toMs: number,
  pendingPath = PENDING_DB_PATH,
  balancesPath = BALANCES_DB_PATH,
): { rows: LiveRevenueRow[]; liability: { tokens: number; micros: bigint } } {
  const pending = openReadonly(pendingPath);
  const balances = openReadonly(balancesPath);
  try {
    const rows = pending
      .query<LiveRevenueRow, [number, number]>(
        "SELECT at, asset, asset_atomic, scale, usd_micros, gross_micros FROM revenue WHERE at >= ? AND at < ? ORDER BY at ASC",
      )
      .all(fromMs, toMs);
    const total = balances
      .query<{ tokens: number; micros: string }, []>(
        "SELECT COUNT(*) AS tokens, CAST(COALESCE(SUM(balance), 0) AS TEXT) AS micros FROM tokens",
      )
      .get();
    return {
      rows,
      liability: { tokens: total?.tokens ?? 0, micros: BigInt(total?.micros ?? "0") },
    };
  } finally {
    pending.close();
    balances.close();
  }
}
