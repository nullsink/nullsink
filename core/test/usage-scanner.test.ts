// Direct unit tests for two streaming-scanner billing paths flagged as surviving mutants (the broad streaming
// tests drive the scanners through the handler with multi-frame streams, so these single-frame edges slip
// through).
import { test, expect } from "bun:test";
import { streamUsageScanner } from "../src/cost/usage/anthropic";
import { openaiChatScanner, openaiResponsesScanner } from "../src/cost/usage/openai";
import { MAX_SSE_LINE } from "../src/cost/usage/types";

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
});

// types.ts MAX_SSE_LINE — a newline-less upstream run must not grow the scanner buffer unbounded. The
// oversized partial is dropped (so its eventual completion no longer parses) and the scanner resyncs at the
// next newline. A capped scanner yields null for the over-long frame; an UNCAPPED one would assemble + bill
// it — so `result() === null` here is what proves the cap fires.
test("Anthropic scanner drops a newline-less over-long frame, then recovers", () => {
  const scan = streamUsageScanner();
  // start of a valid message_start, padded past the cap, NO newline yet → the partial is dropped
  feed(scan, `data: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"_pad":"${"x".repeat(MAX_SSE_LINE + 16)}`);
  feed(scan, `"}}}\n\n`); // completes the now-orphaned line → invalid JSON tail → ignored
  expect(scan.result()).toBeNull(); // over-long frame dropped, not billed (uncapped would bill output 5)
  // ...and the scanner still works for the rest of the stream
  feed(scan, `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 7, output_tokens: 3 } } })}\n\n`);
  expect(scan.result()?.usage.output_tokens).toBe(3);
});

test("OpenAI scanner drops a newline-less over-long frame (no spurious bill)", () => {
  const scan = openaiChatScanner({ model: "gpt-4o", inputTokens: 5 });
  feed(scan, `data: {"model":"gpt-4o","usage":{"prompt_tokens":10,"completion_tokens":5,"_pad":"${"x".repeat(MAX_SSE_LINE + 16)}`);
  feed(scan, `"}}\n\n`);
  expect(scan.result()).toBeNull(); // dropped → nothing parsed → full refund, not the over-long usage
});
