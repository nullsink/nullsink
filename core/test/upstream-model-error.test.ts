// The model-not-found fix: an upstream that rejects the MODEL (Anthropic 404 not_found_error; OpenAI 404
// chat / 400 responses, code model_not_found) must return our own clear `unsupported_model` 4xx — NOT a
// masked 503, NOT the raw provider body. Plus the masked-error log scrub drops the upstream request_id.
// The bodies below are captured VERBATIM from the live providers (real keys, 2026-06-22).
import { test, expect, spyOn } from "bun:test";
import { isModelNotFound, maskedErrorDetail, createHandler, type HandlerDeps, type RailView } from "./support/handler-combined";
import { openDb, hashToken } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { byteBoundHold } from "../src/hold";

const ANTHROPIC_404 = JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: claude-sonnet-4-5-20251101" }, request_id: "req_011CcJcPxUSc7Tc5kGhXcwGW" });
const OPENAI_CHAT_404 = JSON.stringify({ error: { message: "The model `gpt-bogus` does not exist or you do not have access to it.", type: "invalid_request_error", param: null, code: "model_not_found" } });
const OPENAI_RESPONSES_400 = JSON.stringify({ error: { message: "The requested model 'gpt-bogus' does not exist.", type: "invalid_request_error", param: "model", code: "model_not_found" } });

test("isModelNotFound: catches every provider/endpoint model error despite differing status codes", () => {
  expect(isModelNotFound(404, ANTHROPIC_404)).toBe(true); // anthropic /v1/messages
  expect(isModelNotFound(404, OPENAI_CHAT_404)).toBe(true); // openai /v1/chat/completions
  expect(isModelNotFound(400, OPENAI_RESPONSES_400)).toBe(true); // openai /v1/responses — a bare 404 check would MISS this
  expect(isModelNotFound(404, "<html>gateway</html>")).toBe(true); // non-JSON 404 → status fallback
});

test("isModelNotFound: a genuine non-model error is NOT a model-not-found (still relays / masks normally)", () => {
  expect(isModelNotFound(400, JSON.stringify({ error: { message: "Invalid 'temperature'", type: "invalid_request_error", code: "invalid_value" } }))).toBe(false);
  expect(isModelNotFound(401, JSON.stringify({ error: { type: "authentication_error" } }))).toBe(false);
  expect(isModelNotFound(429, JSON.stringify({ error: { type: "rate_limit_error" } }))).toBe(false);
  expect(isModelNotFound(500, "boom")).toBe(false);
});

test("maskedErrorDetail: logs type + model, DROPS the upstream request_id", () => {
  const d = maskedErrorDetail(ANTHROPIC_404);
  expect(d).toContain("not_found_error");
  expect(d).toContain("model: claude-sonnet-4-5-20251101"); // the model id — the actionable bit
  expect(d).not.toContain("req_011"); // the request_id — never logged
});

test("maskedErrorDetail: openai includes type/code; non-JSON → short slice; JSON without error.* → empty", () => {
  expect(maskedErrorDetail(OPENAI_CHAT_404)).toContain("invalid_request_error/model_not_found");
  expect(maskedErrorDetail("<html>502 Bad Gateway</html>")).toBe("<html>502 Bad Gateway</html>");
  expect(maskedErrorDetail(JSON.stringify({ request_id: "req_secret", x: 1 }))).toBe(""); // no error.* → don't slice raw (it holds request_id)
});

function makeHandler(upstreamFetch: (url: string, init: any) => Promise<Response>) {
  const balances = openDb(":memory:");
  const deps: HandlerDeps = {
    anthropic: { apiKey: "k", baseUrl: "https://up.example", version: "2023-06-01", estimateHold: byteBoundHold },
    upstreamTimeoutMs: 1000,
    margin: 1.15, buyMinUsd: 5, buyMaxUsd: 2000, orderTtlMs: 4 * 60 * 60 * 1000, maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096, maxMessagesBodyBytes: 33_554_432, balances, orders: openOrderStore(":memory:"),
    upstreamFetch: upstreamFetch as typeof fetch,
    rails: new Map<string, RailView>([["monero", { name: "monero", createAddress: async () => ({ address: "8a", orderIndex: 0 }), rateUsd: async () => 150, scale: 1e12, unit: "XMR", confirmations: 10, paymentUri: (a, amt) => `monero:${a}?tx_amount=${amt}` }]]),
    defaultRail: "monero",
  };
  return { handler: createHandler(deps), balances };
}
const msg = (token: string) => new Request("https://proxy.local/v1/messages", {
  method: "POST", headers: { "content-type": "application/json", "x-api-key": token },
  body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
});

test("handler: an upstream model 404 returns 400 unsupported_model (not a masked 503), fully refunded", async () => {
  const warnSpy = spyOn(console, "error").mockImplementation(() => {}); // log.warn → console.error
  const { handler, balances } = makeHandler(async () => new Response(ANTHROPIC_404, { status: 404, headers: { "content-type": "application/json" } }));
  const hash = hashToken("pr_m");
  balances.credit(hash, 10_000_000_000);
  const before = balances.getBalance(hash)!;
  const res = await handler(msg("pr_m"));

  expect(res.status).toBe(400); // NOT 503
  expect(JSON.parse(await res.text()).error.message).toBe("unsupported_model"); // nullsink's own envelope, same as the gate
  expect(balances.getBalance(hash)).toBe(before); // refunded — the failed request cost nothing

  const line = warnSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
  expect(line).toContain("model not found upstream");
  expect(line).toContain("claude-sonnet-4-5-20251101"); // the model is logged (actionable)
  expect(line).not.toContain("req_011"); // the upstream request_id is NOT
  warnSpy.mockRestore();
});
