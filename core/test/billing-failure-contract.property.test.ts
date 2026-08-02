// Generated invariants behind billing-failure-contract.test.ts.
// The examples define the policy; these properties vary network chunking and usage magnitudes to make sure
// the scanners cannot accidentally turn transport packet boundaries into money boundaries.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { openaiChatScanner, openaiResponsesScanner, streamUsageScanner } from "../src/cost";

function feedAtOffsets(scanner: ReturnType<typeof openaiChatScanner>, stream: string, rawOffsets: number[]): void {
  const offsets = [...new Set(rawOffsets.filter((offset) => offset > 0 && offset < stream.length))].sort((a, b) => a - b);
  let position = 0;
  for (const offset of offsets) {
    scanner.feed(stream.slice(position, offset));
    position = offset;
  }
  scanner.feed(stream.slice(position));
}

const visibleText = fc.string({ minLength: 1, maxLength: 500 });
const offsets = fc.array(fc.nat({ max: 3000 }), { maxLength: 40 });

test("property · OpenAI upstream-failure billing is invariant under every SSE chunk split and never uses the reasoning maximum", () => {
  fc.assert(fc.property(
    fc.constantFrom("chat" as const, "responses" as const),
    visibleText,
    fc.integer({ min: 1, max: 200_000 }),
    offsets,
    (shape, text, byteBoundInput, rawOffsets) => {
      const maxTokens = 1_000_000;
      const stream = shape === "chat"
        ? `data: ${JSON.stringify({ model: "gpt-5", choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ type: "error", error: { message: "failed" } })}\n\n`
        : `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: ${JSON.stringify({ type: "response.failed", error: { message: "failed" } })}\n\n`;
      const billableInput = Math.ceil(byteBoundInput / 4);
      const make = () => shape === "chat"
        ? openaiChatScanner({ model: "gpt-5", inputTokens: billableInput })
        : openaiResponsesScanner({ model: "gpt-5", inputTokens: billableInput });
      const whole = make();
      whole.feed(stream);
      const split = make();
      feedAtOffsets(split, stream, rawOffsets);

      const expected = {
        input_tokens: billableInput,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: Math.ceil(text.length / 4),
      };
      expect(split.result("evidenced_only")).toEqual(whole.result("evidenced_only"));
      expect(split.result("evidenced_only")?.usage).toEqual(expected);
      expect(split.result("evidenced_only")?.usage.output_tokens).toBeLessThan(maxTokens);
      expect(split.errored()).toBe(true);
    },
  ), { numRuns: 1000 });
});

test("property · exact OpenAI usage dominates estimates even if a later transport/error signal appears", () => {
  fc.assert(fc.property(
    fc.nat({ max: 200_000 }),
    fc.nat({ max: 200_000 }),
    visibleText,
    offsets,
    (inputTokens, outputTokens, text, rawOffsets) => {
      const stream = [
        `data: ${JSON.stringify({ model: "gpt-5", choices: [{ delta: { content: text } }] })}\n\n`,
        `data: ${JSON.stringify({ model: "gpt-5", choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })}\n\n`,
        `data: ${JSON.stringify({ type: "error", error: { message: "late failure" } })}\n\n`,
      ].join("");
      const scanner = openaiChatScanner({ model: "gpt-5", inputTokens: 999_999 });
      feedAtOffsets(scanner, stream, rawOffsets);

      expect(scanner.result("evidenced_only")?.usage).toEqual({
        input_tokens: inputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: outputTokens,
      });
    },
  ), { numRuns: 500 });
});

test("property · Anthropic's last cumulative usage survives arbitrary SSE chunking before an error", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 200_000 }),
    fc.array(fc.nat({ max: 5000 }), { minLength: 1, maxLength: 20 }),
    offsets,
    (inputTokens, increments, rawOffsets) => {
      let total = 0;
      const deltas = increments.map((increment) => {
        total += increment;
        return `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: total } })}\n\n`;
      });
      const stream = [
        `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: inputTokens, output_tokens: 0 } } })}\n\n`,
        ...deltas,
        `data: ${JSON.stringify({ type: "error", error: { type: "overloaded_error" } })}\n\n`,
      ].join("");
      const whole = streamUsageScanner();
      whole.feed(stream);
      const split = streamUsageScanner();
      feedAtOffsets(split as ReturnType<typeof openaiChatScanner>, stream, rawOffsets);

      expect(split.result()).toEqual(whole.result());
      expect(split.result()?.usage).toMatchObject({ input_tokens: inputTokens, output_tokens: total });
      expect(split.errored()).toBe(true);
    },
  ), { numRuns: 1000 });
});

test("property · no OpenAI disconnect estimate can depend on the configured output reservation", () => {
  fc.assert(fc.property(
    fc.constantFrom("chat" as const, "responses" as const),
    fc.string({ maxLength: 500 }),
    fc.integer({ min: 0, max: 200_000 }),
    fc.integer({ min: 1, max: 1_000_000 }),
    (shape, text, inputTokens, outputReservation) => {
      const scanner = shape === "chat"
        ? openaiChatScanner({ model: "gpt-5", inputTokens })
        : openaiResponsesScanner({ model: "gpt-5", inputTokens });
      scanner.feed(shape === "chat"
        ? `data: ${JSON.stringify({ model: "gpt-5", max_tokens: outputReservation, choices: [{ delta: { content: text } }] })}\n\n`
        : `data: ${JSON.stringify({ type: "response.output_text.delta", max_output_tokens: outputReservation, delta: text })}\n\n`);

      expect(scanner.result()?.usage).toMatchObject({
        input_tokens: inputTokens,
        output_tokens: Math.ceil(text.length / 4),
      });
    },
  ), { numRuns: 1000 });
});
