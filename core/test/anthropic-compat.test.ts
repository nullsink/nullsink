// Anthropic via its OpenAI-compat endpoint: claude-* reachable on POST /v1/chat/completions, so one endpoint
// serves every model. It FORWARDS (not translates) to Anthropic's OpenAI-shaped API, reusing the OpenAI usage
// adapters, so billing resolves the returned claude-* id to the Anthropic rate card. Tests: the provider
// pieces, model resolution among the three chat providers, and an end-to-end forward+bill on the money path.
import { test, expect } from "bun:test";
import { createHandler, type HandlerDeps, type RailView } from "../src/handler";
import { makeAnthropicCompatProvider } from "../src/providers/anthropic-compat";
import { selectProviders, resolveProvider } from "../src/providers";
import { openDb, hashToken } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { byteBoundHold } from "../src/hold";

const COMPAT = { apiKey: "sk-ant-xxx", baseUrl: "https://up.example", estimateHold: byteBoundHold };

test("provider: owns claude-*, not gpt-*/open-weight; forwards on the chat path with Bearer auth", () => {
  const p = makeAnthropicCompatProvider(COMPAT);
  expect(p.id).toBe("anthropic");
  expect(p.upstreamPath).toBe("/v1/chat/completions");
  expect(p.ownsModel("claude-opus-4-8")).toBe(true);
  expect(p.ownsModel("claude-fable-5")).toBe(true);
  expect(p.ownsModel("gpt-5.5")).toBe(false); // OpenAI owns gpt-*
  expect(p.ownsModel("gpt-oss-120b")).toBe(false); // Tinfoil owns the open-weight gpt-oss
  const h = new Headers();
  p.injectAuth(h);
  expect(h.get("authorization")).toBe("Bearer sk-ant-xxx");
});

test("provider: cap required; n!=1 rejected; body normalizes cap + include_usage, drops max_tokens, no store", () => {
  const p = makeAnthropicCompatProvider(COMPAT);
  expect(p.outputCap({ max_tokens: 100 })).toBe(100);
  expect(p.outputCap({ max_completion_tokens: 50 })).toBe(50);
  expect(p.outputCap({})).toBeNull(); // → max_tokens_required
  expect(p.premiumReject({ n: 2 })).toEqual({ status: 400, error: "unsupported_option" });
  expect(p.premiumReject({ n: 1 })).toBeNull();
  const out = JSON.parse(p.prepareBody("", { model: "claude-opus-4-8", max_tokens: 40 }, true));
  expect(out.max_completion_tokens).toBe(40);
  expect("max_tokens" in out).toBe(false); // one unambiguous ceiling
  expect(out.stream_options).toEqual({ include_usage: true });
  expect("store" in out).toBe(false); // unlike the OpenAI provider — Anthropic ignores it
});

test("provider: strips the native `thinking` trigger (hidden output tokens would under-bill a disconnect)", () => {
  const p = makeAnthropicCompatProvider(COMPAT);
  const out = JSON.parse(p.prepareBody("", { model: "claude-opus-4-8", max_completion_tokens: 64, thinking: { type: "enabled", budget_tokens: 1024 } }, true));
  expect("thinking" in out).toBe(false); // thinking belongs on the full-fidelity native /v1/messages path
  expect(out.max_completion_tokens).toBe(64); // rest of the body is untouched
});

test("resolution: claude-* → anthropic-compat on the shared chat path; gpt-* → openai; open-weight → tinfoil", () => {
  const providers = selectProviders({
    openai: { apiKey: "o", baseUrl: "https://o", estimateHold: byteBoundHold },
    tinfoil: { apiKey: "t", baseUrl: "https://t", estimateHold: byteBoundHold },
    anthropicCompat: COMPAT,
  });
  const chat = providers.get("/v1/chat/completions")!;
  const known = new Set(chat.map((c) => c.id));
  expect(resolveProvider(chat, "claude-opus-4-8", known)).toMatchObject({ ok: true, provider: { id: "anthropic" }, model: "claude-opus-4-8", prefixed: false });
  expect(resolveProvider(chat, "gpt-5.5", known)).toMatchObject({ ok: true, provider: { id: "openai" } });
  expect(resolveProvider(chat, "gpt-oss-120b", known)).toMatchObject({ ok: true, provider: { id: "tinfoil" } });
  // explicit provider/model prefix still routes to the compat provider
  expect(resolveProvider(chat, "anthropic/claude-opus-4-8", known)).toMatchObject({ ok: true, provider: { id: "anthropic" }, model: "claude-opus-4-8", prefixed: true });
});

