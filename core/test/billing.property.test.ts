// Property + example tests for the request handler (src/handler.ts), driven through createHandler with
// an in-memory balance store and a STUBBED upstream fetch — no port bound, no network. The headline
// property is the hold/refund conservation identity: a completed request's net debit equals the ACTUAL
// metered cost, independent of the hold size (max_tokens / prompt length). The rest cover the refund
// matrix, the privacy/header invariants, the /buy never-undercharge rounding, and the fail-closed gate.
import { test, expect, spyOn } from "bun:test";
import fc from "fast-check";
import { createHandler, type HandlerDeps, type RailView } from "../src/handler";
import { byteBoundHold } from "../src/hold";
import { openDb, type BalanceStore } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { hashToken } from "../src/ledger/db";
import { priceUsage } from "../src/cost";
import { makeTokenBucket } from "../src/ratelimit";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const MODELS = ["claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-4-6"];

// The quoted expires_at window (matches the ORDER_TTL_MS prod default). Shared between the handler deps
// and the expires_at assertion so the test can't silently agree with itself if one side changes.
const ORDER_TTL_MS = 4 * 60 * 60 * 1000;

type Upstream = (url: string, init: any) => Promise<Response>;

// Rail-knob overrides kept for back-compat with this harness's many call sites (xmrUsd / createAddress are the
// historical single-rail field names). makeHandler folds them into the one-entry `rails` map the handler now
// requires; passing an explicit `rails` / `defaultRail` in `over` still wins (the multi-rail tests below).
type RailKnobs = {
  xmrUsd?: RailView["rateUsd"];
  createAddress?: RailView["createAddress"];
  scale?: RailView["scale"];
  unit?: RailView["unit"];
  confirmations?: RailView["confirmations"];
  paymentUri?: RailView["paymentUri"];
};

function makeHandler(upstreamFetch: Upstream, over: Partial<HandlerDeps> & RailKnobs = {}) {
  const balances = openDb(":memory:");
  const orders = openOrderStore(":memory:");
  const { xmrUsd, createAddress, scale, unit, confirmations, paymentUri, ...handlerOver } = over;
  const monero: RailView = {
    name: "monero",
    createAddress: createAddress ?? (async () => ({ address: "8FundAddr", orderIndex: 0 })),
    rateUsd: xmrUsd ?? (async () => 150),
    scale: scale ?? 1_000_000_000_000,
    unit: unit ?? "XMR",
    confirmations: confirmations ?? 10,
    paymentUri: paymentUri ?? ((a, amt) => `monero:${a}?tx_amount=${amt}`),
  };
  const deps: HandlerDeps = {
    anthropic: { apiKey: "real-upstream-key", baseUrl: "https://upstream.example", version: "2023-06-01", estimateHold: byteBoundHold },
    upstreamTimeoutMs: 1000,
    margin: 1.15,
    buyMinUsd: 5,
    buyMaxUsd: 2000,
    orderTtlMs: ORDER_TTL_MS,
    maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096,
    maxMessagesBodyBytes: 33_554_432,
    balances,
    orders,
    upstreamFetch: upstreamFetch as typeof fetch,
    rails: new Map<string, RailView>([["monero", monero]]),
    defaultRail: "monero",
    ...handlerOver,
  };
  return { handler: createHandler(deps), balances, orders };
}

// NIT-2 leak guard: after a request settles (billed or refunded), its holds-journal row MUST be gone. A
// leaked row wouldn't move a balance — so the conservation assertions above can't see it — but it would
// double-refund at the next boot's recoverHolds(). Asserting the journal is empty after each exit path
// pins "every live path closes its hold" against a future regression. `balances.db` is the raw handle.
const holdsCount = (balances: BalanceStore): number =>
  (balances.db.query("SELECT COUNT(*) AS n FROM holds").get() as { n: number }).n;

function messagesReq(token: string | null, body: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-api-key"] = token;
  return new Request("https://proxy.local/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
}

const hexChar = fc.constantFrom(..."0123456789abcdef".split(""));
const hexStr = (n: number) => fc.array(hexChar, { minLength: n, maxLength: n }).map((a) => a.join(""));
const tokenArb = hexStr(16).map((s) => `pr_${s}`);
const modelArb = fc.constantFrom(...MODELS);
const usageArb = fc.record({
  input_tokens: fc.nat({ max: 200_000 }),
  output_tokens: fc.nat({ max: 200_000 }),
  cache_creation_input_tokens: fc.nat({ max: 200_000 }),
  cache_read_input_tokens: fc.nat({ max: 200_000 }),
});

const ok = (model: string, usage: object): Upstream =>
  async () => new Response(JSON.stringify({ model, usage }), { status: 200, headers: { "content-type": "application/json" } });

test("net debit on a completed request equals the actual metered cost, regardless of the hold", async () => {
  // The clamp (handler.ts) logs an error when synthetic usage exceeds the hold; silence it.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  await fc.assert(
    fc.asyncProperty(tokenArb, modelArb, fc.string({ maxLength: 500 }), fc.integer({ min: 1, max: 200_000 }), usageArb, async (token, model, prompt, maxTokens, usage) => {
      const { handler, balances } = makeHandler(ok(model, usage));
      const initial = 10_000_000_000; // $10k — comfortably covers any hold here
      balances.credit(hashToken(token), initial);
      const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
      const res = await handler(messagesReq(token, body));
      expect(res.status).toBe(200);
      const actual = priceUsage(model, usage);
      const holdAmount = byteBoundHold({ model, raw: JSON.stringify(body), body, maxTokens }).micros;
      // Net debit = min(actual, hold). In production the hold is a SOUND upper bound (real tokens ≤
      // bytes), so this is always `actual` and the hold cancels out — the headline property. This
      // generator feeds synthetic usage DECOUPLED from the prompt, which CAN exceed the byte bound (an
      // unreachable regime for real requests); there billing is capped at the hold, never overdrafting.
      expect(initial - balances.getBalance(hashToken(token))!).toBe(Math.min(actual, holdAmount));
      expect(holdsCount(balances)).toBe(0); // settled → the journal row is cleared (NIT-2)
    }),
    { numRuns: 400 },
  );
  errSpy.mockRestore();
});

test("a response that prices ABOVE the hold never overdrafts: net debit is capped at the hold", async () => {
  // Invariant 1 enforced in OUR code: even if the upstream over-reports usage or echoes a pricier
  // response model than the request the hold was sized against, the refund is clamped so the balance
  // can never drop below funded − hold. The clamp logs an error; silence it for the property runs.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  // A deliberately huge usage so actual > any byte-bound hold for a short prompt. Mix model axes too:
  // request a cheap model, have the response claim the priciest one.
  const hugeUsage = { input_tokens: 200_000, output_tokens: 200_000, cache_creation_input_tokens: 200_000, cache_read_input_tokens: 200_000 };
  await fc.assert(
    fc.asyncProperty(tokenArb, fc.integer({ min: 1, max: 64 }), async (token, maxTokens) => {
      const reqModel = "claude-haiku-4-5"; // cheapest; hold sized at its rate
      const { handler, balances } = makeHandler(ok("claude-opus-4-8", hugeUsage)); // priciest in the response
      const initial = 10_000_000_000;
      balances.credit(hashToken(token), initial);
      const body = { model: reqModel, max_tokens: maxTokens, messages: [{ role: "user", content: "hi" }] };
      const holdAmount = byteBoundHold({ model: reqModel, raw: JSON.stringify(body), body, maxTokens }).micros;
      const actual = priceUsage("claude-opus-4-8", hugeUsage);
      expect(actual).toBeGreaterThan(holdAmount); // precondition: this case actually exercises the clamp
      const res = await handler(messagesReq(token, body));
      expect(res.status).toBe(200);
      const debit = initial - balances.getBalance(hashToken(token))!;
      expect(debit).toBe(holdAmount); // charged exactly the hold, never more — no overdraft
      expect(balances.getBalance(hashToken(token))!).toBeGreaterThanOrEqual(0);
    }),
    { numRuns: 100 },
  );
  errSpy.mockRestore();
});

