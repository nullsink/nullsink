import { afterEach, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rootGuardViolation } from "../cli/guard";
import { openDb } from "../src/ledger/db";

test("root is refused unless the exact break-glass override is set", () => {
  expect(rootGuardViolation(0, undefined)).toBe(true);
  expect(rootGuardViolation(0, "0")).toBe(true);
  expect(rootGuardViolation(0, "true")).toBe(true);
  expect(rootGuardViolation(0, "1")).toBe(false);
});

test("non-root and platforms without euid are allowed", () => {
  expect(rootGuardViolation(1000, undefined)).toBe(false);
  expect(rootGuardViolation(undefined, undefined)).toBe(false);
});

const DB = "/tmp/nullsink-guard-cli.db";
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));

function removeDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DB + suffix);
    } catch {
      // absent
    }
  }
}

afterEach(removeDb);

function runNsk(args: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    env: { ...process.env, BALANCES_DB_PATH: DB, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const dbOpened = () => existsSync(DB) || existsSync(`${DB}-wal`) || existsSync(`${DB}-shm`);

test("version and unknown commands open no ledger", () => {
  removeDb();
  expect(runNsk(["version"]).exitCode).toBe(0);
  expect(dbOpened()).toBe(false);
  expect(runNsk(["frobnicate"]).exitCode).toBe(1);
  expect(dbOpened()).toBe(false);
});

test("the balances reader opens an existing configured ledger after the guard", () => {
  const store = openDb(DB);
  store.db.close();
  expect(runNsk(["balances"], { NSK_ALLOW_ROOT: "1" }).exitCode).toBe(0);
  expect(existsSync(DB)).toBe(true);
});
