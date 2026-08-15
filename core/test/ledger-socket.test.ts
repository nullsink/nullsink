import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FatalLedgerError, makeLedgerSocketClient, type LedgerClientOpts } from "../src/ledger/client";
import { openDb, type BalanceStore } from "../src/ledger/db";
import { createLedgerHandler, serveLedgerSocket } from "../src/ledger/server";
import { LEDGER_START_SESSION_PATH, LEDGER_WIRE_HEADER, LEDGER_WIRE_VERSION } from "../src/ledger/wire";

const HASH = "a".repeat(64);
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const H1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const H2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let dir = "";
let running: { stop: () => void } | null = null;
let ledger: BalanceStore | null = null;

function fixture() {
  dir = mkdtempSync(join(tmpdir(), "nsk-ledger-"));
  const socket = join(dir, "l.sock");
  ledger = openDb(join(dir, "balances.db"));
  return { socket, ledger };
}

function client(path: string, sessionId = S1, extra: Partial<LedgerClientOpts> = {}) {
  return makeLedgerSocketClient({ path, sessionId, ...extra });
}

afterEach(() => {
  running?.stop();
  running = null;
  ledger?.db.close();
  ledger = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

test("versioned socket round-trip starts a session and meters one hold", async () => {
  const f = fixture();
  f.ledger.credit(HASH, 1_000);
  running = serveLedgerSocket({ path: f.socket, balances: f.ledger, now: () => 100 });
  const c = client(f.socket);

  expect(await c.startSession()).toEqual({ outcome: "started", recoveredHolds: 0, recoveredMicros: 0 });
  expect(await c.getBalance(HASH)).toBe(1_000);
  expect(await c.openHold(HASH, 400, H1)).toBe(true);
  expect(await c.getBalance(HASH)).toBe(600);
  expect(await c.settleHold(H1, 250)).toBe(true);
  expect(await c.getBalance(HASH)).toBe(750);
  expect(statSync(f.socket).mode & 0o077).toBe(0);
});

test("a lost startSession response retries the same session and preserves recovery evidence", async () => {
  const f = fixture();
  f.ledger.credit(HASH, 1_000);
  expect(f.ledger.openHold(HASH, 400, H1)).toBe(true); // legacy/prior-proxy hold
  let failed = false;
  running = serveLedgerSocket({
    path: f.socket,
    balances: f.ledger,
    hooks: { afterCommit: (mutation) => {
      if (mutation === "start_session" && !failed) {
        failed = true;
        throw new Error("drop committed session response");
      }
    } },
  });

  const errorLog = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await client(f.socket).startSession()).toEqual({
      outcome: "current",
      recoveredHolds: 1,
      recoveredMicros: 400,
    });
    expect(failed).toBe(true);
    expect(f.ledger.getBalance(HASH)).toBe(1_000);
    expect(errorLog.mock.calls.some(([line]) =>
      String(line).includes("[ledger] request handler failed")
    )).toBe(true);
  } finally {
    errorLog.mockRestore();
  }
});

