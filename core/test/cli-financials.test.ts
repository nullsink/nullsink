import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const BALANCES = "/tmp/nullsink-fin-balances.db";
const PENDING = "/tmp/nullsink-fin-pending.db";
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));

function removeDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // absent
    }
  }
}

afterEach(() => {
  removeDb(BALANCES);
  removeDb(PENDING);
});

test("nsk financials reads exact live sales and liability from their owning databases", () => {
  removeDb(BALANCES);
  removeDb(PENDING);
  const orders = openOrderStore(PENDING);
  orders.recordRevenue(
    1_700_000_000_000,
    "monero",
    100_000_000_000,
    ATOMIC_PER_XMR,
    15_000_000,
    16_500_000,
  );
  orders.db.close();
  const balances = openDb(BALANCES);
  balances.credit("h".repeat(64), 40_000_000);
  balances.db.close();
  for (const path of [BALANCES, PENDING]) {
    chmodSync(path, 0o440);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o440);
  }

  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, "financials", "--format", "json"],
    env: { ...process.env, BALANCES_DB_PATH: BALANCES, PENDING_DB_PATH: PENDING, NSK_ALLOW_ROOT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  expect(output.sales).toEqual([
    {
      date: "2023-11-14T22:13:20.000Z",
      asset: "monero",
      coin: "0.100000000000",
      usd_credited: "15.000000",
      usd_gross: "16.500000",
    },
  ]);
  expect(output.totals).toMatchObject({ sales: 1, credit_usd: "15.000000", gross_usd: "16.500000" });
  expect(output.outstanding).toEqual({ tokens: 1, prepaid_usd: "40.000000" });
  for (const path of [BALANCES, PENDING]) {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o222).toBe(0);
    }
  }
});
