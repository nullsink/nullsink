// Validated environment-variable reader, shared by both composition roots (proxy.ts, payments.ts) and the
// config-at-import modules (rate.ts, rails/*). Leaf module — imports only log.
//
// A numeric env that parses to NaN is the silent killer this guards: every `x < NaN` is false, so a typo'd
// RATE_MIN_USD would make the sane-band check reject EVERY rate quote (silently taking down /buy, the sole
// purchasing path), and a malformed *_TIMEOUT_MS would become AbortSignal.timeout(NaN). Fail fast at startup
// instead, so a malformed value never boots a subtly-broken process.
// (This was the pre-split root's local helper; lifted here so rate.ts/rails read config the same validated
// way instead of bare Number(), which is where the NaN risk actually lived.)
import * as log from "./log";

// Read a numeric env var, validating finite and in range — a malformed value (→ NaN) would otherwise
// silently disable comparisons (every `x < NaN` is false), e.g. collapsing the /buy bounds or the rate
// sane-band. Fail fast at startup.
export function numEnv(name: string, def: number, min: number, max: number): number {
  const v = process.env[name] == null ? def : Number(process.env[name]);
  if (!Number.isFinite(v) || v < min || v > max) {
    log.error("boot", `invalid ${name}=${process.env[name]} (expected a number in [${min}, ${max}])`);
    process.exit(1);
  }
  return v;
}