test("a 1-hour cache write bills at 2× input end-to-end, and the (2×-sized) hold covers it — no clamp", async () => {
  // The upstream reports the whole cache write as 1-hour, nested under usage.cache_creation (the real
  // Anthropic shape). With the cache tokens ~= the prompt's byte bound and priced at 2× input, this case
  // would CLAMP (under-bill) under the old 1.25×-sized hold — so a clean (debit == exact) pass guards BOTH
  // the priceUsage split AND the priceHoldBound bump together.
  const model = "claude-opus-4-8";
  const prompt = "x".repeat(4000);
  // The request opts into 1-hour caching (cache_control ttl:"1h" on the system block), so the provider's
  // hold detector reserves the 2× tier — without that breakpoint the gated hold stays at the standard 1.25×
  // and the clamp bites. So a clean (debit == exact) pass guards the priceUsage split, the priceHoldBound
  // tier, AND the gate together.
  const body = { model, max_tokens: 64,
    system: [{ type: "text", text: "cached system block", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: prompt }] };
  const usage = { input_tokens: 0, output_tokens: 50, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 } };
  const { handler, balances } = makeHandler(ok(model, usage));
  const token = "pr_cache1h";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  // The charge our split produces, and the hold the provider sizes for this ttl:"1h" request (oneHourCache → 2× tier).
  const expected = priceUsage(model, { input_tokens: 0, output_tokens: 50, cache_creation_input_tokens: 4000, cache_creation_1h_input_tokens: 4000 });
  const hold = byteBoundHold({ model, raw: JSON.stringify(body), body, maxTokens: 64, oneHourCache: true }).micros;
  expect(expected).toBeLessThanOrEqual(hold); // the 2×-sized hold covers the 2× bill → the clamp never bites
  expect(expected).toBeGreaterThan(priceUsage(model, { output_tokens: 50, cache_creation_input_tokens: 4000 })); // dearer than all-5-min
  const res = await handler(messagesReq(token, body));
  expect(res.status).toBe(200);
  expect(initial - balances.getBalance(hashToken(token))!).toBe(expected); // exact 2× split, not clamped
  expect(holdsCount(balances)).toBe(0);
});

test("non-billable outcomes refund in full (status + zero net debit)", async () => {
  // The noUsage branch legitimately logs to console.error ("refunded in full"); silence it so the
  // hundreds of property runs don't flood the test output. The property doesn't depend on the log.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  // Discriminated upstream outcome → (handler status, whether anything should be billed).
  const outcomeArb = fc.oneof(
    fc.constant({ kind: "non2xx" as const }),
    fc.constant({ kind: "noUsage" as const }),
    fc.constant({ kind: "throw" as const }),
    fc.constant({ kind: "timeout" as const }),
  );
  await fc.assert(
    fc.asyncProperty(tokenArb, modelArb, fc.integer({ min: 1, max: 200_000 }), outcomeArb, async (token, model, maxTokens, outcome) => {
      let upstream: Upstream;
      let wantStatus: number;
      switch (outcome.kind) {
        case "non2xx":
          // a 5xx is our/upstream side, so the handler now MASKS it as 503 (see relayOrMaskUpstream)
          upstream = async () => new Response(JSON.stringify({ error: "upstream boom" }), { status: 500 });
          wantStatus = 503;
          break;
        case "noUsage":
          upstream = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          wantStatus = 200;
          break;
        case "throw":
          upstream = async () => { throw new Error("connect refused"); };
          wantStatus = 502;
          break;
        case "timeout":
          upstream = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
          wantStatus = 504;
          break;
      }
      const { handler, balances } = makeHandler(upstream);
      const initial = 10_000_000_000;
      balances.credit(hashToken(token), initial);
      const res = await handler(messagesReq(token, { model, max_tokens: maxTokens, messages: [{ role: "user", content: "hi" }] }));
      expect(res.status).toBe(wantStatus);
      expect(balances.getBalance(hashToken(token))).toBe(initial); // fully refunded
      expect(holdsCount(balances)).toBe(0); // refunded (incl. the throw/timeout catch path) → journal cleared (NIT-2)
    }),
    { numRuns: 300 },
  );
  errSpy.mockRestore();
});

// The leak fix: a non-OK upstream is refunded either way, but only USER-fixable request errors are relayed
// verbatim; anything that would reveal our key, our billing, or the provider (incl. Anthropic's 400 "credit
// balance too low") is masked behind an opaque nullsink error. See relayOrMaskUpstream in handler.ts.
test("upstream errors: user-fixable relayed, our-side/billing masked (always refunded, no leak)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const model = "claude-opus-4-8";
  const cases = [
    { up: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large for model" } }), want: 400, relayed: true, label: "generic 400 invalid_request" },
    // a real bad request whose message echoes the user's own text containing "billing"/"quota": must RELAY
    // (the tightened isBillingError scopes to error.type/code + a tight phrase, not the whole body)
    { up: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content: too long; trim your notes about billing and quota usage" } }), want: 400, relayed: true, label: "400 echoing billing/quota in user text (must relay)" },
    { up: 413, body: JSON.stringify({ type: "error", error: { type: "request_too_large" } }), want: 413, relayed: true, label: "413 too large" },
    { up: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Purchase credits at https://console.anthropic.com/settings/billing" } }), want: 503, relayed: false, label: "400 billing (the leak)" },
    // OpenAI ships out-of-funds as a 429 insufficient_quota (per its docs), which retrying never clears, so
    // it must mask to 503, NOT 429 rate_limited. A real throttle 429 (below) still masks to 429.
    { up: 429, body: JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }), want: 503, relayed: false, label: "429 openai insufficient_quota -> 503" },
    // Anthropic also defines a 402 billing_error (real low-credit usually arrives as the 400 above)
    { up: 402, body: JSON.stringify({ type: "error", error: { type: "billing_error", message: "There's an issue with your billing or payment information." } }), want: 503, relayed: false, label: "402 anthropic billing_error" },
    { up: 401, body: JSON.stringify({ error: { message: "invalid api key" } }), want: 503, relayed: false, label: "401 our key" },
    { up: 403, body: "forbidden", want: 503, relayed: false, label: "403 permission" },
    { up: 429, body: "slow down", want: 429, relayed: false, label: "429 provider throttle" },
    { up: 500, body: "boom", want: 503, relayed: false, label: "500 provider error" },
    { up: 529, body: JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), want: 503, relayed: false, label: "529 overloaded" },
  ];
  for (const c of cases) {
    const { handler, balances } = makeHandler(async () => new Response(c.body, { status: c.up, headers: { "content-type": "application/json" } }));
    const token = "pr_maskcase";
    const initial = 10_000_000_000;
    balances.credit(hashToken(token), initial);
    const res = await handler(messagesReq(token, { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
    const out = await res.text();
    expect([c.label, res.status]).toEqual([c.label, c.want]);
    expect([c.label, balances.getBalance(hashToken(token))]).toEqual([c.label, initial]); // always refunded
    if (c.relayed) {
      expect([c.label, out]).toEqual([c.label, c.body]); // verbatim so the developer can fix the request
    } else {
      const lower = out.toLowerCase();
      expect([c.label, lower.includes("credit balance") || lower.includes("anthropic") || lower.includes("console")]).toEqual([c.label, false]);
      // /v1/messages → native Anthropic envelope, but the message stays an opaque generic code (no leak).
      const j = JSON.parse(out);
      expect([c.label, j.type]).toEqual([c.label, "error"]);
      expect([c.label, j.error.type]).toEqual([c.label, c.want === 429 ? "rate_limit_error" : "api_error"]);
      expect([c.label, j.error.message]).toEqual([c.label, c.want === 429 ? "rate_limited" : "service_unavailable"]);
    }
  }
  errSpy.mockRestore();
});

test("masked errors preserve a numeric Retry-After so clients still back off on the provider's delay", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const upstream: Upstream = async () => new Response("slow down", { status: 429, headers: { "content-type": "text/plain", "retry-after": "30" } });
  const { handler, balances } = makeHandler(upstream);
  const token = "pr_retryafter";
  balances.credit(hashToken(token), 10_000_000_000);
  const res = await handler(messagesReq(token, { model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("30");
  expect(res.headers.get("x-should-retry")).toBe("true"); // genuine throttle → safe to mark retryable
  const j = JSON.parse(await res.text());
  expect(j.error.type).toBe("rate_limit_error"); // native envelope
  expect(j.error.message).toBe("rate_limited"); // opaque generic code, not the upstream body
  errSpy.mockRestore();
});

test("streaming: a billing error from upstream is masked too (same helper as the buffered path)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const billing = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } });
  const { handler, balances } = makeHandler(async () => new Response(billing, { status: 400, headers: { "content-type": "application/json" } }));
  const token = "pr_streambilling";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(messagesReq(token, { model: "claude-opus-4-8", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }));
  const out = await res.text();
  expect(res.status).toBe(503);
  expect(out.toLowerCase().includes("credit balance")).toBe(false);
  const j = JSON.parse(out);
  expect(j.error.type).toBe("api_error"); // native envelope, opaque message
  expect(j.error.message).toBe("service_unavailable");
  expect(balances.getBalance(hashToken(token))).toBe(initial);
  errSpy.mockRestore();
});

// --- Streaming (SSE) ---
// A stubbed upstream whose body is a ReadableStream emitting one SSE event per pull, so a test can
// read N events then cancel mid-stream. onCancel fires when the client disconnect propagates upstream.
function streamUpstream(events: object[], onCancel?: () => void): Upstream {
  const enc = new TextEncoder();
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // index closed over per-stream; one event per pull
          (controller as any)._i = 0;
        },
        pull(controller) {
          const i = (controller as any)._i++;
          if (i >= events.length) return controller.close();
          const e = events[i] as { type: string };
          controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        },
        cancel() {
          onCancel?.();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

// A long prompt so the byte-bound hold comfortably covers the (synthetic) metered usage below — these
// example streams assert the EXACT delta-billing math, so they must stay in the sound regime (hold ≥
// actual) where the clamp doesn't bite. The actual>hold clamp has its own dedicated test above.
const streamReq = (token: string, model: string, maxTokens: number) =>
  messagesReq(token, { model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: "x".repeat(4000) }] });

test("streaming: net debit equals the final cumulative usage, and bytes pass through untouched", async () => {
  const model = "claude-opus-4-8";
  const usage = { input_tokens: 1234, output_tokens: 777, cache_creation_input_tokens: 20, cache_read_input_tokens: 50 };
  const events = [
    { type: "message_start", message: { model, usage: { ...usage, output_tokens: 1 } } },
    { type: "content_block_delta", delta: { text: "hi" } },
    { type: "message_delta", usage: { output_tokens: 400 } }, // intermediate cumulative total
    { type: "message_delta", usage: { output_tokens: usage.output_tokens } }, // final cumulative total
    { type: "message_stop" },
  ];
  const { handler, balances } = makeHandler(streamUpstream(events));
  const token = "pr_streamok";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(streamReq(token, model, 1000));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text(); // drain fully → handler settles on clean close
  expect(text).toContain("message_stop"); // SSE relayed untouched
  // Billed from message_start (input/cache) + the LAST message_delta (output), not the intermediate one.
  expect(initial - balances.getBalance(hashToken(token))!).toBe(priceUsage(model, usage));
  expect(holdsCount(balances)).toBe(0); // clean close settled → journal cleared (NIT-2)
});

test("streaming: a 1-hour cache slice present only at message_start is billed at 2×", async () => {
  const model = "claude-opus-4-8";
  // The 1h slice arrives ONLY at message_start (nested under cache_creation); the delta carries output only.
  // Isolates the start-path read — dropping it would silently bill the 3000 cache tokens at the 5-min rate.
  const events = [
    { type: "message_start", message: { model, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } } } },
    { type: "message_delta", usage: { output_tokens: 40 } },
    { type: "message_stop" },
  ];
  const { handler, balances } = makeHandler(streamUpstream(events));
  const token = "pr_stream1h_start";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  // ttl:"1h" on the system block → the provider sizes the hold at the 2× tier so it covers the 1h bill.
  const body = { model, max_tokens: 1000, stream: true,
    system: [{ type: "text", text: "cached", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: "x".repeat(4000) }] };
  const res = await handler(messagesReq(token, body));
  expect(res.status).toBe(200);
  await res.text(); // drain → settle on clean close
  const expected = priceUsage(model, { input_tokens: 10, output_tokens: 40, cache_creation_input_tokens: 3000, cache_creation_1h_input_tokens: 2000 });
  expect(initial - balances.getBalance(hashToken(token))!).toBe(expected);
  expect(holdsCount(balances)).toBe(0);
});

