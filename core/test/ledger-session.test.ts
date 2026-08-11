import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/ledger/db";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const H1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const H2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("session holds are replay-safe and reject conflicting payloads without moving money", () => {
  const ledger = openDb(":memory:");
  ledger.credit(HASH, 1_000);
  expect(ledger.beginSession(S1, 100)).toEqual({
    outcome: "started",
    recoveredHolds: 0,
    recoveredMicros: 0,
  });

  expect(ledger.openSessionHold(S1, HASH, 400, H1, 110)).toBe("opened");
  expect(ledger.getBalance(HASH)).toBe(600);
  expect(ledger.openSessionHold(S1, HASH, 400, H1, 120)).toBe("already_open");
  expect(ledger.getBalance(HASH)).toBe(600);
  expect(ledger.openSessionHold(S1, HASH, 401, H1, 120)).toBe("conflict");
  expect(ledger.openSessionHold(S1, OTHER_HASH, 400, H1, 120)).toBe("conflict");
  expect(ledger.getBalance(HASH)).toBe(600);

  expect(ledger.settleSessionHold(S1, H1, 250, 130)).toBe("settled");
  expect(ledger.getBalance(HASH)).toBe(750);
  expect(ledger.settleSessionHold(S1, H1, 250, 140)).toBe("already_settled");
  expect(ledger.settleSessionHold(S1, H1, 249, 140)).toBe("conflict");
  expect(ledger.openSessionHold(S1, HASH, 400, H1, 150)).toBe("conflict");
  expect(ledger.getBalance(HASH)).toBe(750);
});

test("beginSession(same) preserves live holds; beginSession(new) refunds them and switches atomically", () => {
  const ledger = openDb(":memory:");
  ledger.credit(HASH, 1_000);
  expect(ledger.beginSession(S1, 100).outcome).toBe("started");
  expect(ledger.openSessionHold(S1, HASH, 400, H1, 110)).toBe("opened");
  expect(ledger.getBalance(HASH)).toBe(600);

  expect(ledger.beginSession(S1, 120)).toEqual({
    outcome: "current",
    recoveredHolds: 0,
    recoveredMicros: 0,
  });
  expect(ledger.getBalance(HASH)).toBe(600);
  expect(ledger.settleSessionHold(S1, H1, 100, 130)).toBe("settled");
  expect(ledger.getBalance(HASH)).toBe(900);

  expect(ledger.openSessionHold(S1, HASH, 300, H2, 140)).toBe("opened");
  expect(ledger.beginSession(S2, 150)).toEqual({
    outcome: "started",
    recoveredHolds: 1,
    recoveredMicros: 300,
  });
  expect(ledger.currentSession()).toBe(S2);
  expect(ledger.getBalance(HASH)).toBe(900);
  expect(ledger.openSessionHold(S1, HASH, 1, H1, 160)).toBe("stale_session");
  expect(ledger.settleSessionHold(S1, H2, 1, 160)).toBe("stale_session");
  expect(ledger.getSessionBalance(S1, HASH)).toEqual({ stale: true });
  expect(ledger.getSessionBalance(S2, HASH)).toEqual({ stale: false, balance: 900 });
});

test("a retired session cannot reclaim leadership or refund the current session's hold", () => {
  const ledger = openDb(":memory:");
  ledger.credit(HASH, 1_000);
  expect(ledger.beginSession(S1, 100).outcome).toBe("started");
  expect(ledger.beginSession(S2, 110).outcome).toBe("started");
  expect(ledger.openSessionHold(S2, HASH, 300, H1, 120)).toBe("opened");

  expect(ledger.beginSession(S1, 130)).toEqual({ outcome: "stale_session" });
  expect(ledger.currentSession()).toBe(S2);
  expect(ledger.getBalance(HASH)).toBe(700);
  expect(ledger.settleSessionHold(S2, H1, 200, 140)).toBe("settled");
  expect(ledger.getBalance(HASH)).toBe(800);
});

test("a retired-session fence survives a ledger restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "nsk-session-fence-"));
  const path = join(dir, "balances.db");
  try {
    const first = openDb(path);
    first.credit(HASH, 1_000);
    expect(first.beginSession(S1, 100).outcome).toBe("started");
    expect(first.beginSession(S2, 110).outcome).toBe("started");
    expect(first.openSessionHold(S2, HASH, 300, H1, 120)).toBe("opened");
    first.db.close();

    const restarted = openDb(path);
    expect(restarted.beginSession(S1, 130)).toEqual({ outcome: "stale_session" });
    expect(restarted.currentSession()).toBe(S2);
    expect(restarted.getBalance(HASH)).toBe(700);
    expect(restarted.settleSessionHold(S2, H1, 200, 140)).toBe("settled");
    expect(restarted.getBalance(HASH)).toBe(800);
    restarted.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the first session recovers a legacy pre-session hold", () => {
  const ledger = openDb(":memory:");
  ledger.credit(HASH, 500);
  expect(ledger.openHold(HASH, 200, H1)).toBe(true);
  expect(ledger.getBalance(HASH)).toBe(300);

  expect(ledger.beginSession(S1, 100)).toEqual({
    outcome: "started",
    recoveredHolds: 1,
    recoveredMicros: 200,
  });
  expect(ledger.getBalance(HASH)).toBe(500);
});

test("invalid session amounts cannot credit a balance", () => {
  const ledger = openDb(":memory:");
  ledger.credit(HASH, 500);
  ledger.beginSession(S1, 100);
  expect(ledger.openSessionHold(S1, HASH, -1, H1, 110)).toBe("invalid_amount");
  expect(ledger.openSessionHold(S1, HASH, Number.NaN, H1, 110)).toBe("invalid_amount");
  expect(ledger.getBalance(HASH)).toBe(500);
});

test("opening a pre-extraction database adds compatible session columns and recovers its hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "nsk-old-ledger-"));
  const path = join(dir, "balances.db");
  try {
    const old = new Database(path, { create: true });
    old.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
    old.run("CREATE TABLE applied_orders (order_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    old.run("CREATE TABLE holds (hold_id TEXT PRIMARY KEY, hash TEXT NOT NULL, micros INTEGER NOT NULL)");
    old.query("INSERT INTO tokens (hash, balance) VALUES (?, ?)").run(HASH, 300);
    old.query("INSERT INTO holds (hold_id, hash, micros) VALUES (?, ?, ?)").run(H1, HASH, 200);
    old.close();

    const ledger = openDb(path);
    const columns = ledger.db.query<{ name: string }, []>("PRAGMA table_info(holds)").all().map((row) => row.name);
    expect(columns).toContain("session_id");
    expect(columns).toContain("opened_at");
    expect(ledger.beginSession(S1, 100)).toEqual({
      outcome: "started",
      recoveredHolds: 1,
      recoveredMicros: 200,
    });
    expect(ledger.getBalance(HASH)).toBe(500);
    ledger.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
