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

test("revenue migrates xmr_atomic -> asset_atomic (+ asset/scale); balances + sales journal preserved", () => {
  rm(BALANCES);
  const old = new Database(BALANCES);
  old.run(`CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)`);
  old.run(`CREATE TABLE applied_orders (order_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  old.run(`CREATE TABLE revenue (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, xmr_atomic INTEGER NOT NULL, usd_micros INTEGER NOT NULL, gross_micros INTEGER NOT NULL DEFAULT 0)`);
  old.run(`INSERT INTO tokens (hash, balance) VALUES ('aa', 7500000)`); // a real XMR-user balance
  old.run(`INSERT INTO revenue (at, xmr_atomic, usd_micros, gross_micros) VALUES (1000, 50000000000, 7500000, 8250000)`);
  old.close();

  const db = openDb(BALANCES); // opening runs the migration
  expect(db.getBalance("aa")).toBe(7500000); // balance untouched (tokens is schema-unchanged)
  expect(db.listRevenue()).toEqual([
    // the historical Monero sale reads correctly through the new columns
    { at: 1000, asset: "monero", asset_atomic: 50000000000, scale: 1000000000000, usd_micros: 7500000, gross_micros: 8250000 },
  ]);
  db.db.close();

  const again = openDb(BALANCES); // idempotent
  expect(again.listRevenue()).toHaveLength(1);
  again.db.close();
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
  // a confirmed deposit to the migrated order's index settles + credits it on the monero rail:
  settle([{ orderIndex: 7, idempotencyKey: "live:7", amount: 1000000, confirmations: 10, final: true }], store, balances, 2000, { scale: 1_000_000_000_000, asset: "monero", rail: "monero", backstopMs: 9_999_999_999_999 });
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
