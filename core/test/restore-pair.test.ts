// A restore dry-run is a money-safety promise, not just a SQLite checksum. Once an acknowledged outbox row
// has erased its hash/amount, the paired applied_orders marker is the only proof that credit landed. Drive
// the real restore script against tiny artifacts so an inconsistent pair is rejected before --apply.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RESTORE = fileURLToPath(new URL("../deploy/restore.sh", import.meta.url));
const RESTORE_LIB = fileURLToPath(new URL("../deploy/restore-swap.sh", import.meta.url));

function archive(dir: string, artifact: string): void {
  const result = Bun.spawnSync({
    cmd: ["tar", "-C", dir, "-cf", artifact, "balances.db", "pending.db"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function dryRun(artifact: string) {
  return Bun.spawnSync({ cmd: ["bash", RESTORE, artifact], stdout: "pipe", stderr: "pipe" });
}

test("dry-run rejects a tombstone without its applied marker, even if applied_orders contains NULL", () => {
  expect(Bun.which("sqlite3"), "restore contract tests require sqlite3").not.toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-pair-"));
  try {
    const balancesPath = join(dir, "balances.db");
    const pendingPath = join(dir, "pending.db");
    const artifact = join(dir, "backup.tar");

    const balances = new Database(balancesPath, { create: true });
    balances.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
    balances.run("CREATE TABLE applied_orders (order_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    // SQLite permits NULL in a rowid-table TEXT PRIMARY KEY. NOT IN would let this single legacy row hide
    // every missing marker; the restore query deliberately uses correlated NOT EXISTS instead.
    balances.run("INSERT INTO applied_orders (order_id, applied_at) VALUES (NULL, 1)");
    balances.close();

    const pending = new Database(pendingPath, { create: true });
    pending.run("CREATE TABLE pending_orders (rail TEXT, order_index INTEGER)");
    pending.run(`CREATE TABLE credit_outbox (
      idempotency_key TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      micros INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      acked_at INTEGER
    )`);
    pending.run("INSERT INTO credit_outbox VALUES ('missing', '', 0, 1, 2)");
    pending.close();

    archive(dir, artifact);
    let result = dryRun(artifact);
    let output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("pair check FAILED (backup artifact)");
    expect(output).not.toContain("dry-run OK");

    const repaired = new Database(balancesPath);
    repaired.run("INSERT INTO applied_orders (order_id, applied_at) VALUES ('missing', 2)");
    repaired.close();
    archive(dir, artifact);
    result = dryRun(artifact);
    output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("dry-run OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run rejects an integrity-valid artifact with the wrong ledger schema", () => {
  expect(Bun.which("sqlite3"), "restore contract tests require sqlite3").not.toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-schema-"));
  try {
    const balancesPath = join(dir, "balances.db");
    const pendingPath = join(dir, "pending.db");
    const artifact = join(dir, "backup.tar");
    const balances = new Database(balancesPath, { create: true });
    balances.run("CREATE TABLE not_tokens (value INTEGER)");
    balances.close();
    const pending = new Database(pendingPath, { create: true });
    pending.run("CREATE TABLE pending_orders (rail TEXT, order_index INTEGER)");
    pending.close();
    archive(dir, artifact);
    const result = dryRun(artifact);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("required table 'tokens'");
    expect(output).not.toContain("dry-run OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply preflight refuses a balances-only artifact over a live pending database", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-target-"));
  try {
    const extracted = join(dir, "extracted");
    const live = join(dir, "live");
    mkdirSync(extracted);
    mkdirSync(live);
    writeFileSync(join(extracted, "balances.db"), "snapshot");
    writeFileSync(join(live, "pending.db"), "live payment state");

    const run = () =>
      Bun.spawnSync({
        cmd: ["bash", "-c", 'source "$1"; restore_require_matched_pair "$2" "$3"', "harness", RESTORE_LIB, extracted, live],
        stdout: "pipe",
        stderr: "pipe",
      });
    let result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("refusing a balances-only artifact while live pending.db exists");

    writeFileSync(join(extracted, "pending.db"), "paired snapshot");
    result = run();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore re-arms only retained legacy payloads absent from the restored ledger", () => {
  expect(Bun.which("sqlite3"), "restore contract tests require sqlite3").not.toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-rearm-"));
  try {
    const balancesPath = join(dir, "balances.db");
    const pendingPath = join(dir, "pending.db");
    const balances = new Database(balancesPath, { create: true });
    balances.run("CREATE TABLE applied_orders (order_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    balances.run("INSERT INTO applied_orders VALUES ('already-applied', 1), ('tombstone', 1)");
    balances.close();

    const pending = new Database(pendingPath, { create: true });
    pending.run(`CREATE TABLE credit_outbox (
      idempotency_key TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      micros INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      acked_at INTEGER
    )`);
    pending.run("INSERT INTO credit_outbox VALUES ('missing', ?, 5, 1, 10)", ["a".repeat(64)]);
    pending.run("INSERT INTO credit_outbox VALUES ('already-applied', ?, 7, 1, 10)", ["b".repeat(64)]);
    pending.run("INSERT INTO credit_outbox VALUES ('tombstone', '', 0, 1, 10)");
    pending.close();

    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; sqlite3 "$2" "$(restore_legacy_rearm_sql "$3")"',
        "harness",
        RESTORE_LIB,
        pendingPath,
        balancesPath,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("1");

    const restored = new Database(pendingPath);
    const rows = restored
      .query<{ idempotency_key: string; hash: string; micros: number; acked_at: number | null }, []>(
        "SELECT idempotency_key, hash, micros, acked_at FROM credit_outbox ORDER BY idempotency_key",
      )
      .all();
    restored.close();
    expect(rows).toEqual([
      { idempotency_key: "already-applied", hash: "b".repeat(64), micros: 7, acked_at: 10 },
      { idempotency_key: "missing", hash: "a".repeat(64), micros: 5, acked_at: null },
      { idempotency_key: "tombstone", hash: "", micros: 0, acked_at: 10 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed post-swap schema probe is an error, never table-absent", () => {
  const harness = String.raw`
set -euo pipefail
source "$1"
permission_denied() { echo "sqlite: permission denied" >&2; return 77; }
if ! value="$(restore_probe_table permission_denied /tmp/pending.db credit_outbox)"; then
  echo "SERVICES:STOPPED"
  exit 1
fi
echo "SERVICES:RESTARTED:$value"
`;
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", harness, "harness", RESTORE_LIB],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("SERVICES:STOPPED\n");
  expect(result.stdout.toString()).not.toContain("RESTARTED");
  expect(result.stderr.toString()).toContain("restore schema probe FAILED for pending.db/credit_outbox");
  expect(result.stderr.toString()).toContain("permission denied");
});
