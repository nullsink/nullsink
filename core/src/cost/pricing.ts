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

// Same five rate fields in prices.json (USD per Mtok) and, after the scaling below, internally
// (micro-dollars per Mtok). Each prices.json entry also carries a `provider` tag (see RawEntry).
// EXPORTED so the pure cost functions (costOf / holdBoundOf) can price against ANY rate source — not
// just this prices.json-backed table.
export type Rate = { input: number; output: number; cache_read: number; cache_write: number; cache_write_1h: number };

// A prices.json entry as stored on disk: the provider tag + the five USD/Mtok rates. The generator
// (cli/sync-prices.ts) emits the COMPLETE rate card — including cache_write_1h, which models.dev doesn't
// model, derived there per provider (Anthropic 2× input; otherwise = cache_write) — so this cost engine
// is purely table-driven, with zero provider knowledge. Regenerate with `bun run cli/sync-prices.ts`,
// never hand-edit.
export type RawEntry = Rate & { provider: string };

// A resolved model: which provider owns it (for the cross-provider endpoint gate) + its scaled rate.
type PricedModel = { provider: string; rate: Rate };

// Merge id-keyed price sources, THROWING on a duplicate id across them — the tripwire that an id is now
// served by >1 provider (at which point pricing must key by (provider, id), and the handler's `provider/model`
// routing becomes load-bearing for billing too). Each source is internally id-unique (a JSON object), so a
// duplicate can only arise ACROSS sources. Exported + pure so the throw is unit-testable. Fail LOUD rather
// than silently letting one source shadow the other (which would mis-price/mis-route).
export function mergeRawPrices(...sources: Record<string, RawEntry>[]): [string, RawEntry][] {
  const seen = new Set<string>();
  const merged: [string, RawEntry][] = [];
  for (const src of sources) {
    for (const [id, c] of Object.entries(src)) {
      if (seen.has(id)) throw new Error(`duplicate priced model id "${id}" across price sources — pricing must move to (provider, id) keys (see the handler's provider/model routing)`);
      seen.add(id);
      merged.push([id, c]);
    }
  }
  return merged;
}

// Tinfoil is now synced into prices.json alongside Anthropic/OpenAI (cli/sync-prices.ts), so this is a single
// source today. mergeRawPrices stays as the cross-source dup guard for any future second source; the
// cross-PROVIDER dup tripwire now lives in cli/sync-prices.ts (build time, across providers in the one file).
const RAW_PRICES = mergeRawPrices(prices as Record<string, RawEntry>);

// Billing invariants every table rate must satisfy, re-asserted on the post-rounding micro rates costOf
// actually bills with (the generator asserts the same on the USD figures). Throwing at module load means a
// bad prices.json — hand-edited, or a generator regression that slipped review — refuses to BOOT rather
// than under-billing quietly: non-finite/negative rates could bill NaN or mint balance, and a 1-hour write
// tier below the standard one would let a usage report bill LESS by classifying write tokens as 1-hour
// (the monotonicity the property tests pin in CI). Exported + pure so the throw is unit-testable.
export function assertRateInvariants(id: string, rate: Rate): Rate {
  for (const [k, v] of Object.entries(rate)) {
    if (!(Number.isFinite(v) && v >= 0)) throw new Error(`prices.json: ${id}.${k} is not a finite non-negative rate: ${v}`);
  }
  if (rate.cache_write_1h < rate.cache_write) throw new Error(`prices.json: ${id}.cache_write_1h (${rate.cache_write_1h}) < cache_write (${rate.cache_write}) — a 1h-classified write would bill less`);
  return rate;
}

// id → {provider, rate}, sorted longest-id-first so the most specific match wins (see findModel for the
// dated-suffix matching rule).
const RATES: [id: string, m: PricedModel][] = RAW_PRICES
  .map(([id, c]): [string, PricedModel] => [
    id,
    {
      provider: c.provider,
      rate: assertRateInvariants(id, {
        input: Math.round(c.input * 1_000_000),
        output: Math.round(c.output * 1_000_000),
        cache_read: Math.round(c.cache_read * 1_000_000),
        cache_write: Math.round(c.cache_write * 1_000_000),
        cache_write_1h: Math.round(c.cache_write_1h * 1_000_000),
      }),
    },
  ])
  .sort((a, b) => b[0].length - a[0].length);

