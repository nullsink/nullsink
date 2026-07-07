// Live-DB migrations. Real XMR users exist, so the rail-seam schema changes must migrate an existing
// pre-seam DB IN PLACE — never rebuild (that would destroy real balances + the irreplaceable payment↔token
// links). pending_orders: subaddr_index -> order_index (+ address), then a composite (rail, order_index) PK
// rebuild for multi-rail (existing rows back-fill rail='monero'). revenue: xmr_atomic -> asset_atomic
// (+ asset/scale), existing rows back-filling to monero/1e12 (they ARE Monero sales). All idempotent.
import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { openOrderStore } from "../src/ledger/orders";
import { openDb } from "../src/ledger/db";
import { settle } from "../src/ledger/settle";
import { drainCreditOutbox } from "../src/ledger/drain";
import { migrateRevenue, reconcileOutbox } from "../src/ledger/migrate-revenue";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const PENDING = "/tmp/nullsink-mig-pending.db";
const BALANCES = "/tmp/nullsink-mig-balances.db";
const rm = (p: string) => {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(p + s);
    } catch {
      /* not present */
    }
  }
};
afterEach(() => {
  rm(PENDING);
  rm(BALANCES);
});

test("pending_orders migrates subaddr_index -> order_index (+ address), preserving a live in-flight order", () => {
  rm(PENDING);
  // pre-seam schema + a real paid-but-unconfirmed XMR order:
  const old = new Database(PENDING);
  old.run(
    `CREATE TABLE pending_orders (subaddr_index INTEGER PRIMARY KEY, hash TEXT NOT NULL, expected_atomic INTEGER NOT NULL, credit_micros INTEGER NOT NULL, received_atomic INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, rate_usd REAL NOT NULL DEFAULT 0)`,
  );
  old.run(`INSERT INTO pending_orders (subaddr_index, hash, expected_atomic, credit_micros, received_atomic, created_at, rate_usd) VALUES (7, 'h7', 100000, 50000, 0, 1000, 165)`);
  old.close();

  const store = openOrderStore(PENDING); // opening runs the migration
  const rows = store.openOrders();
  expect(rows.length).toBe(1); // the live order survived
  expect(rows[0]!.order_index).toBe(7); // renamed PK column, value preserved
  expect(rows[0]!.address).toBe(""); // back-filled — Monero settles by index, not address
  expect(rows[0]!.hash).toBe("h7");
  expect(rows[0]!.expected_atomic).toBe(100000);
  store.db.close();

  const again = openOrderStore(PENDING); // idempotent: an already-migrated DB is a no-op, no error
  expect(again.openOrders().length).toBe(1);
  again.db.close();
});

// D5: the sales book moves balances.db → pending.db at cutover (migrateRevenue), normalising the pre-seam
// (xmr_atomic, no asset/scale) schema on the way. Real XMR sales exist, so this must copy them exactly and
// refuse to double-book on a re-run. (balances.db no longer keeps a revenue table; tokens/balances are untouched.)
test("migrateRevenue moves the sales book balances.db -> pending.db, normalising a pre-seam (xmr_atomic) schema", () => {
  rm(BALANCES);
  rm(PENDING);
  const old = new Database(BALANCES);
  old.run(`CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)`);
  old.run(`CREATE TABLE revenue (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, xmr_atomic INTEGER NOT NULL, usd_micros INTEGER NOT NULL, gross_micros INTEGER NOT NULL DEFAULT 0)`);
  old.run(`INSERT INTO tokens (hash, balance) VALUES ('aa', 7500000)`); // a real XMR-user balance (stays put)
  old.run(`INSERT INTO revenue (at, xmr_atomic, usd_micros, gross_micros) VALUES (1000, 50000000000, 7500000, 8250000)`);
  old.close();

  const balancesDb = new Database(BALANCES);
  const orders = openOrderStore(PENDING);
  expect(migrateRevenue(balancesDb, orders).copied).toBe(1);
  // the pre-seam row lands in pending.db, back-filled monero / 1e12 through the new columns:
  expect(orders.listRevenue()).toEqual([
    { at: 1000, asset: "monero", asset_atomic: 50000000000, scale: 1000000000000, usd_micros: 7500000, gross_micros: 8250000 },
  ]);
  expect(openDb(BALANCES).getBalance("aa")).toBe(7500000); // balances untouched by the move
  // idempotent: a second run REFUSES (pending.db already has revenue) rather than doubling the book:
  expect(() => migrateRevenue(balancesDb, orders)).toThrow(/already/);
  expect(orders.listRevenue()).toHaveLength(1);
  balancesDb.close();
  orders.db.close();
});

