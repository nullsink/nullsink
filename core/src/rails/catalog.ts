// Pure per-rail display metadata: rail name → its coin's display ticker + atomic scale. No I/O and no wallet
// imports, so shared code can use it without dragging in the wallet-RPC-laden rail modules
// (src/rails/{monero,bitcoin}.ts) and their RPC config.
//
// The ticker string lives HERE as its single home: the live rails consume `unit` from this map (so a coin's
// ticker is declared exactly once), and `scale` mirrors the monetary constant whose single home is units.ts.
// The key set is also the canonical list of supported rail names.
import { ATOMIC_PER_XMR, SATS_PER_BTC } from "./units";

export type RailMeta = { unit: string; scale: number };

export const RAIL_META: Record<string, RailMeta> = {
  monero: { unit: "XMR", scale: ATOMIC_PER_XMR },
  bitcoin: { unit: "BTC", scale: SATS_PER_BTC },
};

// Known rail names. Order follows insertion above.
export const RAIL_NAMES = Object.keys(RAIL_META);
