// Step-5 preparatory contract: request handling sees an asynchronous money boundary even while the current
// production adapter is local SQLite. These tests deliberately pause settlement and prove no response/drain
// can declare billing complete early, and every terminal race joins one promise latch.
import { expect, test } from "bun:test";
import { createProxyHandler, type ProxyHandlerDeps } from "../src/handler";
import { priceUsage } from "../src/cost";
import { byteBoundHold } from "../src/hold";
import { hashToken, openDb } from "../src/ledger/db";
import { localMeteringLedger, type MeteringLedgerPort } from "../src/ledger/port";

const MODEL = "claude-opus-4-8";
const INITIAL = 10_000_000_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function request(token: string, stream = false): Request {
  return new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      stream,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

function handler(
  balances: MeteringLedgerPort,
  upstreamFetch: typeof fetch,
  inflight = new Set<(reason?: "drain") => Promise<void>>(),
) {
  const deps: ProxyHandlerDeps = {
    anthropic: {
      apiKey: "upstream-key",
      baseUrl: "https://upstream.example",
      version: "2023-06-01",
      estimateHold: byteBoundHold,
    },
    upstreamTimeoutMs: 1000,
    maxMessagesBodyBytes: 33_554_432,
    balances,
    upstreamFetch,
    inflight,
  };
  return createProxyHandler(deps);
}

function delayedSettlementPort() {
  const store = openDb(":memory:");
  const local = localMeteringLedger(store);
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const port: MeteringLedgerPort = {
    ...local,
    settleHold: async (holdId, chargedMicros) => {
      calls += 1;
      started.resolve();
      await release.promise;
      return local.settleHold(holdId, chargedMicros);
    },
  };
  return { store, port, started: started.promise, release: release.resolve, calls: () => calls };
}

const holds = (store: ReturnType<typeof openDb>): number =>
  (store.db.query("SELECT COUNT(*) AS n FROM holds").get() as { n: number }).n;

test("buffered response waits for a definite asynchronous settlement", async () => {
  const delayed = delayedSettlementPort();
  const token = "pr_async_buffered";
  const hash = hashToken(token);
  delayed.store.credit(hash, INITIAL);
  const usage = { input_tokens: 120, output_tokens: 30 };
  const upstream = (async () => Response.json({ model: MODEL, usage })) as unknown as typeof fetch;
  let returned = false;

  const responsePromise = handler(delayed.port, upstream)(request(token)).then((response) => {
    returned = true;
    return response;
  });
  await delayed.started;

  expect(returned).toBe(false);
  expect(delayed.calls()).toBe(1);
  expect(holds(delayed.store)).toBe(1);

  delayed.release();
  const response = await responsePromise;
  expect(response.status).toBe(200);
  expect(holds(delayed.store)).toBe(0);
  expect(INITIAL - delayed.store.getBalance(hash)!).toBe(priceUsage(MODEL, usage));
});

test("buffered settlement failure never retries the hold with a different charge", async () => {
  const store = openDb(":memory:");
  const local = localMeteringLedger(store);
  const token = "pr_async_buffered_failure";
  const hash = hashToken(token);
  store.credit(hash, INITIAL);
  const usage = { input_tokens: 120, output_tokens: 30 };
  const charges: number[] = [];
  const port: MeteringLedgerPort = {
    ...local,
    settleHold: async (_holdId, chargedMicros) => {
      charges.push(chargedMicros);
      throw new Error("ledger unavailable");
    },
  };
  const upstream = (async () => Response.json({ model: MODEL, usage })) as unknown as typeof fetch;

  await expect(handler(port, upstream)(request(token))).rejects.toThrow("ledger unavailable");

  expect(charges).toEqual([priceUsage(MODEL, usage)]);
  expect(holds(store)).toBe(1);
});

test("upstream forwarding waits for a definite asynchronous hold", async () => {
  const store = openDb(":memory:");
  const local = localMeteringLedger(store);
  const token = "pr_async_open_hold";
  const hash = hashToken(token);
  store.credit(hash, INITIAL);
  const started = deferred();
  const release = deferred();
  let forwarded = 0;
  const port: MeteringLedgerPort = {
    ...local,
    openHold: async (tokenHash, micros, holdId) => {
      started.resolve();
      await release.promise;
      return local.openHold(tokenHash, micros, holdId);
    },
  };
  const upstream = (async () => {
    forwarded += 1;
    return Response.json({ model: MODEL, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as unknown as typeof fetch;

  const responsePromise = handler(port, upstream)(request(token));
  await started.promise;

  expect(forwarded).toBe(0);
  expect(holds(store)).toBe(0);

  release.resolve();
  expect((await responsePromise).status).toBe(200);
  expect(forwarded).toBe(1);
  expect(holds(store)).toBe(0);
});

test("a later upstream-body failure reuses a completed refund instead of masquerading as ledger failure", async () => {
  const store = openDb(":memory:");
  const local = localMeteringLedger(store);
  const token = "pr_async_non_ok_body_failure";
  const hash = hashToken(token);
  store.credit(hash, INITIAL);
  const settlements: Array<{ holdId: string; chargedMicros: number }> = [];
  const port: MeteringLedgerPort = {
    ...local,
    settleHold: async (holdId, chargedMicros) => {
      settlements.push({ holdId, chargedMicros });
      return local.settleHold(holdId, chargedMicros);
    },
  };
  const upstream = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("upstream error body broke")); },
  }), { status: 429 })) as unknown as typeof fetch;

  const response = await handler(port, upstream)(request(token, true));

  expect(response.status).toBe(502);
  expect(settlements).toHaveLength(1);
  expect(settlements[0]!.chargedMicros).toBe(0);
  expect(holds(store)).toBe(0);
  expect(store.getBalance(hash)).toBe(INITIAL);
});

