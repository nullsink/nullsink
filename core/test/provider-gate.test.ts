// Provider gate tests for surviving mutants in the outputCap boundary and the server-tool denylists (the
// existing gate tests cover some reject reasons but skip these specific fee-bearing tools and the m>0 edge).
// (Gaps surfaced by mutation testing.)
import { test, expect } from "bun:test";
import { makeAnthropicProvider } from "../src/providers/anthropic";
import { makeOpenAIProviders } from "../src/providers/openai";
import type { HoldEstimator } from "../src/hold";

const estimateHold = (() => ({ micros: 0, inputTokens: 0 })) as unknown as HoldEstimator;
const anthropic = makeAnthropicProvider({ apiKey: "k", baseUrl: "https://up", version: "2023-06-01", estimateHold });
const { chat, responses } = makeOpenAIProviders({ apiKey: "k", baseUrl: "https://up", estimateHold });

// providers/anthropic.ts:93 + providers/openai.ts:82/136 — `m > 0` survived `m >= 0`, so `max_tokens: 0` is
// accepted as a valid 0-cap (an input-only hold) instead of being rejected as max_tokens_required.
test("outputCap rejects max_tokens === 0 (m > 0, not m >= 0) on every provider", () => {
  expect(anthropic.outputCap({ max_tokens: 0 })).toBeNull();
  expect(anthropic.outputCap({ max_tokens: 5 })).toBe(5);
  expect(chat.outputCap({ max_completion_tokens: 0 })).toBeNull();
  expect(chat.outputCap({ max_tokens: 0 })).toBeNull();
  expect(responses.outputCap({ max_output_tokens: 0 })).toBeNull();
  expect(responses.outputCap({ max_output_tokens: 5 })).toBe(5);
});

// Positive control for the OpenAI chat precedence (max_completion_tokens wins over legacy max_tokens).
test("openai chat outputCap prefers max_completion_tokens over max_tokens", () => {
  expect(chat.outputCap({ max_completion_tokens: 5, max_tokens: 9 })).toBe(5);
  expect(chat.outputCap({ max_tokens: 7 })).toBe(7);
});

// outputCap / premiumReject must tolerate a null body and a malformed tools array (the gate runs on
// upstream-adjacent parsed input) — pins the `body?.`/`t?.type` optional-chaining + the non-string type coercion.
test("the gate functions don't crash on a null body or malformed tool entries", () => {
  expect(anthropic.outputCap(null)).toBeNull();
  expect(chat.outputCap(null)).toBeNull();
  expect(responses.outputCap(null)).toBeNull();
  expect(anthropic.premiumReject({ tools: [null, { type: 123 }] })).toBeNull(); // non-server / non-string types → not rejected, no throw
  expect(responses.premiumReject({ tools: [null, { type: 123 }] })).toBeNull();
});

// providers/anthropic.ts:35 — the server-tool denylist is `web_search || code_execution`; the code_execution
// clause is untested (existing gate test only sends web_search), so dropping it forwards a fee-bearing tool.
test("anthropic premiumReject rejects code_execution as well as web_search", () => {
  expect(anthropic.premiumReject({ tools: [{ type: "code_execution_20250825" }] })).toEqual({ status: 400, error: "unsupported_tool" });
  expect(anthropic.premiumReject({ tools: [{ type: "web_search_20250305" }] })).toEqual({ status: 400, error: "unsupported_tool" });
  expect(anthropic.premiumReject({ tools: [{ type: "custom_user_tool" }] })).toBeNull(); // client tools are just tokens
});

// providers/openai.ts:103-114 — the Responses built-in-tool denylist has four fee-bearing prefixes; the gate
// tests don't exercise file_search / computer_use / image_generation, so dropping any clause under-bills.
test("openai responses premiumReject rejects each fee-bearing built-in tool", () => {
  // Suffixed variants on purpose: the denylist is PREFIX-matched (startsWith), so a versioned tool id must
  // still be caught — and this kills the startsWith→endsWith mutant an exact string would leave equivalent.
  for (const type of ["web_search_preview", "file_search_2025", "computer_use_preview", "image_generation_v1", "code_interpreter_2025"]) {
    expect(responses.premiumReject({ tools: [{ type }] })).toEqual({ status: 400, error: "unsupported_tool" });
  }
  expect(responses.premiumReject({ tools: [{ type: "function" }] })).toBeNull(); // function tools are allowed
});

// providers/openai.ts:164 — ownsModel must reject off-card ids that PREFIX-match a priced base (search-preview
// would re-admit at gpt-4o's base rate and under-bill the per-call search fee).
test("openai ownsModel rejects off-card *-search-preview but accepts the priced base", () => {
  expect(chat.ownsModel("gpt-4o-search-preview")).toBe(false);
  expect(chat.ownsModel("gpt-4o")).toBe(true);
  expect(chat.ownsModel("claude-opus-4-8")).toBe(false); // wrong provider
});
