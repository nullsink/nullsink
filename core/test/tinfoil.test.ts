// Tinfoil provider + namespaced model routing through createHandler — in-memory stores, stubbed upstream,
// no network. Covers what's Tinfoil-specific and what the shared /v1/chat/completions path now requires:
// routing by model (bare id → owner, `provider/model` prefix, wrong-path prefix), the prefix strip on
// forward, flat billing (cache_read == input), forced stream_options.include_usage with NO store:false, and
// forceReasoning (a disconnect bills the output cap for a model that isn't a REASONING_MARKER). The shared
// hold/refund skeleton is covered in billing.property.test.ts.
import { test, expect } from "bun:test";
import { createHandler, type HandlerDeps, type RailView } from "./support/handler-combined";
import { byteBoundHold } from "../src/hold";
import { openDb, hashToken } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { priceUsage, type Usage } from "../src/cost";

type Upstream = (url: string, init: any) => Promise<Response>;
const INITIAL = 10_000_000_000; // $10k — covers any hold here
const TF = "glm-5-2"; // priced under tinfoil (prices.json); NOT a REASONING_MARKER id

const anthropic = { apiKey: "real-anthropic-key", baseUrl: "https://anthropic.example", version: "2023-06-01", estimateHold: byteBoundHold };

// OpenAI + Tinfoil both configured by default → both share /v1/chat/completions (the routing case under test).
function makeHandler(upstreamFetch: Upstream, over: Partial<HandlerDeps> = {}) {
  const balances = openDb(":memory:");
  const orders = openOrderStore(":memory:");
  const deps: HandlerDeps = {
    openai: { apiKey: "real-openai-key", baseUrl: "https://openai.example", estimateHold: byteBoundHold },
    tinfoil: { apiKey: "real-tinfoil-key", baseUrl: "https://tinfoil.example", estimateHold: byteBoundHold },
    upstreamTimeoutMs: 1000,
    margin: 1.15,
    buyMinUsd: 5,
    buyMaxUsd: 2000,
    orderTtlMs: 4 * 60 * 60 * 1000,
    orderTrackingMs: (4 * 60 + 30) * 60 * 1000,
    maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096,
    maxMessagesBodyBytes: 33_554_432,
    balances,
    orders,
    upstreamFetch: upstreamFetch as typeof fetch,
    rails: new Map<string, RailView>([
      ["monero", { name: "monero", createAddress: async () => ({ address: "8x", orderIndex: 0 }), rateUsd: async () => 150, scale: 1_000_000_000_000, unit: "XMR", confirmations: 10, paymentUri: (a: string, amt: string) => `monero:${a}?tx_amount=${amt}` }],
    ]),
    defaultRail: "monero",
    ...over,
  };
  return { handler: createHandler(deps), balances, orders };
}