test("migrateRevenue copies a post-seam (asset_atomic) book, preserving each row's own asset + scale", () => {
  rm(BALANCES);
  rm(PENDING);
  const old = new Database(BALANCES);
  old.run(`CREATE TABLE revenue (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, asset TEXT NOT NULL DEFAULT 'monero', asset_atomic INTEGER NOT NULL, scale INTEGER NOT NULL DEFAULT 1000000000000, usd_micros INTEGER NOT NULL, gross_micros INTEGER NOT NULL DEFAULT 0)`);
  old.run(`INSERT INTO revenue (at, asset, asset_atomic, scale, usd_micros, gross_micros) VALUES (500, 'bitcoin', 100000, 100000000, 60000000, 60000000)`);
  old.close();

  const balancesDb = new Database(BALANCES);
  const orders = openOrderStore(PENDING);
  expect(migrateRevenue(balancesDb, orders).copied).toBe(1);
  expect(orders.listRevenue()).toEqual([
    { at: 500, asset: "bitcoin", asset_atomic: 100000, scale: 100000000, usd_micros: 60000000, gross_micros: 60000000 },
  ]);
  balancesDb.close();
  orders.db.close();
});

test("migrateRevenue is a clean no-op on a balances.db with NO revenue table (fresh post-split), not a throw", () => {
  rm(BALANCES);
  rm(PENDING);
  new Database(BALANCES).run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)"); // no revenue table at all
  const balancesDb = new Database(BALANCES);
  const orders = openOrderStore(PENDING);
  expect(migrateRevenue(balancesDb, orders)).toEqual({ copied: 0, grossMicros: 0 }); // no "no such table" crash
  expect(orders.listRevenue()).toEqual([]);
  balancesDb.close();
  orders.db.close();
});

test("migrateRevenue returns the summed gross of the rows it copied", () => {
  rm(BALANCES);
  rm(PENDING);
  const old = new Database(BALANCES);
  old.run("CREATE TABLE revenue (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, asset TEXT NOT NULL DEFAULT 'monero', asset_atomic INTEGER NOT NULL, scale INTEGER NOT NULL DEFAULT 1000000000000, usd_micros INTEGER NOT NULL, gross_micros INTEGER NOT NULL DEFAULT 0)");
  old.run("INSERT INTO revenue (at, asset_atomic, usd_micros, gross_micros) VALUES (1, 1, 1000000, 1100000)");
  old.run("INSERT INTO revenue (at, asset_atomic, usd_micros, gross_micros) VALUES (2, 1, 2000000, 2200000)");
  old.close();
  const balancesDb = new Database(BALANCES);
  const orders = openOrderStore(PENDING);
  expect(migrateRevenue(balancesDb, orders)).toEqual({ copied: 2, grossMicros: 3_300_000 });
  balancesDb.close();
  orders.db.close();
});

