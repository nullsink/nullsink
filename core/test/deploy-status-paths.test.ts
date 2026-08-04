// Exercise the storage portion of status-check.sh with the two billing databases in different directories.
// All network/systemd probes are deliberately disabled so this remains a local, deterministic path contract.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STATUS_CHECK = fileURLToPath(new URL("../deploy/status-check.sh", import.meta.url));
const workdirs: string[] = [];

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("status check verifies explicit databases in separate state directories", () => {
  const root = mkdtempSync(join(tmpdir(), "nullsink-status-paths-test-"));
  workdirs.push(root);
  const balancesDir = join(root, "proxy-state");
  const pendingDir = join(root, "payments-state");
  const backupDir = join(root, "backup-state");
  const bin = join(root, "bin");
  for (const dir of [balancesDir, pendingDir, backupDir, bin]) mkdirSync(dir);

  const balancesPath = join(balancesDir, "balances.db");
  const pendingPath = join(pendingDir, "pending.db");
  const balances = new Database(balancesPath);
  balances.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
  balances.close();
  const pending = new Database(pendingPath);
  pending.run("CREATE TABLE pending_orders (id INTEGER PRIMARY KEY)");
  pending.close();
  writeFileSync(join(backupDir, "backup-20260804T000000Z.tar.age"), "ciphertext");

  const fakeSystemctl = join(bin, "systemctl");
  writeFileSync(fakeSystemctl, "#!/bin/sh\nexit 1\n");
  const fakeSudo = join(bin, "sudo");
  writeFileSync(fakeSudo, '#!/bin/sh\nif [ "${1:-}" = "-u" ]; then shift 2; fi\nexec "$@"\n');
  const fakeDf = join(bin, "df");
  writeFileSync(fakeDf, '#!/bin/sh\nprintf "Use%%\\n1%%\\n"\n');
  const fakeStat = join(bin, "stat");
  writeFileSync(fakeStat, '#!/bin/sh\nif [ "${2:-}" = "%Y" ]; then date +%s; else exec /usr/bin/stat "$@"; fi\n');
  for (const path of [fakeSystemctl, fakeSudo, fakeDf, fakeStat]) chmodSync(path, 0o755);

  const user = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
  const result = Bun.spawnSync({
    cmd: ["bash", STATUS_CHECK],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DB_DIR: join(root, "unused-legacy-state"),
      BALANCES_DB_PATH: balancesPath,
      PENDING_DB_PATH: pendingPath,
      BALANCES_DB_USER: user,
      PENDING_DB_USER: user,
      BACKUP_DIR: backupDir,
      PAY_RAILS: "none",
      STAMP: join(root, "incident-marker"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain(`disk 1% on ${balancesDir}`);
  expect(output).toContain(`disk 1% on ${pendingDir}`);
  expect(output).toContain("balances.db integrity ok");
  expect(output).toContain("pending.db integrity ok");
  expect(output).toContain("newest backup 0h old");
  expect(output).not.toContain("WARN ");
});