test("streaming: a 1-hour cache slice arriving only in a message_delta is restated and billed at 2×", async () => {
  const model = "claude-opus-4-8";
  // message_start has the total but NO nested breakdown; the 1h slice arrives in a later delta. Isolates the
  // delta-path restatement — dropping it would leave the 1h sub-count 0 and bill the 3000 tokens at 5-min.
  const events = [
    { type: "message_start", message: { model, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 3000 } } },
    { type: "message_delta", usage: { output_tokens: 40, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } } },
    { type: "message_stop" },
  ];
  const { handler, balances } = makeHandler(streamUpstream(events));
  const token = "pr_stream1h_delta";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  // ttl:"1h" on the system block → the provider sizes the hold at the 2× tier so it covers the 1h bill.
  const body = { model, max_tokens: 1000, stream: true,
    system: [{ type: "text", text: "cached", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: "x".repeat(4000) }] };
  const res = await handler(messagesReq(token, body));
  expect(res.status).toBe(200);
  await res.text();
  const expected = priceUsage(model, { input_tokens: 10, output_tokens: 40, cache_creation_input_tokens: 3000, cache_creation_1h_input_tokens: 2000 });
  expect(initial - balances.getBalance(hashToken(token))!).toBe(expected);
  expect(holdsCount(balances)).toBe(0);
});

test("streaming: a client disconnect bills the partial total and cancels upstream", async () => {
  const model = "claude-opus-4-8";
  let cancelled = false;
  const events = [
    { type: "message_start", message: { model, usage: { input_tokens: 1000, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 300 } }, // last total the client reads
    { type: "message_delta", usage: { output_tokens: 9999 } }, // generated after the client leaves — never billed
    { type: "message_stop" },
  ];
  const { handler, balances } = makeHandler(streamUpstream(events, () => { cancelled = true; }));
  const token = "pr_streamcancel";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(streamReq(token, model, 1000));
  const reader = res.body!.getReader();
  await reader.read(); // message_start
  await reader.read(); // first delta (output=300)
  await reader.cancel(); // client disconnects mid-stream
  expect(cancelled).toBe(true); // upstream generation was cancelled → spend stops
  // Billed the partial (output=300), never the later 9999 the client didn't wait for.
  expect(initial - balances.getBalance(hashToken(token))!).toBe(priceUsage(model, { input_tokens: 1000, output_tokens: 300 }));
  expect(holdsCount(balances)).toBe(0); // disconnect settled → journal cleared (NIT-2)
});

test("streaming: an error event before any usage refunds in full", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const events = [{ type: "error", error: { type: "overloaded_error", message: "overloaded" } }];
  const { handler, balances } = makeHandler(streamUpstream(events));
  const token = "pr_streamerr";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(streamReq(token, "claude-opus-4-8", 1000));
  expect(res.status).toBe(200); // headers were 200; the error arrives in-band
  await res.text(); // drain → settle
  expect(balances.getBalance(hashToken(token))).toBe(initial); // nothing billable → full refund
  expect(holdsCount(balances)).toBe(0); // error-refunded → journal cleared (NIT-2)
  errSpy.mockRestore();
});

