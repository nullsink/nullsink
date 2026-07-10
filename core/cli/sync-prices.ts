// Regenerate src/cost/prices.json from models.dev — the pricing source of truth across providers. Run
// manually, then review and commit the diff (output path is script-relative, so the cwd doesn't matter):
//   bun run cli/sync-prices.ts && git diff src/cost/prices.json
// models.dev `cost` is in USD per MILLION tokens, exactly what pricing.ts wants. Each emitted entry
// carries a `provider` tag (carried straight from models.dev, never inferred) so the runtime can reject a
// model sent to the wrong provider's endpoint locally instead of forwarding it for an upstream 404. This
// runs at dev time only; the proxy itself never calls the network for prices.
import { OFF_CARD_MODEL_MARKERS } from "../src/cost";

const SRC = "https://models.dev/api.json";

const res = await fetch(SRC);
if (!res.ok) {
  console.error(`fetch ${SRC} failed: ${res.status}`);
  process.exit(1);
}
const data = (await res.json()) as any;

// models.dev keeps RETIRED Anthropic models in its catalogue (with historical prices), but the live API
// 404s them — so without this filter prices.json carries dead ids that pass our gate, take a hold,
// forward, and get a full refund on the upstream 404 (safe, but a wasted round-trip + a confusing 404
// instead of a clean gate-time 400). This denylist drops ids that 404'd on the live API (probed
// 2026-06-02) so the prune survives re-sync. It fails SAFE: a newly-retired id not yet listed here still
// full-refunds, and removing a still-live id only re-adds it. Re-probe when Anthropic retires more.
// OpenAI has the same kind of denylist (OPENAI_RETIRED below) on top of the modality/cost curation.
const ANTHROPIC_RETIRED = new Set([
  "claude-3-5-haiku-20241022",
  "claude-3-5-haiku-latest",
  "claude-3-5-sonnet-20240620",
  "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-3-haiku-20240307",
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-opus-4-0",
  "claude-opus-4-20250514",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20250514",
]);

// OpenAI counterpart: ids models.dev still lists but that 404 `model_not_found` on the live API for our
// account across /v1/models, /v1/chat/completions, AND /v1/responses (probed 2026-06-06). o1-mini and
// o1-preview are the retired first-gen reasoning preview/mini; o3-pro and gpt-5.3-codex-spark 404 on every
// endpoint including their native one. Same fail-SAFE contract as ANTHROPIC_RETIRED: a dead id not yet
// listed still full-refunds, and a still-live id only re-adds on re-sync. Re-probe when OpenAI retires more.
const OPENAI_RETIRED = new Set([
  "gpt-5.3-codex-spark",
  "o1-mini",
  "o1-preview",
  "o3-pro",
]);

// A model is billable at our flat per-token rates iff it has input+output token pricing (output > 0) AND
// its ONLY output modality is text. This curates the catalogue down to text-chat models, dropping what we
// can't meter at token rates: embeddings (output cost 0), image generation (output: ["image"]), and
// audio/realtime/tts (non-text output, or absent from models.dev entirely). An excluded id is then
// rejected by the gate as unknown — unless it prefix-extends a priced base (gpt-4o-audio-preview →
// `gpt-4o`); those need a marker in OFF_CARD_MODEL_MARKERS.
function billableTextModel(m: any): boolean {
  const c = m?.cost;
  if (!c || c.input == null || c.output == null || !(c.output > 0)) return false;
  const out = m?.modalities?.output;
  return Array.isArray(out) && out.length === 1 && out[0] === "text";
}

// Some text models bundle fee-bearing built-in tools (web search, deep research) whose per-call cost is
// NOT in the per-token rate card — so exclude them by id (OFF_CARD_MODEL_MARKERS, shared with the
// runtime) even though they pass the modality/cost check. NOTE: this table exclusion is necessary but NOT
// sufficient — the runtime gate ALSO rejects these ids (src/cost/pricing.ts isOffCardModel), because its
// prefix matcher would otherwise re-admit an excluded id as its priced base model.

