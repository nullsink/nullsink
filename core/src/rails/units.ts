// Atomic-unit scales — how many indivisible base units make one whole coin. Each is a MONETARY constant
// with exactly ONE home: the quoting site (endpoints/buy.ts) and the crediting site (settle.ts) must agree on
// the scale, or they silently mis-quote or mis-credit. Pure values, no I/O — safe to import anywhere.
//
// This is the CATALOG a rail draws from. Each pay rail (src/rails/*) settles in one coin and carries that
// coin's scale on its PayRail.scale; settlement uses the rail's scale,
// never a hard-coded constant, so a second coin can't be mis-valued as XMR. Balances/credit are
// micro-dollars (1e6, see pricing.ts); a scale converts a coin's atomic amount → whole coins for USD
// valuation (whole = atomic / scale).
//
// SAFE-INTEGER NOTE: settlement does integer math on atomic amounts, which must stay < 2^53. Headroom =
// MAX_SAFE_INTEGER / scale: XMR ~9e3, BTC ~9e7 coins — far past our band, so `number` is sound here. A
// future ETH rail (wei, 1e18) overflows at ~0.009 ETH and would need BigInt atomic amounts — which is why
// ETH is deferred, not a `number`-scale entry.

export const ATOMIC_PER_XMR = 1_000_000_000_000; // piconero — 1 XMR = 1e12 atomic units
export const SATS_PER_BTC = 100_000_000; // satoshi — 1 BTC = 1e8 atomic units
