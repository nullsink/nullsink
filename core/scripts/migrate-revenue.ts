// One-time cutover migration (D5): copy the revenue sales book from balances.db to pending.db. Run with the
// service STOPPED and AFTER draining zombie orders through the OLD binary (see src/ledger/migrate-revenue.ts
// and the cutover runbook). balances.db is only READ here; pending.db is written in place. Verifies the row
// count + gross sum reconcile before/after, and exits non-zero on any mismatch. Rehearse first on copies with
// scripts/rehearse-migration.ts.
//
//   bun run scripts/migrate-revenue.ts <balances.db> <pending.db>
//
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { openOrderStore } from "../src/ledger/orders";
import { migrateRevenue } from "../src/ledger/migrate-revenue";

const balancesPath = process.argv[2];
const pendingPath = process.argv[3];
if (!balancesPath || !pendingPath) {
  console.error("usage: bun run scripts/migrate-revenue.ts <balances.db> <pending.db>");
  process.exit(1);
}
for (const p of [balancesPath, pendingPath]) if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }

const balancesDb = new Database(balancesPath); // read-only use — migrateRevenue only SELECTs from it
const orders = openOrderStore(pendingPath);

const srcCount = balancesDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='revenue'").get()!.n
  ? balancesDb.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM revenue").get()!.n
  : 0;
const srcGross = srcCount ? balancesDb.query<{ g: number }, []>("SELECT COALESCE(SUM(gross_micros), 0) AS g FROM revenue").get()!.g : 0;

const { copied } = migrateRevenue(balancesDb, orders);

const dstRows = orders.listRevenue();
const dstGross = dstRows.reduce((a, r) => a + r.gross_micros, 0);
balancesDb.close();
orders.db.close();

const ok = (b: boolean) => (b ? "✓" : "✗ MISMATCH");
console.log("");
console.log("════════ REVENUE MIGRATION (balances.db → pending.db) ════════");
console.log(`  source rows : ${srcCount}   gross = $${(srcGross / 1_000_000).toFixed(2)}`);
console.log(`  copied      : ${copied}   ${ok(copied === srcCount)}`);
console.log(`  dest rows   : ${dstRows.length}   ${ok(dstRows.length === srcCount)}`);
console.log(`  dest gross  : $${(dstGross / 1_000_000).toFixed(2)}   ${ok(dstGross === srcGross)}`);
const pass = copied === srcCount && dstRows.length === srcCount && dstGross === srcGross;
console.log(pass ? "RESULT: ✓ revenue moved, counts + gross reconcile." : "RESULT: ✗ INVESTIGATE — a figure diverged.");
console.log("");
process.exit(pass ? 0 : 1);
