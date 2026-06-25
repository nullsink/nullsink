// selectProviders — the either-or registration + the ≥1-provider invariant (S17). Each provider is
// registered iff its config is given; an all-absent set throws (the library backstop behind index.ts's boot
// guard), mirroring selectRails' empty-PAY_RAILS guard. The composition root is untested by convention, so
// this seam is where the invariant gets coverage.
import { test, expect } from "bun:test";
import { selectProviders } from "../src/providers";
import type { HoldEstimator } from "../src/hold";

const estimateHold = (() => ({ micros: 0, inputTokens: 0 })) as unknown as HoldEstimator;
const anthropic = { apiKey: "k", baseUrl: "https://up", version: "2023-06-01", estimateHold };
const openai = { apiKey: "k", baseUrl: "https://up", estimateHold };

test("anthropic-only registers /v1/messages and no OpenAI paths", () => {
  const m = selectProviders({ anthropic });
  expect([...m.keys()].sort()).toEqual(["/v1/messages"]);
});

test("openai-only registers the OpenAI pair and not /v1/messages", () => {
  const m = selectProviders({ openai });
  expect([...m.keys()].sort()).toEqual(["/v1/chat/completions", "/v1/responses"]);
});

test("both configured registers all three metered paths", () => {
  const m = selectProviders({ anthropic, openai });
  expect([...m.keys()].sort()).toEqual(["/v1/chat/completions", "/v1/messages", "/v1/responses"]);
});

test("an all-absent config throws (the ≥1-provider invariant)", () => {
  expect(() => selectProviders({})).toThrow(/no providers configured/);
});
