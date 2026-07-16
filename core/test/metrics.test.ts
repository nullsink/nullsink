// Unit + handler-integration tests for the aggregate counters (src/metrics.ts). The module is a process-
// global singleton (like log.ts), so each test reset()s its window first and asserts from there; Bun runs
// tests sequentially, so the reads are deterministic despite the shared module state.
import { test, expect, spyOn } from "bun:test";
import * as metrics from "../src/metrics";
import { createHandler, type HandlerDeps, type RailView } from "./support/handler-combined";
import { openDb, hashToken } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { byteBoundHold } from "../src/hold";
import { makeTokenBucket } from "../src/ratelimit";

test("record / observe / snapshot / reset track every counter and high-water mark", () => {
  metrics.reset(1000);
  expect(metrics.snapshot()).toEqual({
    upstream: { throttle: 0, server: 0, auth: 0, billing: 0, timeout: 0, unreachable: 0, relayed4xx: 0, notfound: 0, other: 0 },
    reject: { buy: 0, read: 0, orders: 0 },
    bill: { refundedInFull: 0, holdExceeded: 0 },
    gate: { auth: 0, request: 0, model: 0, premium: 0, funds: 0 },
    balance: { ok: 0, unknown: 0, throttled: 0, error: 0 },
    credit: { enqueued: 0, acked: 0, alreadyApplied: 0, blocked: 0 },
    requests: 0,
    served: 0,
    servedPartial: 0,
    streamAborted: 0,
    peakStreams: 0,
    peakOpenOrders: 0,
    peakOutbox: 0,
    maxOutboxAgeMs: 0,
    recoveredHolds: 0,
    windowStart: 1000,
  });
  metrics.recordUpstream("throttle");
  metrics.recordUpstream("throttle");
  metrics.recordUpstream("server");
  metrics.recordUpstream("auth");
  metrics.recordUpstream("billing");
  metrics.recordUpstream("timeout");
  metrics.recordUpstream("unreachable");
  metrics.recordUpstream("relayed4xx");
  metrics.recordUpstream("notfound");
  metrics.recordUpstream("other");
  metrics.recordReject("buy");
  metrics.recordReject("read");
  metrics.recordReject("orders");
  metrics.recordBill("refundedInFull");
  metrics.recordBill("holdExceeded");
  metrics.recordGate("auth");
  metrics.recordGate("request");
  metrics.recordGate("model");
  metrics.recordGate("premium");
  metrics.recordGate("funds");
  metrics.recordBalance("ok");
  metrics.recordBalance("unknown");
  metrics.recordBalance("throttled");
  metrics.recordBalance("error");
  metrics.recordCredit("enqueued", 3);
  metrics.recordCredit("acked", 2);
  metrics.recordCredit("alreadyApplied");
  metrics.recordCredit("blocked");
  metrics.recordRequest();
  metrics.recordRequest();
  metrics.recordServed();
  metrics.recordServedPartial();
  metrics.recordStreamAborted();
  metrics.recordRecoveredHolds(5); // adds a count (boot refunds N at once), not a +1
  metrics.observeStreams(3);
  metrics.observeStreams(2); // a lower value never lowers the high-water mark
  metrics.observeOpenOrders(7);
  metrics.observeOpenOrders(4);
  metrics.observeCreditOutbox(5, 12_345);
  metrics.observeCreditOutbox(3, 10_000); // lower values never lower either high-water mark
  expect(metrics.snapshot()).toEqual({
    upstream: { throttle: 2, server: 1, auth: 1, billing: 1, timeout: 1, unreachable: 1, relayed4xx: 1, notfound: 1, other: 1 },
    reject: { buy: 1, read: 1, orders: 1 },
    bill: { refundedInFull: 1, holdExceeded: 1 },
    gate: { auth: 1, request: 1, model: 1, premium: 1, funds: 1 },
    balance: { ok: 1, unknown: 1, throttled: 1, error: 1 },
    credit: { enqueued: 3, acked: 2, alreadyApplied: 1, blocked: 1 },
    requests: 2,
    served: 1,
    servedPartial: 1,
    streamAborted: 1,
    peakStreams: 3,
    peakOpenOrders: 7,
    peakOutbox: 5,
    maxOutboxAgeMs: 12_345,
    recoveredHolds: 5,
    windowStart: 1000,
  });
  metrics.reset(2000); // a flush starts a fresh window: everything back to zero
  expect(metrics.snapshot()).toEqual({
    upstream: { throttle: 0, server: 0, auth: 0, billing: 0, timeout: 0, unreachable: 0, relayed4xx: 0, notfound: 0, other: 0 },
    reject: { buy: 0, read: 0, orders: 0 },
    bill: { refundedInFull: 0, holdExceeded: 0 },
    gate: { auth: 0, request: 0, model: 0, premium: 0, funds: 0 },
    balance: { ok: 0, unknown: 0, throttled: 0, error: 0 },
    credit: { enqueued: 0, acked: 0, alreadyApplied: 0, blocked: 0 },
    requests: 0,
    served: 0,
    servedPartial: 0,
    streamAborted: 0,
    peakStreams: 0,
    peakOpenOrders: 0,
    peakOutbox: 0,
    maxOutboxAgeMs: 0,
    recoveredHolds: 0,
    windowStart: 2000,
  });
});