// Fields we read out of an Anthropic `usage` object. output_tokens is the only one guaranteed present;
// the rest default to 0.
export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  // TOTAL cache-write tokens, all TTL tiers. Anthropic reports the 5-min + 1-hour sum; OpenAI reports its
  // single tier's cache_write_tokens here via the usage adapter (a real fee since gpt-5.6: 1.25× input).
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // Anthropic's 1-hour-TTL slice of cache_creation_input_tokens (the rest is the standard tier). usage.ts
  // normalizes both the buffered and streamed Anthropic shapes — where it arrives nested under
  // usage.cache_creation.ephemeral_1h_input_tokens — to this flat field, which priceUsage bills at the
  // cache_write_1h rate. Only Anthropic has the tier; other providers' adapters never set it, and their
  // cache_write_1h = cache_write keeps a lying report billing-neutral rather than cheaper. Absent → 0 →
  // the whole cache-write total bills at the standard tier.
  cache_creation_1h_input_tokens?: number;
};

// A dated release suffix: -YYYYMMDD / -YYYY-MM-DD (Anthropic / OpenAI style), or the 8-digit numeric form.
// Same shape client/sync-models.ts collapses. Anchored: the WHOLE remainder after the id must be the date.
const DATED_SUFFIX = /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

// Exact match, or a known id extended by a DATED suffix only — `claude-opus-4-1` matches
// `claude-opus-4-1-20250805`, `gpt-4o` matches `gpt-4o-2024-08-06`. Longest id wins. Anything else,
// including a dash-separated NAMED variant, must NOT be absorbed: providers price variants independently
// of their base (gpt-5.6 is $5/$30 while every recent OpenAI "-pro" is ~$30/$180), so absorbing a
// `gpt-5.6-pro` at the base rate would serve it ~6× under cost the day it launches, until the next manual
// price sync. An unabsorbed id is simply unpriced → the gate 400s it before any upstream spend. This also
// covers `claude-opus-4-1` vs `claude-opus-4-12345` (no dash) and keeps off-card variants
// (gpt-4o-audio-preview) out even without their isOffCardModel marker.
function findModel(model: string): PricedModel | undefined {
  return RATES.find(([id]) => model === id || (model.startsWith(id + "-") && DATED_SUFFIX.test(model.slice(id.length + 1))))?.[1];
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

// One entry in the served-model catalog: a price-book id, its provider tag, and the four USD/Mtok rates
// exactly as they sit in prices.json (pre-scaling — these are the human-facing dollar figures the /models
// page shows, not the internal micro-dollar rates).
export type ModelListing = { id: string; provider: string; input: number; output: number; cache_read: number; cache_write: number };

// The whole price book, enumerated — the ONLY place RATES is listed rather than point-queried by id. Powers
// GET /v1/models: the handler filters this to the models an ACTIVE provider owns, giving a catalog whose ids
// are exactly the set that won't 400 unsupported_model. Sorted by id for a stable, deterministic listing.
// (An upstream's own /v1/models can't stand in: none return prices, and each returns its FULL catalog, not
// our curated served subset.)
export function pricedModels(): ModelListing[] {
  return RAW_PRICES.map(([id, c]) => ({ id, provider: c.provider, input: c.input, output: c.output, cache_read: c.cache_read, cache_write: c.cache_write })).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

// Model ids whose REAL billing falls outside the flat per-token rate card: bundled fee-bearing built-in
// tools (web search, deep research — a PER-CALL fee no token rate covers) and non-text token rates
// (audio/realtime — audio tokens bill ~16× the text input rate, and our usage mapping doesn't split them
// out). cli/sync-prices.ts excludes all of these from prices.json, and findModel's dated-suffix-only
// matching means an excluded NAMED variant (o3-deep-research, gpt-4o-audio-preview) can no longer be
// silently re-admitted at its base model's TEXT token rates. This id gate stays as defense in depth on
// top of both. Single source shared with the generator so the two can't drift. (The body-level
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
