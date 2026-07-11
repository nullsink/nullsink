// XMR/USD price for quoting /buy. Balances are USD micro-dollars, so /buy converts "$X of credit" into an
// XMR amount at order time. Cached briefly; sources pluggable via RATE_URL. This fetch goes over clearnet:
// a public price lookup reveals nothing new beyond that the service is running.
import { numEnv } from "../env";

export class RateError extends Error {}

// Default parser handles Kraken's public ticker shape: { result: { <PAIR>: { c: ["<last>", ...] } } }.
// Object.values avoids hard-coding Kraken's pair key (e.g. "XXMRZUSD"). Swap RATE_URL + this parser
// together if you change sources. Pure — exported for direct testing.
export function parseRate(body: any): number {
  const result = body?.result;
  if (result && typeof result === "object") {
    const pair = Object.values(result)[0] as any;
    const last = Number(pair?.c?.[0]);
    if (Number.isFinite(last) && last > 0) return last;
  }
  throw new RateError("could not parse XMR/USD from the rate source");
}

// CoinGecko simple-price shape: { "monero": { "usd": <number> } }. The default fallback source so a
// Kraken outage doesn't take down the sole purchasing path. A different venue just needs its own parser +
// url in the `fallbacks` list.
export function parseCoinGecko(body: any): number {
  const usd = Number(body?.monero?.usd);
  if (Number.isFinite(usd) && usd > 0) return usd;
  throw new RateError("could not parse XMR/USD from CoinGecko");
}

// CoinGecko simple-price parser for any coin id: { "<id>": { "usd": <number> } }. parseCoinGecko above is
// the monero-specific instance (kept for the rate tests); other rails build their source via this factory.
function coinGeckoParser(id: string): (body: any) => number {
  return (body: any) => {
    const usd = Number(body?.[id]?.usd);
    if (Number.isFinite(usd) && usd > 0) return usd;
    throw new RateError(`could not parse ${id}/USD from CoinGecko`);
  };
}

// One price source: where to fetch and how to read it. `name` is only for error/log messages.
export type RateSource = {
  url: string;
  parse?: (body: any) => number;
  name?: string;
};

export type RateOptions = {
  url: string; // primary source url
  parse?: (body: any) => number; // primary parser (default Kraken)
  fallbacks?: RateSource[]; // tried in order after the primary — AVAILABILITY failover, NOT median
  cacheMs: number;
  timeoutMs: number;
  minUsd: number; // sane-band floor: reject a parse error / manipulated source
  maxUsd: number;
  fetchImpl?: typeof fetch; // injectable so tests don't hit the network
};

