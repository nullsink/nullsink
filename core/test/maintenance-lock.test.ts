import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK = fileURLToPath(new URL("../deploy/maintenance-lock.sh", import.meta.url));
const DEPLOY = fileURLToPath(new URL("../deploy/deploy.sh", import.meta.url));
const SETUP = fileURLToPath(new URL("../deploy/setup.sh", import.meta.url));
const RESTORE = fileURLToPath(new URL("../deploy/restore.sh", import.meta.url));
const BACKUP = fileURLToPath(new URL("../deploy/backup.sh", import.meta.url));
const flockTest = Bun.which("flock") ? test : test.skip;

flockTest("the host-wide lock rejects a concurrent maintenance process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-maint-lock-"));
  const lockPath = join(dir, "maintenance.lock");
  const guardPath = join(dir, "restore.guard");
  const ready = join(dir, "ready");
  const env = { ...process.env, NULLSINK_MAINTENANCE_LOCK: lockPath, NULLSINK_RESTORE_GUARD: guardPath };
  const holder = Bun.spawn({
    cmd: [
      "bash",
      "-c",
      'source "$1"; acquire_maintenance_lock holder; : > "$2"; sleep 10',
      "holder",
      LOCK,
      ready,
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);
    const contender = Bun.spawnSync({
      cmd: ["bash", "-c", 'source "$1"; acquire_maintenance_lock contender', "contender", LOCK],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(contender.exitCode).not.toBe(0);
    expect(contender.stderr.toString()).toContain("another nullsink maintenance operation is active");
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

flockTest("the backup run lock rejects a concurrent same-directory publisher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-run-lock-"));
  const ready = join(dir, "ready");
  const holder = Bun.spawn({
    cmd: [
      "bash",
      "-c",
      'source "$1"; acquire_backup_run_lock "$2"; : > "$3"; sleep 10',
      "backup",
      LOCK,
      dir,
      ready,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);
    const contender = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; acquire_backup_run_lock "$2"',
        "backup",
        LOCK,
        dir,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(contender.exitCode).not.toBe(0);
    expect(contender.stderr.toString()).toContain("another ledger backup is active");
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

flockTest("the restore-exclusive ledger lock rejects an active shared CLI lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-ledger-lock-"));
  const lockPath = join(dir, ".ledger.lock");
  const ready = join(dir, "ready");
  const holder = Bun.spawn({
    cmd: [
      "bash",
      "-c",
      'umask 077; exec 9<>"$1"; flock -s -n 9; : > "$2"; sleep 10',
      "holder",
      lockPath,
      ready,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);
    const contender = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; acquire_ledger_maintenance_lock "$2" "$(id -un)"',
        "restore",
        LOCK,
        dir,
      ],
      env: { ...process.env, NULLSINK_LEDGER_LOCK: lockPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(contender.exitCode).not.toBe(0);
    expect(contender.stderr.toString()).toContain("an operator CLI command or backup is using the ledger");
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

flockTest("a backup holds the production shared ledger lock until its shell exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-ledger-lock-"));
  const lockPath = join(dir, ".ledger.lock");
  const ready = join(dir, "ready");
  const holder = Bun.spawn({
    cmd: [
      "bash",
      "-c",
      'source "$1"; acquire_ledger_shared_lock "$2" backup; : > "$3"; sleep 10',
      "backup",
      LOCK,
      dir,
      ready,
    ],
    env: { ...process.env, NULLSINK_LEDGER_LOCK: lockPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);
    const contender = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; acquire_ledger_maintenance_lock "$2" "$(id -un)"',
        "restore",
        LOCK,
        dir,
      ],
      env: { ...process.env, NULLSINK_LEDGER_LOCK: lockPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(contender.exitCode).not.toBe(0);
    expect(contender.stderr.toString()).toContain("operator CLI command or backup is using the ledger");
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

flockTest("a direct backup refuses a durable interrupted-restore marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-backup-restore-guard-"));
  try {
    const guardPath = join(dir, ".restore-in-progress");
    writeFileSync(guardPath, "restore-v2 pair");
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; acquire_ledger_shared_lock "$2" backup',
        "backup",
        LOCK,
        dir,
      ],
      env: {
        ...process.env,
        NULLSINK_LEDGER_LOCK: join(dir, ".ledger.lock"),
        NULLSINK_RESTORE_GUARD: guardPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("interrupted ledger restore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

flockTest("the restore ledger lock is owner-only and remains held until its shell exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-ledger-mode-"));
  const lockPath = join(dir, ".ledger.lock");
  const ready = join(dir, "ready");
  writeFileSync(lockPath, "", { mode: 0o666 });
  chmodSync(lockPath, 0o666);
  const holder = Bun.spawn({
    cmd: [
      "bash",
      "-c",
      'source "$1"; acquire_ledger_maintenance_lock "$2" "$(id -un)"; : > "$3"; sleep 10',
      "restore",
      LOCK,
      dir,
      ready,
    ],
    env: { ...process.env, NULLSINK_LEDGER_LOCK: lockPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    const contender = Bun.spawnSync({
      cmd: ["flock", "-s", "-n", lockPath, "true"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(contender.exitCode).not.toBe(0);
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

flockTest("an interrupted restore blocks other maintenance but permits an explicit restore resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-guard-"));
  try {
    const lockPath = join(dir, "maintenance.lock");
    const guardPath = join(dir, "restore.guard");
    writeFileSync(guardPath, "restore in progress");
    const env = { ...process.env, NULLSINK_MAINTENANCE_LOCK: lockPath, NULLSINK_RESTORE_GUARD: guardPath };
    const blocked = Bun.spawnSync({
      cmd: ["bash", "-c", 'source "$1"; acquire_maintenance_lock deploy', "blocked", LOCK],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr.toString()).toContain("interrupted ledger restore");
    const resume = Bun.spawnSync({
      cmd: ["bash", "-c", 'source "$1"; acquire_maintenance_lock restore 1', "resume", LOCK],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(resume.exitCode, resume.stderr.toString()).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an interrupted deploy guard blocks ordinary maintenance before lock acquisition", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-deploy-guard-"));
  try {
    const deployGuard = join(dir, "deploy.guard");
    writeFileSync(deployGuard, "deploy in progress");
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", 'source "$1"; acquire_maintenance_lock setup', "blocked", LOCK],
      env: {
        ...process.env,
        NULLSINK_MAINTENANCE_LOCK: join(dir, "maintenance.lock"),
        NULLSINK_RESTORE_GUARD: join(dir, "restore.guard"),
        NULLSINK_DEPLOY_GUARD: deployGuard,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("interrupted app deploy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["regular", "dangling-symlink"] as const)(
  "a %s pending-activation marker blocks host maintenance and shared ledger readers",
  (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "nullsink-activation-guard-"));
    try {
      const activationGuard = join(dir, ".restore-activation-pending");
      if (kind === "regular") writeFileSync(activationGuard, "restore-activation-v1 pair");
      else symlinkSync(join(dir, "missing-target"), activationGuard);
      const env = {
        ...process.env,
        NULLSINK_MAINTENANCE_LOCK: join(dir, "maintenance.lock"),
        NULLSINK_LEDGER_LOCK: join(dir, ".ledger.lock"),
        NULLSINK_RESTORE_GUARD: join(dir, ".restore-in-progress"),
        NULLSINK_RESTORE_ACTIVATION_GUARD: activationGuard,
      };
      const maintenance = Bun.spawnSync({
        cmd: ["bash", "-c", 'source "$1"; acquire_maintenance_lock deploy', "blocked", LOCK],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(maintenance.exitCode).not.toBe(0);
      expect(maintenance.stderr.toString()).toContain("restore still awaits activation");

      const reader = Bun.spawnSync({
        cmd: [
          "bash",
          "-c",
          'source "$1"; flock() { return 0; }; acquire_ledger_shared_lock "$2" backup',
          "blocked",
          LOCK,
          dir,
        ],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(reader.exitCode).not.toBe(0);
      expect(reader.stderr.toString()).toContain("restore still awaits activation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("deploy, setup, apply-restore, and backup acquire their required locks before live access", () => {
  const deploy = readFileSync(DEPLOY, "utf8");
  const setup = readFileSync(SETUP, "utf8");
  const restore = readFileSync(RESTORE, "utf8");
  const backup = readFileSync(BACKUP, "utf8");
  expect(deploy).toContain('source "$DEPLOY_SCRIPT_DIR/maintenance-lock.sh"');
  expect(setup).toContain('source "$SETUP_SCRIPT_DIR/maintenance-lock.sh"');
  expect(restore).toContain('source "$(dirname "$0")/maintenance-lock.sh"');
  expect(deploy.lastIndexOf('acquire_maintenance_lock "deploy $REF"')).toBeLessThan(
    deploy.lastIndexOf("deploy_binary"),
  );
  expect(setup.lastIndexOf('acquire_maintenance_lock "setup"')).toBeLessThan(
    setup.indexOf('CURRENT_LIVE_RELEASE="$(complete_live_release || true)"'),
  );
  const restoreHostLock = restore.indexOf('acquire_maintenance_lock "ledger restore" 1');
  const restoreLedgerLock = restore.indexOf(
    'acquire_ledger_maintenance_lock "$DB_DIR" "$SVC_USER"',
  );
  const recoveryRead = restore.indexOf('restore_resuming=0');
  const staging = restore.indexOf('install -o "$SVC_USER"');
  expect(restoreHostLock).toBeLessThan(restoreLedgerLock);
  expect(restoreLedgerLock).toBeLessThan(recoveryRead);
  expect(recoveryRead).toBeLessThan(staging);
  expect(backup).toContain('source "$(dirname "$0")/maintenance-lock.sh"');
  const backupRunLock = backup.indexOf('acquire_backup_run_lock "$BACKUP_DIR"');
  const backupLedgerLock = backup.indexOf('acquire_ledger_shared_lock "$DB_DIR" "ledger backup"');
  expect(backupRunLock).toBeGreaterThan(-1);
  expect(backupRunLock).toBeLessThan(backupLedgerLock);
  expect(backupLedgerLock).toBeLessThan(backup.indexOf('backup_snapshot_databases "$DB_DIR" "$work"'));
});
