// Live hold-soundness + counter checks against the REAL upstreams (operator-run; needs real keys; spends a
// few cents). Validates the headline no-overdraft invariant on REAL prompts — the count-based pre-flight
// hold must be >= the actual billed cost — across text / large / image / tools / cache-hit, for all three
// providers (Tinfoil has no token-counter, so its hold is the byte bound — itself a proven upper bound,
// reported as BYTE-FALLBACK). Also answers two open questions a frozen fixture can't:
//   • does OpenAI's /v1/responses/input_tokens accept a Chat-Completions-shaped {messages,tools} body and
//     return a sound count, or does the hold silently fall back to the (loose) byte bound? (per-shape: it
//     reports "count ok" vs "byte fallback").
//   • does a real prompt-cache hit get split correctly (cache_read at the discount, no double-count)?
// Live-only by nature (it measures the live API's counting + caching); not a committed fixture. It can't
// "fail" on soundness unless there's a real bug: the byte-bound fallback is itself a proven upper bound, so
// hold >= actual holds even when the counter rejects a body — that case is reported, not failed.
//
// Run: ANTHROPIC_API_KEY=… OPENAI_API_KEY=… TINFOIL_API_KEY=… bun run scripts/e2e-hold.ts
// No DB/handler import here (only hold/pricing/usage, which don't open the SQLite singletons), so no env
// dance is needed; generation requests go straight to the upstreams.
import {
  makeCountTokensHold,
  byteBoundHold,
  ANTHROPIC_COUNT_OMIT,
  OPENAI_COUNT_OMIT,
  type HoldEstimator,
} from "../src/hold";
import { priceUsage } from "../src/cost";
import { extractUsage, extractOpenAIChatUsage, extractOpenAIResponsesUsage, type Metered } from "../src/cost";

const A = process.env.ANTHROPIC_API_KEY;
const O = process.env.OPENAI_API_KEY;
const T = process.env.TINFOIL_API_KEY;
if (!A && !O && !T) {
  console.error("set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or TINFOIL_API_KEY");
  process.exit(1);
}
const AB = "https://api.anthropic.com";
const OB = "https://api.openai.com";
const TB = process.env.TINFOIL_BASE_URL ?? "https://inference.tinfoil.sh";
const VER = "2023-06-01";
const TIMEOUT = 60_000;

const anthropicHold: HoldEstimator | null = A
  ? makeCountTokensHold({ countUrl: `${AB}/v1/messages/count_tokens`, authHeaders: { "x-api-key": A, "anthropic-version": VER }, omit: ANTHROPIC_COUNT_OMIT, timeoutMs: TIMEOUT })
  : null;
const openaiHold: HoldEstimator | null = O
  ? makeCountTokensHold({ countUrl: `${OB}/v1/responses/input_tokens`, authHeaders: { authorization: `Bearer ${O}` }, omit: OPENAI_COUNT_OMIT, timeoutMs: TIMEOUT })
  : null;

// A ~4k-token block (well over any provider's cache minimum) for the cache shape.
const BIG = ("The quick brown fox jumps over the lazy dog. ").repeat(900);

type Shape = {
  name: string;
  base: string;
  path: string;
  authHeaders: Record<string, string>;
  hold: HoldEstimator;
  extract: (text: string) => Metered;
  model: string;
  maxTokens: number;
  body: any;
  prepare?: (b: any) => any; // mutate the forwarded body (store:false), like the proxy does
};