test("reconcileOutbox seeds one ACKED tombstone per applied_orders key (idempotent; no-op without the table)", () => {
  rm(BALANCES);
  rm(PENDING);
  const old = new Database(BALANCES);
  old.run("CREATE TABLE applied_orders (order_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  old.run("INSERT INTO applied_orders VALUES ('k1', 100), ('k2', 200)");
  old.close();
  const balancesDb = new Database(BALANCES);
  const orders = openOrderStore(PENDING);
  expect(reconcileOutbox(balancesDb, orders).seeded).toBe(2);
  expect(orders.listUnackedCredits()).toEqual([]); // tombstones are ACKED → the sender never delivers them
  expect(reconcileOutbox(balancesDb, orders).seeded).toBe(0); // idempotent (INSERT OR IGNORE)
  balancesDb.close();
  orders.db.close();

  rm(BALANCES); // a balances.db with no applied_orders table → clean no-op
  new Database(BALANCES).run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
  const bd2 = new Database(BALANCES);
  const o2 = openOrderStore(PENDING);
  expect(reconcileOutbox(bd2, o2).seeded).toBe(0);
  bd2.close();
  o2.db.close();
});

// F3 (the cutover double-book the audit flagged). A pre-cutover ZOMBIE — an order the old binary credited
// (applied_orders marker + revenue row + balance) but left OPEN by a crash before removeOrder — must not book a
// SECOND sale when the new poller re-scans it. reconcileOutbox's acked tombstone makes commitSettlement's
// fresh-guard treat the key as not-fresh. Without reconcileOutbox this booked 2 revenue rows for one sale.
test("F3 cutover: a pre-cutover zombie re-processed post-cutover does NOT double-book its sale", () => {
  rm(BALANCES);
  rm(PENDING);
  const KEY = "tx:7";
  const HASH = "z".repeat(64);
  const NOW = 1_700_000_000_000;
  const old = new Database(BALANCES);
  old.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
  old.run("CREATE TABLE applied_orders (order_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  old.run("CREATE TABLE revenue (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, asset TEXT NOT NULL DEFAULT 'monero', asset_atomic INTEGER NOT NULL, scale INTEGER NOT NULL DEFAULT 1000000000000, usd_micros INTEGER NOT NULL, gross_micros INTEGER NOT NULL DEFAULT 0)");
  old.run("INSERT INTO tokens VALUES (?, 5000000)", [HASH]); // already credited pre-cutover
  old.run("INSERT INTO applied_orders VALUES (?, ?)", [KEY, NOW]);
  old.run("INSERT INTO revenue (at, asset_atomic, usd_micros, gross_micros) VALUES (?, 1000000, 5000000, 0)", [NOW]);
  old.close();
  const orders = openOrderStore(PENDING);
  orders.tryAddOrder({ rail: "monero", order_index: 7, address: "a7", hash: HASH, expected_atomic: 1_000_000, credit_micros: 5_000_000, received_atomic: 0, created_at: NOW, rate_usd: 0 }, Number.MAX_SAFE_INTEGER); // the still-OPEN zombie

  const bdb = new Database(BALANCES);
  migrateRevenue(bdb, orders); // copies the zombie's sale (1 row)
  reconcileOutbox(bdb, orders); // seeds the acked tombstone for KEY — the F3 defense
  expect(orders.listRevenue()).toHaveLength(1);

  // the new poller re-scans the still-open zombie deposit:
  settle([{ orderIndex: 7, idempotencyKey: KEY, amount: 1_000_000, confirmations: 10, final: true }], orders, NOW, { scale: ATOMIC_PER_XMR, asset: "monero", rail: "monero", backstopMs: 9e15 });
  const balances = openDb(BALANCES);
  drainCreditOutbox(orders, balances, NOW);
  expect(orders.listRevenue()).toHaveLength(1); // NOT double-booked (was 2 before reconcileOutbox)
  expect(balances.getBalance(HASH)).toBe(5_000_000); // never double-credited (applied_orders guard)
  expect(orders.openOrders()).toHaveLength(0); // the zombie is closed
  bdb.close();
  orders.db.close();
  balances.db.close();
});

test("removeOrder returns false when no row matches (rail, order_index)", () => {
  const store = openOrderStore(":memory:");
  store.tryAddOrder({ rail: "monero", order_index: 1, address: "a1", hash: "h", expected_atomic: 1, credit_micros: 1, received_atomic: 0, created_at: 1, rate_usd: 0 }, Number.MAX_SAFE_INTEGER);
  expect(store.removeOrder(2, "monero")).toBe(false); // nonexistent index → nothing deleted
  expect(store.removeOrder(1, "bitcoin")).toBe(false); // right index, wrong rail → composite-PK miss
  expect(store.removeOrder(1, "monero")).toBe(true); // the real row
  store.db.close();
});

test("composite-PK migration chains onto the seam migration: a pre-seam DB ends rail='monero' and frees the index for the other rail", () => {
  rm(PENDING);
  const old = new Database(PENDING);
  old.run(
    `CREATE TABLE pending_orders (subaddr_index INTEGER PRIMARY KEY, hash TEXT NOT NULL, expected_atomic INTEGER NOT NULL, credit_micros INTEGER NOT NULL, received_atomic INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, rate_usd REAL NOT NULL DEFAULT 0)`,
  );
  old.run(`INSERT INTO pending_orders (subaddr_index, hash, expected_atomic, credit_micros, received_atomic, created_at, rate_usd) VALUES (7, 'h7', 100000, 50000, 0, 1000, 165)`);
  old.close();

  const store = openOrderStore(PENDING); // runs BOTH the seam migration AND the composite-PK rebuild
  const rows = store.openOrders();
  expect(rows.length).toBe(1); // the live order survived both migrations
  expect(rows[0]!.rail).toBe("monero"); // back-filled
  expect(rows[0]!.order_index).toBe(7);
  expect(rows[0]!.hash).toBe("h7");

  // the whole point: the SAME index on a different rail no longer collides on the PK
  expect(
    store.tryAddOrder({ rail: "bitcoin", order_index: 7, address: "bc1q7", hash: "hb7", expected_atomic: 1, credit_micros: 1, received_atomic: 0, created_at: 2000, rate_usd: 0 }, Number.MAX_SAFE_INTEGER),
  ).toBe(true);
  expect(store.openOrders().length).toBe(2);
  store.db.close();

  const again = openOrderStore(PENDING); // idempotent: table already has `rail` → no rebuild
  expect(again.openOrders().length).toBe(2);
  again.db.close();
});

test("composite key isolates rails: same index coexists, and removeOrder/openOrders/purgeStale only touch their own rail", () => {
  rm(PENDING);
  const store = openOrderStore(PENDING); // fresh DB → composite shape directly
  const mk = (rail: string, idx: number, createdAt: number) => ({ rail, order_index: idx, address: `${rail}${idx}`, hash: `h${rail}${idx}`, expected_atomic: 1, credit_micros: 1, received_atomic: 0, created_at: createdAt, rate_usd: 0 });
  expect(store.tryAddOrder(mk("monero", 5, 1000), Number.MAX_SAFE_INTEGER)).toBe(true);
  expect(store.tryAddOrder(mk("bitcoin", 5, 1000), Number.MAX_SAFE_INTEGER)).toBe(true); // same index, no PK collision
  expect(store.openOrders().length).toBe(2);
  expect(store.openOrders("monero").map((o) => o.address)).toEqual(["monero5"]); // rail-scoped read
  expect(store.openOrders("bitcoin").map((o) => o.address)).toEqual(["bitcoin5"]);

  // THE critical path: removeOrder defaults to monero (what settle calls today) and must NOT touch bitcoin-5:
  expect(store.removeOrder(5)).toBe(true);
  expect(store.openOrders("monero").length).toBe(0);
  expect(store.openOrders("bitcoin").length).toBe(1); // bitcoin-5 survived the monero delete

  // a rail-scoped purge reaps only its own rail:
  store.purgeStale(2000, "monero"); // nothing monero remains; bitcoin-5 (created 1000 < 2000) must stay
  expect(store.openOrders("bitcoin").length).toBe(1);
  store.purgeStale(2000, "bitcoin");
  expect(store.openOrders("bitcoin").length).toBe(0); // now reaped
  store.db.close();
});

test("a migrated pre-seam order still SETTLES: chain the migration, then credit it through a full settle cycle", () => {
  rm(PENDING);
  rm(BALANCES);
  const old = new Database(PENDING); // pre-seam in-flight order at subaddr_index 7, $5 credit, expecting 1e6 atomic
  old.run(
    `CREATE TABLE pending_orders (subaddr_index INTEGER PRIMARY KEY, hash TEXT NOT NULL, expected_atomic INTEGER NOT NULL, credit_micros INTEGER NOT NULL, received_atomic INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, rate_usd REAL NOT NULL DEFAULT 0)`,
  );
  old.run(`INSERT INTO pending_orders (subaddr_index, hash, expected_atomic, credit_micros, received_atomic, created_at, rate_usd) VALUES (7, 'hlive', 1000000, 5000000, 0, 1000, 150)`);
  old.close();

  const store = openOrderStore(PENDING); // runs the seam + composite migrations
  const balances = openDb(BALANCES);
  // a confirmed deposit to the migrated order's index settles (enqueues) on the monero rail; the sender delivers:
  settle([{ orderIndex: 7, idempotencyKey: "live:7", amount: 1000000, confirmations: 10, final: true }], store, 2000, { scale: 1_000_000_000_000, asset: "monero", rail: "monero", backstopMs: 9_999_999_999_999 });
  drainCreditOutbox(store, balances, 2000);
  expect(balances.getBalance("hlive")).toBe(5000000); // the migrated order credited correctly
  expect(store.openOrders().length).toBe(0); // and closed (pay-once)
  store.db.close();
  balances.db.close();
});

test("MAX_OPEN_ORDERS is a GLOBAL cap across rails: interleaved monero+bitcoin claims never overshoot", () => {
  rm(PENDING);
  const store = openOrderStore(PENDING);
  const mk = (rail: string, idx: number) => ({ rail, order_index: idx, address: `${rail}${idx}`, hash: `h${rail}${idx}`, expected_atomic: 1, credit_micros: 1, received_atomic: 0, created_at: 1, rate_usd: 0 });
  const cap = 3;
  expect(store.tryAddOrder(mk("monero", 0), cap)).toBe(true);
  expect(store.tryAddOrder(mk("bitcoin", 0), cap)).toBe(true); // same index, other rail → no PK clash
  expect(store.tryAddOrder(mk("monero", 1), cap)).toBe(true);
  expect(store.tryAddOrder(mk("bitcoin", 1), cap)).toBe(false); // count is 3, not < 3 → rejected (cap spans rails)
  expect(store.tryAddOrder(mk("monero", 2), cap)).toBe(false);
  expect(store.openCount()).toBe(3); // never overshot
  store.db.close();
});
