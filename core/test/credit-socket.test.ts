// The credit crossing over a unix socket. Exactly-once must survive the hop: the outbox is
// at-least-once delivery, creditOnce's applied_orders marker is the idempotent receiver, and the sender acks ONLY
// on a definite applied/already_applied. Anything else — timeout, non-2xx, an unrecognised 2xx body, no socket —
// is AMBIGUOUS (the ledger may have committed and lost the response), so the row stays unacked and is retried.
import { test, expect, afterEach, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { createCreditHandler, serveCreditSocket } from "../src/credit-server";
import { makeSocketSender, drainCreditOutboxOverSocket, oldestUnackedAgeMs, type CreditSender } from "../src/credit-sender";
import { CREDIT_PATH, CREDIT_WIRE_HEADER, CREDIT_WIRE_VERSION, parseCreditRequest } from "../src/credit-wire";

const HASH = "a".repeat(64);
// Unix socket paths are short (104 bytes on macOS), so keep the unique worker directory directly under /tmp.
const TEST_DIR = mkdtempSync("/tmp/nullsink-credit-test-");
const SOCK = join(TEST_DIR, "credit.sock");
const NOT_A_SOCKET = join(TEST_DIR, "not-a-socket");
const NOW = 1_700_000_000_000;

const rmPath = (path: string) => {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* already gone */
  }
};
const rmSock = () => rmPath(SOCK);
let running: { stop: () => void } | null = null;
afterEach(() => {
  running?.stop();
  running = null;
  rmSock();
  rmPath(NOT_A_SOCKET);
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

const creditReq = (body: unknown, wire: string | null = String(CREDIT_WIRE_VERSION)) =>
  new Request(`http://x${CREDIT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(wire === null ? {} : { [CREDIT_WIRE_HEADER]: wire }) },
    body: JSON.stringify(body),
  });

// --- the receiver (ledger side) ---

test("credit handler: first delivery applies; redelivery of the same key is already_applied (credited once)", async () => {
  const balances = openDb(":memory:");
  const h = createCreditHandler(balances, () => NOW);
  const r1 = await h(creditReq({ hash: HASH, micros: 5_000_000, idempotency_key: "tx:1" }));
  expect(r1.status).toBe(200);
  expect(await r1.json()).toEqual({ result: "applied" });
  const r2 = await h(creditReq({ hash: HASH, micros: 5_000_000, idempotency_key: "tx:1" }));
  expect(await r2.json()).toEqual({ result: "already_applied" });
  expect(balances.getBalance(HASH)).toBe(5_000_000); // exactly once, not 10_000_000
});

test("credit handler: a wire-version skew is refused (fail closed) and credits nothing", async () => {
  const balances = openDb(":memory:");
  const h = createCreditHandler(balances, () => NOW);
  const r = await h(creditReq({ hash: HASH, micros: 5_000_000, idempotency_key: "tx:1" }, "999"));
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "wire_version_mismatch" });
  const missing = await h(creditReq({ hash: HASH, micros: 5_000_000, idempotency_key: "tx:1" }, null));
  expect(missing.status).toBe(400);
  expect(balances.getBalance(HASH)).toBeNull();
});

test("credit handler: malformed credits are rejected and move no money", async () => {
  const balances = openDb(":memory:");
  const h = createCreditHandler(balances, () => NOW);
  const bad: unknown[] = [
    { hash: "not-a-hash", micros: 1, idempotency_key: "k" },
    { hash: HASH, micros: -1, idempotency_key: "k" }, // negative
    { hash: HASH, micros: 1.5, idempotency_key: "k" }, // non-integer
    { hash: HASH, micros: 1, idempotency_key: "" }, // empty key
    { hash: HASH, micros: 1 }, // missing key
    "nonsense",
  ];
  for (const b of bad) {
    const r = await h(creditReq(b));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_credit" });
  }
  expect(balances.getBalance(HASH)).toBeNull();
});

test("credit parser: exact financial and identifier boundaries", () => {
  const valid = { hash: HASH, micros: 0, idempotency_key: "k" };
  expect(parseCreditRequest(valid)).toEqual(valid); // zero-micro dust credits are valid
  expect(parseCreditRequest({ ...valid, idempotency_key: "k".repeat(200) })).not.toBeNull();

  const invalid: Array<[string, unknown]> = [
    ["null", null],
    ["array", []],
    ["coercible hash", { ...valid, hash: [HASH] }],
    ["hash prefix", { ...valid, hash: `x${HASH}` }],
    ["hash suffix", { ...valid, hash: `${HASH}x` }],
    ["negative micros", { ...valid, micros: -1 }],
    ["fractional micros", { ...valid, micros: 0.5 }],
    ["unsafe micros", { ...valid, micros: Number.MAX_SAFE_INTEGER + 1 }],
    ["empty key", { ...valid, idempotency_key: "" }],
    ["key over 200", { ...valid, idempotency_key: "k".repeat(201) }],
  ];
  for (const [label, body] of invalid) expect([label, parseCreditRequest(body)]).toEqual([label, null]);
});

test("credit handler: malformed raw JSON is a 400 and moves no money", async () => {
  const balances = openDb(":memory:");
  const h = createCreditHandler(balances, () => NOW);
  const r = await h(new Request(`http://x${CREDIT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CREDIT_WIRE_HEADER]: String(CREDIT_WIRE_VERSION) },
    body: "{",
  }));
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid_json" });
  expect(balances.getBalance(HASH)).toBeNull();
});