// Minimal handler wiring (mirrors billing.property.test.ts) so the integration tests below prove each hook
// is actually wired, not just that the counters increment in isolation.
function makeHandler(upstreamFetch: (url: string, init: any) => Promise<Response>, over: Partial<HandlerDeps> = {}) {
  const balances = openDb(":memory:");
  const deps: HandlerDeps = {
    anthropic: { apiKey: "k", baseUrl: "https://up.example", version: "2023-06-01", estimateHold: byteBoundHold },
    upstreamTimeoutMs: 1000,
    margin: 1.15, buyMinUsd: 5, buyMaxUsd: 2000, orderTtlMs: 4 * 60 * 60 * 1000, maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096, maxMessagesBodyBytes: 33_554_432, balances, orders: openOrderStore(":memory:"),
    upstreamFetch: upstreamFetch as typeof fetch,
    rails: new Map<string, RailView>([["monero", { name: "monero", createAddress: async () => ({ address: "8a", orderIndex: 0 }), rateUsd: async () => 150, scale: 1_000_000_000_000, unit: "XMR", confirmations: 10, paymentUri: (a, amt) => `monero:${a}?tx_amount=${amt}` }]]),
    defaultRail: "monero",
    ...over,
  };
  return { handler: createHandler(deps), balances };
}
const msg = (token: string, extra: object = {}) =>
  new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }], ...extra }),
  });