// Build an XMR/USD fetcher over one-or-more sources, with a short cache and single-flight. Prod uses the
// singleton below; tests inject a fetch (no network, no cache pollution).
export function makeRate(opts: RateOptions): () => Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Primary first, then any fallbacks. Each source carries its own parser so a different venue/shape
  // drops in without touching the loop below. This is AVAILABILITY failover (take the first source that
  // works), NOT price-integrity: a single in-band source is still manipulable, and a median of ≥2 is the
  // separate fix.
  const sources: RateSource[] = [
    { url: opts.url, parse: opts.parse ?? parseRate, name: "primary" },
    ...(opts.fallbacks ?? []),
  ];

  let cached: { usd: number; at: number } | null = null;
  // Single-flight: collapse concurrent refreshes onto ONE in-flight fetch. Without it every caller
  // arriving between cache-expiry and fetch completion starts its OWN request — a cache stampede that can
  // get the source rate-limited/banned and turns a /buy burst into N upstream calls. Callers await the
  // same promise; a rejection propagates to all and clears the slot so the next call retries (never cached).
  let inflight: Promise<number> | null = null;

  async function fetchOne(src: RateSource): Promise<number> {
    const res = await fetchImpl(src.url, {
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new RateError(`${src.name ?? src.url} HTTP ${res.status}`);
    const usd = (src.parse ?? parseRate)(await res.json());
    // Per-source sane band: reject a parse error / manipulated / implausible value (treated as a failure
    // so failover moves on).
    if (!(usd >= opts.minUsd && usd <= opts.maxUsd)) {
      throw new RateError(`${src.name ?? src.url} XMR/USD ${usd} outside the sane band [${opts.minUsd}, ${opts.maxUsd}]`);
    }
    return usd;
  }

  // First in-band value across the sources, or throw aggregating the failures.
  async function refresh(): Promise<number> {
    const errs: string[] = [];
    for (const src of sources) {
      try {
        return await fetchOne(src);
      } catch (err) {
        errs.push(err instanceof Error ? err.message : String(err));
      }
    }
    throw new RateError(`all rate sources failed: ${errs.join("; ")}`);
  }

  return async function xmrUsd(): Promise<number> {
    if (cached && Date.now() - cached.at < opts.cacheMs) return cached.usd;
    if (inflight) return inflight; // join the in-flight refresh instead of starting another
    inflight = (async () => {
      try {
        const usd = await refresh();
        cached = { usd, at: Date.now() }; // cache only on success; window starts at completion
        return usd;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

// Built-in price sources, keyed by name. Each carries its own parser (which a bare URL can't express),
// so adding a venue is one entry here plus its name in RATE_SOURCES. A source's URL can be overridden via
// env for a custom/self-hosted endpoint; the parser stays in code.
const SOURCE_REGISTRY: Record<string, RateSource> = {
  kraken: {
    url: process.env.RATE_URL ?? "https://api.kraken.com/0/public/Ticker?pair=XMRUSD",
    parse: parseRate,
    name: "kraken",
  },
  coingecko: {
    url: process.env.RATE_URL_COINGECKO ?? "https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd",
    parse: parseCoinGecko,
    name: "coingecko",
  },
};

const RATE_CACHE_MS = numEnv("RATE_CACHE_MS", 60_000, 0, 3_600_000);
const RATE_TIMEOUT_MS = numEnv("RATE_TIMEOUT_MS", 10_000, 100, 600_000);
const RATE_MIN_USD = numEnv("RATE_MIN_USD", 1, 0, 100_000_000);
const RATE_MAX_USD = numEnv("RATE_MAX_USD", 100_000, 0, 100_000_000);

// Ordered, comma-separated source names; tried in order (availability failover). Unknown names are
// skipped; if the list resolves to nothing we fall back to kraken so /buy is never left source-less.
const selectedSources = (process.env.RATE_SOURCES ?? "kraken,coingecko")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((name) => SOURCE_REGISTRY[name])
  .filter((s): s is RateSource => s != null);
const [primarySource, ...fallbackSources] = selectedSources.length ? selectedSources : [SOURCE_REGISTRY.kraken!];

// Current XMR price in USD (short-cached, single-flighted, with failover across RATE_SOURCES). Throws
// RateError only when EVERY source fails, so /buy still fails closed.
export const xmrUsd = makeRate({
  url: primarySource!.url,
  parse: primarySource!.parse,
  fallbacks: fallbackSources,
  cacheMs: RATE_CACHE_MS,
  timeoutMs: RATE_TIMEOUT_MS,
  minUsd: RATE_MIN_USD,
  maxUsd: RATE_MAX_USD,
});

// BTC/USD for the Bitcoin rail — Kraken XBTUSD primary, CoinGecko bitcoin fallback (availability failover,
// same machinery + single-flight + cache as xmrUsd). Its own sane band: BTC trades far above XMR, so the
// XMR floor/ceiling would reject every quote. Override band/sources via env if a venue or regime changes.
const BTC_RATE_MIN_USD = numEnv("BTC_RATE_MIN_USD", 1000, 0, 100_000_000);
const BTC_RATE_MAX_USD = numEnv("BTC_RATE_MAX_USD", 10_000_000, 0, 1_000_000_000);
export const btcUsd = makeRate({
  url: process.env.BTC_RATE_URL ?? "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
  parse: parseRate, // Kraken parser is pair-agnostic (Object.values(result)[0].c[0])
  fallbacks: [
    {
      url: process.env.BTC_RATE_URL_COINGECKO ?? "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      parse: coinGeckoParser("bitcoin"),
      name: "coingecko-btc",
    },
  ],
  cacheMs: RATE_CACHE_MS,
  timeoutMs: RATE_TIMEOUT_MS,
  minUsd: BTC_RATE_MIN_USD,
  maxUsd: BTC_RATE_MAX_USD,
});
