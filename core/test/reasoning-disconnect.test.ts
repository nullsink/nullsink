// A reservation ceiling is an admission-control bound, never usage evidence. Before OpenAI's terminal usage
// arrives, every model therefore uses the same conservative visible-work estimate. Hidden reasoning may make
// that estimate lower than the provider's eventual bill, but charging the configured maximum after one tiny
// frame would be a much larger and user-hostile error. A clean close still bills exact reported usage.
import { test, expect } from "bun:test";
import { openaiChatScanner, openaiResponsesScanner } from "../src/cost";

const chatDelta = (text: string, model = "gpt-5-pro") =>
  `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`;
const chatFinalUsage = (model = "gpt-5-pro", completion = 250) =>
  `data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: 100, completion_tokens: completion } })}\n\n`;
const respDelta = (text: string) =>
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;

test("chat: reasoning-model disconnect bills visible output, never the output reservation", () => {
  const scan = openaiChatScanner({ model: "gpt-5-pro", inputTokens: 100 });
  scan.feed(chatDelta("391")); // a 3-char visible answer after lots of invisible reasoning, then disconnect
  expect(scan.result()?.usage.output_tokens).toBe(1);
});

test("chat: non-reasoning disconnect bills the char estimate (cap NOT applied)", () => {
  const scan = openaiChatScanner({ model: "gpt-4o", inputTokens: 100 });
  scan.feed(chatDelta("x".repeat(400), "gpt-4o"));
  expect(scan.result()?.usage.output_tokens).toBe(100); // ceil(400/4), NOT the cap
});

test("chat: a clean close bills exact usage even for a reasoning model", () => {
  const scan = openaiChatScanner({ model: "gpt-5-pro", inputTokens: 100 });
  scan.feed(chatDelta("391"));
  scan.feed(chatFinalUsage("gpt-5-pro", 250)); // include_usage final chunk → exact
  expect(scan.result()?.usage.output_tokens).toBe(250); // exact, not the cap
});

test("responses: reasoning-model disconnect bills visible output, never the output reservation", () => {
  const scan = openaiResponsesScanner({ model: "o4-mini", inputTokens: 100 });
  scan.feed(respDelta("ok"));
  expect(scan.result()?.usage.output_tokens).toBe(1);
});

test("an upstream error before visible output still full-refunds even for a reasoning model", () => {
  const scan = openaiChatScanner({ model: "gpt-5-pro", inputTokens: 100 });
  scan.feed(`data: ${JSON.stringify({ type: "error", error: { message: "overloaded" } })}\n\n`);
  expect(scan.result()).toBeNull(); // nothing usable → full refund, never the cap
});

test("a reasoning-model upstream failure after visible text estimates that text, never the output cap", () => {
  const scan = openaiChatScanner({ model: "gpt-5-pro", inputTokens: 100 });
  scan.feed(chatDelta("12345678"));
  scan.feed(`data: ${JSON.stringify({ type: "error", error: { message: "overloaded" } })}\n\n`);
  expect(scan.result("evidenced_only")?.usage).toMatchObject({
    input_tokens: 100,
    output_tokens: 2,
  });
});

test("metadata-only reasoning stream can never turn the reservation into a charge", () => {
  const scan = openaiChatScanner({ model: "gpt-5-pro", inputTokens: 100 });
  scan.feed(chatDelta(""));
  expect(scan.result()?.usage).toMatchObject({ input_tokens: 100, output_tokens: 0 });
  expect(scan.result("evidenced_only")).toBeNull();
});
