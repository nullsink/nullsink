// Tests for the OpenAI Chat Completions provider path through createHandler — in-memory stores, stubbed
// upstream, no network. Covers what differs from the Anthropic path: the cached-token usage split, the
// streaming content-token disconnect fallback, the store:false + include_usage body mutation, the
// Authorization: Bearer token slot, and the per-provider gate (cross-provider model, required output cap,
// n>1 / service_tier / web_search rejects, key-presence enablement). The shared hold/refund skeleton is
// already covered in billing.property.test.ts, so these focus on OpenAI-specific behavior.
import { test, expect, spyOn } from "bun:test";
import { createHandler, type HandlerDeps, type RailView } from "./support/handler-combined";
import { byteBoundHold } from "../src/hold";
import { openDb, hashToken } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { extractOpenAIChatUsage, extractOpenAIResponsesUsage, priceUsage, type Usage } from "../src/cost";
import * as metrics from "../src/metrics";

type Upstream = (url: string, init: any) => Promise<Response>;
const INITIAL = 10_000_000_000; // $10k — covers any hold here

function makeHandler(upstreamFetch: Upstream, over: Partial<HandlerDeps> = {}) {
  const balances = openDb(":memory:");
  const orders = openOrderStore(":memory:");
  const deps: HandlerDeps = {
    anthropic: { apiKey: "real-anthropic-key", baseUrl: "https://anthropic.example", version: "2023-06-01", estimateHold: byteBoundHold },
    // OpenAI enabled with its own byte-bound estimator (so inputTokens = utf8 bytes — deterministic for
    // the disconnect-bill assertion below).
    openai: { apiKey: "real-openai-key", baseUrl: "https://openai.example", estimateHold: byteBoundHold },
    upstreamTimeoutMs: 1000,
    margin: 1.15,
    buyMinUsd: 5,
    buyMaxUsd: 2000,
    orderTtlMs: 4 * 60 * 60 * 1000,
    maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096,
    maxMessagesBodyBytes: 33_554_432,
    balances,
    orders,
    upstreamFetch: upstreamFetch as typeof fetch,
    rails: new Map<string, RailView>([
      ["monero", { name: "monero", createPayment: async () => ({ payTo: "8x", orderIndex: 0 }), rateUsd: async () => 150, scale: 1_000_000_000_000, unit: "XMR", confirmations: 10, paymentUri: (a: string, amt: string) => `monero:${a}?tx_amount=${amt}` }],
    ]),
    defaultRail: "monero",
    ...over,
  };
  return { handler: createHandler(deps), balances, orders };
}

// OpenAI clients carry the proxy token in Authorization: Bearer.
function chatReq(token: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (token !== null) h["authorization"] = `Bearer ${token}`;
  return new Request("https://proxy.local/v1/chat/completions", { method: "POST", headers: h, body: JSON.stringify(body) });
}

const okChat = (model: string, usage: object): Upstream =>
  async () => new Response(JSON.stringify({ model, usage, choices: [{ message: { role: "assistant", content: "hi" } }] }), { status: 200, headers: { "content-type": "application/json" } });

function fund(balances: ReturnType<typeof openDb>, token: string): void {
  balances.credit(hashToken(token), INITIAL);
}
const debit = (balances: ReturnType<typeof openDb>, token: string) => INITIAL - balances.getBalance(hashToken(token))!;

// --- Buffered billing: the cached-token split -----------------------------------------------------

test("openai buffered: prompt_tokens is split into input + cached, reasoning stays inside output", async () => {
  // prompt_tokens INCLUDES cached (OpenAI), unlike Anthropic. 1000 prompt with 200 cached → 800 billed at
  // the input rate + 200 at cache_read. completion_tokens 500 already includes the 100 reasoning tokens.
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 200 },
    completion_tokens_details: { reasoning_tokens: 100 },
  };
  const token = "pr_oaibuf";
  const { handler, balances } = makeHandler(okChat("gpt-5", usage));
  fund(balances, token);
  const body = { model: "gpt-5", max_completion_tokens: 1000, messages: [{ role: "user", content: "hi" }] };
  const res = await handler(chatReq(token, body));
  expect(res.status).toBe(200);
  const expected: Usage = { input_tokens: 800, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 500 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5", expected));
});