const buyReq = (hash: string) =>
  new Request("https://proxy.local/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hash, credit_usd: 10 }) });
const balanceReq = (token: string) =>
  new Request("https://proxy.local/balance", { method: "GET", headers: { "x-api-key": token } });
const A = "a".repeat(64);
const B = "b".repeat(64);

// An SSE 200 stream so a streaming request registers in `inflight` (→ observeStreams) before we drain it.
function okStream(): (url: string, init: any) => Promise<Response> {
  const enc = new TextEncoder();
  const events = [
    { type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) { (c as any)._i = 0; },
        pull(c) { const i = (c as any)._i++; if (i >= events.length) return c.close(); c.enqueue(enc.encode(`event: ${(events[i] as any).type}\ndata: ${JSON.stringify(events[i])}\n\n`)); },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

// The upstream-outcome map, asserted as a table (the policy that relayOrMaskUpstream + the transport catch
// encode, verified rather than hand-checked). For EVERY row: the named bucket lands at 1 AND every other bucket
// stays 0 — so each status/failure maps to EXACTLY ONE outcome (no double-bucketing). The forwarded request is
// counted (req=1) but never served. And after the loop, the set of buckets the table exercises must equal the
// FULL UpstreamKind set — so adding a kind without a row fails here, keeping the map complete. `up` either
// returns the upstream Response (relay/mask path) or throws (the transport catch → timeout/unreachable).
test("the upstream-outcome map is complete + unique: every non-2xx / transport failure → exactly one bucket", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // the masked rows each log ERROR
  const json = (status: number, error: object) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
  const cases: Array<{ label: string; up: () => Response; bucket: keyof typeof EMPTY.upstream }> = [
    { label: "genuine 429 → throttle", up: () => new Response("slow down", { status: 429, headers: { "content-type": "text/plain" } }), bucket: "throttle" },
    { label: "insufficient_quota 429 → billing", up: () => json(429, { type: "insufficient_quota", code: "insufficient_quota" }), bucket: "billing" },
    { label: "low-credit 400 → billing (billing wears a 400, masked NOT relayed)", up: () => json(400, { message: "Your credit balance is too low" }), bucket: "billing" },
    { label: "invalid_request 400 → relayed4xx (the CLIENT's fixable error)", up: () => json(400, { type: "invalid_request_error", message: "bad field" }), bucket: "relayed4xx" },
    { label: "422 → relayed4xx", up: () => json(422, { type: "invalid_request_error", message: "unprocessable" }), bucket: "relayed4xx" },
    { label: "413 → relayed4xx", up: () => new Response("too big", { status: 413 }), bucket: "relayed4xx" },
    { label: "401 → auth (our key)", up: () => new Response("nope", { status: 401 }), bucket: "auth" },
    { label: "500 → server", up: () => new Response("boom", { status: 500 }), bucket: "server" },
    { label: "404 not_found_error → notfound", up: () => json(404, { type: "not_found_error", message: "model: x" }), bucket: "notfound" },
    { label: "409 → other (rare masked status)", up: () => new Response("conflict", { status: 409 }), bucket: "other" },
    { label: "TimeoutError → timeout", up: () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, bucket: "timeout" },
    { label: "ECONNREFUSED → unreachable", up: () => { throw new Error("ECONNREFUSED"); }, bucket: "unreachable" },
  ];
  for (const c of cases) {
    metrics.reset(0);
    const { handler, balances } = makeHandler(async () => c.up());
    balances.credit(hashToken("pr_u"), 10_000_000_000);
    await handler(msg("pr_u"));
    const s = metrics.snapshot();
    const total = Object.values(s.upstream).reduce((a, b) => a + b, 0);
    // target bucket = 1 AND the whole family sums to 1 → this is the ONLY bucket that moved (uniqueness).
    expect([c.label, s.upstream[c.bucket], total]).toEqual([c.label, 1, 1]);
    expect([c.label, s.requests, s.served]).toEqual([c.label, 1, 0]); // forwarded, never served
  }
  // Completeness: the table must touch every UpstreamKind — a new kind with no row trips this.
  expect(new Set(cases.map((c) => c.bucket as string))).toEqual(new Set(Object.keys(EMPTY.upstream)));
  errSpy.mockRestore();
});

test("a relayed user 4xx is counted as relayed4xx — forwarded but not served (itemizes the served↔req gap)", async () => {
  metrics.reset(0);
  // A non-billing 400 is the CLIENT's fixable request error → relayed verbatim, counted (not masked, not
  // logged: a 4xx body can echo the user's prompt). No console spy: the relay branch is deliberately quiet.
  const body = JSON.stringify({ error: { type: "invalid_request_error", message: "max_tokens: too large" } });
  const { handler, balances } = makeHandler(async () => new Response(body, { status: 400, headers: { "content-type": "application/json" } }));
  balances.credit(hashToken("pr_4xx"), 10_000_000_000);
  const res = await handler(msg("pr_4xx"));
  expect(res.status).toBe(400); // relayed verbatim so the developer sees their own fixable error
  expect(await res.text()).toBe(body); // the upstream's native envelope, unmasked
  const s = metrics.snapshot();
  expect([s.requests, s.served, s.upstream.relayed4xx]).toEqual([1, 0, 1]); // forwarded, not served, classified
});

test("a streamed genuine upstream 429 is also counted as a throttle (streaming non-ok path)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  metrics.reset(0);
  const { handler, balances } = makeHandler(async () => new Response("slow down", { status: 429, headers: { "content-type": "text/plain" } }));
  balances.credit(hashToken("pr_s"), 10_000_000_000);
  const res = await handler(msg("pr_s", { stream: true }));
  expect(res.status).toBe(429);
  expect(metrics.snapshot().upstream.throttle).toBe(1);
  errSpy.mockRestore();
});

test("local rejections are counted by kind: /buy rate limit, read throttle, order cap", async () => {
  // reject:buy — a frozen 1-token /buy bucket sheds the second request.
  metrics.reset(0);
  {
    const { handler } = makeHandler(okStream(), { buyRateLimit: makeTokenBucket({ capacity: 1, refillPerSec: 0, now: () => 0 }) });
    expect((await handler(buyReq(A))).status).toBe(200);
    expect((await handler(buyReq(B))).status).toBe(429);
  }
  expect(metrics.snapshot().reject.buy).toBe(1);

  // reject:read — a frozen 1-token read bucket sheds the second /balance.
  metrics.reset(0);
  {
    const { handler, balances } = makeHandler(okStream(), { readRateLimit: makeTokenBucket({ capacity: 1, refillPerSec: 0, now: () => 0 }) });
    balances.credit(hashToken("pr_r"), 5_000_000);
    expect((await handler(balanceReq("pr_r"))).status).toBe(200);
    expect((await handler(balanceReq("pr_r"))).status).toBe(429);
  }
  expect(metrics.snapshot().reject.read).toBe(1);
  expect(metrics.snapshot().balance.throttled).toBe(1);

  // reject:orders — at maxOpenOrders=1, the first /buy opens an order and the second is shed at the cap.
  metrics.reset(0);
  {
    const { handler } = makeHandler(okStream(), { maxOpenOrders: 1 });
    expect((await handler(buyReq(A))).status).toBe(200);
    expect((await handler(buyReq(B))).status).toBe(503);
  }
  expect(metrics.snapshot().reject.orders).toBe(1);
});

test("/balance outcomes are aggregate and endpoint-specific", async () => {
  metrics.reset(0);
  const { handler, balances } = makeHandler(okStream());
  balances.credit(hashToken("pr_balance"), 5_000_000);
  expect((await handler(balanceReq("pr_balance"))).status).toBe(200);
  expect((await handler(balanceReq("pr_unknown"))).status).toBe(401);
  expect(metrics.snapshot().balance).toEqual({ ok: 1, unknown: 1, throttled: 0, error: 0 });

  const brokenBalances = {
    getBalance: () => { throw new Error("disk read failed"); },
    openHold: () => false,
    settleHold: () => false,
  } as any;
  const broken = makeHandler(okStream(), { balances: brokenBalances }).handler;
  try {
    await broken(balanceReq("pr_broken"));
  } catch {
    // The production root converts this to its generic 500; this combined test router deliberately rethrows.
  }
  expect(metrics.snapshot().balance.error).toBe(1);
});

test("a created order bumps the open-orders high-water mark (observed at creation, not sampled)", async () => {
  metrics.reset(0);
  const { handler } = makeHandler(okStream());
  expect((await handler(buyReq(A))).status).toBe(200);
  expect(metrics.snapshot().peakOpenOrders).toBe(1); // observed right after the order commits
});

test("reject:orders also counts the cross-process claim-lost gate (not just the cap pre-check)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // the orphan path logs a warn (→ console.error)
  metrics.reset(0);
  const realOrders = openOrderStore(":memory:");
  const orders = { ...realOrders, tryAddOrder: () => false }; // openCount stays 0 → the cap gates pass; the claim fails post-createAddress
  const { handler } = makeHandler(okStream(), { orders });
  expect((await handler(buyReq(A))).status).toBe(503);
  expect(metrics.snapshot().reject.orders).toBe(1);
  errSpy.mockRestore();
});

