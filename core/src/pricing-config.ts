// Shared pricing defaults: one source of truth for the markup the SERVER charges by default AND the value
// the CLIENT advertises (the "~N% markup" copy + the up-front ≈ estimate), so the two can't silently drift.
// They did once: the client said 1.15 while the server default was 1.125.
//
// PURE LEAF: zero imports — the client bundles this straight into the browser, so keep it dependency-free.
//
// The server reads DEFAULT_MARGIN as the default for numEnv("MARGIN", …) and can still override it per-box at
// runtime via the MARGIN env var. Keep a box's MARGIN UNSET so it charges exactly this advertised default;
// the authoritative per-order charge always comes from the server's /buy quote (shown verbatim), so this
// governs only the up-front number, never the final amount.

// Markup applied at credit time: to receive $X of credit the buyer pays $X * DEFAULT_MARGIN.
export const DEFAULT_MARGIN = 1.1;
