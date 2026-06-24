// Per-model upstream pricing. The proxy bills exactly what Anthropic charges us; margin is applied
// separately at issuance time, never here.
//
// Rates come from prices.json, generated from models.dev (USD per million tokens). Refresh with `bun run
// cli/sync-prices.ts` and commit the diff — do NOT hand-edit (a hand-maintained table silently drifts).
// The proxy reads the committed file at startup, never at runtime, so billing is deterministic.
//
// Internally everything is MICRO-DOLLARS (millionths of $1): a balance of 1_000_000 means $1.00. Rates
// are stored as micro-dollars per MILLION tokens (USD/Mtok × 1e6), so a request's cost is integer-exact:
//   cost_micros = tokens * rate / 1_000_000   (no floats; truncation favours the user).
import prices from "./prices.json";

// Same four rate fields in prices.json (USD per Mtok) and, after the scaling below, internally
// (micro-dollars per Mtok), PLUS the synthesized `cache_write_1h` tier (see below — not on disk).
// Each prices.json entry also carries a `provider` tag (see RawEntry). EXPORTED so the pure cost functions
// (costOf / holdBoundOf) can price against ANY rate source — not just this prices.json-backed table.
export type Rate = { input: number; output: number; cache_read: number; cache_write: number; cache_write_1h: number };

// A prices.json entry as stored on disk: the provider tag + the four USD/Mtok rates. NOTE: prices.json does
// NOT carry cache_write_1h — that tier is synthesized in the RATES build below, so the on-disk file stays a
// pure models.dev mirror (regenerate with `bun run cli/sync-prices.ts`, never hand-edit).
type RawEntry = Omit<Rate, "cache_write_1h"> & { provider: string };

// A resolved model: which provider owns it (for the cross-provider endpoint gate) + its scaled rate.
type PricedModel = { provider: string; rate: Rate };

// Anthropic bills 1-hour cache-TTL writes at 2× base input, vs 1.25× for the default 5-minute tier (the
// latter is `cache_write`, already in prices.json). models.dev models only that single 5-minute tier, so we
// synthesize the 1-hour rate from the input rate × this multiplier at table-build time — keeping prices.json
// a pure models.dev mirror (no hand-edited JSON) while the pricing math (priceUsage, priceHoldBound) stays
// purely table-driven. Anthropic-only; OpenAI has no cache-write fee and never emits 1h cache tokens.
// Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
//   "1-hour cache write tokens are 2× the base input tokens price".
const ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER = 2;

// id → {provider, rate}, sorted longest-id-first so the most specific match wins. Matching is
// exact-or-prefix, which absorbs dated suffixes (claude-opus-4-8 also matches claude-opus-4-8-20260101,
// gpt-4o also matches gpt-4o-2024-08-06) codeless.
const RATES: [id: string, m: PricedModel][] = Object.entries(prices as Record<string, RawEntry>)
  .map(([id, c]): [string, PricedModel] => {
    const input = Math.round(c.input * 1_000_000);
    return [
      id,
      {
        provider: c.provider,
        rate: {
          input,
          output: Math.round(c.output * 1_000_000),
          cache_read: Math.round(c.cache_read * 1_000_000),
          cache_write: Math.round(c.cache_write * 1_000_000),
          // cache_write_1h: 2× input on Anthropic, 0 elsewhere (see ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER).
          // Derived from the same `input` micro-rate so it can't drift from the table.
          cache_write_1h: c.provider === "anthropic" ? input * ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER : 0,
        },
      },
    ];
  })
  .sort((a, b) => b[0].length - a[0].length);

// Fields we read out of an Anthropic `usage` object. output_tokens is the only one guaranteed present;
// the rest default to 0.
export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number; // TOTAL cache-write tokens (5-min + 1-hour) — Anthropic reports the sum
  cache_read_input_tokens?: number;
  // Anthropic's 1-hour-TTL slice of cache_creation_input_tokens (the rest is the 5-min tier). usage.ts
  // normalizes both the buffered and streamed Anthropic shapes — where it arrives nested under
  // usage.cache_creation.ephemeral_1h_input_tokens — to this flat field, which priceUsage bills at the 2×
  // rate. OpenAI never sets it (no cache-write fee). Absent → 0 → the whole cache-write total bills at 5-min.
  cache_creation_1h_input_tokens?: number;
};