test("streaming: the settle-deadline force-settles a client that opens but stops reading (no hold leak)", async () => {
  // The leak: a client opens the stream, reads a bit, then holds the socket open without reading or
  // disconnecting → none of done/error/cancel fire → settle() never runs → the hold sits debited forever
  // (until a restart full-refunds it while we've already paid the provider). The deadline closes it.
  const model = "claude-opus-4-8";
  let cancelled = false;
  let fire: (() => void) | undefined; // the captured force-settle callback
  const events = [
    { type: "message_start", message: { model, usage: { input_tokens: 1000, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 250 } }, // the partial the client received before stalling
    { type: "message_delta", usage: { output_tokens: 9999 } }, // generated later — never read, never billed
    { type: "message_stop" },
  ];
  const { handler, balances } = makeHandler(streamUpstream(events, () => { cancelled = true; }), {
    scheduleStreamDeadline: (onDeadline) => { fire = onDeadline; return () => {}; }, // capture, fire on demand
  });
  const token = "pr_streamstall";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(streamReq(token, model, 1000));
  const reader = res.body!.getReader();
  await reader.read(); // message_start
  await reader.read(); // delta output=250
  // Client now STALLS: it stops reading and never cancels. The hold is live and would leak forever:
  expect(holdsCount(balances)).toBe(1);

  fire!(); // the settle-deadline elapses
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget upstream cancel run

  expect(cancelled).toBe(true); // upstream generation cancelled → we stop paying the provider
  // Billed the delivered partial (output=250) — not a full refund, and not the 9999 it never received.
  expect(initial - balances.getBalance(hashToken(token))!).toBe(priceUsage(model, { input_tokens: 1000, output_tokens: 250 }));
  expect(holdsCount(balances)).toBe(0); // hold settled at the deadline → the leak is closed
});

test("streaming: a stream that finishes normally clears the settle-deadline (legit streams never force-cut)", async () => {
  const model = "claude-opus-4-8";
  let deadlineCleared = false;
  const events = [
    { type: "message_start", message: { model, usage: { input_tokens: 1000, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 200 } },
    { type: "message_stop" },
  ];
  const { handler, balances } = makeHandler(streamUpstream(events), {
    scheduleStreamDeadline: () => () => { deadlineCleared = true; }, // canceller records that it was cleared
  });
  const token = "pr_streamnatural";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(streamReq(token, model, 1000));
  await res.text(); // drain to clean close → settle on done
  expect(deadlineCleared).toBe(true); // natural settle() cleared the deadline timer → it can never fire
  expect(initial - balances.getBalance(hashToken(token))!).toBe(priceUsage(model, { input_tokens: 1000, output_tokens: 200 }));
  expect(holdsCount(balances)).toBe(0);
});

test("streaming: a client disconnect with no usage frame bills the input floor (not a full refund)", async () => {
  // The early-abort gap: the stream is open and the client disconnects before any usage-bearing frame
  // (Anthropic's message_start) is seen. The upstream has already ingested + bills us for the prompt, so a
  // full refund would be free prompt processing — we bill an input-only floor from the hold's inputTokens
  // (output 0), clamped to the hold. (An UPSTREAM error with no usage still full-refunds — see the
  // error-event test above.) The upstream emits only pre-usage frames (pings), so result() is null no
  // matter how far the response pump read ahead before cancel; the floor is derived from the same
  // byteBoundHold + priceUsage the handler uses so the assertion can't drift from the pricing internals.
  const model = "claude-opus-4-8";
  const body = { model, max_tokens: 1000, stream: true, messages: [{ role: "user", content: "x".repeat(4000) }] };
  const { inputTokens } = byteBoundHold({ model, raw: JSON.stringify(body), body, maxTokens: 1000 });
  const expectedFloor = priceUsage(model, { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

  let cancelled = false;
  const events = Array.from({ length: 20 }, () => ({ type: "ping" })); // never a message_start → never any usage
  const { handler, balances } = makeHandler(streamUpstream(events, () => { cancelled = true; }));
  const token = "pr_streamearlyabort";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(messagesReq(token, body));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  await reader.read(); // a ping — still no usage metered
  await reader.cancel(); // client disconnects with no usage seen
  expect(cancelled).toBe(true); // upstream generation was cancelled
  expect(initial - balances.getBalance(hashToken(token))!).toBe(expectedFloor);
  expect(holdsCount(balances)).toBe(0); // floor-billed → journal cleared (NIT-2)
});

test("streaming: an upstream error frame THEN a client disconnect still refunds in full (no input floor)", async () => {
  // The error+cancel coincidence: a 200-then-error stream where the client aborts on the error event
  // (common client behaviour) must NOT bill the input floor — the upstream failed and the client got
  // nothing usable. The floor is for a CLEAN early disconnect only; an errored stream full-refunds whether
  // the client drains it (the test above) or cancels on the error. The upstream has no usage frame, so
  // result() stays null; scan.errored() (set by the error event) is what blocks the floor here.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const model = "claude-opus-4-8";
  const body = { model, max_tokens: 1000, stream: true, messages: [{ role: "user", content: "x".repeat(4000) }] };
  let cancelled = false;
  const events = [
    { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
    ...Array.from({ length: 10 }, () => ({ type: "ping" })),
  ];
  const { handler, balances } = makeHandler(streamUpstream(events, () => { cancelled = true; }));
  const token = "pr_streamerrcancel";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(messagesReq(token, body));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  await reader.read(); // the error frame → scanner marks the stream errored
  await reader.cancel(); // client aborts on the error
  expect(cancelled).toBe(true);
  expect(balances.getBalance(hashToken(token))).toBe(initial); // full refund, NOT the input floor
  errSpy.mockRestore();
});

test("streaming: a non-2xx upstream is masked (429 stays 429), refunds in full, and never leaks the body", async () => {
  // Distinctive marker in the upstream body — the real no-leak assertion is that THIS never reaches the
  // client (the native masked envelope's own `type` may coincide with the upstream's, so a substring check
  // on the type would be a false signal; a unique marker is the meaningful guard).
  const upstream: Upstream = async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "LEAK-MARKER-org-acme-42 slow down" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  const { handler, balances } = makeHandler(upstream);
  const token = "pr_streamnon2xx";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(streamReq(token, "claude-opus-4-8", 1000));
  const out = await res.text();
  expect(res.status).toBe(429);
  expect(res.headers.get("x-should-retry")).toBe("true");
  const j = JSON.parse(out);
  expect(j.error.type).toBe("rate_limit_error"); // native masked envelope
  expect(j.error.message).toBe("rate_limited"); // opaque generic code
  expect(out).not.toContain("LEAK-MARKER"); // the upstream body is never relayed
  expect(balances.getBalance(hashToken(token))).toBe(initial);
});

test("upstream unreachable / timeout → native envelope, retryable, refunded, never names the upstream", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // warn+error both route here
  const token = "pr_transient";
  const cases = [
    { make: () => { throw new Error("ECONNREFUSED upstream.example"); }, status: 502, code: "upstream_unreachable" },
    { make: () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }, status: 504, code: "upstream_timeout" },
  ];
  for (const c of cases) {
    const { handler, balances } = makeHandler(async () => c.make());
    const initial = 10_000_000_000;
    balances.credit(hashToken(token), initial);
    const res = await handler(messagesReq(token, { model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
    expect([c.code, res.status]).toEqual([c.code, c.status]);
    expect([c.code, res.headers.get("x-should-retry")]).toEqual([c.code, "true"]); // transient → retryable
    const j = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect([c.code, j.type]).toEqual([c.code, "error"]);
    expect([c.code, j.error.type]).toEqual([c.code, "api_error"]); // 502/504 → native api_error
    expect([c.code, j.error.message]).toEqual([c.code, c.code]); // opaque generic code
    expect([c.code, JSON.stringify(j).includes("upstream.example")]).toEqual([c.code, false]); // host never leaked
    expect([c.code, balances.getBalance(hashToken(token))]).toEqual([c.code, initial]); // refunded in full
  }
  errSpy.mockRestore();
});

// --- The graceful-shutdown registry (index.ts drains `inflight` on SIGTERM to settle still-open streams
//     before force-close). These pin the handler's half of that contract: a live stream registers its
//     settle() and removes it on finalize, and draining the registry bills the metered partial exactly once.
test("streaming: the inflight registry holds a live stream and clears it on clean close", async () => {
  const inflight = new Set<() => void>();
  const model = "claude-opus-4-8";
  const events = [
    { type: "message_start", message: { model, usage: { input_tokens: 1234, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 777 } },
    { type: "message_stop" },
  ];
  const { handler, balances } = makeHandler(streamUpstream(events), { inflight });
  const token = "pr_inflight_lifecycle";
  balances.credit(hashToken(token), 10_000_000_000);
  const res = await handler(streamReq(token, model, 1000));
  expect(inflight.size).toBe(1); // registered the moment the response stream is built, before any read
  await res.text(); // drain to clean close → settle() runs and unregisters itself
  expect(inflight.size).toBe(0);
});

test("streaming: draining the inflight registry (shutdown) bills the metered partial, exactly once", async () => {
  const inflight = new Set<() => void>();
  const model = "claude-opus-4-8";
  const events = [
    { type: "message_start", message: { model, usage: { input_tokens: 1000, output_tokens: 1 } } },
    { type: "message_delta", usage: { output_tokens: 300 } }, // last total metered before the drain
    { type: "message_delta", usage: { output_tokens: 9999 } }, // never generated once we cancel upstream
    { type: "message_stop" },
  ];
  let cancelled = false;
  const { handler, balances } = makeHandler(streamUpstream(events, () => { cancelled = true; }), { inflight });
  const token = "pr_inflight_drain";
  const initial = 10_000_000_000;
  balances.credit(hashToken(token), initial);
  const res = await handler(streamReq(token, model, 1000));
  const reader = res.body!.getReader();
  await reader.read(); // message_start → input metered
  await reader.read(); // first delta → output=300 metered
  // Simulate index.ts's SIGTERM drain: settle every still-open stream, then it's gone from the set.
  expect(inflight.size).toBe(1);
  for (const settle of [...inflight]) settle();
  expect(inflight.size).toBe(0);
  const partial = priceUsage(model, { input_tokens: 1000, output_tokens: 300 });
  expect(initial - balances.getBalance(hashToken(token))!).toBe(partial); // partial billed, not the 9999
  expect(holdsCount(balances)).toBe(0); // drain settled the open stream → journal cleared (NIT-2)
  // Idempotent: the later natural cancel must not bill again (settle()'s `settled` guard).
  await reader.cancel().catch(() => {});
  expect(cancelled).toBe(true);
  expect(initial - balances.getBalance(hashToken(token))!).toBe(partial);
});

test("upstream request strips client auth/non-allowlisted-beta/org, injects our key, keeps the rest; response hides our org", async () => {
  const safeVal = fc.stringMatching(/^[A-Za-z0-9._-]+$/);
  const betaArb = safeVal.filter((b) => !b.startsWith("context-management-")); // premium/unknown betas are stripped (the safe subset has its own test below)
  await fc.assert(
    fc.asyncProperty(tokenArb, betaArb, safeVal, safeVal, async (token, beta, auth, custom) => {
      let captured: Headers | undefined;
      const upstream: Upstream = async (_url, init) => {
        captured = new Headers(init.headers);
        return new Response(JSON.stringify({ model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json", "anthropic-organization-id": "OUR-SECRET-ORG" },
        });
      };
      const { handler, balances } = makeHandler(upstream);
      balances.credit(hashToken(token), 10_000_000_000);
      const req = new Request("https://proxy.local/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": token,
          authorization: `Bearer ${auth}`,
          "anthropic-beta": beta,
          "anthropic-organization-id": "client-org",
          "x-custom-passthrough": custom,
        },
        body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      const res = await handler(req);
      expect(res.status).toBe(200);
      // Forwarded request: our key injected, client secrets/beta/org stripped, custom header survives.
      expect(captured!.get("x-api-key")).toBe("real-upstream-key");
      expect(captured!.has("authorization")).toBe(false);
      expect(captured!.has("anthropic-beta")).toBe(false);
      expect(captured!.has("anthropic-organization-id")).toBe(false);
      expect(captured!.get("anthropic-version")).toBe("2023-06-01");
      expect(captured!.get("x-custom-passthrough")).toBe(custom);
      // Response to the client must not leak our account identity.
      expect(res.headers.has("anthropic-organization-id")).toBe(false);
    }),
    { numRuns: 200 },
  );
});

test("the flat-rate-safe beta (context editing) is forwarded; premium betas in the same header are stripped", async () => {
  // Claude Code sends `context_management` (context editing) gated behind the context-management beta. We
  // strip anthropic-beta wholesale to block premium betas, then re-add only the safe subset — so the body
  // field is no longer orphaned (Anthropic rejected it `Extra inputs are not permitted`), while fast mode /
  // 1M-context stay stripped.
  const token = "pr_beta";
  let captured: Headers | undefined;
  const { handler, balances } = makeHandler(async (_url, init) => {
    captured = new Headers(init.headers);
    return new Response(JSON.stringify({ model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  balances.credit(hashToken(token), 10_000_000_000);
  const req = new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": token,
      // a real Claude Code mix: the safe context-management beta alongside the premium 1M-context beta
      "anthropic-beta": "context-1m-2025-08-07, context-management-2025-06-27",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 16,
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect((await handler(req)).status).toBe(200);
  // Only the safe marker survives — premium context-1m is dropped.
  expect(captured!.get("anthropic-beta")).toBe("context-management-2025-06-27");
});

test("a request with ONLY premium betas forwards no anthropic-beta at all", async () => {
  const token = "pr_beta2";
  let captured: Headers | undefined;
  const { handler, balances } = makeHandler(async (_url, init) => {
    captured = new Headers(init.headers);
    return new Response(JSON.stringify({ model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  balances.credit(hashToken(token), 10_000_000_000);
  const req = new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token, "anthropic-beta": "context-1m-2025-08-07, fast-mode-2025-01-01" },
    body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  expect((await handler(req)).status).toBe(200);
  expect(captured!.has("anthropic-beta")).toBe(false); // nothing safe to keep → header absent
});

test("/buy quotes enough XMR to never under-charge credit_usd × MARGIN", async () => {
  await fc.assert(
    fc.asyncProperty(
      hexStr(64), // valid 64-hex hash
      fc.integer({ min: 5, max: 2000 }), // within [BUY_MIN_USD, BUY_MAX_USD]
      fc.integer({ min: 50, max: 500 }), // plausible XMR/USD rate
      async (hash, creditUsd, rate) => {
        const { handler, orders } = makeHandler(ok("claude-opus-4-8", {}), { xmrUsd: async () => rate });
        const req = new Request("https://proxy.local/buy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash, credit_usd: creditUsd }),
        });
        const res = await handler(req);
        expect(res.status).toBe(200);
        const quote = (await res.json()) as { amount: string; rate_usd: number; expires_at: number };
        // The quoted coin amount, valued at the quoted rate, must be at least credit_usd × MARGIN (margin never eroded).
        expect(Number(quote.amount) * rate).toBeGreaterThanOrEqual(creditUsd * 1.15 - 1e-6);
        // An order was recorded for later settlement.
        expect(orders.openCount()).toBe(1);
        // The advertised deadline IS the honored horizon: expires_at == the order's stored created_at +
        // the backstop window — one timestamp, one window. Catches a regression to a separate advisory
        // TTL (a different base time) or a different offset between quoted and purged deadlines.
        const stored = orders.openOrders()[0]!;
        expect(quote.expires_at).toBe(stored.created_at + ORDER_TTL_MS);
      },
    ),
    { numRuns: 300 },
  );
});

test("the gate fails closed: rejects never bill, never reach upstream, and wear the native Anthropic error envelope", async () => {
  const valid = { model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
  // /v1/messages is the Anthropic path, so every gate reject is {type:"error",error:{type,message}} with the
  // status-appropriate native `type` (so a stock SDK classifies it), plus x-should-retry:false (terminal —
  // retrying never clears a bad token / unpriced model / no funds). `msg` is a substring of error.message:
  // it pins the SPECIFIC reason (the two 400s and the two 401s share a status but differ here).
  const cases: Array<{ name: string; token?: string | null; body: unknown; status: number; type: string; msg: string; fund?: number }> = [
    // The body-error cases use a FUNDED token: an unknown token is now shed BEFORE the body is parsed, so to
    // reach (and pin) each body gate the token must clear the validity shed first.
    { name: "inference_geo", token: "pr_x", fund: 5_000_000, body: { ...valid, inference_geo: "us" }, status: 400, type: "invalid_request_error", msg: "unsupported_option" },
    { name: "server tool", token: "pr_x", fund: 5_000_000, body: { ...valid, tools: [{ type: "web_search_20250305", name: "ws" }] }, status: 400, type: "invalid_request_error", msg: "unsupported_tool" },
    { name: "unpriced model", token: "pr_x", fund: 5_000_000, body: { ...valid, model: "gpt-4" }, status: 400, type: "invalid_request_error", msg: "unsupported_model" },
    { name: "no max_tokens", token: "pr_x", fund: 5_000_000, body: { model: "claude-opus-4-8", messages: [] }, status: 400, type: "invalid_request_error", msg: "max_tokens_required" },
    { name: "no token", token: null, body: valid, status: 401, type: "authentication_error", msg: "no API key" },
    { name: "unknown token", token: "pr_unfunded", body: valid, status: 401, type: "authentication_error", msg: "invalid_token" },
    { name: "insufficient balance", token: "pr_poor", body: valid, status: 402, type: "billing_error", msg: "insufficient_balance", fund: 1 },
  ];
  for (const c of cases) {
    let reached = false;
    const { handler, balances } = makeHandler(async () => {
      reached = true;
      return new Response(JSON.stringify({ model: "claude-opus-4-8", usage: { output_tokens: 1 } }), { status: 200 });
    });
    if (c.fund) balances.credit(hashToken(c.token!), c.fund);
    const before = c.token && c.fund ? balances.getBalance(hashToken(c.token)) : null;
    const res = await handler(messagesReq(c.token === undefined ? "pr_x" : c.token, c.body));
    expect(res.status, c.name).toBe(c.status);
    expect(res.headers.get("x-should-retry"), c.name).toBe("false");
    const j = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(j.type, c.name).toBe("error");
    expect(j.error.type, c.name).toBe(c.type);
    expect(j.error.message, c.name).toContain(c.msg);
    expect(reached, `${c.name} must not reach upstream`).toBe(false);
    if (c.fund) expect(balances.getBalance(hashToken(c.token!)), `${c.name} balance unchanged`).toBe(before);
  }
});

test("/v1/messages authenticates a Bearer token too (not only x-api-key), and still injects our key", async () => {
  // Claude Code under ANTHROPIC_AUTH_TOKEN — and other agents/SDKs that only speak Bearer — send the proxy
  // token as Authorization: Bearer with NO x-api-key. That used to 401 (we read x-api-key only); now it
  // authenticates. The client Bearer is still stripped before forwarding and our real upstream key injected.
  const token = "pr_bearer";
  let captured: Headers | undefined;
  const { handler, balances } = makeHandler(async (_url, init) => {
    captured = new Headers(init.headers);
    return new Response(JSON.stringify({ model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  balances.credit(hashToken(token), 10_000_000_000);
  const res = await handler(
    new Request("https://proxy.local/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, // no x-api-key
      body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    }),
  );
  expect(res.status).toBe(200);
  expect(captured!.get("x-api-key")).toBe("real-upstream-key"); // our key injected
  expect(captured!.has("authorization")).toBe(false); // client Bearer stripped, never forwarded
});

test("the allowlist is exact: only POST /v1/messages and the buy/balance paths are served", async () => {
  const { handler } = makeHandler(async () => new Response("{}", { status: 200 }));
  for (const [method, path] of [["POST", "/v1/messages/batches"], ["GET", "/v1/messages"], ["DELETE", "/v1/messages"], ["POST", "/v1/models"]] as const) {
    const res = await handler(new Request(`https://proxy.local${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" }));
    expect(res.status, `${method} ${path}`).toBe(404);
  }
});

// --- /balance and /buy ---

const balanceReq = (token: string | null) =>
  new Request("https://proxy.local/balance", { method: "GET", headers: token === null ? {} : { "x-api-key": token } });
const buyReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://proxy.local/buy", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("/balance reports the token's own balance; unknown/missing token → 401", async () => {
  await fc.assert(
    fc.asyncProperty(tokenArb, fc.nat({ max: 1_000_000_000 }), async (token, micros) => {
      const { handler, balances } = makeHandler(ok("claude-opus-4-8", {}));
      balances.credit(hashToken(token), micros);
      const res = await handler(balanceReq(token));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { balance_usd: number }).balance_usd).toBe(micros / 1_000_000);
    }),
  );
  const { handler } = makeHandler(ok("claude-opus-4-8", {}));
  expect((await handler(balanceReq("pr_never_issued"))).status).toBe(401);
  expect((await handler(balanceReq(null))).status).toBe(401);
});

test("/buy rejects out-of-range or non-numeric credit_usd before storing anything", async () => {
  const badAmount = fc.oneof(
    fc.double({ max: 5, noNaN: true, noDefaultInfinity: true }).filter((n) => n < 5), // below BUY_MIN_USD (incl. ≤0)
    fc.double({ min: 2000, noNaN: true, noDefaultInfinity: true }).filter((n) => n > 2000), // above BUY_MAX_USD
    fc.constantFrom(NaN, Infinity, -Infinity, "10", null, undefined, {}),
  );
  await fc.assert(
    fc.asyncProperty(hexStr(64), badAmount, async (hash, credit_usd) => {
      const { handler, orders } = makeHandler(ok("claude-opus-4-8", {}));
      const res = await handler(buyReq({ hash, credit_usd }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_amount");
      expect(orders.openCount()).toBe(0);
    }),
  );
});

test("/buy treats a degenerate rate (0/negative/NaN/Infinity) as unavailable, storing nothing", async () => {
  // rateUsd() RESOLVING (not throwing) to a non-finite/non-positive value must not poison the quote: a
  // 0/Infinity rate makes expectedAtomic 0 (an order settle's `expected_atomic <= 0` guard can never
  // credit), a negative rate a negative expectation. Reject with a retryable 503 and persist no order.
  const badRate = fc.constantFrom(0, -1, -0.5, NaN, Infinity, -Infinity);
  await fc.assert(
    fc.asyncProperty(hexStr(64), fc.integer({ min: 5, max: 2000 }), badRate, async (hash, credit_usd, rate) => {
      const { handler, orders } = makeHandler(ok("claude-opus-4-8", {}), { xmrUsd: async () => rate });
      const res = await handler(buyReq({ hash, credit_usd }));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("rate_unavailable");
      expect(orders.openCount()).toBe(0);
    }),
  );
});

test("/buy rejects malformed JSON and non-64-hex hashes", async () => {
  const { handler } = makeHandler(ok("claude-opus-4-8", {}));
  expect(((await (await handler(buyReq("not json"))).json()) as { error: string }).error).toBe("invalid_json");
  for (const hash of ["", "xyz", "g".repeat(64), "a".repeat(63), "a".repeat(65), "A".repeat(64)]) {
    const res = await handler(buyReq({ hash, credit_usd: 10 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_hash");
  }
});

test("/v1/messages rejects a body declaring an oversized content-length (413), before auth/parse", async () => {
  // Enforces MAX_MESSAGES_BODY_BYTES (injected here) on the metered route. The header check fires before
  // the token gate, so no valid token is needed; a small injected cap + a large declared length => 413.
  const { handler } = makeHandler(ok("claude-opus-4-8", {}), { maxMessagesBodyBytes: 100 });
  const req = new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "1000000" },
    body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await handler(req);
  expect(res.status).toBe(413);
  expect(res.headers.get("x-should-retry")).toBe("false");
  const j = (await res.json()) as { error: { type: string; message: string } };
  expect(j.error.type).toBe("request_too_large"); // native Anthropic envelope, not the old {error:"..."}
  expect(j.error.message).toContain("payload_too_large");
});

test("/buy rejects an oversized body (413)", async () => {
  const { handler } = makeHandler(ok("claude-opus-4-8", {}), { maxBuyBodyBytes: 50 });
  // Both the real (~90-byte) body length and the explicit header exceed the 50-byte cap.
  const res = await handler(buyReq({ hash: "a".repeat(64), credit_usd: 10 }, { "content-length": "100000" }));
  expect(res.status).toBe(413);
});

test("/buy enforces abuse caps and fails closed on rate/wallet errors", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // rate/wallet failures log
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  // Global ceiling: the second open order is rejected (the cap is checked before createAddress).
  {
    const { handler } = makeHandler(ok("x", {}), { maxOpenOrders: 1 });
    expect((await handler(buyReq({ hash: A, credit_usd: 10 }))).status).toBe(200);
    const res = await handler(buyReq({ hash: B, credit_usd: 10 }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("busy_try_later");
  }
  // Rate source down → 503, no order stored.
  {
    const { handler, orders } = makeHandler(ok("x", {}), { xmrUsd: async () => { throw new Error("down"); } });
    const res = await handler(buyReq({ hash: A, credit_usd: 10 }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("rate_unavailable");
    expect(orders.openCount()).toBe(0);
  }
  // Wallet down → 502, no order stored.
  {
    const { handler, orders } = makeHandler(ok("x", {}), { createAddress: async () => { throw new Error("down"); } });
    const res = await handler(buyReq({ hash: A, credit_usd: 10 }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("wallet_unavailable");
    expect(orders.openCount()).toBe(0);
  }
  errSpy.mockRestore();
});

test("/buy reserves a slot before createAddress: a concurrent burst at the cap mints no orphan subaddress", async () => {
  // The slot-race-lost backstop path logs a warn (→ console.error); silence it in case it ever fires.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  // createAddress suspends until released so both requests are in flight at once. The in-process
  // reservation (openCount() + pendingCreates) must shed the loser at the gate BEFORE it reaches
  // createAddress — so only ONE address is ever minted and the cap (1) is never overshot. This is the
  // orphan-on-race the old post-create tryAddOrder claim could only reject *after* the subaddress existed.
  let creates = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const createAddress = async () => {
    creates++;
    await gate;
    return { address: `8addr${creates}`, orderIndex: creates - 1 };
  };
  const { handler, orders } = makeHandler(ok("x", {}), { maxOpenOrders: 1, createAddress });
  const p1 = handler(buyReq({ hash: "a".repeat(64), credit_usd: 10 }));
  const p2 = handler(buyReq({ hash: "b".repeat(64), credit_usd: 10 }));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  expect([r1.status, r2.status].sort()).toEqual([200, 503]); // exactly one admitted, one rejected
  expect(creates).toBe(1); // the loser was shed BEFORE createAddress — no orphan subaddress minted
  expect(orders.openCount()).toBe(1); // cap never overshot
  errSpy.mockRestore();
});

test("/buy releases the reservation after a successful order (sequential buys don't leak slots)", async () => {
  // A missing/wrong `finally pendingCreates--` would leave the in-process counter inflated after every
  // success, so openCount() + pendingCreates would hit the cap at half the real ceiling and the Nth buy
  // would falsely 503. With maxOpen=2 and the reservation correctly released, two sequential orders land.
  let idx = 0;
  const createAddress = async () => ({ address: `8addr${idx}`, orderIndex: idx++ });
  const { handler, orders } = makeHandler(ok("x", {}), { maxOpenOrders: 2, createAddress });
  const r1 = await handler(buyReq({ hash: "a".repeat(64), credit_usd: 10 }));
  const r2 = await handler(buyReq({ hash: "b".repeat(64), credit_usd: 10 }));
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200); // reservation from #1 was released — #2 isn't falsely capped
  expect(orders.openCount()).toBe(2);
});

test("orders.tryAddOrder is the hard cap backstop: count-gated insert rejects past maxOpen", async () => {
  // The in-process reservation prevents the handler from ever reaching a losing tryAddOrder in
  // single-process, but tryAddOrder remains the authoritative ceiling that also holds across processes
  // sharing pending.db (where the in-memory counter can't see the other). Exercise it directly.
  const store = openOrderStore(":memory:");
  const mk = (i: number) => ({ rail: "monero", order_index: i, address: `8addr${i}`, hash: `${i}`.repeat(64).slice(0, 64), expected_atomic: 1, credit_micros: 1, received_atomic: 0, created_at: 0, rate_usd: 0 });
  expect(store.tryAddOrder(mk(0), 1)).toBe(true); // 0 < 1 → lands
  expect(store.tryAddOrder(mk(1), 1)).toBe(false); // count 1, not < 1 → rejected
  expect(store.openCount()).toBe(1); // the second never landed a row
});

test("/buy returns 503 and stores nothing when the cross-process claim loses the race after createAddress", async () => {
  // Covers the post-createAddress backstop (handler ~928-930): the in-process reservation PASSES (openCount
  // under cap) but tryAddOrder returns false — the authoritative count-gated insert that ALSO holds across
  // processes sharing pending.db, where the in-memory counter can't see the other instance. The address was
  // minted (the logged "orphan"), but no row commits and the buyer gets a retryable 503. Distinct from the
  // pre-check 503 and the single-process reservation test above (both shed BEFORE createAddress).
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // the orphan path logs a warn
  const realOrders = openOrderStore(":memory:");
  const orders = { ...realOrders, tryAddOrder: () => false }; // openCount stays 0 → pre-checks pass; claim fails
  let creates = 0;
  const { handler } = makeHandler(ok("x", {}), {
    orders,
    createAddress: async () => {
      creates++;
      return { address: "8Orphan", orderIndex: 0 };
    },
  });
  const res = await handler(buyReq({ hash: "a".repeat(64), credit_usd: 10 }));
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toBe("busy_try_later");
  expect(creates).toBe(1); // the address WAS minted — the orphan the warn logs
  expect(realOrders.openCount()).toBe(0); // ...but nothing was committed
  errSpy.mockRestore();
});

test("/v1/messages rejects malformed JSON from a FUNDED token with a native 400 (validity shed passed, before billing)", async () => {
  // Covers handleMetered's parse catch: a present, FUNDED token clears the auth + validity sheds, then an
  // unparseable body is a terminal native 400 — never billed, never forwarded.
  let reached = false;
  const { handler, balances } = makeHandler(async () => {
    reached = true;
    return new Response("{}", { status: 200 });
  });
  balances.credit(hashToken("pr_funded"), 5_000_000);
  const req = new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "pr_funded" },
    body: "{ not valid json",
  });
  const res = await handler(req);
  expect(res.status).toBe(400);
  expect(res.headers.get("x-should-retry")).toBe("false");
  const j = (await res.json()) as { type: string; error: { type: string; message: string } };
  expect(j.type).toBe("error");
  expect(j.error.type).toBe("invalid_request_error");
  expect(j.error.message).toContain("invalid_json");
  expect(reached).toBe(false); // gate reject — upstream never touched
});

test("/v1/messages sheds an UNKNOWN token BEFORE buffering/parsing the body (the unfunded-flood guard)", async () => {
  // The free DoS vector is a flood of made-up tokens carrying huge bodies. Every junk string is "not in the
  // DB", so the validity shed runs BEFORE req.text(): an unknown token + an UNPARSEABLE body returns 401
  // invalid_token, NOT 400 invalid_json — which proves the (up to 32 MiB) buffer+parse is never reached (a
  // parsed body would have produced the invalid_json 400). A funded token still buffers+parses (test above).
  let reached = false;
  const { handler } = makeHandler(async () => {
    reached = true;
    return new Response("{}", { status: 200 });
  });
  const res = await handler(
    new Request("https://proxy.local/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "pr_made_up_junk" },
      body: "{ not valid json", // 400 invalid_json IF we buffered+parsed — we must shed to 401 first
    }),
  );
  expect(res.status).toBe(401);
  const j = (await res.json()) as { type: string; error: { type: string; message: string } };
  expect(j.type).toBe("error");
  expect(j.error.type).toBe("authentication_error");
  expect(j.error.message).toContain("invalid_token");
  expect(reached).toBe(false);
});

test("/buy global rate limit sheds excess with 429 before any work (identity-free)", async () => {
  // capacity 1, no refill, frozen clock → first /buy passes, the next is shed. The bucket keys on
  // nothing (no IP, no token) — one shared counter for every caller — and rejects before parse/wallet.
  const buyRateLimit = makeTokenBucket({ capacity: 1, refillPerSec: 0, now: () => 0 });
  const { handler, orders } = makeHandler(ok("x", {}), { buyRateLimit });
  const first = await handler(buyReq({ hash: "a".repeat(64), credit_usd: 10 }));
  expect(first.status).toBe(200);
  const second = await handler(buyReq({ hash: "b".repeat(64), credit_usd: 10 }));
  expect(second.status).toBe(429);
  expect(((await second.json()) as { error: string }).error).toBe("rate_limited");
  expect(orders.openCount()).toBe(1); // the shed request created no order
});

// --- /order-status (live payment progress, keyed by hash, never the raw token) ---

const orderStatusReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://proxy.local/order-status", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("/balance + /order-status share one global read throttle: sheds with 429 + Retry-After (identity-free)", async () => {
  // capacity 1, no refill, frozen clock → the first read passes, the next is shed. The bucket is SHARED
  // across both read endpoints (a /balance consume leaves /order-status drained) and keys on nothing —
  // no IP, no token, one counter for every caller.
  const readRateLimit = makeTokenBucket({ capacity: 1, refillPerSec: 0, now: () => 0 });
  const { handler, balances } = makeHandler(ok("x", {}), { readRateLimit });
  balances.credit(hashToken("pr_reader"), 5_000_000);
  const first = await handler(balanceReq("pr_reader"));
  expect(first.status).toBe(200); // first read consumes the only token
  const second = await handler(orderStatusReq({ hash: "a".repeat(64) }));
  expect(second.status).toBe(429); // shared bucket already drained by the /balance read
  expect(((await second.json()) as { error: string }).error).toBe("rate_limited");
  expect(second.headers.get("retry-after")).toBe("1");
});

test("a tokenless metered request is rejected BEFORE the body is parsed (auth-before-buffer)", async () => {
  // No x-api-key/Bearer + a body that is NOT valid JSON. Token auth is header-only and now runs before the
  // buffer/parse, so this is a 401 — not 400 invalid_json — proving an unauthenticated flood never reaches
  // the 32 MiB buffer+parse. The reason is the disambiguated NO-KEY 401 ("no API key"), distinct from a
  // present-but-unknown token's "invalid_token" — which now ALSO sheds before the buffer (see the unknown-token
  // guard test above), so both an unauthenticated and an unknown-token flood are stopped pre-buffer.
  let reached = false;
  const { handler } = makeHandler(async () => {
    reached = true;
    return new Response("{}", { status: 200 });
  });
  const res = await handler(
    new Request("https://proxy.local/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" }, // deliberately no x-api-key / Authorization
      body: "this is not valid json{",
    }),
  );
  expect(res.status).toBe(401);
  const j = (await res.json()) as { error: { type: string; message: string } };
  expect(j.error.type).toBe("authentication_error");
  expect(j.error.message).toContain("no API key"); // NOT "invalid_token" — disambiguated missing-key reason
  expect(reached).toBe(false);
});

test("/order-status returns closed for a hash with no open order (credited/reaped/never-existed are indistinguishable)", async () => {
  const { handler } = makeHandler(ok("x", {}));
  const res = await handler(orderStatusReq({ hash: "a".repeat(64) }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { state: string }).state).toBe("closed");
});

test("/order-status reflects an open order's live progress: waiting → confirming → finalizing", async () => {
  const hash = "a".repeat(64);
  // A controllable progress source; createAddress (makeHandler default) yields orderIndex 0, so the
  // order's subaddress is 0. confirmations dep is 10.
  let progress: { received_atomic: number; confirmations: number } | undefined;
  const { handler, orders } = makeHandler(ok("x", {}), { orderStatus: () => progress });
  expect((await handler(buyReq({ hash, credit_usd: 10 }))).status).toBe(200);
  const order = orders.openOrders()[0]!;

  // No sighting yet → waiting, but the order's static fields are still reported.
  progress = undefined;
  let body = (await (await handler(orderStatusReq({ hash }))).json()) as any;
  expect(body.state).toBe("waiting");
  expect(body.required).toBe(10);
  expect(body.expected).toBe((order.expected_atomic / ATOMIC_PER_XMR).toFixed(12));
  expect(body.expires_at).toBe(order.created_at + ORDER_TTL_MS);

  // Seen but under CONFIRMATIONS → confirming n/N, with the received amount surfaced.
  progress = { received_atomic: 500, confirmations: 3 };
  body = (await (await handler(orderStatusReq({ hash }))).json()) as any;
  expect(body.state).toBe("confirming");
  expect(body.confirmations).toBe(3);
  expect(body.received).toBe((500 / ATOMIC_PER_XMR).toFixed(12));

  // CONFIRMATIONS met but not yet credited+closed → finalizing (client should now check /balance).
  progress = { received_atomic: 500, confirmations: 10 };
  body = (await (await handler(orderStatusReq({ hash }))).json()) as any;
  expect(body.state).toBe("finalizing");
});

test("/order-status reports `detected`, never `waiting`, for a payment seen before a RESTART", async () => {
  // The live progress map is process-local: a deploy, restore or crash rebuilds it EMPTY, and the poller's
  // first tick is exactly when the wallet is most likely still resyncing (it then reports an empty inbound
  // list as a SUCCESS). Without a durable sighting this order reports "waiting" and the client renders "not
  // seen yet" over a payment we HAVE seen. A buyer who believes that may pay again — and pay-once already
  // closed the order on the first deposit, so settle() drops the second one and it can never be credited.
  const hash = "a".repeat(64);
  let progress: { received_atomic: number; confirmations: number } | undefined;
  const { handler, orders } = makeHandler(ok("x", {}), { orderStatus: () => progress });
  expect((await handler(buyReq({ hash, credit_usd: 10 }))).status).toBe(200);
  const order = orders.openOrders()[0]!;

  // The poller sights a still-confirming deposit: it persists seen_at and populates live progress.
  orders.markSeen(order.order_index, order.rail, 1_700_000_000_000);
  progress = { received_atomic: 500, confirmations: 3 };
  let body = (await (await handler(orderStatusReq({ hash }))).json()) as any;
  expect(body.state).toBe("confirming");

  // --- RESTART: the progress map is gone; the wallet is still resyncing, so nothing repopulates it. ---
  progress = undefined;
  body = (await (await handler(orderStatusReq({ hash }))).json()) as any;
  expect(body.state).toBe("detected"); // NOT "waiting" — seen_at survived on disk
  expect(body.required).toBe(10); // static fields still reported

  // Once the wallet catches up, live progress resumes exactly as before.
  progress = { received_atomic: 500, confirmations: 4 };
  body = (await (await handler(orderStatusReq({ hash }))).json()) as any;
  expect(body.state).toBe("confirming");
  expect(body.confirmations).toBe(4);
});

test("/order-status still reports `waiting` for an order never sighted (detected is not a free pass)", async () => {
  const hash = "b".repeat(64);
  const { handler } = makeHandler(ok("x", {}), { orderStatus: () => undefined });
  expect((await handler(buyReq({ hash, credit_usd: 10 }))).status).toBe(200);
  const body = (await (await handler(orderStatusReq({ hash }))).json()) as any;
  expect(body.state).toBe("waiting"); // seen_at is NULL — nobody has paid
});

test("/order-status rejects malformed JSON, non-64-hex hashes, and oversized bodies", async () => {
  const { handler } = makeHandler(ok("x", {}));
  expect(((await (await handler(orderStatusReq("not json"))).json()) as { error: string }).error).toBe("invalid_json");
  for (const hash of ["", "xyz", "g".repeat(64), "a".repeat(63), "a".repeat(65), "A".repeat(64)]) {
    const res = await handler(orderStatusReq({ hash }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_hash");
  }
  const { handler: h2 } = makeHandler(ok("x", {}), { maxBuyBodyBytes: 10 });
  const big = await h2(orderStatusReq({ hash: "a".repeat(64) }, { "content-length": "100000" }));
  expect(big.status).toBe(413);
});

test("F3: a 2xx with NEGATIVE usage never inflates the balance (cost floored at 0 → full refund)", async () => {
  // priceUsage of negative tokens is negative; the billActual floor (Math.max(0, actual)) must turn that
  // into a FULL refund, never credit MORE than was held. (Not reachable under honest upstreams — a latent
  // foot-gun the floor closes.)
  const token = "pr_negusage";
  const negUsage = { input_tokens: -1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const { handler, balances } = makeHandler(ok("claude-haiku-4-5", negUsage));
  const hash = hashToken(token);
  balances.credit(hash, 1_000_000); // fund $1
  const res = await handler(messagesReq(token, { model: "claude-haiku-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(200);
  expect(balances.getBalance(hash)).toBe(1_000_000); // back to exactly the funded amount — NOT inflated
  expect(holdsCount(balances)).toBe(0); // negative-cost full refund → journal cleared (NIT-2)
});

// --- multi-rail (task 4): /buy routes to the requested rail, tags the order, and /order-status renders it ---
const RAIL_XMR: RailView = { name: "monero", createAddress: async () => ({ address: "8xmraddr", orderIndex: 0 }), rateUsd: async () => 150, scale: 1_000_000_000_000, unit: "XMR", confirmations: 10, paymentUri: (a, amt) => `monero:${a}?tx_amount=${amt}` };
const RAIL_BTC: RailView = { name: "bitcoin", createAddress: async () => ({ address: "bc1qtest", orderIndex: 0 }), rateUsd: async () => 60000, scale: 100_000_000, unit: "BTC", confirmations: 3, paymentUri: (a, amt) => `bitcoin:${a}?amount=${amt}` };

test("multi-rail: /buy?rail=bitcoin routes to BTC, tags the order bitcoin, and /order-status renders BTC", async () => {
  const rails = new Map<string, RailView>([["monero", RAIL_XMR], ["bitcoin", RAIL_BTC]]);
  const { handler, orders } = makeHandler(ok("x", {}), { rails, defaultRail: "monero" });
  const hash = "a".repeat(64);

  const res = await handler(buyReq({ hash, credit_usd: 30, rail: "bitcoin" }));
  expect(res.status).toBe(200);
  const q = (await res.json()) as { unit: string; amount: string; pay_uri: string; confirmations_required: number };
  expect(q.unit).toBe("BTC");
  expect(q.confirmations_required).toBe(3); // BTC's confs, not Monero's 10
  expect(q.pay_uri).toContain("bitcoin:bc1qtest");
  expect(q.amount).toBe("0.00057500"); // 30 × 1.15 / 60000 BTC at 8-decimal sats precision

  expect(orders.openOrders()[0]!.rail).toBe("bitcoin"); // order tagged with the chosen rail

  const st = await handler(orderStatusReq({ hash }));
  const s = (await st.json()) as { unit: string; required: number; expected: string };
  expect(s.unit).toBe("BTC"); // formatted by the ORDER's rail, not the default (Monero)
  expect(s.required).toBe(3);
  expect(s.expected).toBe("0.00057500");
});

test("multi-rail: /buy with a rail not in the registry → 400 unknown_rail, nothing stored", async () => {
  const rails = new Map<string, RailView>([["monero", RAIL_XMR]]);
  const { handler, orders } = makeHandler(ok("x", {}), { rails, defaultRail: "monero" });
  const res = await handler(buyReq({ hash: "b".repeat(64), credit_usd: 30, rail: "litecoin" }));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("unknown_rail");
  expect(orders.openCount()).toBe(0);
});

test("GET /rails lists the active rails + the default (for the client coin picker)", async () => {
  const rails = new Map<string, RailView>([["monero", RAIL_XMR], ["bitcoin", RAIL_BTC]]);
  const { handler } = makeHandler(ok("x", {}), { rails, defaultRail: "monero" });
  const res = await handler(new Request("https://proxy.local/rails", { method: "GET" }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { default: string; rails: { name: string; unit: string; confirmations: number }[] };
  expect(body.default).toBe("monero");
  expect(body.rails).toEqual([
    { name: "monero", unit: "XMR", confirmations: 10 },
    { name: "bitcoin", unit: "BTC", confirmations: 3 },
  ]);
});

// --- Mutation-surfaced gate edges ---

// handler.ts:320 — the pre-flight funds gate `preBalance <= 0` survived `→ preBalance < 0`. A token at EXACTLY
// 0 must 402 HERE, before the estimator runs — else a broke token forces a free upstream count_tokens
// round-trip (the free-work abuse this gate exists to shed) before openHold rejects it.
test("a token at exactly balance 0 is 402'd before the hold estimator runs (preBalance <= 0)", async () => {
  let estCalls = 0;
  const estimateHold = (input: Parameters<typeof byteBoundHold>[0]) => { estCalls++; return byteBoundHold(input); };
  // estimateHold now lives under the nested anthropic config, so override the whole object (the deps spread
  // replaces anthropic wholesale) — restating the base creds with the counting estimator swapped in.
  const { handler, balances } = makeHandler(ok("claude-opus-4-8", { output_tokens: 1 }), {
    anthropic: { apiKey: "real-upstream-key", baseUrl: "https://upstream.example", version: "2023-06-01", estimateHold },
  });
  const token = "pr_zero";
  balances.credit(hashToken(token), 0); // a real row at exactly 0 (not an unknown token → that's 401)
  const res = await handler(messagesReq(token, { model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(402);
  expect(((await res.json()) as { error: { message: string } }).error.message).toContain("insufficient_balance");
  expect(estCalls).toBe(0); // the `< 0` mutant would let 0 through and call the estimator
});

// endpoints/buy.ts:42 — the credit_usd validation `typeof≠number || !finite || <MIN || >MAX` survived the
// `||`→`&&` mutant (which never rejects). A below-minimum amount must 400 invalid_amount and store nothing.
test("/buy rejects a below-minimum credit_usd with 400 invalid_amount (validation is OR-joined)", async () => {
  const { handler, orders } = makeHandler(ok("x", {}));
  const res = await handler(buyReq({ hash: "a".repeat(64), credit_usd: 1 })); // < buyMinUsd (5 in this harness)
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid_amount");
  expect(orders.openCount()).toBe(0); // nothing reserved
});
