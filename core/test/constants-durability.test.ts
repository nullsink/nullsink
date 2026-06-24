// Two load-bearing invariants asserted nowhere else: the literal atomic scales (imported in lockstep
// everywhere, so a dropped zero hides), and the SQLite durability PRAGMAs (a silent drop from FULL to NORMAL
// can lose credited balances on power loss).
import { test, expect } from "bun:test";
import { ATOMIC_PER_XMR, SATS_PER_BTC } from "../src/rails/units";
import { openSqlite } from "../src/ledger/sqlite";

// units.ts:16-17 — golden-value the scales. Stryker doesn't mutate bare numeric literals, so nothing else
// catches a dropped/added zero here; every importer moves in lockstep with the wrong value.
test("atomic scales are exactly 1e12 (XMR) and 1e8 (BTC)", () => {
  expect(ATOMIC_PER_XMR).toBe(1_000_000_000_000);
  expect(SATS_PER_BTC).toBe(100_000_000);
});

// sqlite.ts:13-14 — assert the durability/concurrency PRAGMAs are actually applied. A StringLiteral→"" mutant
// makes a PRAGMA a silent no-op (db.run("") is a no-op), leaving synchronous at the default NORMAL — exactly
// the data-loss-on-power-loss regression the comment warns about.
test("openSqlite sets synchronous=FULL and busy_timeout=5000", () => {
  const db = openSqlite(":memory:");
  expect((db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(2); // 2 = FULL
  expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
  db.close();
});
