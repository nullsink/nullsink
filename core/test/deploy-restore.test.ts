// Exercise restore.sh's cross-database validation with real SQLite files + tar artifacts. Static deploy
// wiring tests pin important shell shapes, but only executing the dry-run catches semantic drift between the
// credit wire and the restore invariant (for example, zero is a valid delivered amount; negative is not).
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RESTORE = fileURLToPath(new URL("../deploy/restore.sh", import.meta.url));
const HASH = "a".repeat(64);
const workdirs: string[] = [];

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type OutboxRow = {
  key: string;
  hash: string;
  micros: number;
  ackedAt: number | null;
};

function artifact(rows: OutboxRow[]): string {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-test-"));
  workdirs.push(dir);

  const pending = new Database(join(dir, "pending.db"));
  pending.run(`CREATE TABLE credit_outbox (
    idempotency_key TEXT PRIMARY KEY,
    hash            TEXT NOT NULL,
    micros          INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    acked_at        INTEGER
  )`);
  const insert = pending.prepare(
    "INSERT INTO credit_outbox (idempotency_key, hash, micros, created_at, acked_at) VALUES (?, ?, ?, 100, ?)",
  );
  for (const row of rows) insert.run(row.key, row.hash, row.micros, row.ackedAt);
  pending.close();

  const balances = new Database(join(dir, "balances.db"));
  balances.run(`CREATE TABLE applied_orders (
    order_id   TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  balances.close();

  const tar = join(dir, "backup.tar");
  const packed = Bun.spawnSync({
    cmd: ["tar", "-C", dir, "-cf", tar, "pending.db", "balances.db"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode, packed.stderr.toString()).toBe(0);
  return tar;
}

function dryRun(rows: OutboxRow[]) {
  return Bun.spawnSync({
    cmd: ["bash", RESTORE, artifact(rows)],
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("restore accepts zero-credit payloads while unacknowledged or legacy-acknowledged", () => {
  const result = dryRun([
    { key: "unacked-zero", hash: HASH, micros: 0, ackedAt: null },
    { key: "legacy-acked-zero", hash: HASH, micros: 0, ackedAt: 200 },
  ]);
  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode, output).toBe(0);
  expect(output).toContain("dry-run OK");
});

test("restore still rejects negative-credit payloads", () => {
  const result = dryRun([{ key: "negative", hash: HASH, micros: -1, ackedAt: null }]);
  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("poison or partially scrubbed credit-outbox row");
});
