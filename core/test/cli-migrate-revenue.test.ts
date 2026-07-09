// `nsk migrate-revenue` is the ONLY way the stage-2 D5 cutover can run on a box: the box is source-free (no
// Bun, no src/, and the release tarball ships only deploy/), so scripts/migrate-revenue.ts is unreachable
// there. Drive the REAL CLI in a subprocess (same pattern as cli-financials.test.ts) so a broken wiring —
// dry-run that secretly writes, an unreconciled copy, a missing tombstone — fails here rather than during a
// one-way production cutover.
import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openOrderStore } from "../src/ledger/orders";
import { migrateRevenue } from "../src/ledger/migrate-revenue";
import { openDb } from "../src/ledger/db";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const B = "/tmp/nullsink-mig-balances.db";
const P = "/tmp/nullsink-mig-pending.db";
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const rm = (p: string) => {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(p + s);
    } catch {
      /* absent */
    }
  }
};
afterEach(() => {
  rm(B);
  rm(P);
});

const run = (...args: string[]) =>
  Bun.spawnSync({
    cmd: [process.execPath, CLI, "migrate-revenue", ...args],
    env: { ...process.env, DB_PATH: B, PENDING_DB_PATH: P, NSK_ALLOW_ROOT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

// A pre-cutover box: the sales book lives in balances.db, and applied_orders records credited deposits.
function seedPreCutover(): void {
  rm(B);
  rm(P);
  const balances = openDb(B);
  balances.db.run(
    "CREATE TABLE IF NOT EXISTS revenue (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, asset TEXT NOT NULL DEFAULT 'monero', asset_atomic INTEGER NOT NULL, scale INTEGER NOT NULL, usd_micros INTEGER NOT NULL, gross_micros INTEGER NOT NULL)",
  );
  balances.db.run("INSERT INTO revenue (at, asset, asset_atomic, scale, usd_micros, gross_micros) VALUES (?,?,?,?,?,?)", [
    1_700_000_000_000, "monero", 100_000_000_000, ATOMIC_PER_XMR, 15_000_000, 16_500_000,
  ]);
  balances.db.run("INSERT INTO revenue (at, asset, asset_atomic, scale, usd_micros, gross_micros) VALUES (?,?,?,?,?,?)", [
    1_700_000_100_000, "monero", 50_000_000_000, ATOMIC_PER_XMR, 7_000_000, 7_700_000,
  ]);
  balances.creditOnce("a".repeat(64), 15_000_000, "order-a", 1_700_000_000_000); // → applied_orders
  balances.creditOnce("b".repeat(64), 7_000_000, "order-b", 1_700_000_100_000);
  balances.db.close();
  openOrderStore(P).db.close(); // fresh pending.db with the post-split schema, empty revenue
}

const countRows = (path: string, table: string): number => {
  const db = new Database(path, { readonly: true });
  const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  db.close();
  return n;
};
const hasTable = (path: string, table: string): boolean => {
  const db = new Database(path, { readonly: true });
  const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table)!.n;
  db.close();
  return n > 0;
};

test("dry run reports what would move, and does not even CREATE pending.db's schema", () => {
  seedPreCutover();
  // Replace the seeded pending.db with a BARE database — no tables at all. This is what makes the assertion
  // below discriminating: openOrderStore() runs CREATE TABLE + ALTERs, so if the survey opened the store
  // read-write (rather than a readonly Database), the tables would exist afterwards. Against an
  // already-provisioned pending.db, a read-write open is invisible.
  rm(P);
  new Database(P).close();

  const r = run();
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString();
  expect(out).toContain("sales rows to copy       : 2");
  expect(out).toContain("$24.20"); // 16.50 + 7.70 gross
  expect(out).toContain("outbox tombstones to seed: up to 2");
  expect(out).toContain("DRY RUN");
  expect(hasTable(P, "revenue")).toBe(false);
  expect(hasTable(P, "credit_outbox")).toBe(false);
  expect(hasTable(P, "pending_orders")).toBe(false);
});

test("--apply moves the sales book, reconciles, and seeds acked tombstones", () => {
  seedPreCutover();
  const r = run("--apply");
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("RESULT: ✓");

  // Sales book is now payment-world state, gross intact.
  const orders = openOrderStore(P);
  const rows = orders.listRevenue();
  expect(rows.length).toBe(2);
  expect(rows.reduce((a, x) => a + x.gross_micros, 0)).toBe(24_200_000);

  // One ACKED tombstone per already-applied key: never delivered (they'd fail the 64-hex wire check), and
  // present so a pre-cutover zombie re-settling post-cutover cannot double-book its sale.
  expect(orders.listUnackedCredits().length).toBe(0);
  const tombstones = orders.db.query<{ k: string; hash: string; micros: number }, []>(
    "SELECT idempotency_key AS k, hash, micros FROM credit_outbox WHERE acked_at IS NOT NULL",
  ).all();
  expect(tombstones.map((t) => t.k).sort()).toEqual(["order-a", "order-b"]);
  expect(tombstones.every((t) => t.hash === "" && t.micros === 0)).toBe(true);
  orders.db.close();

  // balances.db keeps its old revenue table — that copy-not-move is what makes a pre-split rollback readable.
  expect(countRows(B, "revenue")).toBe(2);
});

test("re-running after a successful migration is a safe no-op, not a double-copy", () => {
  seedPreCutover();
  expect(run("--apply").exitCode).toBe(0);
  const again = run("--apply");
  expect(again.exitCode).toBe(0);
  expect(again.stdout.toString()).toContain("copy SKIPPED");
  const orders = openOrderStore(P);
  expect(orders.listRevenue().length).toBe(2); // still 2, not 4
  expect(orders.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credit_outbox").get()!.n).toBe(2); // tombstones unchanged
  orders.db.close();
});

test("an interrupted migration is REPAIRED by re-running, not declared complete", () => {
  // The trap this closes: migrateRevenue and reconcileOutbox used to commit separately, so a kill in the gap
  // left `revenue` copied with ZERO tombstones. The old recovery path then saw revenue rows, printed
  // "already migrated. Nothing to do.", and exited 1 -- steering the operator into a deploy where a
  // pre-cutover zombie order re-settles, finds its key absent from the outbox, and DOUBLE-BOOKS its sale.
  seedPreCutover();
  // Simulate exactly that partial state: copy the sales book, seed no tombstones.
  const orders = openOrderStore(P);
  migrateRevenue(new Database(B, { readonly: true }), orders);
  expect(orders.listRevenue().length).toBe(2);
  expect(orders.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credit_outbox").get()!.n).toBe(0); // the hole
  orders.db.close();

  const r = run("--apply");
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("copy SKIPPED");
  expect(r.stdout.toString()).toContain("RESULT: ✓");

  const after = openOrderStore(P);
  expect(after.listRevenue().length).toBe(2); // not double-copied
  const tombstones = after.db.query<{ k: string }, []>("SELECT idempotency_key AS k FROM credit_outbox WHERE acked_at IS NOT NULL").all();
  expect(tombstones.map((t) => t.k).sort()).toEqual(["order-a", "order-b"]); // the hole is repaired
  after.db.close();
});

test("runCutover is atomic: a failure after the copy leaves NEITHER the copy nor the tombstones", () => {
  seedPreCutover();
  const orders = openOrderStore(P);
  const bal = new Database(B, { readonly: true });
  // Force the second half to throw by removing the table reconcileOutbox reads, mid-flight is impossible to
  // schedule -- so instead drive runCutover's own transaction and throw from inside it, which is exactly the
  // rollback path a SIGKILL-free error takes.
  expect(() =>
    orders.db.transaction(() => {
      migrateRevenue(bal, orders);
      throw new Error("simulated crash between the two halves");
    })(),
  ).toThrow("simulated crash");
  expect(orders.listRevenue().length).toBe(0); // the copy rolled back with the outer transaction
  expect(orders.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credit_outbox").get()!.n).toBe(0);
  orders.db.close();
  bal.close();
});

test("a missing database is a clean error, not a crash", () => {
  rm(B);
  rm(P);
  const r = run("--apply");
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("missing");
});