// Exact match, or a dated suffix of a known id. The trailing "-" is required so `claude-opus-4-1` matches
// `claude-opus-4-1-20250805` but NOT a hypothetical pricier `claude-opus-4-12345`. Longest id wins.
function findModel(model: string): PricedModel | undefined {
  return RATES.find(([id]) => model === id || model.startsWith(id + "-"))?.[1];
}

function findRate(model: string): Rate | undefined {
  return findModel(model)?.rate;
}

// Whether we have a price for this model — the priced-or-not predicate. The live request gate is
// provider.ownsModel (built on providerOf, below), which rejects unknown/unpriced models BEFORE forwarding
// so we never spend upstream on something we can't bill.
export function isPriced(model: string): boolean {
  return findModel(model) !== undefined;
}

// Which provider owns this model id, or undefined if unpriced. The handler gates a request to the
// endpoint whose provider owns the model — so a gpt-* model on /v1/messages (or a claude-* on the OpenAI
// endpoint) is rejected locally with unsupported_model instead of being forwarded for an upstream 404.
export function providerOf(model: string): string | undefined {
  return findModel(model)?.provider;
}

// Model ids whose REAL billing falls outside the flat per-token rate card: bundled fee-bearing built-in
// tools (web search, deep research — a PER-CALL fee no token rate covers) and non-text token rates
// (audio/realtime — audio tokens bill ~16× the text input rate, and our usage mapping doesn't split them
// out). cli/sync-prices.ts excludes all of these from prices.json — but that alone is NOT enough:
// findModel() above matches by exact-OR-PREFIX, so an excluded id that is a suffix of a priced base
// (o3-deep-research → matches priced `o3`; gpt-4o-audio-preview → `gpt-4o`) gets silently re-admitted at
// the BASE model's TEXT token rates, under-billing the fee/audio premium. So the runtime gate MUST also
// reject these by id. Single source shared with the generator so the two can't drift. (The body-level
// audio gate in providers/openai.ts OPENAI_CHAT_REJECTS backstops this list: even a future audio-capable id
// missing a marker can't be asked for audio output without `modalities`/`audio` in the body.)
export const OFF_CARD_MODEL_MARKERS = ["deep-research", "search", "audio", "realtime"];
export function isOffCardModel(model: string): boolean {
  return OFF_CARD_MODEL_MARKERS.some((m) => model.includes(m));
}

// OpenAI REASONING model families (o-series, gpt-5). Their billed "thinking" tokens count as OUTPUT but
// NEVER appear in the streamed text, so the streaming-disconnect char-estimate (usage.ts) is blind to them
// and would massively under-bill. For these, the disconnect path bills the output CAP instead (a sound
// upper bound — reasoning can fill it). Anthropic extended-thinking is NOT here: its scanner reads the
// cumulative output_tokens (thinking included) off each delta, so its disconnect bill is already
// reasoning-aware. Prefix-matched and curated — maintain as OpenAI ships new reasoning families.
export const REASONING_MARKERS = ["o1", "o3", "o4", "gpt-5"];
export function isReasoningModel(model: string): boolean {
  // The -chat variants (gpt-5-chat-latest, gpt-5.x-chat-latest) are the NON-reasoning, chat-tuned members
  // of an otherwise reasoning family: all their output is visible streamed text, so the disconnect char
  // estimate is accurate for them and billing the cap would overcharge an honest early abort.
  return REASONING_MARKERS.some((m) => model.startsWith(m)) && !model.includes("-chat");
}

// --- Pure cost math: a Rate in, micro-dollars out. No model id, no findRate, no prices.json — so the cost
// engine is reusable against any rate source. The model-string wrappers below (priceUsage / priceHoldBound)
// are the ONLY things that touch the table; they resolve a Rate and delegate here. ---

// Coerce an upstream-reported usage count to a sane, finite, non-negative number — the SINGLE sanitizer for
// every count that reaches the cost math. A buffered Anthropic body passes usage through verbatim and the
// streaming scanners only `?? 0`, so a parseable-but-mistyped field (a string, a negative, a non-finite) from
// a buggy/hostile upstream would otherwise bill NaN (corrupting the ledger) or a negative (minting balance).
// Exported and reused by the OpenAI usage adapter (usage/openai.ts) so both providers sanitize IDENTICALLY;
// valid counts are unchanged.
export const sanitizeCount = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);