test("credit handler: only POST /credit is served", async () => {
  const balances = openDb(":memory:");
  const h = createCreditHandler(balances, () => NOW);
  const wrongPath = new Request("http://x/nope", { method: "POST", headers: { [CREDIT_WIRE_HEADER]: String(CREDIT_WIRE_VERSION) } });
  expect((await h(wrongPath)).status).toBe(404);
  const wrongMethod = new Request(`http://x${CREDIT_PATH}`, { method: "GET" });
  expect((await h(wrongMethod)).status).toBe(404);
});

// --- the wire, over a real unix socket ---

test("round-trip over a real unix socket: applied, then already_applied; balance credited exactly once", async () => {
  rmSock();
  const balances = openDb(":memory:");
  running = serveCreditSocket({ path: SOCK, balances, now: () => NOW });
  const send = makeSocketSender(SOCK);
  expect(await send({ hash: HASH, micros: 5_000_000, idempotency_key: "tx:1" })).toEqual({ ok: true, outcome: "applied" });
  expect(await send({ hash: HASH, micros: 5_000_000, idempotency_key: "tx:1" })).toEqual({ ok: true, outcome: "already_applied" });
  expect(balances.getBalance(HASH)).toBe(5_000_000);
});

test("the socket is bound owner-only without changing the process umask", () => {
  rmSock();
  const original = process.umask();
  try {
    process.umask(0o027); // explicit sentinel: independent of earlier tests and the runner's starting umask
    running = serveCreditSocket({ path: SOCK, balances: openDb(":memory:") });
    expect(process.umask()).toBe(0o027);
    expect(statSync(SOCK).isSocket()).toBe(true);
    // Production systemd widens the completed socket to the dedicated credit group before starting payments;
    // this bind-level test proves there is no permissive creation window.
    expect(statSync(SOCK).mode & 0o077).toBe(0);
  } finally {
    process.umask(original);
  }
});

test("serveCreditSocket replaces a stale socket left by an earlier process", async () => {
  const stale = Bun.serve({ unix: SOCK, fetch: () => new Response("stale") });
  try {
    running = serveCreditSocket({ path: SOCK, balances: openDb(":memory:"), now: () => NOW });
    expect(await makeSocketSender(SOCK)({ hash: HASH, micros: 1, idempotency_key: "fresh" }))
      .toEqual({ ok: true, outcome: "applied" });
  } finally {
    stale.stop(true);
  }
});

test("serveCreditSocket refuses to unlink a path that is not a socket", () => {
  writeFileSync(NOT_A_SOCKET, "i am a file");
  expect(() => serveCreditSocket({ path: NOT_A_SOCKET, balances: openDb(":memory:") })).toThrow(/not a socket/);
  expect(statSync(NOT_A_SOCKET).isFile()).toBe(true);
});

// --- the sender's ambiguity rules (never ack on anything but a definite outcome) ---

test("sender: no socket at all is AMBIGUOUS (ok:false), never a throw — payments can boot before the proxy", async () => {
  rmSock();
  const r = await makeSocketSender(SOCK, 500)({ hash: HASH, micros: 1, idempotency_key: "k" });
  expect(r.ok).toBe(false);
});

test("sender: a 2xx with an unrecognised body is NOT an ack", async () => {
  rmSock();
  const server = Bun.serve({ unix: SOCK, fetch: () => Response.json({ result: "weird" }) });
  running = { stop: () => void server.stop(true) };
  expect(await makeSocketSender(SOCK)({ hash: HASH, micros: 1, idempotency_key: "k" })).toEqual({ ok: false, reason: "unrecognized_response" });
});

test("sender: null or malformed 2xx JSON is NOT an ack", async () => {
  for (const response of [Response.json(null), new Response("{", { status: 200, headers: { "content-type": "application/json" } })]) {
    rmSock();
    const server = Bun.serve({ unix: SOCK, fetch: () => response });
    try {
      expect((await makeSocketSender(SOCK)({ hash: HASH, micros: 1, idempotency_key: "k" })).ok).toBe(false);
    } finally {
      server.stop(true);
      rmSock();
    }
  }
});

