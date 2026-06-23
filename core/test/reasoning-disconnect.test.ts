// F1 (B4 audit): an OpenAI reasoning-model stream that DISCONNECTS before the final usage chunk must bill
// the output CAP, not the char estimate — its billed "thinking" tokens never appear in the streamed text,
// so the char count is blind to them and would massively under-bill. A clean close still bills EXACT usage.
import { test, expect } from "bun:test";
import { openaiChatScanner, openaiResponsesScanner } from "../src/cost";

const chatDelta = (text: string, model = "gpt-5-pro") =>
  `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`;
const chatFinalUsage = (model = "gpt-5-pro", completion = 250) =>
  `data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: 100, completion_tokens: completion } })}\n\n`;
const respDelta = (text: string) =>
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;

test("chat: reasoning-model disconnect bills the output CAP, not the tiny char estimate", () => {
  const scan = openaiChatScanner({ model: "gpt-5-pro", inputTokens: 100, maxTokens: 40_000, reasoning: true });
  scan.feed(chatDelta("391")); // a 3-char visible answer after lots of invisible reasoning, then disconnect
  expect(scan.result()?.usage.output_tokens).toBe(40_000); // the cap — NOT ceil(3/4)=1
});

test("chat: non-reasoning disconnect bills the char estimate (cap NOT applied)", () => {
  const scan = openaiChatScanner({ model: "gpt-4o", inputTokens: 100, maxTokens: 40_000, reasoning: false });
  scan.feed(chatDelta("x".repeat(400), "gpt-4o"));
  expect(scan.result()?.usage.output_tokens).toBe(100); // ceil(400/4), NOT the cap
});

test("chat: a CLEAN close bills EXACT usage even for a reasoning model (cap override only on disconnect)", () => {
  const scan = openaiChatScanner({ model: "gpt-5-pro", inputTokens: 100, maxTokens: 40_000, reasoning: true });
  scan.feed(chatDelta("391"));
  scan.feed(chatFinalUsage("gpt-5-pro", 250)); // include_usage final chunk → exact
  expect(scan.result()?.usage.output_tokens).toBe(250); // exact, not the cap
});

test("responses: reasoning-model disconnect bills the output CAP", () => {
  const scan = openaiResponsesScanner({ model: "o4-mini", inputTokens: 100, maxTokens: 12_000, reasoning: true });
  scan.feed(respDelta("ok"));
  expect(scan.result()?.usage.output_tokens).toBe(12_000);
});

test("an upstream-error stream still full-refunds (null) even for a reasoning model", () => {
  const scan = openaiChatScanner({ model: "gpt-5-pro", inputTokens: 100, maxTokens: 40_000, reasoning: true });
  scan.feed(`data: ${JSON.stringify({ type: "error", error: { message: "overloaded" } })}\n\n`);
  expect(scan.result()).toBeNull(); // nothing usable → full refund, never the cap
});
