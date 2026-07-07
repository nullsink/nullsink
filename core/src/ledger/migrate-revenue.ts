// One-time cutover migration (D5): move the `revenue` sales book from balances.db (prompt world) to pending.db
// (payment world). The book no longer lives in openDb's schema, so this reads the old balances.db revenue table
// via raw SQL and inserts every row into the pending.db revenue table (created by openOrderStore).
//
// SAFETY: run with the service STOPPED, and only AFTER draining any zombie orders through the OLD binary (one
// full poll cycle per rail, then assert no still-open order's deposit is already in applied_orders) — otherwise
// a post-cutover settle re-books a sale the migration also copied (the F3 double-count). This function itself
// refuses to run if pending.db already holds revenue rows, so a re-run can't double the book. Column-normalises
// the pre-seam (`xmr_atomic`, no asset/scale) and post-seam (`asset_atomic`) schemas so an older DB still moves.
import { Database } from "bun:sqlite";
import type { OrdersStore } from "./orders";

export function migrateRevenue(balancesDb: Database, orders: OrdersStore): { copied: number; grossMicros: number } {
  const existing = orders.listRevenue();
  if (existing.length > 0)
    throw new Error(`refusing to migrate: pending.db already has ${existing.length} revenue row(s) — already migrated?`);

  // A fresh post-split balances.db has no revenue table — nothing to move.
  const hasTable = balancesDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='revenue'").get()!.n > 0;
  if (!hasTable) return { copied: 0, grossMicros: 0 };

  // Normalise across schemas: pre-seam rows key the coin amount as `xmr_atomic` and lack asset/scale (they ARE
  // Monero sales → default to monero / 1e12); post-seam rows already have asset_atomic/asset/scale.
  const cols = new Set(balancesDb.query<{ name: string }, []>("PRAGMA table_info(revenue)").all().map((c) => c.name));
  const atomicCol = cols.has("asset_atomic") ? "asset_atomic" : "xmr_atomic";
  const assetExpr = cols.has("asset") ? "asset" : "'monero'";
  const scaleExpr = cols.has("scale") ? "scale" : "1000000000000";
  const rows = balancesDb
    .query<{ at: number; asset: string; asset_atomic: number; scale: number; usd_micros: number; gross_micros: number }, []>(
      `SELECT at, ${assetExpr} AS asset, ${atomicCol} AS asset_atomic, ${scaleExpr} AS scale, usd_micros, gross_micros FROM revenue ORDER BY at ASC`,
    )
    .all();

  // One transaction on pending.db: all rows land or none do.
  let grossMicros = 0;
  orders.db.transaction(() => {
    for (const r of rows) {
      orders.recordRevenue(r.at, r.asset, r.asset_atomic, r.scale, r.usd_micros, r.gross_micros);
      grossMicros += r.gross_micros;
    }
  })();
  return { copied: rows.length, grossMicros };
}
