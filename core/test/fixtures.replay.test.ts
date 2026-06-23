// Offline regression over the golden fixtures captured by `bun run scripts/e2e-capture.ts` (real upstream
// bytes, committed under test/fixtures/). Replays each through the SAME parser the handler uses, then
// cross-checks the result against the upstream's OWN reported usage — read here independently of our
// mapping — so a field-name drift (OpenAI renames a usage field) or a mapping bug (cached double-count,
// reasoning dropped) is caught against bytes the providers actually emit, not hand-built ones.
//
// Skips when no fixtures are present (CI without a key), so it never fails for lack of capture; once the
// fixtures are committed it runs everywhere, offline, for free.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import {
  extractUsage,
  streamUsageScanner,
  extractOpenAIChatUsage,
  openaiChatScanner,
  extractOpenAIResponsesUsage,
  openaiResponsesScanner,
  type Metered,
  type UsageScanner,
} from "../src/cost";
import { priceUsage, type Usage } from "../src/cost";

type Meta = { name: string; provider: "anthropic" | "openai"; endpoint: string; model: string; stream: boolean; expectReasoning: boolean };

const DIR = new URL("./fixtures/", import.meta.url);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];

const num = (x: any): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

// Run OUR parser (buffered extractor or streaming scanner), exactly as the handler would.
function ourUsage(meta: Meta, raw: string): Metered {
  if (!meta.stream) {
    if (meta.provider === "anthropic") return extractUsage(raw);
    return meta.endpoint === "/v1/responses" ? extractOpenAIResponsesUsage(raw) : extractOpenAIChatUsage(raw);
  }
  const ctx = { model: meta.model, inputTokens: 0 }; // complete stream → final usage wins, inputTokens unused
  const scan: UsageScanner =
    meta.provider === "anthropic"
      ? streamUsageScanner()
      : meta.endpoint === "/v1/responses"
        ? openaiResponsesScanner(ctx)
        : openaiChatScanner(ctx);
  // Feed in small chunks to also exercise the scanner's cross-chunk line buffering.
  for (let i = 0; i < raw.length; i += 64) scan.feed(raw.slice(i, i + 64));
  return scan.result();
}

// Pull the upstream's RAW usage object out of a fixture, independently of our scanners.
function rawUsage(meta: Meta, raw: string): any {
  if (!meta.stream) return JSON.parse(raw).usage;
  const frames: any[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const p = t.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    try {
      frames.push(JSON.parse(p));
    } catch {}
  }
  if (meta.provider === "anthropic") {
    const start = frames.find((f) => f.type === "message_start")?.message?.usage ?? {};
    let output = num(start.output_tokens);
    for (const f of frames) if (f.type === "message_delta" && typeof f.usage?.output_tokens === "number") output = f.usage.output_tokens;
    return { ...start, output_tokens: output };
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    const u = frames[i].usage ?? frames[i].response?.usage;
    if (u) return u;
  }
  return null;
}

// What our Usage SHOULD be, computed from the raw upstream fields by hand (NOT via src/usage mapping).
// Concrete all-number return so the per-field assertions don't trip over Usage's optional fields.
function expectedUsage(meta: Meta, ru: any): Required<Usage> {
  if (meta.provider === "anthropic") {
    return {
      input_tokens: num(ru.input_tokens),
      output_tokens: num(ru.output_tokens),
      cache_read_input_tokens: num(ru.cache_read_input_tokens),
      cache_creation_input_tokens: num(ru.cache_creation_input_tokens),
      // 1-hour slice lives nested under cache_creation; our parser normalizes it to the flat field.
      cache_creation_1h_input_tokens: num(ru.cache_creation?.ephemeral_1h_input_tokens),
    };
  }
  // OpenAI: the input total is INCLUSIVE of cached → split; no cache-write fee (and no 1-hour tier).
  const total = meta.endpoint === "/v1/responses" ? num(ru.input_tokens) : num(ru.prompt_tokens);
  const cached = meta.endpoint === "/v1/responses" ? num(ru.input_tokens_details?.cached_tokens) : num(ru.prompt_tokens_details?.cached_tokens);
  const output = meta.endpoint === "/v1/responses" ? num(ru.output_tokens) : num(ru.completion_tokens);
  return { input_tokens: Math.max(0, total - cached), cache_read_input_tokens: cached, cache_creation_input_tokens: 0, cache_creation_1h_input_tokens: 0, output_tokens: output };
}

function reasoningOf(meta: Meta, ru: any): number {
  return num(ru?.completion_tokens_details?.reasoning_tokens) || num(ru?.output_tokens_details?.reasoning_tokens);
}

if (files.length === 0) {
  test.skip("golden fixtures — none captured yet (run `ANTHROPIC_API_KEY=… OPENAI_API_KEY=… bun run scripts/e2e-capture.ts`)", () => {});
} else {
  for (const f of files) {
    const { meta, raw } = JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as { meta: Meta; raw: string };
    test(`golden fixture: ${meta.name} — parser matches the upstream's own usage`, () => {
      const metered = ourUsage(meta, raw);
      expect(metered, "parser returned null on a real 200 response").not.toBeNull();
      const u = metered!.usage;

      // Sound shape: a real completion has output + some input, and is billable at our rates.
      expect(metered!.model.length).toBeGreaterThan(0);
      expect(num(u.output_tokens)).toBeGreaterThan(0);
      expect(num(u.input_tokens) + num(u.cache_read_input_tokens)).toBeGreaterThan(0);
      expect(priceUsage(metered!.model, u)).toBeGreaterThan(0);

      // Strong cross-check: our mapped usage must match what the upstream itself reported (independently
      // mapped here) — catches a renamed field, a cached double-count, or a stream scanner that misses the
      // terminal usage chunk. Compare the BILLING-RELEVANT counts + the resulting charge, NOT the whole
      // object: the Anthropic buffered extractor passes usage through verbatim, so it can carry extra
      // informational fields (e.g. service_tier, inference_geo) that priceUsage ignores.
      const ru = rawUsage(meta, raw);
      expect(ru, "could not locate the upstream usage in the fixture").not.toBeNull();
      const exp = expectedUsage(meta, ru);
      expect(num(u.input_tokens), "input mismatch vs upstream").toBe(exp.input_tokens);
      expect(num(u.output_tokens), "output mismatch vs upstream").toBe(exp.output_tokens);
      expect(num(u.cache_read_input_tokens), "cache_read mismatch vs upstream").toBe(exp.cache_read_input_tokens);
      expect(num(u.cache_creation_input_tokens), "cache_creation mismatch vs upstream").toBe(exp.cache_creation_input_tokens);
      expect(num(u.cache_creation_1h_input_tokens), "cache_creation_1h mismatch vs upstream").toBe(exp.cache_creation_1h_input_tokens);
      expect(priceUsage(metered!.model, u), "charge mismatch vs upstream").toBe(priceUsage(metered!.model, exp));

      // Reasoning fixtures: output must INCLUDE the reasoning tokens (not dropped, not added on top).
      if (meta.expectReasoning) {
        const r = reasoningOf(meta, ru);
        expect(r, "fixture marked reasoning but the upstream reported none").toBeGreaterThan(0);
        expect(num(u.output_tokens)).toBeGreaterThanOrEqual(r);
      }
    });
  }
}