function chatReq(token: string, body: unknown): Request {
  return new Request("https://proxy.local/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}
const fund = (b: ReturnType<typeof openDb>, token: string) => b.credit(hashToken(token), INITIAL);
const debit = (b: ReturnType<typeof openDb>, token: string) => INITIAL - b.getBalance(hashToken(token))!;

// Buffered chat stub that records each forwarded {url, headers, body}.
function capturing(model: string, usage: object) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fetchImpl: Upstream = async (url, init) => {
    calls.push({ url, headers: init.headers as Headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ model, usage, choices: [{ message: { role: "assistant", content: "hi" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

// OpenAI-shape SSE stub (Tinfoil is OpenAI-compatible): bare `data: {json}` frames + `data: [DONE]`. One
// frame per client pull, so a test can read N then cancel; onCancel fires when the disconnect reaches upstream.
function stream(chunks: object[], onCancel?: () => void): Upstream {
  const enc = new TextEncoder();
  const frames = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { (controller as any)._i = 0; },
        pull(controller) {
          const i = (controller as any)._i++;
          if (i >= frames.length) return controller.close();
          controller.enqueue(enc.encode(frames[i]!));
        },
        cancel() { onCancel?.(); },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

// --- Routing on the shared /v1/chat/completions path ----------------------------------------------

test("a bare Tinfoil model routes to Tinfoil and bills FLAT (cache_read == input)", async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } };
  const { fetchImpl, calls } = capturing(TF, usage);
  const token = "pr_tf_bare";
  const { handler, balances } = makeHandler(fetchImpl);
  fund(balances, token);
  const res = await handler(chatReq(token, { model: TF, max_completion_tokens: 1000, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(200);
  expect(calls[0]!.url).toBe("https://tinfoil.example/v1/chat/completions"); // routed to Tinfoil, not OpenAI
  expect("store" in calls[0]!.body).toBe(false); // OpenAI-specific; never sent to Tinfoil (buffered path)
  // 400 of the 1000 prompt tokens are cached, but Tinfoil's cache_read rate == input rate → the bill equals
  // charging the whole prompt at the input rate. Flatness, proven against an independent shape.
  expect(debit(balances, token)).toBe(priceUsage(TF, { input_tokens: 1000, output_tokens: 200 }));
});

test("a `tinfoil/<model>` prefix routes to Tinfoil and forwards the native (stripped) id", async () => {
  const { fetchImpl, calls } = capturing(TF, { prompt_tokens: 10, completion_tokens: 5 });
  const token = "pr_tf_prefix";
  const { handler, balances } = makeHandler(fetchImpl);
  fund(balances, token);
  const res = await handler(chatReq(token, { model: `tinfoil/${TF}`, max_completion_tokens: 100, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(200);
  expect(calls[0]!.url).toBe("https://tinfoil.example/v1/chat/completions");
  expect(calls[0]!.body.model).toBe(TF); // prefix stripped before forwarding (upstream never sees `tinfoil/`)
});

test("on the shared path, a bare OpenAI model still routes to OpenAI (coexistence)", async () => {
  const { fetchImpl, calls } = capturing("gpt-5", { prompt_tokens: 10, completion_tokens: 5 });
  const token = "pr_tf_coexist";
  const { handler, balances } = makeHandler(fetchImpl);
  fund(balances, token);
  const res = await handler(chatReq(token, { model: "gpt-5", max_completion_tokens: 100, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(200);
  expect(calls[0]!.url).toBe("https://openai.example/v1/chat/completions");
});

test("a prefix naming a provider that doesn't serve this path is rejected before any spend", async () => {
  const { fetchImpl, calls } = capturing(TF, {});
  const token = "pr_tf_wrongpath";
  // anthropic configured → `anthropic` is a known provider id, but it lives on /v1/messages, not the chat path.
  const { handler, balances } = makeHandler(fetchImpl, { anthropic });
  fund(balances, token);
  const res = await handler(chatReq(token, { model: "anthropic/claude-opus-4-8", max_completion_tokens: 100, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(400);
  expect(calls.length).toBe(0); // gated at routing — nothing forwarded
  expect(debit(balances, token)).toBe(0); // and nothing spent
});

// --- Body mutation: forced include_usage, never store:false ---------------------------------------

test("Tinfoil forward forces stream_options.include_usage (over a client false) and never sends store:false", async () => {
  const calls: { headers: Headers; body: any }[] = [];
  const fetchImpl: Upstream = async (_url, init) => {
    calls.push({ headers: init.headers as Headers, body: JSON.parse(init.body) });
    const enc = new TextEncoder();
    const frames = [
      `data: ${JSON.stringify({ model: TF, choices: [{ delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ model: TF, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
      "data: [DONE]\n\n",
    ];
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (i >= frames.length) return c.close(); c.enqueue(enc.encode(frames[i++]!)); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const token = "pr_tf_body";
  const { handler, balances } = makeHandler(fetchImpl);
  fund(balances, token);
  const res = await handler(chatReq(token, { model: TF, max_completion_tokens: 100, stream: true, stream_options: { include_usage: false }, messages: [{ role: "user", content: "hi" }] }));
  expect(res.status).toBe(200);
  await res.text(); // drain → settle
  expect(calls[0]!.body.stream_options.include_usage).toBe(true); // forced on (client sent false)
  expect("store" in calls[0]!.body).toBe(false); // OpenAI-specific; Tinfoil enclaves are ephemeral
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer real-tinfoil-key"); // our key injected
});

// --- forceReasoning: a disconnect bills the cap, not the visible-char estimate --------------------

test("a Tinfoil streaming disconnect counts delta.reasoning (and reasoning_content) in the char estimate, no cap", async () => {
  let cancelled = false;
  // Verified-live Tinfoil shape: reasoning streams in `delta.reasoning` (gpt-oss/glm/kimi). We also count the
  // DeepSeek-style `reasoning_content` for robustness. Both must feed the disconnect estimate (no cap).
  const chunks = [
    { model: TF, choices: [{ delta: { role: "assistant", content: "" } }] },
    { model: TF, choices: [{ delta: { reasoning: "r".repeat(24) } }] }, // Tinfoil's field — 24 chars
    { model: TF, choices: [{ delta: { reasoning_content: "x".repeat(16) } }] }, // DeepSeek-style — 16 chars
    { model: TF, choices: [{ delta: { content: "cccccccc" } }] }, // 8 answer chars
    { model: TF, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 9999 } }, // never reached
  ];
  const token = "pr_tf_cancel";
  const { handler, balances } = makeHandler(stream(chunks, () => (cancelled = true)));
  fund(balances, token);
  const body = { model: TF, max_completion_tokens: 1000, stream: true, messages: [{ role: "user", content: "x".repeat(4000) }] };
  const res = await handler(chatReq(token, body));
  const reader = res.body!.getReader();
  await reader.read(); // role chunk
  await reader.read(); // delta.reasoning (24) — counted
  await reader.read(); // delta.reasoning_content (16) — counted
  await reader.read(); // content (8)
  await reader.cancel(); // client disconnects
  expect(cancelled).toBe(true); // upstream generation cancelled → spend stops
  // B: open-weight reasoning is visible, so the disconnect uses the char estimate over content + reasoning —
  // NOT the cap. 24 + 16 + 8 = 48 chars → ceil(48/4) = 12 output tokens. Input is the byte-bound hold's count.
  // (OpenAI's HIDDEN-reasoning models still bill the cap — see openai.property.test.)
  const inputTokens = Buffer.byteLength(JSON.stringify(body), "utf8");
  const expected: Usage = { input_tokens: inputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 12 };
  expect(debit(balances, token)).toBe(priceUsage(TF, expected));
});

// --- Premium gate + price-file invariant ----------------------------------------------------------

test("Tinfoil rejects output-multiplying options (n/best_of != 1) with unsupported_option, before any spend; n==1/best_of==1 pass", async () => {
  const { fetchImpl, calls } = capturing(TF, { prompt_tokens: 10, completion_tokens: 5 });
  const token = "pr_tf_reject";
  const { handler, balances } = makeHandler(fetchImpl);
  fund(balances, token);
  for (const bad of [{ n: 2 }, { best_of: 2 }, { n: 2, best_of: 2 }]) {
    const res = await handler(chatReq(token, { model: TF, max_completion_tokens: 100, ...bad, messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(400); // n / best_of would multiply output past the single-completion hold
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported_option");
  }
  expect(calls.length).toBe(0); // every reject gated before forwarding
  expect(debit(balances, token)).toBe(0); // and nothing spent
  // Boundary: the accepted values (n==1, best_of==1) are NOT rejected — the request forwards.
  const ok = await handler(chatReq(token, { model: TF, max_completion_tokens: 100, n: 1, best_of: 1, messages: [{ role: "user", content: "hi" }] }));
  expect(ok.status).toBe(200);
  expect(calls.length).toBe(1);
});

test("Tinfoil accepts the legacy max_tokens cap and x-api-key auth; an absent cap is rejected", async () => {
  const { fetchImpl, calls } = capturing(TF, { prompt_tokens: 10, completion_tokens: 5 });
  const token = "pr_tf_compat";
  const { handler, balances } = makeHandler(fetchImpl);
  fund(balances, token);
  // Legacy `max_tokens` (not max_completion_tokens) + the proxy token via x-api-key (the Bearer fallback).
  const ok = await handler(new Request("https://proxy.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({ model: TF, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
  }));
  expect(ok.status).toBe(200);
  expect(calls.length).toBe(1);
  // Legacy cap is normalized to max_completion_tokens (the field the backend honors) on forward; max_tokens dropped.
  expect(calls[0]!.body.max_completion_tokens).toBe(100);
  expect("max_tokens" in calls[0]!.body).toBe(false);
  // max_tokens: 0 fails the m>0 guard → no cap → max_tokens_required, no further spend.
  const noCap = await handler(chatReq(token, { model: TF, max_tokens: 0, messages: [{ role: "user", content: "hi" }] }));
  expect(noCap.status).toBe(400);
  expect(((await noCap.json()) as { error: { code: string } }).error.code).toBe("max_tokens_required");
  expect(calls.length).toBe(1); // still only the one accepted call
});

test("Tinfoil-only deployment exercises Tinfoil's own readToken (Bearer + x-api-key; no auth → 401)", async () => {
  // With OpenAI also configured, representative=openai and OpenAI's reader runs — so Tinfoil's bearerToken is
  // only reached when Tinfoil is the sole provider on the path (a privacy-focused Tinfoil-only box).
  const { fetchImpl, calls } = capturing(TF, { prompt_tokens: 10, completion_tokens: 5 });
  const token = "pr_tf_only";
  const { handler, balances } = makeHandler(fetchImpl, { openai: undefined });
  fund(balances, token);
  const body = { model: TF, max_completion_tokens: 100, messages: [{ role: "user", content: "hi" }] };
  expect((await handler(chatReq(token, body))).status).toBe(200); // Authorization: Bearer
  expect((await handler(new Request("https://proxy.local/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, body: JSON.stringify(body) }))).status).toBe(200); // x-api-key fallback
  expect((await handler(new Request("https://proxy.local/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))).status).toBe(401); // no token
  expect(calls.length).toBe(2); // the two authed calls forwarded; the unauthed one gated before spend
});

test("Tinfoil forward preserves the client's output cap, injects the default when omitted, and adds no stream_options to a non-stream request", async () => {
  const { fetchImpl, calls } = capturing(TF, { prompt_tokens: 10, completion_tokens: 5 });
  const token = "pr_tf_cap";
  const { handler, balances } = makeHandler(fetchImpl, { defaultMaxOutputTokens: 222 });
  fund(balances, token);
  // Client sends a cap → forwarded body keeps it verbatim (not overwritten), and a non-stream request gets no stream_options.
  await handler(chatReq(token, { model: TF, max_completion_tokens: 100, messages: [{ role: "user", content: "hi" }] }));
  expect(calls[0]!.body.max_completion_tokens).toBe(100);
  expect("stream_options" in calls[0]!.body).toBe(false);
  // Client omits a cap → the configured default is injected into the forward (bounding output to the hold).
  await handler(chatReq(token, { model: TF, messages: [{ role: "user", content: "hi" }] }));
  expect(calls[1]!.body.max_completion_tokens).toBe(222);
  // Both caps present → forwarded as a single max_completion_tokens == the hold's cap; legacy max_tokens dropped,
  // so the forwarded ceiling can't diverge from the hold regardless of backend cap precedence.
  await handler(chatReq(token, { model: TF, max_completion_tokens: 100, max_tokens: 999999, messages: [{ role: "user", content: "hi" }] }));
  expect(calls[2]!.body.max_completion_tokens).toBe(100);
  expect("max_tokens" in calls[2]!.body).toBe(false);
});