// --- Streaming: clean close (exact) vs disconnect (content fallback) -------------------------------

// OpenAI SSE: bare `data: {json}` per chunk, then `data: [DONE]`. One chunk per client pull, so a test can
// read N then cancel. onCancel fires when the client disconnect propagates upstream.
function openaiStream(chunks: object[], onCancel?: () => void): Upstream {
  const enc = new TextEncoder();
  const frames = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          (controller as any)._i = 0;
        },
        pull(controller) {
          const i = (controller as any)._i++;
          if (i >= frames.length) return controller.close();
          controller.enqueue(enc.encode(frames[i]!));
        },
        cancel() {
          onCancel?.();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

// Long prompt so the byte-bound hold comfortably covers the synthetic usage (clean-path exact-bill regime).
const streamBody = (maxOut: number) => ({ model: "gpt-5", max_completion_tokens: maxOut, stream: true, messages: [{ role: "user", content: "x".repeat(8000) }] });

test("openai streaming: a clean close bills the exact usage from the final include_usage chunk", async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 } };
  const chunks = [
    { model: "gpt-5", choices: [{ delta: { role: "assistant", content: "" } }] },
    { model: "gpt-5", choices: [{ delta: { content: "hello" } }] },
    { model: "gpt-5", choices: [{ delta: { content: " world" } }] },
    { model: "gpt-5", choices: [], usage }, // final chunk: choices:[] + usage
  ];
  const token = "pr_oaistream";
  const { handler, balances } = makeHandler(openaiStream(chunks));
  fund(balances, token);
  const res = await handler(chatReq(token, streamBody(1000)));
  expect(res.status).toBe(200);
  await res.text(); // drain → settle on clean close
  const expected: Usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 500 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5", expected));
});

test("openai streaming: a reasoning-model disconnect bills input (from the hold) + the output cap (not the char estimate)", async () => {
  let cancelled = false;
  const chunks = [
    { model: "gpt-5", choices: [{ delta: { role: "assistant", content: "" } }] },
    { model: "gpt-5", choices: [{ delta: { content: "12345678" } }] }, // 8 chars seen before disconnect
    { model: "gpt-5", choices: [{ delta: { content: "never-read-by-client" } }] },
    { model: "gpt-5", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 9999 } }, // never reached
  ];
  const token = "pr_oaicancel";
  const { handler, balances } = makeHandler(openaiStream(chunks, () => (cancelled = true)));
  fund(balances, token);
  const body = streamBody(1000);
  const res = await handler(chatReq(token, body));
  const reader = res.body!.getReader();
  await reader.read(); // role chunk (content "")
  await reader.read(); // "12345678" → 8 content chars metered
  await reader.cancel(); // client disconnects
  expect(cancelled).toBe(true); // upstream generation cancelled → spend stops
  // gpt-5 is a REASONING model: its thinking tokens never stream, so the char estimate (ceil(8/4)=2) is
  // blind to them — the disconnect bills the output CAP instead (max_completion_tokens=1000, a sound upper
  // bound). Bill = ctx.inputTokens (byte-bound hold ⇒ utf8 bytes of the original raw body) at the input
  // rate + 1000 output tokens, which stays ≤ the hold so billActual doesn't clamp.
  const inputTokens = Buffer.byteLength(JSON.stringify(body), "utf8");
  const expected: Usage = { input_tokens: inputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1000 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5", expected));
});

test("openai streaming disconnect counts as `served`, NOT stream:partial — pins the Anthropic-granularity caveat", async () => {
  // The OBSERVABILITY half of the disconnect above. The OpenAI scanner folds a mid-stream disconnect into
  // result() (input + char/cap estimate), so settle() takes the `metered` branch → recordServed. Anthropic's
  // scanner returns null until a usage frame → the input-floor branch → recordServedPartial. So an OpenAI
  // partial is COUNTED as served, never as stream:partial — exactly the granularity the metric documents.
  metrics.reset(0);
  let cancelled = false;
  const chunks = [
    { model: "gpt-5", choices: [{ delta: { role: "assistant", content: "" } }] },
    { model: "gpt-5", choices: [{ delta: { content: "12345678" } }] }, // content seen → scanner.sawAny
    { model: "gpt-5", choices: [{ delta: { content: "never-read" } }] },
  ];
  const token = "pr_oaicount";
  const { handler, balances } = makeHandler(openaiStream(chunks, () => (cancelled = true)));
  fund(balances, token);
  const res = await handler(chatReq(token, streamBody(1000)));
  const reader = res.body!.getReader();
  await reader.read(); // role chunk
  await reader.read(); // "12345678"
  await reader.cancel(); // client disconnects mid-stream
  expect(cancelled).toBe(true); // upstream generation cancelled
  const s = metrics.snapshot();
  expect([s.served, s.servedPartial, s.streamAborted, s.bill.refundedInFull]).toEqual([1, 0, 0, 0]); // served, not partial
});