// Providers to sync, each with its retired-id denylist (ids that 404 upstream despite models.dev listing).
// flatCache: the provider bills cached prompt reads at the full INPUT rate (models.dev lists no cache rate).
// Tinfoil is flat AND its vLLM backend CAN report cached prompt tokens (prompt_tokens_details.cached_tokens →
// cache_read_input_tokens via the OpenAI usage extractor), so cache_read must default to `input`, never 0 —
// else a cache hit would bill free and under-charge. (nomic-embed-text is dropped by billableTextModel: output 0.)
const PROVIDERS: Array<{ name: string; retired: Set<string>; flatCache?: boolean }> = [
  { name: "anthropic", retired: ANTHROPIC_RETIRED },
  { name: "openai", retired: OPENAI_RETIRED },
  { name: "tinfoil", retired: new Set(), flatCache: true },
];

const out: Record<string, unknown> = {};
const counts: Record<string, number> = {};
for (const { name, retired, flatCache } of PROVIDERS) {
  const models = data[name]?.models ?? {};
  for (const [id, m] of Object.entries<any>(models)) {
    if (retired.has(id)) continue; // retired upstream — see note above
    if (!billableTextModel(m)) continue;
    if (OFF_CARD_MODEL_MARKERS.some((s) => id.includes(s))) continue; // off-card billing (fee tools / audio) — see note
    // prices.json is id-keyed across ALL providers, so a shared id would silently clobber here. Throw — the
    // tripwire that an id is now served by >1 provider and pricing must move to (provider, id) keys. (This
    // replaces the old cross-source dup-throw in pricing.mergeRawPrices, now that Tinfoil is synced here too.)
    if (id in out) throw new Error(`duplicate priced model id "${id}" across providers (${(out[id] as { provider: string }).provider} vs ${name}) — pricing must key by (provider, id)`);
    const c = m.cost;
    // cache_read: a real discount from models.dev when present. Absent → 0 for discount-providers (they
    // never report cached tokens), but → INPUT for a flatCache provider (Tinfoil): its vLLM can report a
    // cache hit yet bills it at the full input rate, so 0 would under-charge. cache_write is absent for
    // providers with no cache-WRITE token fee (OpenAI before gpt-5.6, Tinfoil) → 0; the hold's
    // max(input, cache_read, cache_write) still resolves to input.
    const cache_write = c.cache_write ?? 0;
    const entry = {
      provider: name,
      input: c.input,
      output: c.output,
      cache_read: c.cache_read ?? (flatCache ? c.input : 0),
      cache_write,
      // cache_write_1h: the 1-hour-TTL cache-write tier, emitted explicitly so the runtime cost engine is
      // purely table-driven (no provider conditionals). models.dev doesn't model the tier, so: Anthropic →
      // 2× base input (https://platform.claude.com/docs/en/build-with-claude/prompt-caching: "1-hour cache
      // write tokens are 2× the base input tokens price"); every other provider → its cache_write rate, so
      // a usage report that classifies write tokens as 1-hour bills the same as the standard tier instead
      // of free (providers without the tier never emit the field; this keeps cost monotonic if one lies).
      // A real models.dev cache_write_1h, if it ever appears, wins over both rules.
      cache_write_1h: c.cache_write_1h ?? (name === "anthropic" ? 2 * c.input : cache_write),
    };
    // Generation-time billing invariants: every rate a sane non-negative number, and the 1-hour write tier
    // at least the standard one — the precondition for "more reported tokens never bills less" (the
    // monotonicity property pricing.ts re-asserts at load and the property tests check in CI).
    for (const [k, v] of Object.entries(entry)) {
      if (k !== "provider" && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) throw new Error(`${id}: rate ${k} is not a finite non-negative number: ${v}`);
    }
    if (entry.cache_write_1h < entry.cache_write) throw new Error(`${id}: cache_write_1h (${entry.cache_write_1h}) < cache_write (${entry.cache_write}) would let a 1h-classified write bill less`);
    out[id] = entry;
    counts[name] = (counts[name] ?? 0) + 1;
  }
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
// Resolve relative to this script (cli/), not the cwd, so the file lands in
// src/cost/prices.json no matter where the command is run from.
const dest = new URL("../src/cost/prices.json", import.meta.url);
await Bun.write(dest, JSON.stringify(sorted, null, 2) + "\n");
const summary = Object.entries(counts).map(([p, n]) => `${n} ${p}`).join(", ");
console.log(`wrote src/cost/prices.json (${Object.keys(sorted).length} models: ${summary})`);
