// The hold-soundness invariant: the byte-bound hold is a true UPPER BOUND on what a request can be
// billed, so reconciliation (credit = hold − actual, in handler.ts) can never go negative. This is the
// property that closes the free-usage exploit — a CJK/dense prompt or an all-cache-write request can no
// longer be billed above its hold and drive the balance below zero. Pure (no handler/DB), so it runs
// fast at high numRuns.
import { test, expect } from "bun:test";
import fc from "fast-check";
import { byteBoundHold, makeCountTokensHold, HOLD_INPUT_MARGIN, HOLD_INPUT_PAD, ANTHROPIC_COUNT_OMIT } from "../src/hold";
import { priceUsage, priceHoldBound } from "../src/cost";
import { hasOneHourCacheControl } from "../src/providers/anthropic";

// Span the live rate shapes in prices.json (cheapest → priciest). The retired exotic shapes
// (claude-3-haiku at 1.2×, claude-3-sonnet-20240229 with cache_write CHEAPER than input) were pruned
// from prices.json along with the other dead models, so they can no longer be referenced here; every
// live model is the standard cache_write = 1.25× input shape. The bound still derives the per-model MAX
// input rate from the table rather than hardcoding 1.25×, so it stays sound if an exotic shape returns —
// and the synthesized cache_write_1h (2×input on Anthropic) is in that max, so 1-hour cache writes are covered.
const MODELS = [
  "claude-opus-4-1", // priciest (15/75)
  "claude-opus-4-8",
  "claude-haiku-4-5", // cheapest (1/5)
  "claude-sonnet-4-6",
];

test("byteBoundHold ≥ actual cost for any usage the request could produce (never-negative refund)", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "grapheme", maxLength: 2000 }), // multi-byte UTF-8 (CJK/emoji), not just ASCII
      fc.integer({ min: 1, max: 200_000 }), // max_tokens
      fc.constantFrom(...MODELS),
      fc.double({ min: 0, max: 1, noNaN: true }), // arbitrary split of prompt tokens across input fields
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }), // ...and the 1-hour (2× input, priciest) share of the cache-write portion
      fc.boolean(), // did the request opt into 1-hour caching? Gates BOTH the hold tier AND whether 1h tokens can occur
      (raw, maxTokens, model, s1, s2, s3, oneHourCache) => {
        const utf8 = Buffer.byteLength(raw, "utf8");
        // Worst case the API can bill: the prompt tokenizes to as many tokens as it has UTF-8 bytes
        // (BPE byte-fallback ceiling), split arbitrarily across input / cache_read / cache_write. A response
        // can bill 1-hour (2× input) tokens ONLY if the request opted in, so the 1h slice is gated on the
        // SAME flag the hold is sized with — modelling the real invariant. Output saturated to max_tokens.
        // If the hold covers this, it covers every lighter reality.
        const a = Math.floor(utf8 * s1);
        const b = Math.floor((utf8 - a) * s2);
        const c = utf8 - a - b;
        const usage = {
          input_tokens: a,
          cache_read_input_tokens: b,
          cache_creation_input_tokens: c,
          cache_creation_1h_input_tokens: oneHourCache ? Math.floor(c * s3) : 0,
          output_tokens: maxTokens,
        };
        const hold = byteBoundHold({ model, raw, body: {}, maxTokens, oneHourCache }).micros;
        expect(hold).toBeGreaterThanOrEqual(priceUsage(model, usage));
      },
    ),
    { numRuns: 2000 },
  );
});

test("the 1-hour cache tier is GATED: oneHourCache enlarges an Anthropic hold, no-ops on OpenAI", () => {
  // Same inputs, only the flag differs. On Anthropic the input ceiling jumps 1.25×→2× input; on OpenAI
  // (no cache-write fee, cache_write_1h=0) the flag changes nothing.
  const raw = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(8000) }] });
  const sized = (model: string, oneHourCache: boolean) => byteBoundHold({ model, raw, body: {}, maxTokens: 1000, oneHourCache }).micros;
  expect(sized("claude-opus-4-8", true)).toBeGreaterThan(sized("claude-opus-4-8", false));
  expect(sized("gpt-4o", true)).toBe(sized("gpt-4o", false));
});

test("hasOneHourCacheControl: detects ttl:1h anywhere; ignores 5-minute and absent breakpoints", () => {
  const cc1h = { type: "ephemeral", ttl: "1h" };
  const cc5m = { type: "ephemeral" };
  expect(hasOneHourCacheControl({ system: [{ type: "text", text: "x", cache_control: cc1h }] })).toBe(true);
  expect(hasOneHourCacheControl({ messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: cc1h }] }] })).toBe(true);
  expect(hasOneHourCacheControl({ tools: [{ name: "t", cache_control: cc1h }] })).toBe(true);
  expect(hasOneHourCacheControl({ cache_control: cc1h })).toBe(true); // top-level auto-cache form
  expect(hasOneHourCacheControl({ system: [{ type: "text", text: "x", cache_control: cc5m }] })).toBe(false); // 5-min ≠ 1-hour
  expect(hasOneHourCacheControl({ messages: [{ role: "user", content: "plain string, no breakpoints" }] })).toBe(false);
  expect(hasOneHourCacheControl({})).toBe(false);
});

