// nsk's refuse-as-root guard. Two groups of tests:
//   1. the pure policy (rootGuardViolation) — the unit-tested surface; refuseRootOrExit is the thin
//      print+exit shell around it (codebase convention: test the pure helper, not the process exit).
//   2. the guard's load-bearing INVARIANT: cli/index.ts must open NO ledger before the guard runs — which
//      holds only while index.ts statically imports nothing that reaches src/ledger/db (whose module-load
//      singleton opens balances.db at import). We pin it by spawning the real CLI for the non-DB commands
//      with a throwaway DB_PATH and asserting no balances.db* appears, so a future static import that opens
//      the DB before the guard (defeating it) fails here.
import { test, expect, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const rmDb = () => {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DBP + s);
    } catch {
      /* not present */
    }
  }
};
afterEach(rmDb);

// Run the real `nsk` entry in a subprocess with a throwaway DB_PATH (the test preload doesn't reach a child,
// so DB_PATH is exactly what we pass). process.execPath is this bun. Returns exit code + stdout.
function runNsk(args: string[], extraEnv: Record<string, string> = {}): { code: number | null; out: string } {
  rmDb();
  const r = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    env: { ...process.env, DB_PATH: DBP, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString() };
}

const dbOpened = () => existsSync(DBP) || existsSync(DBP + "-wal") || existsSync(DBP + "-shm");

test("`nsk version` opens no ledger (guarded entry stays DB-free)", () => {
  const { code, out } = runNsk(["version"]);
  expect(code).toBe(0);
  expect(out.trim().length).toBeGreaterThan(0); // printed a version
  expect(dbOpened()).toBe(false);
});

test("an unknown command opens no ledger either", () => {
  const { code } = runNsk(["frobnicate"]);
  expect(code).toBe(1);
  expect(dbOpened()).toBe(false);
});

// Positive control: proves the assertions above aren't vacuously green — a real subcommand DOES open the
// ledger. NSK_ALLOW_ROOT=1 so it holds even if the test runs as root (e.g. a root CI container).
test("positive control: a real subcommand opens the ledger", () => {
  const { code } = runNsk(["issue", "5"], { NSK_ALLOW_ROOT: "1" });
  expect(code).toBe(0);
  expect(existsSync(DBP)).toBe(true);
});
