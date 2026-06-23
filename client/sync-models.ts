// Regenerate src/models.json — the vendored snapshot the /models page renders. Run manually, then
// review and commit the diff (paths are script-relative, so cwd doesn't matter):
//   bun run sync:models && git diff src/models.json
//
// The list is the EXACT set of models the proxy prices and will route to: it's derived from
// core/src/cost/prices.json (core's own snapshot of models.dev, refreshed by core/cli/sync-prices.ts). We
// read that committed file rather than hitting models.dev again, so the page can't list a model the
// proxy would reject. This couples the two packages at sync time ONLY — the client BUILD reads this
// committed snapshot, never core (same decoupling as the BUY_MIN constant we keep in sync by hand).
//
// We collapse dated aliases: prices.json carries both the canonical id and its dated twin
// (claude-haiku-4-5 + claude-haiku-4-5-20251001, gpt-4o + gpt-4o-2024-08-06). The page wants the
// canonical id, so a dated id is dropped WHEN its undated base is also priced. A "-latest" pointer with
// no undated base (gpt-5-chat-latest) has no base to fold into, so it stays.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const PRICES = join(HERE, "../core/src/cost/prices.json");
const OUT = join(HERE, "src/models.json");

// Display order + label per provider. Anthropic first: the proxy is Anthropic-compatible at its core.
// A provider absent from prices.json simply yields no group (filtered out below).
const PROVIDERS = [
  { key: "anthropic", label: "Anthropic" },
  { key: "openai", label: "OpenAI" },
];

const prices = JSON.parse(readFileSync(PRICES, "utf8")) as Record<string, { provider: string }>;
const ids = Object.keys(prices);
const priced = new Set(ids);

// A dated suffix: -YYYYMMDD (Anthropic) or -YYYY-MM-DD (OpenAI). Drop the alias only if the undated
// base is itself priced, so a model that exists ONLY in dated/latest form is never lost.
const DATED = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
function isDatedAlias(id: string): boolean {
  const m = DATED.exec(id);
  return m != null && priced.has(id.slice(0, m.index));
}

const providers = PROVIDERS.map(({ key, label }) => ({
  id: key,
  label,
  models: ids.filter((id) => prices[id].provider === key && !isDatedAlias(id)).sort(),
})).filter((p) => p.models.length > 0);

const total = providers.reduce((n, p) => n + p.models.length, 0);
writeFileSync(OUT, JSON.stringify({ providers }, null, 2) + "\n");
console.log(`sync:models — wrote ${total} models across ${providers.length} providers to ${OUT}`);
