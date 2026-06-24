// PROTOTYPE — a new test TYPE: contract / schema-drift guard for the recorded golden fixtures.
//
// fixtures.replay.test.ts checks the parsed VALUES match the upstream's own numbers. This guards the SHAPE
// the parsers depend on, and fails EARLY with a precise message if a fixture is hand-edited, a regenerate
// drops a field, or a model is pruned from the price card while a fixture still references it (which would
// otherwise surface downstream as a confusing "no price for model" throw inside replay). Cheap structural
// validation, no upstream key needed.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { isPriced, extractUsage, extractOpenAIChatUsage, extractOpenAIResponsesUsage } from "../src/cost";

const DIR = new URL("./fixtures/", import.meta.url);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

// The frames a streamed fixture must still contain for the scanner to find a terminal usage, per provider/endpoint.
function streamHasTerminalUsage(provider: string, endpoint: string, raw: string): boolean {
  const frames: any[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const p = t.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    try { frames.push(JSON.parse(p)); } catch {}
  }
  if (provider === "anthropic") return frames.some((f) => f.type === "message_start" && isObj(f.message?.usage));
  if (endpoint === "/v1/responses") return frames.some((f) => isObj(f.response?.usage));
  return frames.some((f) => isObj(f.usage)); // openai chat: the include_usage final chunk
}

if (files.length === 0) {
  test.skip("fixture schema — none captured yet (run scripts/e2e-capture.ts)", () => {});
} else {
  for (const f of files) {
    test(`fixture schema: ${f} still matches the contract the parsers depend on`, () => {
      const parsed = JSON.parse(readFileSync(new URL(f, DIR), "utf8"));
      // Envelope
      expect(isObj(parsed) && isObj(parsed.meta) && typeof parsed.raw === "string", "expected { meta, raw:string }").toBe(true);
      const { meta, raw } = parsed as { meta: any; raw: string };
      expect(raw.length, "raw bytes must be non-empty").toBeGreaterThan(0);

      // Meta shape
      expect(["anthropic", "openai"], "meta.provider").toContain(meta.provider);
      expect(typeof meta.endpoint).toBe("string");
      expect(typeof meta.model).toBe("string");
      expect(typeof meta.stream).toBe("boolean");
      expect(typeof meta.expectReasoning).toBe("boolean");

      // The fixture's model must still be on the price card — else the live gate would reject it and replay
      // would throw deep in priceUsage. Catch the drift here with a clear message.
      expect(isPriced(meta.model), `fixture model "${meta.model}" is no longer priced — re-capture or prune this fixture`).toBe(true);

      // Payload shape the parser reads, per buffered/stream.
      if (!meta.stream) {
        const obj = JSON.parse(raw);
        expect(isObj(obj) && typeof obj.model === "string" && isObj(obj.usage), "buffered body needs top-level model:string + usage:object").toBe(true);
      } else {
        expect(raw.includes("data:"), "stream fixture must contain SSE data: frames").toBe(true);
        expect(streamHasTerminalUsage(meta.provider, meta.endpoint, raw), "stream fixture is missing the terminal usage-bearing frame the scanner reads").toBe(true);
      }

      // End-to-end shape sanity: our own parser still extracts a usable {model, usage} from the buffered shape.
      if (!meta.stream) {
        const m = meta.provider === "anthropic" ? extractUsage(raw) : meta.endpoint === "/v1/responses" ? extractOpenAIResponsesUsage(raw) : extractOpenAIChatUsage(raw);
        expect(m, "parser returned null on a recorded 200 body — shape drift").not.toBeNull();
      }
    });
  }
}
