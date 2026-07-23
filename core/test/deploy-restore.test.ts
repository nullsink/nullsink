// Exercise restore.sh's cross-database validation with real SQLite files + tar artifacts. Static deploy
// wiring tests pin important shell shapes, but only executing the dry-run catches semantic drift between the
// credit wire and the restore invariant (for example, zero is a valid delivered amount; negative is not).
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  return dryRunArtifact(artifact(rows));
}

function dryRunArtifact(path: string, env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: ["bash", RESTORE, path],
    env: { ...process.env, ...env },
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

test("restore rejects unexpected or duplicate archive members before extraction", () => {
  const unexpected = artifact([]);
  const unexpectedDir = dirname(unexpected);
  writeFileSync(join(unexpectedDir, "customer-history.csv"), "sensitive");
  const appendUnexpected = Bun.spawnSync({
    cmd: ["tar", "-C", unexpectedDir, "-rf", unexpected, "customer-history.csv"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(appendUnexpected.exitCode, appendUnexpected.stderr.toString()).toBe(0);
  const unexpectedResult = dryRunArtifact(unexpected);
  expect(unexpectedResult.exitCode).not.toBe(0);
  expect(unexpectedResult.stderr.toString()).toContain("unexpected archive member: customer-history.csv");

  const duplicate = artifact([]);
  const duplicateDir = dirname(duplicate);
  const appendDuplicate = Bun.spawnSync({
    cmd: ["tar", "-C", duplicateDir, "-rf", duplicate, "balances.db"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(appendDuplicate.exitCode, appendDuplicate.stderr.toString()).toBe(0);
  const duplicateResult = dryRunArtifact(duplicate);
  expect(duplicateResult.exitCode).not.toBe(0);
  expect(duplicateResult.stderr.toString()).toContain("duplicate archive member: balances.db");
});

test("restore rejects links and archive members over the configured size ceiling", () => {
  const regular = artifact([]);
  const dir = dirname(regular);
  rmSync(join(dir, "pending.db"));
  symlinkSync("balances.db", join(dir, "pending.db"));
  const linked = join(dir, "linked.tar");
  const packLinked = Bun.spawnSync({
    cmd: ["tar", "-C", dir, "-cf", linked, "balances.db", "pending.db"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packLinked.exitCode, packLinked.stderr.toString()).toBe(0);
  const linkedResult = dryRunArtifact(linked);
  expect(linkedResult.exitCode).not.toBe(0);
  expect(linkedResult.stderr.toString()).toContain("backup archive contains a non-regular member");

  const oversizedResult = dryRunArtifact(artifact([]), { RESTORE_MAX_MEMBER_BYTES: "1" });
  expect(oversizedResult.exitCode).not.toBe(0);
  expect(oversizedResult.stderr.toString()).toContain("exceeds RESTORE_MAX_MEMBER_BYTES");
});