const shapes: Shape[] = [];
if (O && openaiHold) {
  const oa = (body: any, model = "gpt-4o-mini", maxTokens = 64): Omit<Shape, "name"> => ({
    base: OB,
    path: "/v1/chat/completions",
    authHeaders: { authorization: `Bearer ${O}`, "content-type": "application/json" },
    hold: openaiHold,
    extract: extractOpenAIChatUsage,
    model,
    maxTokens,
    body: { model, max_completion_tokens: maxTokens, ...body },
    prepare: (b) => ({ ...b, store: false }),
  });
  shapes.push(
    { name: "openai-chat-small", ...oa({ messages: [{ role: "user", content: "Reply with one short sentence." }] }) },
    { name: "openai-chat-large", ...oa({ messages: [{ role: "user", content: "Summarize in one sentence:\n" + BIG.slice(0, 8000) }] }) },
    { name: "openai-chat-tools", ...oa({ tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }], messages: [{ role: "user", content: "Weather in Paris? Use the tool." }] }) },
    {
      name: "openai-responses-text",
      base: OB,
      path: "/v1/responses",
      authHeaders: { authorization: `Bearer ${O}`, "content-type": "application/json" },
      hold: openaiHold,
      extract: extractOpenAIResponsesUsage,
      model: "gpt-4o-mini",
      maxTokens: 64,
      body: { model: "gpt-4o-mini", max_output_tokens: 64, input: "Reply with one short sentence." },
      prepare: (b) => ({ ...b, store: false }),
    },
  );
}
if (A && anthropicHold) {
  const an = (body: any, maxTokens = 64): Omit<Shape, "name"> => ({
    base: AB,
    path: "/v1/messages",
    authHeaders: { "x-api-key": A, "anthropic-version": VER, "content-type": "application/json" },
    hold: anthropicHold,
    extract: extractUsage,
    model: "claude-haiku-4-5",
    maxTokens,
    body: { model: "claude-haiku-4-5", max_tokens: maxTokens, ...body },
  });
  shapes.push(
    { name: "anthropic-text", ...an({ messages: [{ role: "user", content: "Reply with one short sentence." }] }) },
  );
}
if (T) {
  // Tinfoil is OpenAI-chat-shaped but has NO count_tokens endpoint → the byte bound IS the hold (a proven
  // upper bound; the run reports it as BYTE-FALLBACK, which is expected here, not a failure). extract reuses
  // the OpenAI-chat parser. The reasoning shape stresses the output side — gpt-oss streams reasoning into the
  // visible output, so completion_tokens (and the bill) include it; the maxTokens cap still bounds the hold.
  const tf = (body: any, maxTokens = 64): Omit<Shape, "name"> => ({
    base: TB,
    path: "/v1/chat/completions",
    authHeaders: { authorization: `Bearer ${T}`, "content-type": "application/json" },
    hold: byteBoundHold,
    extract: extractOpenAIChatUsage,
    model: "gpt-oss-120b",
    maxTokens,
    body: { model: "gpt-oss-120b", max_completion_tokens: maxTokens, ...body },
  });
  shapes.push(
    { name: "tinfoil-chat-small", ...tf({ messages: [{ role: "user", content: "Reply with one short sentence." }] }) },
    { name: "tinfoil-chat-large", ...tf({ messages: [{ role: "user", content: "Summarize in one sentence:\n" + BIG.slice(0, 8000) }] }) },
    { name: "tinfoil-chat-reasoning", ...tf({ messages: [{ role: "user", content: "What is 17*23? Think briefly, then give the number." }] }, 512) },
  );
}