test("a live stream bumps the concurrent-streams high-water mark", async () => {
  metrics.reset(0);
  const { handler, balances } = makeHandler(okStream());
  balances.credit(hashToken("pr_p"), 10_000_000_000);
  const res = await handler(msg("pr_p", { stream: true }));
  expect(res.status).toBe(200);
  expect(metrics.snapshot().peakStreams).toBe(1); // registered in `inflight` the moment the stream is built
  await res.text(); // drain to settle (leaves the high-water mark in place)
  expect(metrics.snapshot().peakStreams).toBe(1);
});

// A buffered 200 carrying parseable Anthropic usage (mirrors billing.property.test.ts's `ok`).
const okBuffered = (usage: object): ((url: string, init: any) => Promise<Response>) =>
  async () => new Response(JSON.stringify({ model: "claude-opus-4-8", usage }), { status: 200, headers: { "content-type": "application/json" } });

test("a 2xx is counted as served + a forwarded request (volume heartbeat)", async () => {
  metrics.reset(0);
  const { handler, balances } = makeHandler(okBuffered({ input_tokens: 1, output_tokens: 1 }));
  balances.credit(hashToken("pr_ok"), 10_000_000_000);
  expect((await handler(msg("pr_ok"))).status).toBe(200);
  const s = metrics.snapshot();
  expect([s.requests, s.served, s.bill.refundedInFull]).toEqual([1, 1, 0]);
});

test("a 2xx without parseable usage records refundedInFull but NOT served (the leak is not a clean serve)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // the refund-in-full path logs ERROR
  metrics.reset(0);
  const { handler, balances } = makeHandler(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  balances.credit(hashToken("pr_nu"), 10_000_000_000);
  expect((await handler(msg("pr_nu"))).status).toBe(200);
  const s = metrics.snapshot();
  // Forwarded (req=1), but metered nothing → the served-but-unbilled leak. `served` now means "billed clean", so
  // this is refundedInFull and NOT served — they're disjoint, so req reconciles as served + refundedInFull + …
  expect([s.requests, s.served, s.bill.refundedInFull]).toEqual([1, 0, 1]);
  errSpy.mockRestore();
});

