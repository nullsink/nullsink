// Read-only migration rehearsal. Point it at a SCRATCH dir holding COPIES of the production pending.db and
// balances.db (+ their -wal/-shm sidecars). It copies them into a throwaway work dir, snapshots each DB's
// pre-migration shape, then opens the copies through the app's own openOrderStore/openDb — which runs the
// REAL in-place migrations (seam + composite-PK on pending; xmr_atomic→asset_atomic on revenue) — and prints
// a BEFORE/AFTER so you can confirm no row was lost and the schema transformed as expected. It NEVER writes
// to the input files and NEVER touches the box. Re-runnable: the work dir is rebuilt each run.
//
//   bun run scripts/rehearse-migration.ts <dir-with-db-copies>
//
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun run scripts/rehearse-migration.ts <dir-with-pending.db-and-balances.db-copies>");
  process.exit(1);
}
for (const name of ["pending.db", "balances.db"]) {
  if (!existsSync(`${dir}/${name}`)) {
    console.error(`missing ${dir}/${name} — copy the production DBs (and any -wal/-shm) into ${dir} first`);
    process.exit(1);
  }
}

const cols = (db: Database, t: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const count = (db: Database, t: string) => {
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0;
  } catch {
    return -1; // table absent
  }
};

// 1) copy the inputs into a throwaway work dir (originals are never opened, only copied) -------------------
const work = `${dir}/.rehearsal-work`;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const name of ["pending.db", "balances.db"])
  for (const sfx of ["", "-wal", "-shm"]) if (existsSync(`${dir}/${name}${sfx}`)) copyFileSync(`${dir}/${name}${sfx}`, `${work}/${name}${sfx}`);

// 2) snapshot the copies RAW (no app code, no migration) --------------------------------------------------
const pRaw = new Database(`${work}/pending.db`);
const before = {
  pendingCols: cols(pRaw, "pending_orders"),
  pendingRows: count(pRaw, "pending_orders"),
};
pRaw.close();
const bRaw = new Database(`${work}/balances.db`);
const beforeB = {
  tokens: count(bRaw, "tokens"),
  applied: count(bRaw, "applied_orders"),
  revenueCols: cols(bRaw, "revenue"),
  revenueRows: count(bRaw, "revenue"),
};
bRaw.close();

// 3) neutralise the app modules' load-time prod singletons (they open PENDING_DB_PATH/DB_PATH at import),
//    then open the COPIES through the real stores so the migrations run ------------------------------------
process.env.PENDING_DB_PATH = `${work}/.singleton-pending.db`;
process.env.DB_PATH = `${work}/.singleton-balances.db`;
const { openOrderStore } = await import("../src/ledger/orders");
const { openDb } = await import("../src/ledger/db");

const orders = openOrderStore(`${work}/pending.db`);
const balances = openDb(`${work}/balances.db`);
const afterOrders = orders.openOrders();
const afterRevenue = balances.listRevenue();
orders.db.close();
balances.db.close();

// 4) idempotency: a second open (mirrors a service restart re-running the migration) must be a no-op -------
const orders2 = openOrderStore(`${work}/pending.db`);
const balances2 = openDb(`${work}/balances.db`);
const reopenPending = orders2.openOrders().length;
const reopenRevenue = balances2.listRevenue().length;
orders2.db.close();
balances2.db.close();

// 5) report -----------------------------------------------------------------------------------------------
const ok = (b: boolean) => (b ? "✓" : "✗ MISMATCH");
const p = console.log;
p("");
p("════════ MIGRATION REHEARSAL (read-only on copies) ════════");
p("");
p("── pending.db ──────────────────────────────────────────────");
p(`  before  cols : [${before.pendingCols.join(", ")}]`);
p(`  before  rows : ${before.pendingRows}`);
p(`  after   rows : ${afterOrders.length}   ${ok(afterOrders.length === before.pendingRows)} (no rows lost)`);
p(`  rail values  : {${[...new Set(afterOrders.map((o) => o.rail))].join(", ") || "—"}}   (expect: monero)`);
p(`  re-open rows : ${reopenPending}   ${ok(reopenPending === afterOrders.length)} (idempotent)`);
if (afterOrders.length) {
  const s = afterOrders[0]!;
  p(`  sample order : rail=${s.rail} index=${s.order_index} hash=${s.hash.slice(0, 10)}… expected=${s.expected_atomic} credit_micros=${s.credit_micros}`);
}
p("");
p("── balances.db ─────────────────────────────────────────────");
p(`  tokens rows  : ${beforeB.tokens}   (schema-unchanged, not migrated)`);
p(`  applied rows : ${beforeB.applied}`);
p(`  revenue before cols : [${beforeB.revenueCols.join(", ")}]`);
p(`  revenue before rows : ${beforeB.revenueRows}`);
p(`  revenue after  rows : ${afterRevenue.length}   ${ok(afterRevenue.length === beforeB.revenueRows)} (no rows lost)`);
p(`  re-open  rows : ${reopenRevenue}   ${ok(reopenRevenue === afterRevenue.length)} (idempotent)`);
p(`  assets       : {${[...new Set(afterRevenue.map((r) => r.asset))].join(", ") || "—"}}   total gross = $${(afterRevenue.reduce((a, r) => a + r.gross_micros, 0) / 1_000_000).toFixed(2)}`);
if (afterRevenue.length) {
  const r = afterRevenue[afterRevenue.length - 1]!;
  p(`  latest sale  : asset=${r.asset} asset_atomic=${r.asset_atomic} scale=${r.scale} usd=$${(r.usd_micros / 1_000_000).toFixed(2)}`);
}
p("");
const allPass = afterOrders.length === before.pendingRows && afterRevenue.length === beforeB.revenueRows && reopenPending === afterOrders.length && reopenRevenue === afterRevenue.length;
p(allPass ? "RESULT: ✓ all row counts preserved + idempotent — migration is safe on this data." : "RESULT: ✗ INVESTIGATE — a count changed; do NOT deploy until resolved.");
p("");
