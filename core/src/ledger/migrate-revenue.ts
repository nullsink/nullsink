// One-time cutover migration (D5). Two steps, both run with the service STOPPED (see scripts/migrate-revenue.ts):
//   migrateRevenue   — move the `revenue` sales book from balances.db (prompt world) to pending.db (payment
//                      world). The book no longer lives in openDb's schema, so this reads the old balances.db
//                      revenue table via raw SQL and inserts every row into the pending.db revenue table.
//   reconcileOutbox  — the F3 defense (below): seed credit_outbox with acked tombstones for every already-applied
//                      key, so a pre-cutover zombie can't double-book its sale post-cutover.
// Column-normalises the pre-seam (`xmr_atomic`, no asset/scale) and post-seam (`asset_atomic`) revenue schemas so
// an older DB still moves. Draining zombies through the old binary first is still good hygiene, but the sales book
// is now protected in code, not only by that runbook step.
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

// The F3 defense, in code. The old binary tracked "already credited" in balances.db.applied_orders; crediting now
// lives behind credit_outbox in pending.db. A pre-cutover ZOMBIE — an order the old binary credited (its key in
// applied_orders) but left OPEN by a crash before removeOrder — would otherwise be re-processed by the new poller
// and, finding its key absent from the fresh credit_outbox, DOUBLE-BOOK its sale (balance stays safe via
// applied_orders, but the revenue book doubles). Seed every applied key into credit_outbox as an ACKED tombstone
// (hash/micros empty — never delivered, since acked, and never re-credited: the credit already landed pre-cutover).
// Then commitSettlement's fresh-guard sees the key → not fresh → no second sale, and removeOrder still closes the
// zombie. Idempotent (enqueueCredit is INSERT OR IGNORE). Bounded by the applied_orders count (~one per sale).
export function reconcileOutbox(balancesDb: Database, orders: OrdersStore): { seeded: number } {
  const hasApplied = balancesDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='applied_orders'").get()!.n > 0;
  if (!hasApplied) return { seeded: 0 };
  const applied = balancesDb.query<{ order_id: string; applied_at: number }, []>("SELECT order_id, applied_at FROM applied_orders").all();
  let seeded = 0;
  orders.db.transaction(() => {
    for (const a of applied) {
      // enqueue an empty tombstone under the applied key, then ack it so the sender never delivers it.
      if (orders.enqueueCredit(a.order_id, "", 0, a.applied_at)) {
        orders.ackCredit(a.order_id, a.applied_at);
        seeded++;
      }
    }
  })();
  return { seeded };
}
