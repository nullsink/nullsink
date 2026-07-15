// nsk's refuse-as-root guard. Two groups of tests:
//   1. the pure policy (rootGuardViolation) — the unit-tested surface; refuseRootOrExit is the thin
//      print+exit shell around it (codebase convention: test the pure helper, not the process exit).
//   2. the guard's load-bearing INVARIANT: cli/index.ts must open NO ledger before the guard runs. Each
//      subcommand opens its DB inside run() (after the guard), and version/usage never load a ledger module.
//      We pin it by spawning the real CLI for the non-DB commands with a throwaway DB_PATH and asserting no
//      balances.db* appears, so a regression that opens the DB before the guard (a module-top open, or a
//      static import that does I/O at load) fails here.
import { test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rootGuardViolation } from "../cli/guard";

test("root (euid 0) with no override is refused", () => {
  expect(rootGuardViolation(0, undefined)).toBe(true);
});

test("NSK_ALLOW_ROOT=1 lets root through (deliberate break-glass)", () => {
  expect(rootGuardViolation(0, "1")).toBe(false);
});

test('only exactly "1" overrides — other truthy-looking values still refuse', () => {
  expect(rootGuardViolation(0, "0")).toBe(true);
  expect(rootGuardViolation(0, "")).toBe(true);
  expect(rootGuardViolation(0, "true")).toBe(true);
});

test("a non-root euid is always allowed (override irrelevant)", () => {
  expect(rootGuardViolation(1000, undefined)).toBe(false);
  expect(rootGuardViolation(1000, "1")).toBe(false);
});

test("no euid (platform without uids) is allowed — nothing to enforce", () => {
  expect(rootGuardViolation(undefined, undefined)).toBe(false);
});

// --- group 2: the entry opens no ledger for non-DB commands (the guard's invariant; see header) ---

const DBP = "/tmp/nullsink-guard-cli.db";
const PENDING_DBP = "/tmp/nullsink-guard-cli.pending.db";
const LOCKP = join(tmpdir(), "nullsink-guard-cli.ledger.lock");
const RESTORE_GUARD = join(tmpdir(), "nullsink-guard-cli.restore-in-progress");
const RESTORE_ACTIVATION_GUARD = join(tmpdir(), "nullsink-guard-cli.restore-activation-pending");
const DEPLOY_GUARD = join(tmpdir(), "nullsink-guard-cli.deploy-in-progress");
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const LEDGER_LOCK = fileURLToPath(new URL("../cli/ledger-lock.ts", import.meta.url));
const rmDb = (all = false) => {
  const paths = [
    DBP,
    DBP + "-wal",
    DBP + "-shm",
    PENDING_DBP,
    PENDING_DBP + "-wal",
    PENDING_DBP + "-shm",
  ];
  if (all)
    paths.push(
      LOCKP,
      RESTORE_GUARD,
      RESTORE_ACTIVATION_GUARD,
      DEPLOY_GUARD,
      LOCKP + ".ready",
    );
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      /* not present */
    }
  }
};
afterEach(() => rmDb(true));