test("a lost open response retries the identical mutation and debits once", async () => {
  const f = fixture();
  f.ledger.credit(HASH, 1_000);
  let failed = false;
  running = serveLedgerSocket({
    path: f.socket,
    balances: f.ledger,
    hooks: { afterCommit: (mutation) => {
      if (mutation === "open_hold" && !failed) {
        failed = true;
        throw new Error("drop committed open response");
      }
    } },
  });
  const c = client(f.socket);
  await c.startSession();

  expect(await c.openHold(HASH, 400, H1)).toBe(true);
  expect(failed).toBe(true);
  expect(f.ledger.getBalance(HASH)).toBe(600);
  expect(f.ledger.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM holds").get()?.n).toBe(1);
});

test("a lost settle response retries the identical mutation and refunds once", async () => {
  const f = fixture();
  f.ledger.credit(HASH, 1_000);
  let failed = false;
  running = serveLedgerSocket({
    path: f.socket,
    balances: f.ledger,
    hooks: { afterCommit: (mutation) => {
      if (mutation === "settle_hold" && !failed) {
        failed = true;
        throw new Error("drop committed settle response");
      }
    } },
  });
  const c = client(f.socket);
  await c.startSession();
  await c.openHold(HASH, 400, H1);

  expect(await c.settleHold(H1, 250)).toBe(true);
  expect(failed).toBe(true);
  expect(f.ledger.getBalance(HASH)).toBe(750);
  expect(f.ledger.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM holds").get()?.n).toBe(0);
  expect(f.ledger.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM settled_holds").get()?.n).toBe(1);
});

test("ledger restart preserves the current proxy session and its live hold", async () => {
  const f = fixture();
  const dbPath = join(dir, "balances.db");
  f.ledger.credit(HASH, 1_000);
  running = serveLedgerSocket({ path: f.socket, balances: f.ledger });
  const c = client(f.socket);
  await c.startSession();
  await c.openHold(HASH, 400, H1);

  running.stop();
  running = null;
  f.ledger.db.close();
  ledger = openDb(dbPath);
  running = serveLedgerSocket({ path: f.socket, balances: ledger });

  expect(await c.settleHold(H1, 250)).toBe(true);
  expect(await c.getBalance(HASH)).toBe(750);
});

test("after both sides restart, a new session atomically refunds the old proxy's hold", async () => {
  const f = fixture();
  const dbPath = join(dir, "balances.db");
  f.ledger.credit(HASH, 1_000);
  running = serveLedgerSocket({ path: f.socket, balances: f.ledger });
  const oldProxy = client(f.socket, S1);
  await oldProxy.startSession();
  await oldProxy.openHold(HASH, 400, H1);
  expect(f.ledger.getBalance(HASH)).toBe(600);

  running.stop();
  running = null;
  f.ledger.db.close();
  ledger = openDb(dbPath);
  running = serveLedgerSocket({ path: f.socket, balances: ledger });
  const newProxy = client(f.socket, S2);

  expect(await newProxy.startSession()).toEqual({ outcome: "started", recoveredHolds: 1, recoveredMicros: 400 });
  expect(await newProxy.getBalance(HASH)).toBe(1_000);
  await expect(oldProxy.getBalance(HASH)).rejects.toBeInstanceOf(FatalLedgerError);
});

test("a delayed retired-session start retry cannot reclaim leadership", async () => {
  const f = fixture();
  f.ledger.credit(HASH, 1_000);
  let startCalls = 0;
  let firstStartReached!: () => void;
  let releaseFirstStart!: () => void;
  const firstReached = new Promise<void>((resolve) => { firstStartReached = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
  running = serveLedgerSocket({
    path: f.socket,
    balances: f.ledger,
    hooks: { afterCommit: async (mutation) => {
      if (mutation === "start_session" && startCalls++ === 0) {
        firstStartReached();
        await firstRelease;
        throw new Error("drop delayed first-session response");
      }
    } },
  });
  const first = client(f.socket, S1, { retryDelayMs: 0 });
  const second = client(f.socket, S2);

  const delayedFirstStart = first.startSession();
  await Promise.race([
    firstReached,
    delayedFirstStart.then(() => {
      throw new Error("startSession completed before the post-commit barrier");
    }),
  ]);
  await second.startSession();
  expect(await second.openHold(HASH, 300, H1)).toBe(true);
  expect(f.ledger.getBalance(HASH)).toBe(700);

  releaseFirstStart();
  await expect(delayedFirstStart).rejects.toBeInstanceOf(FatalLedgerError);
  expect(f.ledger.currentSession()).toBe(S2);
  expect(f.ledger.getBalance(HASH)).toBe(700);
  expect(await second.settleHold(H1, 200)).toBe(true);
  expect(f.ledger.getBalance(HASH)).toBe(800);
});

test("unknown success bodies are ambiguous and replay the byte-identical mutation", async () => {
  const bodies: string[] = [];
  let attempt = 0;
  const fakeFetch = async (_url: string, init: RequestInit & { unix: string }) => {
    bodies.push(String(init.body));
    attempt += 1;
    return attempt === 1 ? Response.json({ result: "mystery" }) : Response.json({ result: "opened" });
  };
  const c = client("/unused", S1, { fetch: fakeFetch, retryDelayMs: 0 });

  expect(await c.openHold(HASH, 10, H1)).toBe(true);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
});

test("an unresolved mutation is bounded and escalates fatally with one immutable payload", async () => {
  const bodies: string[] = [];
  let clock = 0;
  const fakeFetch = async (_url: string, init: RequestInit & { unix: string }): Promise<Response> => {
    bodies.push(String(init.body));
    clock += 10;
    throw new Error("socket down");
  };
  const c = client("/unused", S1, {
    fetch: fakeFetch,
    attemptTimeoutMs: 1,
    operationTimeoutMs: 25,
    retryDelayMs: 0,
    now: () => clock,
    sleep: async () => {},
  });

  await expect(c.settleHold(H1, 7)).rejects.toBeInstanceOf(FatalLedgerError);
  expect(bodies.length).toBeGreaterThan(1);
  expect(new Set(bodies).size).toBe(1);
});

test("stale sessions and conflicting replays fail closed", async () => {
  const f = fixture();
  f.ledger.credit(HASH, 1_000);
  running = serveLedgerSocket({ path: f.socket, balances: f.ledger });
  const first = client(f.socket, S1);
  const second = client(f.socket, S2);
  await first.startSession();
  await first.openHold(HASH, 100, H1);
  await second.startSession();

  await expect(first.openHold(HASH, 100, H2)).rejects.toBeInstanceOf(FatalLedgerError);
  await second.openHold(HASH, 100, H1);
  await expect(second.openHold(HASH, 101, H1)).rejects.toBeInstanceOf(FatalLedgerError);
});

test("the handler rejects wire skew and malformed sessions before state changes", async () => {
  const balances = openDb(":memory:");
  const handler = createLedgerHandler(balances);
  const request = (body: unknown, wire = String(LEDGER_WIRE_VERSION)) => new Request(`http://x${LEDGER_START_SESSION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [LEDGER_WIRE_HEADER]: wire },
    body: JSON.stringify(body),
  });

  expect((await handler(request({ session_id: S1 }, "999"))).status).toBe(400);
  expect((await handler(request({ session_id: "not-a-uuid" }))).status).toBe(400);
  expect(balances.currentSession()).toBeNull();
  balances.db.close();
});