test("stream terminal races join one settlement promise and stay registered until it completes", async () => {
  const delayed = delayedSettlementPort();
  const token = "pr_async_stream";
  const hash = hashToken(token);
  delayed.store.credit(hash, INITIAL);
  const inflight = new Set<(reason?: "drain") => Promise<void>>();
  const event = `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { model: MODEL, usage: { input_tokens: 90, output_tokens: 0 } },
  })}\n\n`;
  const upstream = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(event)); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

  const response = await handler(delayed.port, upstream, inflight)(request(token, true));
  const reader = response.body!.getReader();
  await reader.read(); // make the usage evidence visible before shutdown drain wins
  expect(inflight.size).toBe(1);

  const settle = [...inflight][0]!;
  const first = settle("drain");
  const racing = settle("drain");
  expect(racing).toBe(first);
  await delayed.started;

  expect(delayed.calls()).toBe(1);
  expect(inflight.size).toBe(1);
  expect(holds(delayed.store)).toBe(1);

  delayed.release();
  await Promise.all([first, racing]);
  expect(delayed.calls()).toBe(1);
  expect(inflight.size).toBe(0);
  expect(holds(delayed.store)).toBe(0);
  expect(INITIAL - delayed.store.getBalance(hash)!).toBe(priceUsage(MODEL, {
    input_tokens: 90,
    output_tokens: 0,
  }));
  await reader.cancel().catch(() => {});
});

test("a rejected stream settlement stays registered and retries the identical operation", async () => {
  const store = openDb(":memory:");
  const local = localMeteringLedger(store);
  const token = "pr_async_stream_retry";
  const hash = hashToken(token);
  store.credit(hash, INITIAL);
  const calls: Array<{ holdId: string; chargedMicros: number }> = [];
  const port: MeteringLedgerPort = {
    ...local,
    settleHold: async (holdId, chargedMicros) => {
      calls.push({ holdId, chargedMicros });
      if (calls.length === 1) throw new Error("temporary ledger failure");
      return local.settleHold(holdId, chargedMicros);
    },
  };
  const inflight = new Set<(reason?: "drain") => Promise<void>>();
  const event = `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { model: MODEL, usage: { input_tokens: 90, output_tokens: 0 } },
  })}\n\n`;
  const upstream = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(event)); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

  const response = await handler(port, upstream, inflight)(request(token, true));
  const reader = response.body!.getReader();
  await reader.read();
  const settle = [...inflight][0]!;

  await expect(settle("drain")).rejects.toThrow("temporary ledger failure");
  expect(inflight.has(settle)).toBe(true);
  expect(holds(store)).toBe(1);

  await settle("drain");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(inflight.size).toBe(0);
  expect(holds(store)).toBe(0);
  await reader.cancel().catch(() => {});
});