test("sender: emits the exact versioned JSON request contract", async () => {
  const seen: { value?: { method: string; path: string; wire: string | null; contentType: string | null; body: unknown } } = {};
  const server = Bun.serve({
    unix: SOCK,
    fetch: async (req) => {
      seen.value = {
        method: req.method,
        path: new URL(req.url).pathname,
        wire: req.headers.get(CREDIT_WIRE_HEADER),
        contentType: req.headers.get("content-type"),
        body: await req.json(),
      };
      return Response.json({ result: "applied" });
    },
  });
  running = { stop: () => void server.stop(true) };
  const credit = { hash: HASH, micros: 1, idempotency_key: "k" };
  expect(await makeSocketSender(SOCK)(credit)).toEqual({ ok: true, outcome: "applied" });
  expect(seen.value).toEqual({
    method: "POST",
    path: CREDIT_PATH,
    wire: String(CREDIT_WIRE_VERSION),
    contentType: "application/json",
    body: credit,
  });
});

test("the socket stop handle actually stops accepting credits", async () => {
  running = serveCreditSocket({ path: SOCK, balances: openDb(":memory:") });
  running.stop();
  running = null;
  expect((await makeSocketSender(SOCK, 100)({ hash: HASH, micros: 1, idempotency_key: "k" })).ok).toBe(false);
});

test("sender: a non-2xx is not an ack", async () => {
  rmSock();
  const server = Bun.serve({ unix: SOCK, fetch: () => Response.json({ error: "boom" }, { status: 500 }) });
  running = { stop: () => void server.stop(true) };
  expect(await makeSocketSender(SOCK)({ hash: HASH, micros: 1, idempotency_key: "k" })).toEqual({ ok: false, reason: "http_500" });
});

// --- the drain loop ---

test("drain acks only on definite outcomes and delivers every row", async () => {
  const orders = openOrderStore(":memory:");
  orders.enqueueCredit("k1", HASH, 1, 100);
  orders.enqueueCredit("k2", HASH, 2, 200);
  const r = await drainCreditOutboxOverSocket(orders, async () => ({ ok: true, outcome: "applied" }), NOW);
  expect(r).toEqual({ delivered: 2, alreadyApplied: 0 });
  expect(orders.listUnackedCredits()).toEqual([]);
  expect(orders.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credit_outbox WHERE hash = '' AND micros = 0").get()?.n).toBe(2);
});

test("drain STOPS at the first ambiguous result (fail-closed head-of-line); nothing after it is acked", async () => {
  const orders = openOrderStore(":memory:");
  orders.enqueueCredit("k1", HASH, 1, 100);
  orders.enqueueCredit("k2", HASH, 2, 200);
  const send: CreditSender = async (c) => (c.idempotency_key === "k1" ? { ok: false, reason: "timeout" } : { ok: true, outcome: "applied" });
  expect(await drainCreditOutboxOverSocket(orders, send, NOW)).toEqual({ delivered: 0, alreadyApplied: 0, blocked: "timeout" });
  expect(orders.listUnackedCredits().map((x) => x.idempotency_key)).toEqual(["k1", "k2"]); // both durable, retried next tick
  expect(orders.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credit_outbox WHERE hash <> '' AND micros > 0").get()?.n).toBe(2);
});

test("crash before ack: the redelivered row reports already_applied and the balance moves exactly once", async () => {
  rmSock();
  const balances = openDb(":memory:");
  const orders = openOrderStore(":memory:");
  running = serveCreditSocket({ path: SOCK, balances, now: () => NOW });
  orders.enqueueCredit("tx:1", HASH, 5_000_000, 100);
  const send = makeSocketSender(SOCK);

  // Simulate the crash: the credit is delivered (and committed ledger-side) but ackCredit never runs.
  expect(await send({ hash: HASH, micros: 5_000_000, idempotency_key: "tx:1" })).toEqual({ ok: true, outcome: "applied" });
  expect(orders.listUnackedCredits()).toHaveLength(1);

  // The next tick redelivers the still-unacked row: applied_orders makes it a no-op, and the row finally acks.
  expect(await drainCreditOutboxOverSocket(orders, send, NOW)).toEqual({ delivered: 1, alreadyApplied: 1 });
  expect(balances.getBalance(HASH)).toBe(5_000_000); // exactly once, not 10_000_000
  expect(orders.listUnackedCredits()).toEqual([]);
  expect(
    orders.db.query<{ hash: string; micros: number }, [string]>(
      "SELECT hash, micros FROM credit_outbox WHERE idempotency_key = ?",
    ).get("tx:1"),
  ).toEqual({ hash: "", micros: 0 });
});

test("oldestUnackedAgeMs: 0 when drained, else the age of the oldest undelivered credit", () => {
  const orders = openOrderStore(":memory:");
  expect(oldestUnackedAgeMs(orders, NOW)).toBe(0);
  orders.enqueueCredit("k1", HASH, 1, NOW - 5_000);
  orders.enqueueCredit("k2", HASH, 1, NOW - 1_000);
  expect(oldestUnackedAgeMs(orders, NOW)).toBe(5_000); // the OLDEST, not the newest
  orders.ackCredit("k1", NOW);
  expect(oldestUnackedAgeMs(orders, NOW)).toBe(1_000);
  orders.ackCredit("k2", NOW);
  expect(oldestUnackedAgeMs(orders, NOW)).toBe(0);
});
