// The credit crossing over a unix socket. Exactly-once must survive the hop: the outbox is
// at-least-once delivery, creditOnce's applied_orders marker is the idempotent receiver, and the sender acks ONLY
// on a definite applied/already_applied. Anything else — timeout, non-2xx, an unrecognised 2xx body, no socket —
// is AMBIGUOUS (the proxy may have committed and lost the response), so the row stays unacked and is retried.
import { test, expect, afterEach } from "bun:test";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { createCreditHandler, serveCreditSocket } from "../src/credit-server";
import { makeSocketSender, drainCreditOutboxOverSocket, oldestUnackedAgeMs, type CreditSender } from "../src/credit-sender";
import { CREDIT_PATH, CREDIT_WIRE_HEADER, CREDIT_WIRE_VERSION } from "../src/credit-wire";

const HASH = "a".repeat(64);
const SOCK = "/tmp/nullsink-credit-test.sock";
const NOW = 1_700_000_000_000;

const rmSock = () => {
  try {
    if (existsSync(SOCK)) unlinkSync(SOCK);
  } catch {
    /* already gone */
  }
};
let running: { stop: () => void } | null = null;
afterEach(() => {
  running?.stop();
  running = null;
  rmSock();
});

const creditReq = (body: unknown, wire: string | null = String(CREDIT_WIRE_VERSION)) =>
  new Request(`http://x${CREDIT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(wire === null ? {} : { [CREDIT_WIRE_HEADER]: wire }) },
    body: JSON.stringify(body),
  });

// --- the receiver (proxy side) ---

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
  for (const b of bad) expect((await h(creditReq(b))).status).toBe(400);
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

test("the socket is bound owner-only (umask 0077): no group/other bits, so only the owning uid may connect", () => {
  rmSock();
  running = serveCreditSocket({ path: SOCK, balances: openDb(":memory:") });
  expect(statSync(SOCK).isSocket()).toBe(true);
  // connect(2) needs the WRITE bit; leaving group/other unset means only the owning uid may connect. Both
  // services share that uid today, so this mode IS the authentication. A uid split must grant payments the
  // write bit (group or POSIX ACL) and relax this assertion accordingly.
  expect(statSync(SOCK).mode & 0o077).toBe(0);
});

test("serveCreditSocket refuses to unlink a path that is not a socket", () => {
  const notASocket = "/tmp/nullsink-credit-not-a-socket";
  Bun.write(notASocket, "i am a file");
  expect(() => serveCreditSocket({ path: notASocket, balances: openDb(":memory:") })).toThrow(/not a socket/);
  unlinkSync(notASocket);
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

  // Simulate the crash: the credit is delivered (and committed proxy-side) but ackCredit never runs.
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