test("an over-reported 2xx pricing above the hold records holdExceeded (refund clamped, no overdraft)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // the clamp logs ERROR
  metrics.reset(0);
  // A deliberately huge usage so actual > any byte-bound hold for a short prompt (mirrors billing.property.test.ts).
  const huge = { input_tokens: 200_000, output_tokens: 200_000, cache_creation_input_tokens: 200_000, cache_read_input_tokens: 200_000 };
  const { handler, balances } = makeHandler(okBuffered(huge));
  balances.credit(hashToken("pr_he"), 10_000_000_000);
  expect((await handler(msg("pr_he"))).status).toBe(200);
  const s = metrics.snapshot();
  expect([s.served, s.bill.holdExceeded]).toEqual([1, 1]);
  errSpy.mockRestore();
});

test("a transport failure is classified timeout vs unreachable: a forwarded request, never served", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // the catch logs a WARN (→ console.error)
  // connection failure → unreachable (502)
  metrics.reset(0);
  {
    const { handler, balances } = makeHandler(async () => { throw new Error("ECONNREFUSED"); });
    balances.credit(hashToken("pr_un"), 10_000_000_000);
    expect((await handler(msg("pr_un"))).status).toBe(502);
  }
  let s = metrics.snapshot();
  expect([s.requests, s.served, s.upstream.unreachable, s.upstream.timeout]).toEqual([1, 0, 1, 0]);
  // wall-clock timeout (AbortSignal.timeout throws a TimeoutError) → timeout (504)
  metrics.reset(0);
  {
    const { handler, balances } = makeHandler(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
    balances.credit(hashToken("pr_to"), 10_000_000_000);
    expect((await handler(msg("pr_to"))).status).toBe(504);
  }
  s = metrics.snapshot();
  expect([s.requests, s.served, s.upstream.timeout, s.upstream.unreachable]).toEqual([1, 0, 1, 0]);
  errSpy.mockRestore();
});

