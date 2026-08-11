import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyHandler, type ProxyHandlerDeps } from "../src/handler";
import { hashToken, openDb, type BalanceStore } from "../src/ledger/db";
import { makeLedgerSocketClient } from "../src/ledger/client";
import { serveLedgerSocket } from "../src/ledger/server";

const MODEL = "claude-opus-4-8";
const SESSION = "11111111-1111-4111-8111-111111111111";

let dir = "";
let running: { stop: () => void } | null = null;
let store: BalanceStore | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  store?.db.close();
  store = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function request(token: string): Request {
  return new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

function handler(balances: ProxyHandlerDeps["balances"], upstreamFetch: typeof fetch) {
  return createProxyHandler({
    anthropic: {
      apiKey: "upstream-key",
      baseUrl: "https://upstream.example",
      version: "2023-06-01",
      estimateHold: () => ({ micros: 100, inputTokens: 1, inputTokensSource: "counted" }),
    },
    upstreamTimeoutMs: 1_000,
    maxMessagesBodyBytes: 33_554_432,
    balances,
    upstreamFetch,
  });
}

async function fixture() {
  dir = mkdtempSync(join(tmpdir(), "nsk-handler-ledger-"));
  const socket = join(dir, "l.sock");
  store = openDb(join(dir, "balances.db"));
  running = serveLedgerSocket({ path: socket, balances: store });
  const client = makeLedgerSocketClient({ path: socket, sessionId: SESSION, attemptTimeoutMs: 100 });
  await client.startSession();
  return { socket, client, store };
}

test("socket-backed concurrent holds preserve no-overdraft and forward only the admitted request", async () => {
  const f = await fixture();
  const token = "socket-no-overdraft";
  f.store.credit(hashToken(token), 100); // exactly one reservation
  let release!: () => void;
  let forwarded!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { forwarded = resolve; });
  let upstreamCalls = 0;
  const upstream = (async () => {
    upstreamCalls += 1;
    forwarded();
    await gate;
    return Response.json({ model: MODEL, usage: { input_tokens: 0, output_tokens: 0 } });
  }) as unknown as typeof fetch;
  const serve = handler(f.client, upstream);

  const first = serve(request(token));
  await started;
  const second = await serve(request(token));

  expect(second.status).toBe(402);
  expect(upstreamCalls).toBe(1);
  expect(f.store.getBalance(hashToken(token))).toBe(0);

  release();
  expect((await first).status).toBe(200);
  expect(f.store.getBalance(hashToken(token))).toBe(100);
  expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM holds").get()?.n).toBe(0);
});

test("ledger outage fails a metered request before any upstream forwarding", async () => {
  const f = await fixture();
  const token = "socket-ledger-outage";
  f.store.credit(hashToken(token), 1_000);
  running!.stop();
  running = null;
  let upstreamCalls = 0;
  const upstream = (async () => {
    upstreamCalls += 1;
    return Response.json({ model: MODEL, usage: { input_tokens: 0, output_tokens: 0 } });
  }) as unknown as typeof fetch;

  await expect(handler(f.client, upstream)(request(token))).rejects.toThrow(/ledger read unavailable/);
  expect(upstreamCalls).toBe(0);
  expect(f.store.getBalance(hashToken(token))).toBe(1_000);
});
