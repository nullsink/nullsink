import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBalances } from "../cli/live-db";
import { openDb } from "../src/ledger/db";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));

test("the read-only balance view is complete, sorted, and reconciled", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-live-balances-"));
  const path = join(dir, "balances.db");
  try {
    const store = openDb(path);
    store.credit("a".repeat(64), 3_000_000);
    store.credit("b".repeat(64), 1_000_000);
    store.credit("c".repeat(64), 2_000_000);
    store.db.close();

    expect(readBalances(path)).toEqual({
      rows: [
        { hash: "a".repeat(64), balance: 3_000_000 },
        { hash: "c".repeat(64), balance: 2_000_000 },
        { hash: "b".repeat(64), balance: 1_000_000 },
      ],
      tokens: 3,
      micros: 6_000_000n,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nsk balances JSON preserves full hashes and exact liability", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-nsk-balances-"));
  const path = join(dir, "balances.db");
  try {
    const store = openDb(path);
    store.credit("d".repeat(64), 3_405_787);
    store.db.close();

    const result = Bun.spawnSync({
      cmd: [process.execPath, CLI, "balances", "--format", "json"],
      env: { ...process.env, DB_PATH: path, NSK_ALLOW_ROOT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      balances: [{ hash: "d".repeat(64), usd_balance: "3.405787" }],
      totals: { tokens: 1, prepaid_usd: "3.405787" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