function makeHandler(upstreamFetch: (url: string, init: any) => Promise<Response>) {
  const balances = openDb(":memory:");
  const deps: HandlerDeps = {
    anthropic: { apiKey: "native", baseUrl: "https://native.example", version: "2023-06-01", estimateHold: byteBoundHold },
    anthropicCompat: COMPAT,
    upstreamTimeoutMs: 1000,
    margin: 1.15, buyMinUsd: 5, buyMaxUsd: 2000, orderTtlMs: 4 * 60 * 60 * 1000, maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096, maxMessagesBodyBytes: 33_554_432, balances, orders: openOrderStore(":memory:"),
    upstreamFetch: upstreamFetch as typeof fetch,
    rails: new Map<string, RailView>([["monero", { name: "monero", createAddress: async () => ({ address: "8a", orderIndex: 0 }), rateUsd: async () => 150, scale: 1e12, unit: "XMR", confirmations: 10, paymentUri: (a, amt) => `monero:${a}?tx_amount=${amt}` }]]),
    defaultRail: "monero",
  };
  return { handler: createHandler(deps), balances };
}

test("handler: claude-* on /v1/chat/completions forwards to Anthropic's compat endpoint with our Bearer key, bills the Anthropic rate", async () => {
  let captured: { url: string; init: any } | null = null;
  const upstream = JSON.stringify({
    id: "chatcmpl-x", object: "chat.completion", model: "claude-fable-5",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, prompt_tokens_details: { cached_tokens: 0 } },
  });
  const { handler, balances } = makeHandler(async (url, init) => {
    captured = { url, init };
    return new Response(upstream, { status: 200, headers: { "content-type": "application/json" } });
  });
  const hash = hashToken("tok");
  balances.credit(hash, 10_000_000_000);
  const before = balances.getBalance(hash)!;

  const res = await handler(new Request("https://proxy.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify({ model: "claude-fable-5", max_completion_tokens: 256, messages: [{ role: "user", content: "hi" }] }),
  }));

  expect(res.status).toBe(200);
  // forwarded to Anthropic's OpenAI-compat endpoint (NOT the native /v1/messages), with OUR real key as Bearer
  expect(captured!.url).toBe("https://up.example/v1/chat/completions");
  expect((captured!.init.headers as Headers).get("authorization")).toBe("Bearer sk-ant-xxx");
  const fwd = JSON.parse(captured!.init.body);
  expect(fwd.max_completion_tokens).toBe(256);
  expect("store" in fwd).toBe(false);
  // billed the Anthropic rate for claude-fable-5 (input 10 / output 50 $/Mtok): 100*10 + 200*50 = 11000 micro-$
  expect(before - balances.getBalance(hash)!).toBe(11_000);
});

test("handler: with compat DISABLED, a claude-* model on /v1/chat/completions is rejected (unsupported_model)", async () => {
  // Only OpenAI on the chat path; no anthropicCompat → Claude isn't reachable there.
  const balances = openDb(":memory:");
  const deps: HandlerDeps = {
    openai: { apiKey: "o", baseUrl: "https://o.example", estimateHold: byteBoundHold },
    upstreamTimeoutMs: 1000, margin: 1.15, buyMinUsd: 5, buyMaxUsd: 2000, orderTtlMs: 4 * 60 * 60 * 1000, maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096, maxMessagesBodyBytes: 33_554_432, balances, orders: openOrderStore(":memory:"),
    upstreamFetch: (async () => { throw new Error("must not forward"); }) as unknown as typeof fetch,
    rails: new Map<string, RailView>([["monero", { name: "monero", createAddress: async () => ({ address: "8a", orderIndex: 0 }), rateUsd: async () => 150, scale: 1e12, unit: "XMR", confirmations: 10, paymentUri: (a, amt) => `monero:${a}?tx_amount=${amt}` }]]),
    defaultRail: "monero",
  };
  const handler = createHandler(deps);
  balances.credit(hashToken("tok"), 10_000_000_000);
  const res = await handler(new Request("https://proxy.local/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify({ model: "claude-fable-5", max_completion_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  }));
  expect(res.status).toBe(400);
  expect(JSON.parse(await res.text()).error.message).toBe("unsupported_model");
});