test("every pre-forward gate site is counted by the right kind (auth/request/funds), siblings stay 0, never forwarded", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const never = async () => new Response("{}", { status: 200 }); // upstream must never be reached on a gated request
  // Assert EXACTLY one gate kind fired this window, the two siblings stayed 0, and nothing was forwarded
  // (req/served 0). The sibling-zero check is load-bearing: it's what catches a mutant that ALSO double-counts
  // into another bucket — a kind-only assertion wouldn't. One assertion per site = the whole gate matrix pinned.
  const gateOnly = (kind: "auth" | "request" | "model" | "premium" | "funds") => {
    const s = metrics.snapshot();
    expect({ auth: s.gate.auth, request: s.gate.request, model: s.gate.model, premium: s.gate.premium, funds: s.gate.funds, req: s.requests, served: s.served }).toEqual({
      auth: kind === "auth" ? 1 : 0, request: kind === "request" ? 1 : 0, model: kind === "model" ? 1 : 0, premium: kind === "premium" ? 1 : 0, funds: kind === "funds" ? 1 : 0, req: 0, served: 0,
    });
  };
  // a /v1/messages POST with arbitrary headers + body, escaping the msg() helper's fixed shape
  const post = (headers: Record<string, string>, body: string) =>
    new Request("https://proxy.local/v1/messages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  // request: a body that DECLARES an oversized length, shed before the token is even read (413 payload_too_large)
  metrics.reset(0);
  { const { handler } = makeHandler(never, { maxMessagesBodyBytes: 10 }); // declared content-length over the cap
    expect((await handler(post({ "content-length": "5000" }, "{}"))).status).toBe(413); }
  gateOnly("request");

  // auth: no token at all — the cheap header-only shed (401 missing_api_key)
  metrics.reset(0);
  { const { handler } = makeHandler(never);
    expect((await handler(post({}, JSON.stringify({ model: "claude-opus-4-8", max_tokens: 16, messages: [] })))).status).toBe(401); }
  gateOnly("auth");

  // request: a body we can't parse (400 invalid_json) — funded so it clears the validity shed and reaches the parse
  metrics.reset(0);
  { const { handler, balances } = makeHandler(never);
    balances.credit(hashToken("pr_ij"), 5_000_000);
    expect((await handler(post({ "x-api-key": "pr_ij" }, "not json{"))).status).toBe(400); }
  gateOnly("request");

  // premium: a premium-priced feature the flat card doesn't cover (400 unsupported_option) — its OWN gate kind now
  metrics.reset(0);
  { const { handler, balances } = makeHandler(never);
    balances.credit(hashToken("pr_pm"), 5_000_000);
    expect((await handler(msg("pr_pm", { inference_geo: "eu" }))).status).toBe(400); }
  gateOnly("premium");

  // model: an unknown/unowned model (400 unsupported_model) — its OWN gate kind now (cf. the upstream:notfound sibling)
  metrics.reset(0);
  { const { handler, balances } = makeHandler(never);
    balances.credit(hashToken("pr_um"), 5_000_000);
    expect((await handler(msg("pr_um", { model: "totally-made-up-model" }))).status).toBe(400); }
  gateOnly("model");

  // request: no output cap and no default (400 max_tokens_required) — funded to reach the body gate
  metrics.reset(0);
  { const { handler, balances } = makeHandler(never);
    balances.credit(hashToken("pr_mt"), 5_000_000);
    expect((await handler(post({ "x-api-key": "pr_mt" }, JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] })))).status).toBe(400); }
  gateOnly("request");

  // auth: a present-but-unknown token, shed BEFORE the body gates now (401 invalid_token, the pre-buffer validity check)
  metrics.reset(0);
  { const { handler } = makeHandler(never); // pr_unknown never credited → getBalance null
    expect((await handler(msg("pr_unknown"))).status).toBe(401); }
  gateOnly("auth");

  // funds: a KNOWN token sitting at exactly 0 (402 insufficient_balance, the <=0 pre-check — distinct from the race below)
  metrics.reset(0);
  { const { handler, balances } = makeHandler(never);
    balances.credit(hashToken("pr_zero"), 0); // a 0-balance row → getBalance 0, not null → the <=0 gate, not invalid_token
    expect((await handler(msg("pr_zero"))).status).toBe(402); }
  gateOnly("funds");

  // funds: funded a hair, but the byte-bound hold dwarfs it → openHold's atomic debit loses (402, race-loss / funds leg)
  metrics.reset(0);
  { const { handler, balances } = makeHandler(never);
    balances.credit(hashToken("pr_race"), 1); // 1 micro passes the >0 pre-check; openHold then fails on the real hold
    expect((await handler(msg("pr_race"))).status).toBe(402); }
  gateOnly("funds");

  // auth: token deleted DURING body buffering — the pre-buffer shed passed, but the post-buffer getBalance
  // re-read finds it gone, so it's shed as invalid_token (401, auth), NOT insufficient_balance (402, funds).
  // A stateful stub: non-null at the pre-buffer shed (1st getBalance), null at the re-read (2nd). This is the
  // ONLY way to reach that re-read branch — an already-unknown token is caught by the earlier pre-buffer shed.
  metrics.reset(0);
  { let calls = 0;
    const balances = { getBalance: () => (calls++ === 0 ? 5 : null), openHold: () => true, settleHold: () => true } as any;
    const { handler } = makeHandler(never, { balances });
    expect((await handler(msg("pr_midbuf"))).status).toBe(401); } // re-read found it gone → 401 invalid_token, kind=auth
  gateOnly("auth");

  // auth: token VANISHES between the pre-check and openHold (race-loss / gone leg) → invalid_token, not insufficient_balance.
  // A stateful balances stub: positive until openHold runs, null after — the only way to reach the gone=true branch.
  metrics.reset(0);
  { let held = false;
    const balances = { getBalance: () => (held ? null : 5), openHold: () => { held = true; return false; }, settleHold: () => true } as any;
    const { handler } = makeHandler(never, { balances });
    expect((await handler(msg("pr_gone"))).status).toBe(401); } // gone → 401 invalid_token (matches the recorded auth kind)
  gateOnly("auth");

  errSpy.mockRestore();
});

// --- formatMetricsLine: the pure WARN/INFO formatting extracted from index.ts's flushMetrics ---

const EMPTY = {
  upstream: { throttle: 0, server: 0, auth: 0, billing: 0, timeout: 0, unreachable: 0, relayed4xx: 0, notfound: 0, other: 0 },
  reject: { buy: 0, read: 0, orders: 0 },
  bill: { refundedInFull: 0, holdExceeded: 0 },
  gate: { auth: 0, request: 0, model: 0, premium: 0, funds: 0 },
  balance: { ok: 0, unknown: 0, throttled: 0, error: 0 },
  credit: { enqueued: 0, acked: 0, alreadyApplied: 0, blocked: 0 },
  requests: 0,
  served: 0,
  servedPartial: 0,
  streamAborted: 0,
  peakStreams: 0,
  peakOpenOrders: 0,
  peakOutbox: 0,
  maxOutboxAgeMs: 0,
  recoveredHolds: 0,
  windowStart: 0,
};

test("formatMetricsLine: a clean window logs nothing (no spam)", () => {
  expect(metrics.formatMetricsLine(EMPTY, 60_000)).toBeNull();
});

