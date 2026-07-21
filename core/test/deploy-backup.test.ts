// Execute the production backup path against real SQLite files. These tests pin the Step 2 boundary that
// static shell-shape assertions cannot: only a validated pair gets a final artifact name, routine reports are
// aggregate-only, and a report failure does not erase a usable recovery artifact.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKUP = fileURLToPath(new URL("../deploy/backup.sh", import.meta.url));
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const ADDRESS = "bc1q-private-open-order-address";
const ORDER_ID = "private-payment-txid:7";
const workdirs: string[] = [];

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { root: string; db: string; backups: string; bin: string; ageMarker: string } {
  const root = mkdtempSync(join(tmpdir(), "nullsink-backup-test-"));
  workdirs.push(root);
  const db = join(root, "db");
  const backups = join(root, "backups");
  const bin = join(root, "bin");
  mkdirSync(db);
  mkdirSync(backups);
  mkdirSync(bin);
  const ageMarker = join(root, "age-called");
  const fakeAge = join(bin, "age");
  writeFileSync(fakeAge, '#!/bin/sh\n[ -z "${FAKE_AGE_MARKER:-}" ] || : > "$FAKE_AGE_MARKER"\ncp "$5" "$4"\n');
  chmodSync(fakeAge, 0o755);
  return { root, db, backups, bin, ageMarker };
}