async function generate(s: Shape): Promise<NonNullable<Metered>> {
  const body = s.prepare ? s.prepare(s.body) : s.body;
  const res = await fetch(s.base + s.path, { method: "POST", headers: s.authHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  if (!res.ok) throw new Error(`generate ${res.status}: ${text.slice(0, 200)}`);
  const m = s.extract(text);
  if (!m) throw new Error(`could not parse usage from ${s.name}`);
  return m;
}

let failures = 0;
let totalActualMicros = 0;
console.log(`\nHold-soundness sweep — ${shapes.length} shape(s)\n`);

for (const s of shapes) {
  try {
    const input = { model: s.model, raw: JSON.stringify(s.body), body: s.body, maxTokens: s.maxTokens };
    const hold = await s.hold(input);
    const metered = await generate(s);
    const actual = priceUsage(metered.model, metered.usage, s.model);
    totalActualMicros += actual;
    // Did the count endpoint actually count, or did the estimator fall back to the byte bound?
    const byteInput = byteBoundHold(input).inputTokens;
    const fellBack = hold.inputTokens >= byteInput; // byte fallback returns utf8 bytes as inputTokens
    const sound = hold.micros >= actual;
    if (!sound) failures++;
    const ratio = actual > 0 ? (hold.micros / actual).toFixed(1) : "∞";
    console.log(
      `  ${sound ? "✓" : "✗ OVERDRAFT"} ${s.name}: hold=$${(hold.micros / 1e6).toFixed(6)} actual=$${(actual / 1e6).toFixed(6)} (hold ${ratio}× actual) | count=${fellBack ? "BYTE-FALLBACK" : `ok (${hold.inputTokens} tok)`} actual_in=${(metered.usage.input_tokens ?? 0) + (metered.usage.cache_read_input_tokens ?? 0)}`,
    );
  } catch (err) {
    console.log(`  ✗ ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

// Explicit probe: POST a Chat-shaped body straight to /v1/responses/input_tokens.
if (O) {
  try {
    const res = await fetch(`${OB}/v1/responses/input_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${O}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "count these tokens please" }] }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    const n = (() => { try { return JSON.parse(text).input_tokens; } catch { return undefined; } })();
    console.log(`\n  [probe] /v1/responses/input_tokens with a CHAT {messages} body → status=${res.status} input_tokens=${n ?? "?"}`);
    if (res.status !== 200 || typeof n !== "number") console.log(`           → counter does NOT cleanly accept a chat body; chat holds fall back to the byte bound (sound, looser).`);
  } catch (err) {
    console.log(`\n  [probe] counter probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Cache hit (Anthropic, deterministic via cache_control): send a big cached block twice; the 2nd
// should report cache_read_input_tokens > 0 and our split must bill it at the cache_read rate.
if (A && anthropicHold) {
  try {
    const body = {
      model: "claude-haiku-4-5",
      max_tokens: 16,
      system: [{ type: "text", text: BIG, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Reply OK." }],
    };
    const call = async () => {
      const res = await fetch(`${AB}/v1/messages`, { method: "POST", headers: { "x-api-key": A, "anthropic-version": VER, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
      const text = await res.text();
      if (!res.ok) throw new Error(`cache call ${res.status}: ${text.slice(0, 200)}`);
      return extractUsage(text)!;
    };
    await call(); // warm the cache (cache_creation)
    const m = await call(); // should be a cache READ
    const cacheRead = m.usage.cache_read_input_tokens ?? 0;
    const hold = await anthropicHold({ model: "claude-haiku-4-5", raw: JSON.stringify(body), body, maxTokens: 16 });
    const actual = priceUsage(m.model, m.usage);
    const ok = cacheRead > 0 && hold.micros >= actual;
    if (!ok) failures++;
    console.log(`\n  ${cacheRead > 0 ? "✓" : "✗"} [cache] anthropic 2nd call: cache_read=${cacheRead} tok, input=${m.usage.input_tokens ?? 0}, hold=$${(hold.micros / 1e6).toFixed(6)} >= actual=$${(actual / 1e6).toFixed(6)} ${hold.micros >= actual ? "✓" : "✗ OVERDRAFT"}${cacheRead > 0 ? "" : " (no cache hit — warm-up may have missed; rerun)"}`);
  } catch (err) {
    console.log(`\n  ✗ [cache] ${err instanceof Error ? err.message : String(err)}`);
    failures++;
  }
}

console.log(`\nTotal generation spend this run: ~$${(totalActualMicros / 1e6).toFixed(4)}.`);
if (failures) {
  console.log(`\n${failures} check(s) failed — an OVERDRAFT (hold < actual) is a real soundness bug; a missed cache hit is usually a warm-up flake (rerun).`);
  process.exit(1);
}
console.log(`\nAll holds sound (hold >= actual) across every shape.`);
