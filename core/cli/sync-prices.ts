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
const PROVIDERS: Array<{ name: string; retired: Set<string> }> = [
  { name: "anthropic", retired: ANTHROPIC_RETIRED },
  { name: "openai", retired: OPENAI_RETIRED },
];

const out: Record<string, unknown> = {};
const counts: Record<string, number> = {};
for (const { name, retired } of PROVIDERS) {
  const models = data[name]?.models ?? {};
  for (const [id, m] of Object.entries<any>(models)) {
    if (retired.has(id)) continue; // retired upstream — see note above
    if (!billableTextModel(m)) continue;
    if (OFF_CARD_MODEL_MARKERS.some((s) => id.includes(s))) continue; // off-card billing (fee tools / audio) — see note
    const c = m.cost;
    out[id] = {
      provider: name,
      input: c.input,
      output: c.output,
      // OpenAI has no cache-WRITE premium (cached input is billed at a discount on read, writes are free),
      // so cache_write is absent there → 0. Sound: OpenAI never reports cache-creation tokens, and the
      // hold bound's max(input, cache_read, cache_write) still resolves to `input`.
      cache_read: c.cache_read ?? 0,
      cache_write: c.cache_write ?? 0,
    };
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
