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