// --- count_tokens estimator (makeCountTokensHold): tight hold w/ token headroom, byte-bound cap+fallback

const okCount = (inputTokens: number): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ input_tokens: inputTokens }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const deps = {
  countUrl: "https://up.example/v1/messages/count_tokens",
  authHeaders: { "x-api-key": "k", "anthropic-version": "2023-06-01" },
  omit: ANTHROPIC_COUNT_OMIT,
  timeoutMs: 1000,
};
const padded = (n: number) => Math.ceil(n * HOLD_INPUT_MARGIN) + HOLD_INPUT_PAD;

test("count_tokens hold = min(byteBound, priceHoldBound at the PADDED count)", async () => {
  // Body large enough that the byte cap doesn't bind, so the count branch is what's returned.
  const body = { model: "claude-opus-4-8", max_tokens: 500, messages: [{ role: "user", content: "x".repeat(40_000) }] };
  const input = { model: "claude-opus-4-8", raw: JSON.stringify(body), body, maxTokens: 500 };
  const got = await makeCountTokensHold({ ...deps, fetchImpl: okCount(1234) })(input);
  const expected = Math.min(byteBoundHold(input).micros, priceHoldBound("claude-opus-4-8", padded(1234), 500));
  expect(got.micros).toBe(expected);
  expect(got.micros).toBe(priceHoldBound("claude-opus-4-8", padded(1234), 500)); // cap didn't bind here
  expect(got.inputTokens).toBe(1234); // the unpadded count, surfaced for the disconnect bill
});

test("SOUNDNESS: count_tokens hold ≥ actual cost even when the real bill drifts ABOVE the count", () => {
  // The headroom (×MARGIN + PAD) must cover real input tokens exceeding what count_tokens reported.
  // Body kept huge so the byte cap never binds and we're testing the count branch's margin.
  const big = "x".repeat(60_000);
  fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5_000 }), // the count_tokens result
      fc.integer({ min: 1, max: 50_000 }), // max_tokens
      fc.constantFrom(...MODELS),
      fc.double({ min: 0, max: 1, noNaN: true }), // how far real input drifts toward the padded ceiling
      fc.double({ min: 0, max: 1, noNaN: true }), // split across input fields
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }), // ...and the 1-hour (2× input) share of the cache-write portion
      fc.boolean(), // did the request opt into 1-hour caching?
      async (count, maxTokens, model, drift, s1, s2, s3, oneHourCache) => {
        const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: big }] };
        const input = { model, raw: JSON.stringify(body), body, maxTokens, oneHourCache };
        const hold = (await makeCountTokensHold({ ...deps, fetchImpl: okCount(count) })(input)).micros;
        // Worst realistic case: actual billable input lands anywhere from the count up to the padded ceiling
        // the hold reserved for, split arbitrarily across input / cache_read / cache_write (the cache-write
        // portion further across its 5-min and 1-hour 2× sub-tiers), output saturated to max_tokens. If the
        // hold covers THAT, drift within the margin is safe.
        const actualInput = count + Math.floor((padded(count) - count) * drift);
        const a = Math.floor(actualInput * s1);
        const b = Math.floor((actualInput - a) * s2);
        const c = actualInput - a - b;
        const usage = { input_tokens: a, cache_read_input_tokens: b, cache_creation_input_tokens: c, cache_creation_1h_input_tokens: oneHourCache ? Math.floor(c * s3) : 0, output_tokens: maxTokens };
        expect(hold).toBeGreaterThanOrEqual(priceUsage(model, usage));
      },
    ),
    { numRuns: 600 },
  );
});

test("count_tokens hold is far tighter than the byte bound on a base64-image-sized body", async () => {
  const big = "A".repeat(150_000); // stand-in for a ~150 KB base64 image
  const body = {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: big } }] }],
  };
  const input = { model: "claude-opus-4-8", raw: JSON.stringify(body), body, maxTokens: 1024 };
  const tight = (await makeCountTokensHold({ ...deps, fetchImpl: okCount(1600) })(input)).micros;
  const loose = byteBoundHold(input).micros;
  expect(tight).toBe(priceHoldBound("claude-opus-4-8", padded(1600), 1024));
  expect(tight).toBeLessThan(loose / 10); // still ~50× tighter even with the headroom
});

