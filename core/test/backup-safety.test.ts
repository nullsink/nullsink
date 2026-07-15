import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../deploy/backup-safety.sh", import.meta.url));
const BACKUP = fileURLToPath(new URL("../deploy/backup.sh", import.meta.url));

const ORDER_HARNESS = String.raw`
set -euo pipefail
source "$1"
work="$(mktemp -d)"; snapshots="$(mktemp -d)"; trap 'rm -rf "$work" "$snapshots"' EXIT
touch "$work/pending.db" "$work/balances.db"
sqlite3() {
  if [ "$1" = -cmd ]; then
    base="$(basename "$3")"
    touch "$snapshots/$base"
    printf '%s\n' "$base"
  else
    printf '1\n'
  fi
}
backup_snapshot_databases "$work" "$snapshots"
printf 'FILES:%s\n' "${"${files[*]}"}"
`;

test("backup snapshots pending.db before balances.db and archives them in the same order", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", ORDER_HARNESS, "harness", LIB],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toBe("pending.db\nbalances.db\nFILES:pending.db balances.db\n");
});

test("backup refuses a missing balance ledger instead of letting sqlite create an empty source", () => {
  expect(Bun.which("sqlite3"), "backup contract tests require sqlite3").not.toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-missing-"));
  try {
    const live = join(dir, "live");
    const snapshots = join(dir, "snapshots");
    mkdirSync(live);
    mkdirSync(snapshots);
    const pending = new Database(join(live, "pending.db"), { create: true });
    pending.run("CREATE TABLE pending_orders (rail TEXT, order_index INTEGER)");
    pending.close();
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", 'source "$1"; backup_snapshot_databases "$2" "$3"', "harness", LIB, live, snapshots],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("balances.db is missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup refuses a missing payment ledger instead of blessing a balances-only artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-missing-pending-"));
  try {
    const live = join(dir, "live");
    const snapshots = join(dir, "snapshots");
    mkdirSync(live);
    mkdirSync(snapshots);
    const balances = new Database(join(live, "balances.db"), { create: true });
    balances.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
    balances.close();
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", 'source "$1"; backup_snapshot_databases "$2" "$3"', "harness", LIB, live, snapshots],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("pending.db is missing");
    expect(existsSync(join(snapshots, "balances.db"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup refuses wrong schemas and validates the snapshot schema", () => {
  expect(Bun.which("sqlite3"), "backup contract tests require sqlite3").not.toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-schema-"));
  try {
    const live = join(dir, "live");
    const snapshots = join(dir, "snapshots");
    mkdirSync(live);
    mkdirSync(snapshots);
    const pending = new Database(join(live, "pending.db"), { create: true });
    pending.run("CREATE TABLE pending_orders (rail TEXT, order_index INTEGER)");
    pending.close();
    const balances = new Database(join(live, "balances.db"), { create: true });
    balances.run("CREATE TABLE wrong (value INTEGER)");
    balances.close();
    let result = Bun.spawnSync({
      cmd: ["bash", "-c", 'source "$1"; backup_snapshot_databases "$2" "$3"', "harness", LIB, live, snapshots],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("required table 'tokens'");

    const repaired = new Database(join(live, "balances.db"));
    repaired.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
    repaired.close();
    result = Bun.spawnSync({
      cmd: ["bash", "-c", 'source "$1"; backup_snapshot_databases "$2" "$3"', "harness", LIB, live, snapshots],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a completed backup is validated, file-synced, atomically renamed, then directory-synced", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-publish-"));
  try {
    const payload = join(dir, "payload");
    const candidate = join(dir, ".backup.tar.partial");
    const artifact = join(dir, "backup-20260714T000000Z.tar");
    mkdirSync(payload);
    writeFileSync(join(payload, "balances.db"), "ledger");
    const archive = Bun.spawnSync({
      cmd: ["tar", "-C", payload, "-cf", candidate, "balances.db"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(archive.exitCode, archive.stderr.toString()).toBe(0);
    chmodSync(candidate, 0o666);

    const harness = String.raw`
set -euo pipefail
source "$1"
sync() { printf 'SYNC:%s\n' "${"${!#}"}"; }
mv() { printf 'RENAME\n'; command mv "$@"; }
backup_publish_candidate "$2" "$3" tar
`;
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", harness, "publish", LIB, candidate, artifact],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      `SYNC:${candidate}`,
      "RENAME",
      `SYNC:${dir}`,
    ]);
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(artifact)).toBe(true);
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ["empty", ""],
  ["invalid", "not a tar archive"],
])("an %s candidate is never given a freshness-visible final name", (_label, contents) => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-invalid-"));
  try {
    const candidate = join(dir, ".backup.tar.partial");
    const artifact = join(dir, "backup-20260714T000000Z.tar");
    writeFileSync(candidate, contents);
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; backup_publish_candidate "$2" "$3" tar',
        "publish",
        LIB,
        candidate,
        artifact,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(artifact)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file-fsync failure happens before rename and leaves no final artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-fsync-"));
  try {
    const payload = join(dir, "payload");
    const candidate = join(dir, ".backup.tar.partial");
    const artifact = join(dir, "backup-20260714T000000Z.tar");
    mkdirSync(payload);
    writeFileSync(join(payload, "pending.db"), "ledger");
    const archive = Bun.spawnSync({
      cmd: ["tar", "-C", payload, "-cf", candidate, "pending.db"],
      stderr: "pipe",
    });
    expect(archive.exitCode, archive.stderr.toString()).toBe(0);
    const harness = String.raw`
source "$1"
sync() { return 70; }
backup_publish_candidate "$2" "$3" tar
`;
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", harness, "publish", LIB, candidate, artifact],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(candidate)).toBe(true);
    expect(existsSync(artifact)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a same-second final-name collision never overwrites the completed artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-collision-"));
  try {
    const payload = join(dir, "payload");
    const candidate = join(dir, ".backup.tar.partial");
    const artifact = join(dir, "backup-20260714T000000Z.tar");
    mkdirSync(payload);
    writeFileSync(join(payload, "pending.db"), "new-ledger");
    const archive = Bun.spawnSync({
      cmd: ["tar", "-C", payload, "-cf", candidate, "pending.db"],
      stderr: "pipe",
    });
    expect(archive.exitCode, archive.stderr.toString()).toBe(0);
    writeFileSync(artifact, "FIRST-COMPLETE-BACKUP");
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; backup_publish_candidate "$2" "$3" tar',
        "publish",
        LIB,
        candidate,
        artifact,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(artifact, "utf8")).toBe("FIRST-COMPLETE-BACKUP");
    expect(existsSync(candidate)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup.sh holds the shared restore lock and exposes only dot-prefixed candidates before publish", () => {
  const backup = readFileSync(BACKUP, "utf8");
  const runLock = backup.indexOf('acquire_backup_run_lock "$BACKUP_DIR"');
  const lock = backup.indexOf('acquire_ledger_shared_lock "$DB_DIR" "ledger backup"');
  const stamp = backup.indexOf('STAMP="$(date -u');
  const snapshot = backup.indexOf('backup_snapshot_databases "$DB_DIR" "$work"');
  const hiddenCandidate = backup.indexOf('mktemp "$BACKUP_DIR/.backup-$STAMP');
  const publish = backup.indexOf('backup_publish_candidate "$artifact_tmp"');
  const success = backup.indexOf('echo "backup: $artifact');
  expect(runLock).toBeGreaterThan(-1);
  expect(lock).toBeGreaterThan(runLock);
  expect(stamp).toBeGreaterThan(lock);
  expect(lock).toBeLessThan(snapshot);
  expect(hiddenCandidate).toBeGreaterThan(snapshot);
  expect(publish).toBeGreaterThan(hiddenCandidate);
  expect(success).toBeGreaterThan(publish);
  expect(backup).not.toContain('-o "$artifact"');
  expect(backup).not.toContain('cp "$work/backup.tar" "$artifact"');
});

const PUSH_HARNESS = String.raw`
set -euo pipefail
source "$1"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
plain="$work/backup.tar"; encrypted="$work/backup.tar.age"
touch "$plain" "$encrypted"
push='printf pushed > "$ARTIFACT.pushed"'
if backup_push_artifact "$plain" "$push"; then echo PLAIN:UNSAFE; else echo PLAIN:BLOCKED; fi
if [ -e "$plain.pushed" ]; then echo PLAIN:EXECUTED; else echo PLAIN:NOT_EXECUTED; fi
backup_push_artifact "$encrypted" "$push"
if [ -e "$encrypted.pushed" ]; then echo ENCRYPTED:EXECUTED; else echo ENCRYPTED:FAILED; fi
`;

test("off-box push refuses plaintext before executing the operator command", () => {
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", PUSH_HARNESS, "harness", LIB],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toContain("refusing to push an UNENCRYPTED artifact off-box");
  expect(result.stdout.toString()).toContain("PLAIN:BLOCKED\nPLAIN:NOT_EXECUTED");
  expect(result.stdout.toString()).toContain("push: shipping backup.tar.age off-box\nENCRYPTED:EXECUTED");
});
