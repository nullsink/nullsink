// PROTOTYPE — a new test TYPE: adversarial fuzzing of the untrusted-byte parsers.
//
// The proxy parses bytes it did NOT author: upstream provider bodies/SSE streams and client request bodies.
// usage-content-robustness.test.ts pins a few hand-built hostile cases; this generates them in bulk with
// fast-check. Two contracts hold for EVERY input, however malformed/truncated/mistyped:
//   (1) the parser NEVER throws (it must degrade to null / a rejection, never crash the request); and
//   (2) any usage it DOES return must price to a FINITE, NON-NEGATIVE bill — a hostile upstream must never be
//       able to mint balance (negative bill) or corrupt the ledger (NaN bill).
import { test, expect } from "bun:test";
import fc from "fast-check";
import { extractUsage, streamUsageScanner } from "../src/cost/usage/anthropic";
import { extractOpenAIChatUsage, extractOpenAIResponsesUsage, openaiChatScanner, openaiResponsesScanner } from "../src/cost/usage/openai";
import { priceUsage, isPriced } from "../src/cost";
import { readJsonBody } from "../src/http/body";
import type { Metered } from "../src/cost/usage/types";

const PRICED = ["claude-opus-4-8", "claude-haiku-4-5", "gpt-4o", "gpt-4o-mini"];

// A "hostile token-count-ish" value: the things a buggy/malicious upstream could put where a count belongs.
// (NaN/Infinity can't survive JSON, so the reachable hostiles via the text path are negatives, strings,
// huge ints, nulls, nested objects, and missing fields.)
const hostileNum = fc.oneof(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.integer({ min: -10, max: 10 }).map((n) => n * 1e15), // huge / huge-negative
  fc.constantFrom("12", "lots", "", "-5"),
  fc.constant(null),
  fc.constant(undefined),
  fc.record({ nested: fc.integer() }), // wrong type entirely
);

// A usage-shaped bag with arbitrarily hostile fields (any subset present).
const hostileUsage = fc.record(
  {
    input_tokens: hostileNum,
    output_tokens: hostileNum,
    cache_read_input_tokens: hostileNum,
    cache_creation_input_tokens: hostileNum,
    cache_creation: fc.option(fc.record({ ephemeral_1h_input_tokens: hostileNum, ephemeral_5m_input_tokens: hostileNum }, { requiredKeys: [] }), { nil: undefined }),
    prompt_tokens: hostileNum,
    completion_tokens: hostileNum,
    prompt_tokens_details: fc.option(fc.record({ cached_tokens: hostileNum }, { requiredKeys: [] }), { nil: undefined }),
  },
  { requiredKeys: [] },
);

// JSON text the buffered extractors will receive: sometimes a well-formed {model, usage} bag with hostile
// counts, sometimes arbitrary/garbage/truncated text.
const bodyText = fc.oneof(
  fc.record({ model: fc.option(fc.constantFrom(...PRICED, "unpriced-xyz"), { nil: undefined }), usage: fc.option(hostileUsage, { nil: undefined }) }).map((o) => JSON.stringify(o)),
  fc.string(), // raw garbage
  fc.json().map((j) => (typeof j === "string" ? j : JSON.stringify(j)).slice(0, 200)), // arbitrary, possibly truncated
);

const billIsSane = (m: Metered) => {
  if (!m || !isPriced(m.model)) return; // priceUsage throws on unpriced — the live gate blocks those first
  const c = priceUsage(m.model, m.usage);
  expect(Number.isFinite(c), `bill must be finite for usage ${JSON.stringify(m.usage)}`).toBe(true);
  expect(c, `bill must be non-negative for usage ${JSON.stringify(m.usage)}`).toBeGreaterThanOrEqual(0);
};

test("buffered usage extractors never throw and never yield a non-finite / negative bill", () => {
  fc.assert(
    fc.property(bodyText, (text) => {
      for (const extract of [extractUsage, extractOpenAIChatUsage, extractOpenAIResponsesUsage]) {
        let m: Metered = null;
        expect(() => { m = extract(text); }).not.toThrow();
        billIsSane(m);
      }
    }),
    { numRuns: 2000 },
  );
});

// Build an SSE byte stream from frames, then re-split it at arbitrary offsets to also fuzz the scanner's
// cross-chunk line buffering (a frame can be torn across feed() calls anywhere).
const sseStream = fc
  .array(
    fc.oneof(
      fc.record({ type: fc.constantFrom("message_start", "message_delta", "error", "ping", "response.completed", "response.output_text.delta") }).chain((base) =>
        fc.record({ frame: fc.constant(base), usage: fc.option(hostileUsage, { nil: undefined }), model: fc.option(fc.constantFrom(...PRICED), { nil: undefined }), delta: fc.option(fc.string(), { nil: undefined }) }),
      ),
      fc.constant({ raw: "[DONE]" as const }),
    ),
    { maxLength: 12 },
  )
  .map((items) =>
    items
      .map((it: any) => {
        if (it.raw) return `data: ${it.raw}`;
        const payload: any = { type: it.frame.type };
        if (it.usage) { payload.usage = it.usage; payload.message = { usage: it.usage, model: it.model }; payload.response = { usage: it.usage, model: it.model }; }
        if (it.delta != null) payload.delta = it.delta;
        return `event: ${it.frame.type}\ndata: ${JSON.stringify(payload)}`;
      })
      .join("\n\n") + "\n\n",
  );

const chunkOffsets = fc.array(fc.nat({ max: 200 }), { maxLength: 20 });

test("streaming usage scanners never throw and never yield a non-finite / negative bill (torn at any offset)", () => {
  const ctx = { model: "gpt-4o", inputTokens: 10, maxTokens: 100 };
  fc.assert(
    fc.property(sseStream, chunkOffsets, (stream, rawOffsets) => {
      const offsets = [...new Set(rawOffsets.filter((o) => o < stream.length))].sort((a, b) => a - b);
      const makeScanners = () => [streamUsageScanner(), openaiChatScanner(ctx), openaiResponsesScanner(ctx)];
      for (const scan of makeScanners()) {
        let pos = 0;
        expect(() => {
          for (const o of offsets) { scan.feed(stream.slice(pos, o)); pos = o; }
          scan.feed(stream.slice(pos));
        }, "scanner.feed threw").not.toThrow();
        let m: Metered = null;
        expect(() => { m = scan.result(); }).not.toThrow();
        billIsSane(m);
        expect(() => scan.errored()).not.toThrow();
      }
    }),
    { numRuns: 1000 },
  );
});

test("readJsonBody resolves to a body-or-rejection for any bytes + any content-length, never throws", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string(), fc.option(fc.string(), { nil: undefined }), fc.integer({ min: 0, max: 1_000_000 }), async (bodyStr, ctHeader, cap) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (ctHeader !== undefined) headers["content-length"] = ctHeader;
      const req = new Request("https://x.local/buy", { method: "POST", headers, body: bodyStr });
      const out = await readJsonBody(req, cap);
      const ok = ("body" in out && typeof out.body === "object" && out.body !== null && !Array.isArray(out.body)) || ("rejection" in out && out.rejection instanceof Response);
      expect(ok).toBe(true);
    }),
    { numRuns: 500 },
  );
});