test("count_tokens body forwards unknown/new fields (denylist) but strips control fields", async () => {
  let sent: any = null;
  const capture: typeof fetch = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const body = {
    model: "claude-opus-4-8",
    max_tokens: 500,
    stream: true,
    temperature: 0.7,
    metadata: { user_id: "u" },
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] }, // beta-gated → 400s the count w/o the anthropic-beta header the count call doesn't send
    system: "be brief",
    tools: [{ name: "t", input_schema: {} }],
    future_billable_field: { big: "x".repeat(100) }, // unknown to us → must be forwarded (fail safe)
    messages: [{ role: "user", content: "hi" }],
  };
  await makeCountTokensHold({ ...deps, fetchImpl: capture })({ model: "claude-opus-4-8", raw: JSON.stringify(body), body, maxTokens: 500 });
  // Stripped control/sampling fields (context_management included: see ANTHROPIC_COUNT_OMIT note in hold.ts):
  for (const k of ["max_tokens", "stream", "temperature", "metadata", "context_management"]) expect(sent[k]).toBeUndefined();
  // Forwarded billable + unknown fields:
  expect(sent.messages).toEqual(body.messages);
  expect(sent.system).toBe("be brief");
  expect(sent.tools).toEqual(body.tools);
  expect(sent.future_billable_field).toEqual(body.future_billable_field);
  expect(sent.model).toBe("claude-opus-4-8");
});

test("count_tokens forwards the client's anthropic-beta (countHeaders) so beta-gated fields are accepted", async () => {
  let headers: Headers | null = null;
  const capture: typeof fetch = (async (_url: string, init: any) => {
    headers = new Headers(init.headers);
    return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const body = { model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };
  const beta = "context-management-2025-06-27, prompt-caching-scope-2026-01-05";
  await makeCountTokensHold({ ...deps, fetchImpl: capture })({
    model: "claude-opus-4-8",
    raw: JSON.stringify(body),
    body,
    maxTokens: 100,
    countHeaders: { "anthropic-beta": beta },
  });
  expect(headers!.get("anthropic-beta")).toBe(beta); // forwarded to the free counter so it accepts beta-gated body fields
  expect(headers!.get("x-api-key")).toBe("k"); // our injected auth still present
});

test("countHeaders can ADD headers but can NEVER override our injected auth (authHeaders win)", async () => {
  let headers: Headers | null = null;
  const capture: typeof fetch = (async (_url: string, init: any) => {
    headers = new Headers(init.headers);
    return new Response(JSON.stringify({ input_tokens: 5 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const body = { model: "claude-opus-4-8", max_tokens: 50, messages: [{ role: "user", content: "x" }] };
  await makeCountTokensHold({ ...deps, fetchImpl: capture })({
    model: "claude-opus-4-8",
    raw: JSON.stringify(body),
    body,
    maxTokens: 50,
    countHeaders: { "x-api-key": "SPOOFED", "anthropic-version": "9999-99-99", "anthropic-beta": "b" },
  });
  expect(headers!.get("x-api-key")).toBe("k"); // ours wins — countHeaders cannot spoof auth
  expect(headers!.get("anthropic-version")).toBe("2023-06-01"); // ours wins
  expect(headers!.get("anthropic-beta")).toBe("b"); // additive header still forwarded
});

test("no countHeaders → no anthropic-beta sent (OpenAI/plain requests unaffected)", async () => {
  let headers: Headers | null = null;
  const capture: typeof fetch = (async (_url: string, init: any) => {
    headers = new Headers(init.headers);
    return new Response(JSON.stringify({ input_tokens: 7 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const body = { model: "claude-opus-4-8", max_tokens: 20, messages: [{ role: "user", content: "x" }] };
  await makeCountTokensHold({ ...deps, fetchImpl: capture })({ model: "claude-opus-4-8", raw: JSON.stringify(body), body, maxTokens: 20 });
  expect(headers!.get("anthropic-beta")).toBeNull();
});

test("count_tokens hold falls back to the byte bound on any failure (incl. a zero count)", async () => {
  // Every failure path returns the SOUND byte bound for the hold — silently. The estimator is PURE: no log, no
  // metric, no fallback field. The byte bound is a proven upper bound + billActual reconciles, so it costs nothing.
  const body = { model: "claude-haiku-4-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] };
  const input = { model: "claude-haiku-4-5", raw: JSON.stringify(body), body, maxTokens: 32 };
  const expected = byteBoundHold(input);
  const cases: (typeof fetch)[] = [
    (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch, // upstream error
    (async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "tools: not permitted" } }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch, // 400 (count-omit gap or bad request)
    (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch, // missing input_tokens
    (async () => new Response(JSON.stringify({ input_tokens: -5 }), { status: 200 })) as unknown as typeof fetch, // negative
    (async () => new Response(JSON.stringify({ input_tokens: 0 }), { status: 200 })) as unknown as typeof fetch, // zero (a bug, not a tiny prompt)
    (async () => new Response("{ not json", { status: 200 })) as unknown as typeof fetch, // malformed JSON
    (async () => { throw new Error("network down"); }) as unknown as typeof fetch, // thrown
  ];
  for (const fetchImpl of cases) {
    const got = await makeCountTokensHold({ ...deps, fetchImpl })(input);
    expect(got).toEqual(expected); // exactly the byte bound — nothing else surfaced
  }
});