// Run the real `nsk` entry in a subprocess with a throwaway DB_PATH (the test preload doesn't reach a child,
// so DB_PATH is exactly what we pass). process.execPath is this bun. Returns exit code + stdout.
function runNsk(
  args: string[],
  extraEnv: Record<string, string> = {},
): { code: number | null; out: string; err: string } {
  rmDb();
  const r = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    env: {
      ...process.env,
      DB_PATH: DBP,
      PENDING_DB_PATH: PENDING_DBP,
      NULLSINK_LEDGER_LOCK: LOCKP,
      NULLSINK_RESTORE_GUARD: RESTORE_GUARD,
      NULLSINK_RESTORE_ACTIVATION_GUARD: RESTORE_ACTIVATION_GUARD,
      NULLSINK_DEPLOY_GUARD: DEPLOY_GUARD,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const dbOpened = () => existsSync(DBP) || existsSync(DBP + "-wal") || existsSync(DBP + "-shm");

test("`nsk version` opens no ledger (guarded entry stays DB-free)", () => {
  const { code, out } = runNsk(["version"]);
  expect(code).toBe(0);
  expect(out.trim().length).toBeGreaterThan(0); // printed a version
  expect(dbOpened()).toBe(false);
  expect(existsSync(LOCKP)).toBe(false);
});

test("an unknown command opens no ledger either", () => {
  const { code } = runNsk(["frobnicate"]);
  expect(code).toBe(1);
  expect(dbOpened()).toBe(false);
  expect(existsSync(LOCKP)).toBe(false);
});

test("root guard then ledger lock both run before the ledger-opening dynamic import", () => {
  const source = readFileSync(CLI, "utf8");
  const rootGuard = source.lastIndexOf("refuseRootOrExit(cmd);");
  const ledgerLock = source.lastIndexOf("acquireLedgerLockOrExit();");
  const dynamicLoad = source.lastIndexOf("\nload()");
  expect(rootGuard).toBeGreaterThan(0);
  expect(rootGuard).toBeLessThan(ledgerLock);
  expect(ledgerLock).toBeLessThan(dynamicLoad);
  expect(readFileSync(LEDGER_LOCK, "utf8")).not.toContain('from "../src/ledger/');
});

for (const [label, marker] of [
  ["restore", RESTORE_GUARD],
  ["restore activation", RESTORE_ACTIVATION_GUARD],
  ["deploy", DEPLOY_GUARD],
] as const) {
  test(`a durable ${label} marker blocks a real command before lock/DB creation`, () => {
    writeFileSync(marker, `${label} in progress`, { mode: 0o600 });
    const { code, err } = runNsk(["issue", "5"], { NSK_ALLOW_ROOT: "1" });
    expect(code).not.toBe(0);
    expect(err).toContain(
      label === "restore"
        ? "interrupted ledger restore"
        : label === "restore activation"
          ? "validated ledger restore awaits activation"
          : "interrupted app deploy",
    );
    expect(dbOpened()).toBe(false);
    expect(existsSync(LOCKP)).toBe(false);
  });
}

// Positive control: proves the assertions above aren't vacuously green — a real subcommand DOES open the
// ledger. NSK_ALLOW_ROOT=1 so it holds even if the test runs as root (e.g. a root CI container).
test("positive control: a real subcommand opens the ledger", () => {
  const { code } = runNsk(["issue", "5"], { NSK_ALLOW_ROOT: "1" });
  expect(code).toBe(0);
  expect(existsSync(DBP)).toBe(true);
  expect(statSync(DBP).mode & 0o777).toBe(0o600);
  expect(statSync(LOCKP).mode & 0o777).toBe(0o600);
});

test("the pending ledger is also created owner-only after the CLI umask boundary", () => {
  const { code } = runNsk(["orders", "--format", "json"], { NSK_ALLOW_ROOT: "1" });
  expect(code).toBe(0);
  expect(existsSync(PENDING_DBP)).toBe(true);
  expect(statSync(PENDING_DBP).mode & 0o777).toBe(0o600);
});

const flockTest = process.platform === "linux" && Bun.which("flock") ? test : test.skip;
const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("Linux fails closed before DB open when util-linux flock is unavailable", () => {
  const { code, err } = runNsk(["issue", "5"], {
    NSK_ALLOW_ROOT: "1",
    // An empty PATH lets execvp fall back to the platform's default search path on Linux, which can still
    // find /usr/bin/flock. Point at a definitely absent directory so spawnSync deterministically returns
    // ENOENT and exercises the production fail-closed branch.
    PATH: join(tmpdir(), "nullsink-no-such-bin-directory"),
  });
  expect(code).not.toBe(0);
  expect(err).toContain("flock is required to protect the live ledger");
  expect(dbOpened()).toBe(false);
});

flockTest("the CLI keeps its shared kernel lock for the full process lifetime", async () => {
  const ready = LOCKP + ".ready";
  const helper = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `import { acquireLedgerLockOrExit } from ${JSON.stringify(pathToFileURL(LEDGER_LOCK).href)};
       acquireLedgerLockOrExit();
       await Bun.write(${JSON.stringify(ready)}, "ready");
       await Bun.sleep(10_000);`,
    ],
    env: {
      ...process.env,
      DB_PATH: DBP,
      PENDING_DB_PATH: PENDING_DBP,
      NULLSINK_LEDGER_LOCK: LOCKP,
      NULLSINK_RESTORE_GUARD: RESTORE_GUARD,
      NULLSINK_RESTORE_ACTIVATION_GUARD: RESTORE_ACTIVATION_GUARD,
      NULLSINK_DEPLOY_GUARD: DEPLOY_GUARD,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 200 && !existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);
    const exclusive = Bun.spawnSync({
      cmd: ["flock", "-x", "-n", LOCKP, "true"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(exclusive.exitCode).not.toBe(0);
  } finally {
    helper.kill();
    await helper.exited;
  }
});