// --- Body mutation: store:false always, include_usage on streams ----------------------------------

test("openai forward: injects store:false (+ stream_options.include_usage when streaming), swaps in our key, strips org", async () => {
  let captured: { url: string; headers: Headers; body: any } | undefined;
  const upstream: Upstream = async (url, init) => {
    captured = { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ model: "gpt-5", usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json", "openai-organization": "OUR-ORG" } });
  };
  const token = "pr_oaihdr";
  const { handler, balances } = makeHandler(upstream);
  fund(balances, token);
  // Non-streaming: store:false injected, no stream_options.
  const res = await handler(
    chatReq(token, { model: "gpt-5", max_completion_tokens: 16, messages: [{ role: "user", content: "hi" }] }, { "openai-organization": "client-org", "x-keep": "yes" }),
  );
  expect(res.status).toBe(200);
  expect(captured!.url).toBe("https://openai.example/v1/chat/completions");
  expect(captured!.body.store).toBe(false);
  expect(captured!.body.stream_options).toBeUndefined();
  expect(captured!.headers.get("authorization")).toBe("Bearer real-openai-key"); // our key injected
  expect(captured!.headers.has("openai-organization")).toBe(false); // client org stripped
  expect(captured!.headers.get("x-keep")).toBe("yes"); // unrelated header survives
  expect(res.headers.has("openai-organization")).toBe(false); // our org not leaked back

  // Streaming: include_usage forced on.
  await handler(chatReq(token, { model: "gpt-5", max_completion_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }));
  expect(captured!.body.store).toBe(false);
  expect(captured!.body.stream_options).toEqual({ include_usage: true });
});

// --- Gate: cross-provider, required output cap, premium rejects, auth, enablement ------------------

test("openai gate fails closed: rejects never bill and never reach upstream", async () => {
  const valid = { model: "gpt-5", max_completion_tokens: 16, messages: [{ role: "user", content: "hi" }] };
  const cases: Array<{ name: string; token?: string | null; body: unknown; status: number; error: string; fund?: boolean }> = [
    { name: "claude model on openai endpoint", body: { ...valid, model: "claude-opus-4-8" }, status: 400, error: "unsupported_model" },
    { name: "unknown model", body: { ...valid, model: "gpt-nope" }, status: 400, error: "unsupported_model" },
    { name: "no output cap", body: { model: "gpt-5", messages: [] }, status: 400, error: "max_tokens_required" },
    { name: "n>1", body: { ...valid, n: 2 }, status: 400, error: "unsupported_option" },
    { name: "service_tier flex", body: { ...valid, service_tier: "flex" }, status: 400, error: "unsupported_option" },
    { name: "web_search_options", body: { ...valid, web_search_options: {} }, status: 400, error: "unsupported_tool" },
    // Audio bills at off-card rates (~16× text input / ~8× text output) our usage mapping doesn't split
    // out — every body-level route to it is rejected: output modalities, the audio output config, and
    // input_audio content parts.
    { name: "audio output modality", body: { ...valid, modalities: ["text", "audio"] }, status: 400, error: "unsupported_option" },
    { name: "audio output config", body: { ...valid, audio: { voice: "alloy", format: "wav" } }, status: 400, error: "unsupported_option" },
    {
      name: "input_audio content part",
      body: { ...valid, messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }] }] },
      status: 400,
      error: "unsupported_option",
    },
    { name: "no token", token: null, body: valid, status: 401, error: "missing_api_key" }, // disambiguated: no auth header at all
    { name: "unknown token", token: "pr_unfunded", body: valid, status: 401, error: "invalid_token" }, // present but unrecognized
  ];
  for (const c of cases) {
    let reached = false;
    const { handler, balances } = makeHandler(async () => {
      reached = true;
      return new Response(JSON.stringify({ model: "gpt-5", usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });
    const tok = c.token === undefined ? "pr_x" : c.token;
    // Body-error cases need a FUNDED token now that an unknown token is shed before the body is parsed; the two
    // auth cases (no token / unknown token) stay unfunded to pin their 401s.
    if (tok !== null && tok !== "pr_unfunded") fund(balances, tok);
    const res = await handler(chatReq(tok, c.body));
    expect(res.status, c.name).toBe(c.status);
    expect(res.headers.get("x-should-retry"), c.name).toBe("false"); // terminal gate reject
    // OpenAI-native envelope: error is an OBJECT {message,type,code}, not a bare string.
    const j = (await res.json()) as { error: { type: string; code: string } };
    expect(j.error.code, c.name).toBe(c.error);
    expect(j.error.type, c.name).toBe("invalid_request_error"); // all gate cases here are 4xx non-429
    expect(reached, `${c.name} must not reach upstream`).toBe(false);
  }
});

test("explicit text-only modalities are NOT over-rejected (only non-text output is off-card)", async () => {
  const token = "pr_textmod";
  const { handler, balances } = makeHandler(okChat("gpt-5", { prompt_tokens: 1, completion_tokens: 1 }));
  fund(balances, token);
  const res = await handler(
    chatReq(token, { model: "gpt-5", max_completion_tokens: 16, modalities: ["text"], messages: [{ role: "user", content: "hi" }] }),
  );
  expect(res.status).toBe(200);
});

test("openai endpoint accepts max_tokens as a legacy output cap, and reads the token from x-api-key too", async () => {
  const token = "pr_oailegacy";
  const { handler, balances } = makeHandler(okChat("gpt-5", { prompt_tokens: 10, completion_tokens: 10 }));
  fund(balances, token);
  // Legacy max_tokens (not max_completion_tokens) + token in x-api-key (compat path) both accepted.
  const req = new Request("https://proxy.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({ model: "gpt-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  expect((await handler(req)).status).toBe(200);
  expect(debit(balances, token)).toBe(priceUsage("gpt-5", { input_tokens: 10, output_tokens: 10 }));
});

test("openai endpoint 404s when the provider is not configured (no OPENAI_API_KEY)", async () => {
  const { handler } = makeHandler(okChat("gpt-5", {}), { openai: undefined });
  const res = await handler(chatReq("pr_x", { model: "gpt-5", max_completion_tokens: 16, messages: [] }));
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toBe("unsupported_endpoint");
});

test("default output cap: when configured, an omitted cap is INJECTED into the forward (not a 400); a client cap is respected", async () => {
  let captured: any;
  const upstream: Upstream = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: "gpt-5", usage: { input_tokens: 5, output_tokens: 5, prompt_tokens: 5, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const token = "pr_defcap";
  const { handler, balances } = makeHandler(upstream, { defaultMaxOutputTokens: 1234 });
  fund(balances, token);
  // Chat without max_completion_tokens → 200, default injected as max_completion_tokens.
  const chat = await handler(chatReq(token, { model: "gpt-5", messages: [{ role: "user", content: "hi" }] }));
  expect(chat.status).toBe(200);
  expect(captured.max_completion_tokens).toBe(1234);
  // Responses without max_output_tokens → default injected as max_output_tokens.
  await handler(responsesReq(token, { model: "gpt-5", input: "hi" }));
  expect(captured.max_output_tokens).toBe(1234);
  // A client-provided cap is respected, never overwritten by the default.
  await handler(chatReq(token, { model: "gpt-5", max_completion_tokens: 77, messages: [{ role: "user", content: "hi" }] }));
  expect(captured.max_completion_tokens).toBe(77);
});

test("default output cap: with the default off (0, the prod-test default), an omitted cap still 400s (strict)", async () => {
  const token = "pr_strictcap";
  const { handler, balances } = makeHandler(okChat("gpt-5", { input_tokens: 1, output_tokens: 1 }));
  fund(balances, token);
  const res = await handler(chatReq(token, { model: "gpt-5", messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(400);
  const j = (await res.json()) as { error: { type: string; code: string } };
  expect(j.error.code).toBe("max_tokens_required"); // OpenAI-native object envelope
  expect(j.error.type).toBe("invalid_request_error");
});

test("masked upstream errors on an OpenAI endpoint wear OpenAI's native envelope (opaque), refunded, no leak", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // masked errors log a server-side snippet
  const token = "pr_oamask";
  const cases = [
    { up: 401, body: JSON.stringify({ error: { message: "Incorrect API key SECRET-oa-key", type: "invalid_request_error", code: "invalid_api_key" } }), want: 503, type: "server_error", code: "service_unavailable", retry: null },
    { up: 429, body: "slow down LEAK-oa", want: 429, type: "rate_limit_error", code: "rate_limited", retry: "true" },
    { up: 500, body: "boom SECRET-oa", want: 503, type: "server_error", code: "service_unavailable", retry: null },
  ];
  for (const c of cases) {
    const { handler, balances } = makeHandler(async () => new Response(c.body, { status: c.up, headers: { "content-type": "application/json" } }));
    fund(balances, token);
    const res = await handler(chatReq(token, { model: "gpt-5", max_completion_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
    const out = await res.text();
    expect([c.up, res.status]).toEqual([c.up, c.want]);
    expect([c.up, res.headers.get("x-should-retry")]).toEqual([c.up, c.retry]); // 429 retryable; masked 503 left unset (ambiguous)
    const j = JSON.parse(out);
    expect([c.up, j.error.type]).toEqual([c.up, c.type]); // OpenAI-native object envelope
    expect([c.up, j.error.code]).toEqual([c.up, c.code]);
    expect([c.up, j.error.message]).toEqual([c.up, c.code]); // opaque generic code, never the upstream body
    expect([c.up, out.includes("SECRET-oa") || out.includes("LEAK-oa")]).toEqual([c.up, false]); // body never relayed
    expect([c.up, balances.getBalance(hashToken(token))]).toEqual([c.up, INITIAL]); // refunded in full
  }
  errSpy.mockRestore();
});

test("cross-provider: a gpt-* model on /v1/messages is rejected (the Anthropic endpoint doesn't own it)", async () => {
  const { handler, balances } = makeHandler(okChat("x", {}));
  fund(balances, "pr_cross");
  const req = new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "pr_cross" },
    body: JSON.stringify({ model: "gpt-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await handler(req);
  expect(res.status).toBe(400);
  // /v1/messages is the Anthropic endpoint → native envelope (not the simple {error} the OpenAI paths emit).
  const j = (await res.json()) as { error: { type: string; message: string } };
  expect(j.error.type).toBe("invalid_request_error");
  expect(j.error.message).toContain("unsupported_model");
});

// --- /v1/responses (phase 2): the third shape ----------------------------------------------------

function responsesReq(token: string | null, body: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (token !== null) h["authorization"] = `Bearer ${token}`;
  return new Request("https://proxy.local/v1/responses", { method: "POST", headers: h, body: JSON.stringify(body) });
}

test("responses buffered: input_tokens split on cached, output already includes reasoning", async () => {
  const usage = {
    input_tokens: 320,
    input_tokens_details: { cached_tokens: 120 },
    output_tokens: 180,
    output_tokens_details: { reasoning_tokens: 60 },
    total_tokens: 500,
  };
  const upstream: Upstream = async () =>
    new Response(JSON.stringify({ object: "response", status: "completed", model: "gpt-5", usage, output: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const token = "pr_resp";
  const { handler, balances } = makeHandler(upstream);
  fund(balances, token);
  const res = await handler(responsesReq(token, { model: "gpt-5", max_output_tokens: 1000, input: "hi" }));
  expect(res.status).toBe(200);
  const expected: Usage = { input_tokens: 200, cache_read_input_tokens: 120, cache_creation_input_tokens: 0, output_tokens: 180 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5", expected));
});

// --- gpt-5.6 cache writes: the first OpenAI family with a cache-write fee (1.25× input). The adapter must
// slice cache_write_tokens out of the input total and bill it at the cache_write rate, on BOTH shapes —
// leaving it inside input_tokens would eat the 0.25× surcharge on every cached gpt-5.6 request.

test("gpt-5.6 chat buffered: cache_write_tokens bills at the cache-write rate, not the input rate", async () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
  };
  const token = "pr_56chat";
  const { handler, balances } = makeHandler(okChat("gpt-5.6", usage));
  fund(balances, token);
  const res = await handler(chatReq(token, { model: "gpt-5.6", max_completion_tokens: 500, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(200);
  const expected: Usage = { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 300, output_tokens: 100 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5.6", expected));
  expect(priceUsage("gpt-5.6", expected)).toBeGreaterThan(priceUsage("gpt-5.6", { input_tokens: 800, cache_read_input_tokens: 200, output_tokens: 100 })); // the surcharge is real money
});

test("gpt-5.6 responses buffered: cache_write_tokens sliced out of input_tokens identically", async () => {
  const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000 }, output_tokens: 50 };
  const upstream: Upstream = async () =>
    new Response(JSON.stringify({ object: "response", status: "completed", model: "gpt-5.6", usage, output: [] }), { status: 200, headers: { "content-type": "application/json" } });
  const token = "pr_56resp";
  const { handler, balances } = makeHandler(upstream);
  fund(balances, token);
  const res = await handler(responsesReq(token, { model: "gpt-5.6", max_output_tokens: 1000, input: "hi" }));
  expect(res.status).toBe(200);
  const expected: Usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 50 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5.6", expected));
});

test("hostile cache slices are CLAMPED: read caps at the total, write at the remainder, input never negative", async () => {
  // cached + written > prompt total: read takes its slice first, write gets what remains, input floors at 0.
  // Unclamped, a lying report could bill write tokens the prompt never had (overcharging the user) or push
  // input_tokens negative.
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 80 },
  };
  const token = "pr_56clamp";
  const { handler, balances } = makeHandler(okChat("gpt-5.6", usage));
  fund(balances, token);
  const res = await handler(chatReq(token, { model: "gpt-5.6", max_completion_tokens: 500, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(200);
  const expected: Usage = { input_tokens: 0, cache_read_input_tokens: 80, cache_creation_input_tokens: 20, output_tokens: 10 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5.6", expected));
});

test("hostile READ slice: cached_tokens above the prompt total caps at the total, on both shapes", () => {
  // cached alone exceeds the total: read caps at the total, leaving nothing for write or input. Unclamped,
  // a lying cached_tokens would bill cache-reads on tokens the prompt never had — unbounded overcharge at
  // the adapter (the handler's hold clamp merely caps the damage, it doesn't correct the split).
  const chat = extractOpenAIChatUsage(
    JSON.stringify({ model: "gpt-5.6", usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 250, cache_write_tokens: 80 } } }),
  );
  expect(chat!.usage).toEqual({ input_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 10 });
  const responses = extractOpenAIResponsesUsage(
    JSON.stringify({ model: "gpt-5.6", usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 250, cache_write_tokens: 80 } } }),
  );
  expect(responses!.usage).toEqual({ input_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 10 });
});

test("responses streaming: a clean close bills the usage from the response.completed event (no include_usage needed)", async () => {
  const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 400 };
  const chunks = [
    { type: "response.created", response: { model: "gpt-5" } },
    { type: "response.output_text.delta", delta: "hello" },
    { type: "response.output_text.delta", delta: " world" },
    { type: "response.completed", response: { model: "gpt-5", usage } },
  ];
  const token = "pr_respstream";
  const { handler, balances } = makeHandler(openaiStream(chunks));
  fund(balances, token);
  const res = await handler(responsesReq(token, { model: "gpt-5", max_output_tokens: 1000, stream: true, input: "x".repeat(8000) }));
  expect(res.status).toBe(200);
  await res.text();
  const expected: Usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 400 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5", expected));
});

test("responses streaming: a reasoning-model disconnect bills input (from the hold) + the output cap", async () => {
  let cancelled = false;
  const chunks = [
    { type: "response.created", response: { model: "gpt-5" } },
    { type: "response.output_text.delta", delta: "abcdefgh" }, // 8 chars
    { type: "response.output_text.delta", delta: "never-read" },
    { type: "response.completed", response: { model: "gpt-5", usage: { input_tokens: 1000, output_tokens: 9999 } } },
  ];
  const token = "pr_respcancel";
  const { handler, balances } = makeHandler(openaiStream(chunks, () => (cancelled = true)));
  fund(balances, token);
  const body = { model: "gpt-5", max_output_tokens: 1000, stream: true, input: "x".repeat(8000) };
  const res = await handler(responsesReq(token, body));
  const reader = res.body!.getReader();
  await reader.read(); // response.created
  await reader.read(); // first delta (8 chars)
  await reader.cancel();
  expect(cancelled).toBe(true);
  // gpt-5 reasoning: the disconnect bills the output CAP (max_output_tokens=1000), not the char estimate.
  const inputTokens = Buffer.byteLength(JSON.stringify(body), "utf8");
  const expected: Usage = { input_tokens: inputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1000 };
  expect(debit(balances, token)).toBe(priceUsage("gpt-5", expected));
});

test("responses forward: store:false injected, NO stream_options (Responses streams usage by default)", async () => {
  let captured: any;
  const upstream: Upstream = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ model: "gpt-5", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const token = "pr_respfwd";
  const { handler, balances } = makeHandler(upstream);
  fund(balances, token);
  await handler(responsesReq(token, { model: "gpt-5", max_output_tokens: 16, stream: true, input: "hi" }));
  expect(captured.url).toBe("https://openai.example/v1/responses");
  expect(captured.body.store).toBe(false);
  expect(captured.body.stream_options).toBeUndefined();
});

test("responses gate: required max_output_tokens, built-in tools rejected, cross-provider model rejected", async () => {
  const valid = { model: "gpt-5", max_output_tokens: 16, input: "hi" };
  const cases: Array<{ name: string; body: unknown; error: string }> = [
    { name: "no max_output_tokens", body: { model: "gpt-5", input: "hi" }, error: "max_tokens_required" },
    { name: "built-in web_search tool", body: { ...valid, tools: [{ type: "web_search_preview" }] }, error: "unsupported_tool" },
    { name: "code_interpreter tool", body: { ...valid, tools: [{ type: "code_interpreter" }] }, error: "unsupported_tool" },
    { name: "service_tier flex", body: { ...valid, service_tier: "flex" }, error: "unsupported_option" },
    { name: "claude model", body: { ...valid, model: "claude-opus-4-8" }, error: "unsupported_model" },
    {
      name: "input_audio content part",
      body: { ...valid, input: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }] }] },
      error: "unsupported_option",
    },
  ];
  for (const c of cases) {
    let reached = false;
    const { handler, balances } = makeHandler(async () => {
      reached = true;
      return new Response("{}", { status: 200 });
    });
    fund(balances, "pr_g");
    const res = await handler(responsesReq("pr_g", c.body));
    expect(res.status, c.name).toBe(400);
    expect(res.headers.get("x-should-retry"), c.name).toBe("false");
    const j = (await res.json()) as { error: { type: string; code: string } };
    expect(j.error.code, c.name).toBe(c.error); // OpenAI-native object envelope
    expect(j.error.type, c.name).toBe("invalid_request_error");
    expect(reached, `${c.name} must not reach upstream`).toBe(false);
  }
});

test("responses: a function tool is allowed (just tokens), unlike built-in tools", async () => {
  const token = "pr_respfn";
  const { handler, balances } = makeHandler(
    async () => new Response(JSON.stringify({ model: "gpt-5", usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  fund(balances, token);
  const res = await handler(responsesReq(token, { model: "gpt-5", max_output_tokens: 16, input: "hi", tools: [{ type: "function", name: "f", parameters: {} }] }));
  expect(res.status).toBe(200);
});

test("responses endpoint 404s when the provider is not configured", async () => {
  const { handler } = makeHandler(okChat("gpt-5", {}), { openai: undefined });
  const res = await handler(responsesReq("pr_x", { model: "gpt-5", max_output_tokens: 16, input: "hi" }));
  expect(res.status).toBe(404);
});

test("openai streaming: an upstream error mid-stream refunds in full (not billed as a client disconnect)", async () => {
  // An error frame after some content is an UPSTREAM failure, not a client disconnect — nothing billable
  // happened, so the input must NOT be billed via the disconnect fallback. (Regression: a real response
  // that 200s then fails mid-stream was billing the prompt.) chat: an `error` frame; responses: response.failed.
  // The full-refund path logs the "[bill] … refunded in full" alert line by design; silence it here.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const chat = [
    { model: "gpt-5", choices: [{ delta: { role: "assistant", content: "" } }] },
    { model: "gpt-5", choices: [{ delta: { content: "partial" } }] },
    { error: { message: "the server had an error", type: "server_error" } }, // no usage
  ];
  {
    const token = "pr_chatfail";
    const { handler, balances } = makeHandler(openaiStream(chat));
    fund(balances, token);
    const res = await handler(chatReq(token, streamBody(1000)));
    await res.text();
    expect(debit(balances, token)).toBe(0); // full refund
  }
  const resp = [
    { type: "response.created", response: { model: "gpt-5" } },
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.failed", response: { model: "gpt-5", usage: null } }, // no usage
  ];
  {
    const token = "pr_respfail";
    const { handler, balances } = makeHandler(openaiStream(resp));
    fund(balances, token);
    const res = await handler(responsesReq(token, { model: "gpt-5", max_output_tokens: 1000, stream: true, input: "x".repeat(8000) }));
    await res.text();
    expect(debit(balances, token)).toBe(0); // full refund
  }
  errSpy.mockRestore();
});

test("openai chat streaming: an error frame THEN a client disconnect still refunds in full (no input floor)", async () => {
  // Mirror of the Anthropic error+cancel case: a 200-then-error chat stream the client aborts on must NOT
  // bill the input floor. The scanner's `failed` flag (exposed via errored()) blocks the floor even though
  // the client cancelled. The drain variant is covered by the "upstream error mid-stream" test above.
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  let cancelled = false;
  const chunks = [
    { error: { message: "the server had an error", type: "server_error" } },
    ...Array.from({ length: 10 }, () => ({ model: "gpt-5", choices: [] })),
  ];
  const token = "pr_chaterrcancel";
  const { handler, balances } = makeHandler(openaiStream(chunks, () => (cancelled = true)));
  fund(balances, token);
  const res = await handler(chatReq(token, streamBody(1000)));
  const reader = res.body!.getReader();
  await reader.read(); // the error frame → scanner marks the stream failed
  await reader.cancel(); // client aborts on the error
  expect(cancelled).toBe(true);
  expect(debit(balances, token)).toBe(0); // full refund, NOT the input floor
  errSpy.mockRestore();
});

test("off-card models are rejected at the gate, NOT re-admitted as their priced base via prefix-match", async () => {
  // o3-deep-research and gpt-4o-audio-preview are excluded from prices.json, but findModel matches by
  // prefix, so they resolve to priced `o3` / `gpt-4o` — without the isOffCardModel gate they would
  // forward and bill at the base's TEXT token rates while the per-call web-search fee / audio token
  // premium goes uncharged. Must reject (unsupported_model), on BOTH endpoints, before forwarding. The
  // priced base `o3` itself must still be accepted (no over-rejection).
  for (const model of ["o3-deep-research", "o4-mini-deep-research", "gpt-4o-audio-preview", "gpt-4o-mini-audio-preview", "gpt-4o-realtime-preview"]) {
    let reached = false;
    const { handler, balances } = makeHandler(async () => {
      reached = true;
      return new Response(JSON.stringify({ model, usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    });
    fund(balances, "pr_fee");
    const chat = await handler(chatReq("pr_fee", { model, max_completion_tokens: 16, messages: [{ role: "user", content: "hi" }] }));
    expect(chat.status, `${model} chat`).toBe(400);
    expect(((await chat.json()) as { error: { code: string } }).error.code, `${model} chat`).toBe("unsupported_model");
    const resp = await handler(responsesReq("pr_fee", { model, max_output_tokens: 16, input: "hi" }));
    expect(resp.status, `${model} responses`).toBe(400);
    expect(reached, `${model} must not reach upstream`).toBe(false);
  }
  // The priced base model is still accepted.
  const token = "pr_base";
  const { handler, balances } = makeHandler(okChat("o3", { prompt_tokens: 10, completion_tokens: 10 }));
  fund(balances, token);
  expect((await handler(chatReq(token, { model: "o3", max_completion_tokens: 16, messages: [{ role: "user", content: "hi" }] }))).status).toBe(200);
});