function seedDatabases(dbDir: string, options: { tokensTable?: boolean; missingTombstoneMarker?: boolean } = {}): void {
  const balances = new Database(join(dbDir, "balances.db"));
  if (options.tokensTable !== false) {
    balances.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
    balances.run("INSERT INTO tokens VALUES (?, ?), (?, ?)", [HASH, 7_500_000, OTHER_HASH, 2_500_000]);
  }
  balances.run("CREATE TABLE applied_orders (order_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  if (!options.missingTombstoneMarker) balances.run("INSERT INTO applied_orders VALUES ('delivered-order', 1000)");
  balances.close();

  const pending = new Database(join(dbDir, "pending.db"));
  pending.run(`CREATE TABLE pending_orders (
    rail TEXT NOT NULL, order_index INTEGER NOT NULL, address TEXT NOT NULL, hash TEXT NOT NULL,
    expected_atomic INTEGER NOT NULL, credit_micros INTEGER NOT NULL, received_atomic INTEGER NOT NULL,
    created_at INTEGER NOT NULL, rate_usd REAL NOT NULL, seen_at INTEGER,
    PRIMARY KEY (rail, order_index)
  )`);
  pending.run("INSERT INTO pending_orders VALUES ('bitcoin', 7, ?, ?, 1000, 20000000, 0, 1000, 1, 2000)", [ADDRESS, HASH]);
  pending.run(`CREATE TABLE credit_outbox (
    idempotency_key TEXT PRIMARY KEY, hash TEXT NOT NULL, micros INTEGER NOT NULL,
    created_at INTEGER NOT NULL, acked_at INTEGER
  )`);
  pending.run("INSERT INTO credit_outbox VALUES (?, ?, 10000000, 3000, NULL)", [ORDER_ID, HASH]);
  pending.run("INSERT INTO credit_outbox VALUES ('delivered-order', '', 0, 500, 1000)");
  pending.run(`CREATE TABLE revenue (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, asset TEXT NOT NULL, asset_atomic INTEGER NOT NULL,
    scale INTEGER NOT NULL, usd_micros INTEGER NOT NULL, gross_micros INTEGER NOT NULL
  )`);
  pending.run("INSERT INTO revenue VALUES (1, 1784505600000, 'monero', 1, 1000000000000, 10000000, 11000000)");
  pending.run("INSERT INTO revenue VALUES (2, 1784509200000, 'monero', 2, 1000000000000, 5000000, 5500000)");
  pending.run("INSERT INTO revenue VALUES (3, 1784505600000, 'bitcoin', 3, 100000000, 20000000, 22000000)");
  pending.close();
}

function runBackup(env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["bash", BACKUP],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("backup publishes a validated encrypted artifact and an aggregate-only report", () => {
  const w = workspace();
  seedDatabases(w.db);
  const oldArtifact = join(w.backups, "backup-20000101T000000Z.tar.age");
  const oldReport = join(w.backups, "report-20000101T000000Z.json");
  writeFileSync(oldArtifact, "old");
  writeFileSync(oldReport, "old");

  const result = runBackup({
    PATH: `${w.bin}:${process.env.PATH}`,
    DB_DIR: w.db,
    BACKUP_DIR: w.backups,
    BACKUP_KEEP: "1",
    BACKUP_AGE_RECIPIENT: "age1test",
    FAKE_AGE_MARKER: w.ageMarker,
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);

  const names = readdirSync(w.backups).sort();
  const artifactName = names.find((name) => /^backup-.*\.tar\.age$/.test(name));
  const reportName = names.find((name) => /^report-.*\.json$/.test(name));
  expect(artifactName).toBeDefined();
  expect(reportName).toBeDefined();
  expect(names.some((name) => name.includes(".partial."))).toBe(false);
  expect(names).not.toContain("backup-20000101T000000Z.tar.age");
  expect(names).not.toContain("report-20000101T000000Z.json");
  expect(statSync(join(w.backups, artifactName!)).mode & 0o777).toBe(0o600);
  expect(statSync(join(w.backups, reportName!)).mode & 0o777).toBe(0o600);

  const raw = readFileSync(join(w.backups, reportName!), "utf8");
  const report = JSON.parse(raw);
  expect(Object.keys(report)).toEqual(["schema_version", "snapshot", "finance", "operations"]);
  expect(report.schema_version).toBe(1);
  expect(report.snapshot.artifact).toBe(artifactName);
  expect(report.snapshot.validation).toBe("restore-dry-run-ok");
  expect(report.finance.liability).toEqual({ outstanding_micros: "10000000" });
  expect(report.finance.revenue_by_day_asset).toEqual([
    { date: "2026-07-20", asset: "bitcoin", sales: 1, credited_micros: "20000000", gross_micros: "22000000" },
    { date: "2026-07-20", asset: "monero", sales: 2, credited_micros: "15000000", gross_micros: "16500000" },
  ]);
  expect(report.operations.open_orders).toEqual({ count: 1, credit_micros: "20000000", payment_seen: 1 });
  expect(report.operations.undelivered_credits.count).toBe(1);
  expect(report.operations.undelivered_credits.micros).toBe("10000000");
  expect(report.operations.undelivered_credits.oldest_age_seconds).toBeGreaterThan(0);

  for (const forbidden of [HASH, OTHER_HASH, ADDRESS, ORDER_ID, "delivered-order"]) expect(raw).not.toContain(forbidden);
});

test("backup validates the matched pair before invoking encryption or publishing a final name", () => {
  const w = workspace();
  seedDatabases(w.db, { missingTombstoneMarker: true });

  const result = runBackup({
    PATH: `${w.bin}:${process.env.PATH}`,
    DB_DIR: w.db,
    BACKUP_DIR: w.backups,
    BACKUP_AGE_RECIPIENT: "age1test",
    FAKE_AGE_MARKER: w.ageMarker,
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("scrubbed credit tombstone(s) have no matching ledger marker");
  expect(readdirSync(w.backups)).toEqual([]);
});

test("a report-schema failure leaves the already validated recovery artifact intact", () => {
  const w = workspace();
  seedDatabases(w.db, { tokensTable: false });

  const result = runBackup({
    PATH: `${w.bin}:${process.env.PATH}`,
    DB_DIR: w.db,
    BACKUP_DIR: w.backups,
    BACKUP_AGE_RECIPIENT: "age1test",
    FAKE_AGE_MARKER: w.ageMarker,
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("no such table: tokens");
  expect(readdirSync(w.backups).filter((name) => /^backup-.*\.tar\.age$/.test(name))).toHaveLength(1);
  expect(readdirSync(w.backups).filter((name) => /^report-.*\.json$/.test(name))).toHaveLength(0);
});

test("a provider-only box without pending.db still emits a valid liability report", () => {
  const w = workspace();
  seedDatabases(w.db);
  rmSync(join(w.db, "pending.db"));

  const result = runBackup({
    PATH: `${w.bin}:${process.env.PATH}`,
    DB_DIR: w.db,
    BACKUP_DIR: w.backups,
    BACKUP_AGE_RECIPIENT: "age1test",
    FAKE_AGE_MARKER: w.ageMarker,
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  const reportName = readdirSync(w.backups).find((name) => /^report-.*\.json$/.test(name));
  const report = JSON.parse(readFileSync(join(w.backups, reportName!), "utf8"));
  expect(report.finance.revenue_by_day_asset).toEqual([]);
  expect(report.finance.liability).toEqual({ outstanding_micros: "10000000" });
  expect(report.operations.open_orders).toEqual({ count: 0, credit_micros: "0", payment_seen: 0 });
  expect(report.operations.undelivered_credits).toEqual({ count: 0, micros: "0", oldest_age_seconds: null });
});