// Cost of one request's realized usage at `rate`, in micro-dollars (truncated; truncation favours the user).
export function costOf(rate: Rate, usage: Usage): number {
  const input = sanitizeCount(usage.input_tokens);
  const output = sanitizeCount(usage.output_tokens);
  const cacheWrite = sanitizeCount(usage.cache_creation_input_tokens); // total: 5-min + 1-hour
  const cacheRead = sanitizeCount(usage.cache_read_input_tokens);
  // Split the cache-write total into its 1-hour (2× input) and 5-min (1.25× input) tiers. CLAMP the 1-hour
  // slice to [0, total]: a malformed/hostile report with 1h > total (or negative) must never drive the
  // 5-min remainder negative — since the 1h rate is dearer, that would UNDER-bill. Absent breakdown (every
  // OpenAI response, and any Anthropic response with no 1h writes) → write1h 0 → the whole total at 5-min.
  const write1h = Math.min(sanitizeCount(usage.cache_creation_1h_input_tokens), cacheWrite);
  const write5m = cacheWrite - write1h;
  return Math.floor(
    (input * rate.input +
      output * rate.output +
      write5m * rate.cache_write +
      write1h * rate.cache_write_1h +
      cacheRead * rate.cache_read) /
      1_000_000,
  );
}

// Cost of one request in micro-dollars. `model` is normally the response's model; `fallback` is the
// gate-validated request model, used when Anthropic resolves an alias to a response id we don't price (so
// a request can never end up free). Throws only if neither is priced, which the gate makes impossible.
export function priceUsage(model: string, usage: Usage, fallback?: string): number {
  const rate = findRate(model) ?? (fallback ? findRate(fallback) : undefined);
  if (!rate) throw new Error(`no price for model: ${model}`);
  return costOf(rate, usage);
}

// Sound UPPER-BOUND cost (micro-dollars) for sizing a pre-flight hold, at `rate`. Treats the whole prompt as
// `inputTokens` billed at the MOST EXPENSIVE applicable per-token input rate (max of input / cache_read /
// cache_write, plus the 1-hour cache-write tier when opts.oneHourCache is set), so however those tokens are
// classified at generation time they cost no more. (Deriving the max from the rate, not assuming
// cache_write = 1.25×input, keeps this sound for any future/multi-provider rate that breaks that ratio.)
// Output is exact: every output token (thinking included) counts toward max_tokens. Truncation matches costOf
// and the numerator dominates term-by-term, so the result ≥ any actual cost for this rate WHENEVER
// inputTokens ≥ the actual input tokens billed — guaranteed for the byte bound (utf8_bytes ≥ tokens), a bet
// for the count_tokens estimator. The handler refund clamp backstops the rest.
//
// opts.oneHourCache gates the 1-hour cache-write tier: a response can bill 1h tokens only if the request
// asked for them (detected from the body in providers/anthropic.ts), so a non-1h request gets the tighter
// standard ceiling and isn't over-reserved; a 1h request reserves at 2× so the refund clamp can't eat the
// 2×→1.25× gap.
export function holdBoundOf(
  rate: Rate,
  inputTokens: number,
  maxTokens: number,
  opts: { oneHourCache?: boolean } = {},
): number {
  const maxInputRate = Math.max(rate.input, rate.cache_read, rate.cache_write, ...(opts.oneHourCache ? [rate.cache_write_1h] : []));
  return Math.floor((inputTokens * maxInputRate + maxTokens * rate.output) / 1_000_000);
}

// Model-string wrapper over holdBoundOf. The hold is always sized from the gate-validated REQUEST model (the
// response model isn't known yet), so — unlike priceUsage — there's no response→request fallback to resolve.
export function priceHoldBound(
  model: string,
  inputTokens: number,
  maxTokens: number,
  opts: { oneHourCache?: boolean } = {},
): number {
  const rate = findRate(model);
  if (!rate) throw new Error(`no price for model: ${model}`);
  return holdBoundOf(rate, inputTokens, maxTokens, { oneHourCache: opts.oneHourCache });
}
