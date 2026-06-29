// The wordmark mark's "alive" pulse, as data. A seed deterministically yields the seven per-square CSS
// animation-delays that phase-offset the breathing so the funnel doesn't blink in unison. mulberry32 is a
// tiny integer PRNG (public domain); integer-only and seeded, so the SAME seed gives the SAME delays on the
// server prerender and on the client — no hydration drift. PulseMark (ui.tsx) consumes pulseDelays().

// The seed the live wordmark breathes on. Change here to reseed the whole site's mark.
export const WORDMARK_SEED = 1;

// The mark has seven squares (see PULSE_GEO in ui.tsx); one delay each.
const SQUARES = 7;
// The shared loop length the delays phase against (matches `ns-pulse … 2.2s` in app.css).
const LOOP_S = 2.2;

// mulberry32: one PRNG step in [0,1). Deterministic + integer-only (no Date/Math.random), so prerender and
// client agree. Seeded per call so each pulseDelays() is independent.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seven CSS animation-delay strings (e.g. "1.81s") for a seed — mulberry32(seed) scaled to the loop.
export function pulseDelays(seed: number): string[] {
  const next = mulberry32(seed);
  return Array.from({ length: SQUARES }, () => (next() * LOOP_S).toFixed(2) + "s");
}
