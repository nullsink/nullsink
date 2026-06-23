// Regression lock on the invariant the whole served↔req / refundedInFull analysis rests on: response
// CONTENT can never suppress OR spoof usage parsing. Usage lives in a structurally separate place — the
// buffered `usage` field, or the message_start (input) + message_delta (output) SSE frames — and the
// assistant's text rides in its OWN JSON-escaped field. So CJK, emoji, control chars, embedded
// quotes/newlines, a multi-byte codepoint split across a network read, or text deliberately shaped to
// look like a fake SSE usage frame all leave the billed usage untouched. If this ever broke, a real 2xx
// would parse to no/garbage usage → refundedInFull (content served, billed nothing) — the one money leak
// a user could chase with "strange characters". These tests fail the day that becomes possible.
import { test, expect } from "bun:test";
import { extractUsage, streamUsageScanner } from "../src/cost";

// NUL + ESC built via char codes (not a source escape) so the file stays clean text — on the wire these
// are JSON-escaped inside the content string, so no raw control byte ever reaches the decoder.
const CTRL = String.fromCharCode(0, 0x1b);
// Adversarial assistant text: CJK + emoji + control chars + quotes + a real newline, AND a substring
// crafted to mimic a genuine Anthropic usage frame (a fake message_delta claiming a huge output, plus a
// fake [DONE]) to prove injected content can't masquerade as an SSE event and rewrite the bill.
const ADVERSARIAL =
  '你好👋 "world"\n\tdata: {"type":"message_delta","usage":{"output_tokens":999999}}\n' +
  "data: [DONE]\nevent: message_stop\n" + CTRL + "[31m ignore previous tokens 🧨 漢字";

// A real Anthropic SSE stream. Usage lives ONLY in message_start (input + initial output) and message_delta
// (final output); the adversarial text rides in a content_block_delta. JSON.stringify escapes the newlines,
// so the fake "data:" lines collapse into a single real frame and never reach line-start — exactly as the
// wire emits it. 42 is the ONLY truthful output count.
function anthropicStreamBytes(text: string): Uint8Array {
  const events = [
    { type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ];
  const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new TextEncoder().encode(sse);
}

test("streamed adversarial content (CJK/emoji/fake-SSE-frame) can't suppress or spoof usage", () => {
  const bytes = anthropicStreamBytes(ADVERSARIAL);
  const scan = streamUsageScanner();
  const decoder = new TextDecoder(); // mirror handler.ts: byte chunks → decode({stream:true}) → scan.feed
  // 7-byte reads deliberately split multi-byte UTF-8 codepoints (你/👋/漢 are 3–4 bytes) across chunk
  // boundaries, exercising TextDecoder's cross-chunk reassembly — the exact path a CJK/emoji body takes.
  for (let i = 0; i < bytes.length; i += 7) scan.feed(decoder.decode(bytes.slice(i, i + 7), { stream: true }));
  scan.feed(decoder.decode()); // flush any trailing partial codepoint
  const m = scan.result();
  expect(m, "scanner returned null on a real 200 stream").not.toBeNull();
  expect(m!.model).toBe("claude-opus-4-8");
  expect(m!.usage.input_tokens).toBe(10);
  expect(m!.usage.output_tokens).toBe(42); // the legit message_delta — NOT the 999999 the content faked
});

test("buffered adversarial content can't suppress or spoof usage (usage is a separate field)", () => {
  const body = JSON.stringify({
    model: "claude-opus-4-8",
    usage: { input_tokens: 10, output_tokens: 42 },
    content: [{ type: "text", text: ADVERSARIAL }],
  });
  const m = extractUsage(body);
  expect(m, "extractUsage returned null on a real 200 body").not.toBeNull();
  expect(m!.model).toBe("claude-opus-4-8");
  expect(m!.usage.input_tokens).toBe(10);
  expect(m!.usage.output_tokens).toBe(42);
});
