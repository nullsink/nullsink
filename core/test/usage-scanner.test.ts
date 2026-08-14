// Direct unit tests for two streaming-scanner billing paths flagged as surviving mutants (the broad streaming
// tests drive the scanners through the handler with multi-frame streams, so these single-frame edges slip
// through).
import { test, expect } from "bun:test";
import { streamUsageScanner } from "../src/cost/usage/anthropic";
import { openaiChatScanner, openaiResponsesScanner } from "../src/cost/usage/openai";

const feed = (scan: { feed(c: string): void }, s: string) => scan.feed(s);

// anthropic.ts:59 — `output_tokens: u.output_tokens ?? 0` survived `→ u.output_tokens && 0` (always 0). That
// drops the ONLY output figure billed when a client disconnects right after message_start (before any delta).
test("Anthropic scanner bills the message_start output_tokens when no delta follows", () => {
  const scan = streamUsageScanner();
  feed(scan, `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`);
  const m = scan.result();
  expect(m).not.toBeNull();
  expect(m!.usage.output_tokens).toBe(5); // the `&& 0` mutant would make this 0
  expect(m!.usage.input_tokens).toBe(10);
  expect(scan.completed()).toBe(false); // usage alone is not a successful Anthropic terminal state
});

test("Anthropic scanner completes only on message_stop", () => {
  const scan = streamUsageScanner();
  feed(scan, `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
  expect(scan.completed()).toBe(false);
  feed(scan, `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  expect(scan.completed()).toBe(true);
});

test("OpenAI Chat scanner completes only on the [DONE] sentinel", () => {
  const scan = openaiChatScanner({ model: "gpt-5", inputTokens: 10 });
  feed(scan, `data: ${JSON.stringify({ model: "gpt-5", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
  expect(scan.completed()).toBe(false); // even exact terminal usage does not replace the protocol sentinel
  feed(scan, "data: [DONE]\n\n");
  expect(scan.completed()).toBe(true);
});

// cost/usage/openai.ts:183 — the Responses disconnect path accumulates `contentChars` from
// `response.output_text.delta` frames; both EqualityOperator negations survived. On a mid-stream disconnect
// (no terminal event) that count is the SOLE basis for the partial-output bill.
test("OpenAI Responses scanner estimates disconnect output from streamed delta chars (no terminal event)", () => {
  const scan = openaiResponsesScanner({ model: "gpt-4o", inputTokens: 10 });
  feed(scan, `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "abcd" })}\n\n`);
  feed(scan, `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "efgh" })}\n\n`);
  const m = scan.result(); // no response.completed → disconnect path
  expect(m).not.toBeNull();
  expect(m!.usage.output_tokens).toBe(2); // ceil(8 chars / 4); a dropped delta-accumulation mutant → 0
  expect(m!.usage.input_tokens).toBe(10); // the input floor from ctx
  expect(m!.model).toBe("gpt-4o");
});

// Positive control: a clean close with a terminal usage event bills exact usage, not the char estimate.
test("OpenAI Responses scanner bills exact usage on a clean close (terminal event present)", () => {
  const scan = openaiResponsesScanner({ model: "gpt-4o", inputTokens: 10 });
  feed(scan, `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "abcd" })}\n\n`);
  feed(scan, `data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-4o-2024-08-06", usage: { input_tokens: 100, output_tokens: 50 } } })}\n\n`);
  const m = scan.result();
  expect(m!.usage.output_tokens).toBe(50); // exact, not ceil(4/4)=1
  expect(m!.model).toBe("gpt-4o-2024-08-06");
  expect(scan.completed()).toBe(true);
});

test("OpenAI Responses treats response.incomplete as a successful terminal state, but response.failed as an error", () => {
  const incomplete = openaiResponsesScanner({ model: "gpt-5", inputTokens: 10 });
  feed(incomplete, `data: ${JSON.stringify({ type: "response.incomplete", response: { model: "gpt-5", usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`);
  expect(incomplete.completed()).toBe(true);
  expect(incomplete.errored()).toBe(false);

  const failed = openaiResponsesScanner({ model: "gpt-5", inputTokens: 10 });
  feed(failed, `data: ${JSON.stringify({ type: "response.failed", response: { model: "gpt-5", usage: null } })}\n\n`);
  expect(failed.completed()).toBe(false);
  expect(failed.errored()).toBe(true);
});
