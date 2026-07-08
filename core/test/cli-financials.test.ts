// `nsk financials` became a TWO-DB command with the D5 revenue move: the sales journal comes from pending.db
// (listRevenue) and the outstanding-credit liability from balances.db (liabilityTotal). Drive the REAL CLI in a
// subprocess (same pattern as guard.test.ts) so a DB swap — reading `revenue` from balances.db, where the table
// no longer exists — would surface as a "no such table" crash here rather than silently in prod.
import { test, expect, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openOrderStore } from "../src/ledger/orders";
import { openDb } from "../src/ledger/db";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const B = "/tmp/nullsink-fin-balances.db";
const P = "/tmp/nullsink-fin-pending.db";
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

test("nsk financials reads the sales journal from pending.db and the liability from balances.db", () => {
  rm(B);
  rm(P);
  // a $16.50-gross monero sale in pending.db; a separate $40 token balance in balances.db.
  const orders = openOrderStore(P);
  orders.recordRevenue(1_700_000_000_000, "monero", 100_000_000_000, ATOMIC_PER_XMR, 15_000_000, 16_500_000);
  orders.db.close();
  const balances = openDb(B);
  balances.credit("h".repeat(64), 40_000_000);
  balances.db.close();

  const r = Bun.spawnSync({
    cmd: [process.execPath, CLI, "financials", "--format", "json"],
    env: { ...process.env, DB_PATH: B, PENDING_DB_PATH: P, NSK_ALLOW_ROOT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode).toBe(0); // no "no such table" crash from a mis-wired DB
  const out = JSON.parse(r.stdout.toString());
  expect(out.totals.sales).toBe(1); // the sale — from pending.db
  expect(out.totals.gross_usd).toBe("16.500000"); // gross — from the pending.db revenue row
  expect(out.outstanding.prepaid_usd).toBe("40.000000"); // liability — from balances.db (a different store)
});