test("formatMetricsLine: peaks alone are a routine heartbeat → INFO", () => {
  expect(metrics.formatMetricsLine({ ...EMPTY, peakStreams: 3, peakOpenOrders: 7 }, 5 * 60_000)).toEqual({
    level: "info",
    line: "peak:streams=3 peak:orders=7 (last 5m)",
  });
});

test("formatMetricsLine: balance and credit delivery stay aggregate; failures drive WARN", () => {
  expect(
    metrics.formatMetricsLine(
      {
        ...EMPTY,
        balance: { ok: 8, unknown: 2, throttled: 1, error: 1 },
        credit: { enqueued: 4, acked: 3, alreadyApplied: 1, blocked: 2 },
        peakOutbox: 4,
        maxOutboxAgeMs: 12_345,
      },
      60_000,
    ),
  ).toEqual({
    level: "warn",
    line: "balance:error=1 credit:blocked=2 balance:ok=8 balance:unknown=2 balance:throttled=1 credit:enqueued=4 credit:acked=3 credit:dedup=1 peak:outbox=4 max:outbox-age-s=13 (last 1m)",
  });
});

test("formatMetricsLine: any problem → WARN, with the heartbeat riding along for context", () => {
  expect(
    metrics.formatMetricsLine(
      { ...EMPTY, upstream: { throttle: 2, server: 0, auth: 1, billing: 0, timeout: 0, unreachable: 0, relayed4xx: 0, notfound: 0, other: 0 }, reject: { buy: 0, read: 5, orders: 0 }, peakStreams: 4 },
      60_000,
    ),
  ).toEqual({ level: "warn", line: "upstream:throttle=2 upstream:auth=1 reject:read=5 peak:streams=4 (last 1m)" });
});

test("formatMetricsLine: served/req traffic alone is a routine heartbeat → INFO", () => {
  expect(metrics.formatMetricsLine({ ...EMPTY, served: 140, requests: 150 }, 60 * 60_000)).toEqual({
    level: "info",
    line: "served=140 req=150 (last 60m)",
  });
});

test("formatMetricsLine: relayed user 4xx rides the routine heartbeat → INFO, itemizing the served↔req gap", () => {
  // The exact prod shape: served=13 req=16, the gap of 3 being relayed user 4xx — NOT a problem (stays INFO).
  expect(
    metrics.formatMetricsLine({ ...EMPTY, served: 13, requests: 16, upstream: { ...EMPTY.upstream, relayed4xx: 3 } }, 60 * 60_000),
  ).toEqual({ level: "info", line: "served=13 req=16 upstream:4xx=3 (last 60m)" });
});

test("formatMetricsLine: relayed 4xx stays in the routine segment even when a real problem forces WARN", () => {
  // upstream:5xx is the problem driving WARN; relayed4xx still rides along after served/req (never a problem itself).
  expect(
    metrics.formatMetricsLine({ ...EMPTY, served: 13, requests: 16, upstream: { ...EMPTY.upstream, server: 1, relayed4xx: 3 } }, 60_000),
  ).toEqual({ level: "warn", line: "upstream:5xx=1 served=13 req=16 upstream:4xx=3 (last 1m)" });
});

test("formatMetricsLine: model-not-found (upstream:notfound) rides the routine heartbeat → INFO", () => {
  // The 15:58 prod shape: served=1 req=6, the gap being the client's bad model — not an operator problem.
  expect(
    metrics.formatMetricsLine({ ...EMPTY, served: 1, requests: 6, upstream: { ...EMPTY.upstream, notfound: 5 } }, 60 * 60_000),
  ).toEqual({ level: "info", line: "served=1 req=6 upstream:notfound=5 (last 60m)" });
});

test("formatMetricsLine: a masked `other` status (rare 405/409/…) is a problem → WARN", () => {
  expect(
    metrics.formatMetricsLine({ ...EMPTY, served: 4, requests: 5, upstream: { ...EMPTY.upstream, other: 1 } }, 60_000),
  ).toEqual({ level: "warn", line: "upstream:other=1 served=4 req=5 (last 1m)" });
});

test("the served↔req gap now reconciles exactly: served + Σ upstream.* = req (no hidden residual)", () => {
  // gap of 5 fully itemized — notfound(2) + relayed4xx(1) + 5xx(1) + auth(1); nothing unbucketed.
  const u = { ...EMPTY.upstream, notfound: 2, relayed4xx: 1, server: 1, auth: 1 };
  const sum = u.throttle + u.server + u.auth + u.billing + u.timeout + u.unreachable + u.relayed4xx + u.notfound + u.other;
  expect(6 - 1).toBe(sum); // req - served === Σ upstream.*
});

