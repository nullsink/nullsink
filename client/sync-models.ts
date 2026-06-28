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

// The providers to vendor, with display labels. This is just the data source; the /models page groups them
// into trust tiers itself (see flow/Models.tsx). A provider absent from prices.json yields no group
// (filtered out below), so a key here that the proxy doesn't price yet costs nothing.
const PROVIDERS = [
  { key: "anthropic", label: "Anthropic" },
  { key: "openai", label: "OpenAI" },
  { key: "tinfoil", label: "Tinfoil" },
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

// Display order within a provider: a curated FAMILY rank (flagship → small) is the primary key, then newest
// version first, then a variant tier (pro → base → mini → nano). Curated because a model's tier isn't in its
// id or its price — Anthropic priced legacy Opus *above* the current one, and "claude-fable-5"'s version
// would otherwise top the list. New versions sort themselves; only a brand-new family needs a line here.
// Families not listed (and "fable") fall to the bottom; the /models preview shows the head of this order.
const FAMILY: Record<string, string[]> = {
  anthropic: ["claude-opus", "claude-sonnet", "claude-haiku"],
  openai: ["gpt-5", "o4", "o3", "o1", "gpt-4.1", "gpt-4o", "gpt-4", "gpt-3"],
  tinfoil: ["glm", "kimi", "gpt-oss-120b", "llama", "gemma", "gpt-oss"],
};

// First (longest) matching family prefix wins; an unlisted family sorts last.
function familyRank(id: string, fams: string[]): number {
  let rank = fams.length;
  let len = -1;
  fams.forEach((p, i) => {
    if (id.startsWith(p) && p.length > len) {
      rank = i;
      len = p.length;
    }
  });
  return rank;
}

// Variant tier inside one version: pro → base → codex* → chat → mini → nano.
function variantRank(id: string): number {
  if (id.includes("pro")) return 0;
  if (id.includes("codex")) return id.includes("max") ? 2 : id.includes("mini") ? 4 : 3;
  if (id.includes("chat")) return 5;
  if (id.includes("mini")) return 6;
  if (id.includes("nano")) return 7;
  return 1; // base
}

function ordered(modelIds: string[], fams: string[]): string[] {
  return [...modelIds].sort((a, b) => {
    const byFamily = familyRank(a, fams) - familyRank(b, fams);
    if (byFamily !== 0) return byFamily;
    const na = a.match(/\d+/g)?.map(Number) ?? [];
    const nb = b.match(/\d+/g)?.map(Number) ?? [];
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const x = na[i] ?? -1;
      const y = nb[i] ?? -1;
      if (x !== y) return y - x; // newer version first
    }
    return variantRank(a) - variantRank(b);
  });
}

const providers = PROVIDERS.map(({ key, label }) => ({
  id: key,
  label,
  models: ordered(
    ids.filter((id) => prices[id].provider === key && !isDatedAlias(id)),
    FAMILY[key] ?? [],
  ),
})).filter((p) => p.models.length > 0);

const total = providers.reduce((n, p) => n + p.models.length, 0);
writeFileSync(OUT, JSON.stringify({ providers }, null, 2) + "\n");
console.log(`sync:models — wrote ${total} models across ${providers.length} providers to ${OUT}`);
