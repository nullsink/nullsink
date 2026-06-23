// Global, identity-free token bucket. ONE shared bucket for the whole process — no per-IP, per-token,
// or any other key — so it bounds the AGGREGATE request rate without tracking or identifying anyone.
// It is a BURST / resource guard, NOT an anti-abuse gate — under a determined
// flood it throttles everyone equally (fail-safe), which is acceptable for /buy because /buy dispenses
// no free value; the real determined-attacker lever is proof-of-work, held in reserve.
//
// `now` is injected so refill is deterministic under test (no real clock, no sleeps).
export type TokenBucket = { tryConsume: () => boolean };

export function makeTokenBucket(opts: {
  capacity: number; // max burst (and the steady-state ceiling)
  refillPerSec: number; // tokens replenished per second → the sustained rate
  now?: () => number;
}): TokenBucket {
  const now = opts.now ?? Date.now;
  let tokens = opts.capacity;
  let last = now();
  return {
    // Consume one token if available. Refills lazily based on elapsed wall-clock since the last call,
    // capped at `capacity`, so there is no background timer and bursts up to `capacity` are allowed.
    tryConsume(): boolean {
      const t = now();
      const elapsed = (t - last) / 1000;
      if (elapsed > 0) {
        tokens = Math.min(opts.capacity, tokens + elapsed * opts.refillPerSec);
        last = t;
      }
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