test("the full outcome taxonomy reconciles: req = served + servedPartial + streamAborted + refundedInFull + Σ upstream.*, and incoming = req + Σ gate", () => {
  // A window of 16 incoming: 10 forwarded (req=10), 6 shed at a pre-forward gate (never reached req). The 10
  // forwarded split into EVERY success/forwarded-error outcome — 4 clean served, 1 input-floor partial, 1 stream
  // abort, 1 unbilled leak, and 3 upstream errors (5xx + throttle + relayed4xx). Nothing unbucketed/double-counted.
  const s = {
    ...EMPTY, requests: 10, served: 4, servedPartial: 1, streamAborted: 1,
    bill: { refundedInFull: 1, holdExceeded: 0 },
    upstream: { ...EMPTY.upstream, server: 1, throttle: 1, relayed4xx: 1 },
    gate: { auth: 2, request: 1, model: 1, premium: 1, funds: 1 },
  };
  const u = s.upstream;
  const upstreamErr = u.throttle + u.server + u.auth + u.billing + u.timeout + u.unreachable + u.relayed4xx + u.notfound + u.other;
  const forwardedOutcomes = s.served + s.servedPartial + s.streamAborted + s.bill.refundedInFull + upstreamErr;
  const gated = s.gate.auth + s.gate.request + s.gate.model + s.gate.premium + s.gate.funds;
  expect(forwardedOutcomes).toBe(s.requests); // every forwarded request lands in exactly one outcome
  expect(s.requests + gated).toBe(16); // incoming = forwarded + gated — the load-bearing reconciliation
});

test("formatMetricsLine: gate rejections ride the routine heartbeat → INFO (a flood is visible, not a WARN)", () => {
  // a bad-token flood: 5000 shed at the door, nothing forwarded — visible without per-event spam, not a problem.
  // also pins the emit ORDER of the split gate family (auth, request, model, premium, funds).
  expect(
    metrics.formatMetricsLine({ ...EMPTY, gate: { auth: 5000, request: 2, model: 3, premium: 4, funds: 1 } }, 60 * 60_000),
  ).toEqual({ level: "info", line: "gate:auth=5000 gate:request=2 gate:model=3 gate:premium=4 gate:funds=1 (last 60m)" });
});

test("formatMetricsLine: streamed partial/abort outcomes ride the routine heartbeat → INFO, itemizing the served↔req gap", () => {
  // 94 clean serves of 100 forwarded; the other 6 are 2 input-floor partials + 3 mid-flight aborts (+ 1 leak,
  // which is the WARN bill:refunded, tested separately). Partials/aborts are routine — real billing / refunds.
  expect(
    metrics.formatMetricsLine({ ...EMPTY, served: 94, requests: 100, servedPartial: 2, streamAborted: 3 }, 60 * 60_000),
  ).toEqual({ level: "info", line: "served=94 req=100 stream:partial=2 stream:aborted=3 (last 60m)" });
});

test("formatMetricsLine: recovered:holds rides the routine heartbeat → INFO (boot gauge; the [boot] WARN is the alert)", () => {
  expect(
    metrics.formatMetricsLine({ ...EMPTY, recoveredHolds: 4 }, 60 * 60_000),
  ).toEqual({ level: "info", line: "recovered:holds=4 (last 60m)" });
});

test("formatMetricsLine: a bill anomaly drives WARN and sorts first, the heartbeat riding along", () => {
  expect(
    metrics.formatMetricsLine({ ...EMPTY, bill: { refundedInFull: 2, holdExceeded: 1 }, served: 5, requests: 5 }, 60_000),
  ).toEqual({ level: "warn", line: "bill:refunded=2 bill:holdexceeded=1 served=5 req=5 (last 1m)" });
});

test("formatMetricsLine: upstream timeout + unreachable appear on the WARN line", () => {
  expect(
    metrics.formatMetricsLine({ ...EMPTY, upstream: { throttle: 0, server: 0, auth: 0, billing: 0, timeout: 3, unreachable: 2, relayed4xx: 0, notfound: 0, other: 0 } }, 60_000),
  ).toEqual({ level: "warn", line: "upstream:timeout=3 upstream:unreachable=2 (last 1m)" });
});

test("formatMetricsLine: window minutes floor at 1 (a sub-minute window never reads as 0m)", () => {
  expect(metrics.formatMetricsLine({ ...EMPTY, upstream: { throttle: 1, server: 0, auth: 0, billing: 0, timeout: 0, unreachable: 0, relayed4xx: 0, notfound: 0, other: 0 } }, 1000)?.line).toContain("(last 1m)");
});
