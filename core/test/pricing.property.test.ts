// Property tests for the billing math in src/pricing.ts. These are pure functions over an effectively
// infinite input space (any model string × any usage), so we assert universal invariants against an
// INDEPENDENT reference oracle built from the same prices.json — never by re-deriving the answer the
// way the implementation does (that would only prove the code equals itself).
//
// Covered:
//   - findRate (via isPriced/priceUsage): exact-or-dated-suffix match, LONGEST id wins, and the
//     critical non-match — appended digits without a "-" must NOT match a shorter id
//     (claude-opus-4-1 must never absorb claude-opus-4-12345, a potentially pricier model).
//   - priceUsage: exact cost vs a BigInt oracle, non-negativity, monotonicity, truncation favours the
//     user (floor), and the response→request fallback (a request can never end up unpriced/free).
import { test, expect } from "bun:test";
import fc from "fast-check";
import { costOf, holdBoundOf, isPriced, isReasoningModel, mergeRawPrices, priceHoldBound, priceUsage, type Rate, type Usage } from "../src/cost";
import prices from "../src/cost/prices.json";
import tinfoilPrices from "../src/cost/prices.tinfoil.json";

type UsdRate = { provider: string; input: number; output: number; cache_read: number; cache_write: number };
// Merge both rate sources exactly as pricing.ts does, so the oracle stays a faithful independent check of the
// real table (now incl. the hand-maintained Tinfoil rates). Disjoint ids today; pricing.ts throws if they
// ever collide, so the spread can't silently shadow.
const PRICES = { ...prices, ...tinfoilPrices } as Record<string, UsdRate>;
const IDS = Object.keys(PRICES);

// Independent reimplementation of the matcher: among every registered id that is an exact match or a
// "<id>-…" prefix of `model`, the LONGEST id wins. Mirrors findRate's contract without copying its code.
function oracleRate(model: string): UsdRate | undefined {
  let best: { id: string; rate: UsdRate } | undefined;
  for (const [id, rate] of Object.entries(PRICES)) {
    if ((model === id || model.startsWith(id + "-")) && (!best || id.length > best.id.length)) {
      best = { id, rate };
    }
  }
  return best?.rate;
}

// Scale USD/Mtok → micro-dollars/Mtok exactly as pricing.ts does (Math.round), then sum the cost in
// BigInt and floor by truncating the division. BigInt keeps the oracle independent of the float path
// the implementation takes, so a precision bug there would show up as a divergence.
function oracleCost(rate: UsdRate, u: Usage): number {
  const m = (usd: number) => BigInt(Math.round(usd * 1_000_000));
  // Split the cache-write total into its 1-hour (2× input, Anthropic-only) and 5-min tiers, clamping the 1h
  // slice to the total — mirroring pricing.ts so the oracle stays an INDEPENDENT check, not a copy. The 1h
  // micro-rate is the input micro-rate × 2 (the exact arithmetic the table build uses), so no rounding drift.
  const total = BigInt(u.cache_creation_input_tokens ?? 0);
  const raw1h = BigInt(Math.max(0, u.cache_creation_1h_input_tokens ?? 0));
  const write1h = raw1h < total ? raw1h : total;
  const write5m = total - write1h;
  const cacheWrite1hMicro = rate.provider === "anthropic" ? m(rate.input) * 2n : 0n;
  const sum =
    BigInt(u.input_tokens ?? 0) * m(rate.input) +
    BigInt(u.output_tokens ?? 0) * m(rate.output) +
    write5m * m(rate.cache_write) +
    write1h * cacheWrite1hMicro +
    BigInt(u.cache_read_input_tokens ?? 0) * m(rate.cache_read);
  return Number(sum / 1_000_000n); // non-negative, so truncation == floor
}

const registeredArb = fc.constantFrom(...IDS);
const fieldArb = fc.constantFrom(
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_creation_1h_input_tokens",
  "cache_read_input_tokens",
) as fc.Arbitrary<keyof Usage>;

// Token counts bounded to a realistic range. The cap keeps the worst-case product
// (≈ 4 × 1e6 tokens × 75e6 micro-rate ≈ 3e14) well inside Number's safe-integer range, so the
// float path and the BigInt oracle must agree exactly; huge adversarial counts that lose float
// precision are a separate (documented) concern, not asserted here. Optional fields exercise the ?? 0.
const tokenArb = fc.option(fc.nat({ max: 1_000_000 }), { nil: undefined });
const usageArb: fc.Arbitrary<Usage> = fc.record({
  input_tokens: tokenArb,
  output_tokens: tokenArb,
  cache_creation_input_tokens: tokenArb,
  // Generated INDEPENDENTLY of the total (so 1h > total occurs) to exercise priceUsage's clamp; the oracle
  // clamps identically, so the equality + monotonicity properties still hold on those adversarial draws.
  cache_creation_1h_input_tokens: tokenArb,
  cache_read_input_tokens: tokenArb,
});

// A spread of model strings: exact ids, dated suffixes (-YYYYMMDD-ish), digits appended WITHOUT a dash
// (the safety boundary), the specific claude-opus-4-1 vs claude-opus-4-12345 trap, and random noise.
const datedArb = fc
  .tuple(registeredArb, fc.integer({ min: 0, max: 99_999_999 }))
  .map(([id, n]) => `${id}-${String(n).padStart(8, "0")}`);
const noDashArb = fc
  .tuple(registeredArb, fc.integer({ min: 0, max: 999_999 }))
  .map(([id, n]) => `${id}${n}`);
const opus41TrapArb = fc.integer({ min: 0, max: 99_999 }).map((n) => `claude-opus-4-1${n}`);
const modelArb = fc.oneof(registeredArb, datedArb, noDashArb, opus41TrapArb, fc.string());

// Strings guaranteed NOT priced (filtered through the oracle so the set can't silently rot).
const unpricedArb = fc
  .constantFrom("gpt-4", "claude", "claude-opus-4-2", "claude-opus-4-12345", "unknown", "")
  .filter((m) => oracleRate(m) === undefined);

test("isPriced agrees with the longest-prefix oracle", () => {
  fc.assert(
    fc.property(modelArb, (model) => {
      expect(isPriced(model)).toBe(oracleRate(model) !== undefined);
    }),
    { numRuns: 1000 },
  );
});

test("priceUsage equals the BigInt oracle when priced, throws when not", () => {
  fc.assert(
    fc.property(modelArb, usageArb, (model, usage) => {
      const rate = oracleRate(model);
      if (rate === undefined) {
        expect(() => priceUsage(model, usage)).toThrow();
      } else {
        expect(priceUsage(model, usage)).toBe(oracleCost(rate, usage));
      }
    }),
    { numRuns: 1000 },
  );
});

test("priceUsage is non-negative and never overcharges (floor) on priced models", () => {
  fc.assert(
    fc.property(registeredArb, usageArb, (model, usage) => {
      const got = priceUsage(model, usage);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(got).toBe(oracleCost(PRICES[model]!, usage)); // == floor of the exact cost
    }),
  );
});

test("priceUsage is monotonic: more tokens never costs less", () => {
  fc.assert(
    fc.property(registeredArb, usageArb, fieldArb, fc.nat({ max: 1_000_000 }), (model, usage, field, delta) => {
      const base = priceUsage(model, usage);
      const bumped = priceUsage(model, { ...usage, [field]: (usage[field] ?? 0) + delta });
      expect(bumped).toBeGreaterThanOrEqual(base);
    }),
  );
});

test("1-hour cache writes bill 2× input, 5-minute writes 1.25×, and a lying 1h>total can't undercharge", () => {
  // Concrete tiers on a known model: haiku input is $1/Mtok → 5-min write $1.25, 1-hour write $2.00 per Mtok.
  const haiku = (u: Usage) => priceUsage("claude-haiku-4-5", u);
  expect(haiku({ cache_creation_input_tokens: 1_000_000 })).toBe(1_250_000); // all 5-min → 1.25×
  expect(haiku({ cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: 1_000_000 })).toBe(2_000_000); // all 1-hour → 2×
  expect(haiku({ cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: 500_000 })).toBe(1_625_000); // half/half
  // A negative 1h slice (garbled/hostile) is floored to 0 → all-5-min; the lower clamp must never let it
  // drive the 5-min remainder ABOVE the total (which would overcharge) or below 0.
  expect(haiku({ cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: -50_000 })).toBe(1_250_000);
  // A report claiming MORE 1-hour than the total is clamped to the total — never cheaper than all-1-hour.
  expect(haiku({ cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: 5_000_000 })).toBe(2_000_000);
  // OpenAI has no cache-write fee in either tier, even if a 1h field somehow appeared (it never does).
  expect(priceUsage("gpt-4o-mini", { cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: 1_000_000 })).toBe(0);
});

test("costOf / holdBoundOf are PURE: they price against any Rate, with no prices.json involved", () => {
  // A hand-built rate, NOT from the table (micro-dollars per Mtok): input $2, output $8, cache_read $0.2,
  // 5-min write $2.5, 1-hour write $4. This is the whole point — the cost engine works off a Rate alone.
  const rate: Rate = { input: 2_000_000, output: 8_000_000, cache_read: 200_000, cache_write: 2_500_000, cache_write_1h: 4_000_000 };
  expect(costOf(rate, { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBe(10_000_000); // 2 + 8
  expect(costOf(rate, { cache_creation_input_tokens: 1_000_000 })).toBe(2_500_000); // all 5-min
  expect(costOf(rate, { cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: 1_000_000 })).toBe(4_000_000); // all 1-hour
  expect(costOf(rate, { cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: 5_000_000 })).toBe(4_000_000); // clamp still applies
  // holdBoundOf: dearest input tier × inputTokens + output × maxTokens; the 1h tier is gated on the opt.
  expect(holdBoundOf(rate, 1_000_000, 0)).toBe(2_500_000); // max(input 2, cache_read .2, cache_write 2.5)
  expect(holdBoundOf(rate, 1_000_000, 0, { oneHourCache: true })).toBe(4_000_000); // ...+ cache_write_1h 4
  expect(holdBoundOf(rate, 0, 1_000_000)).toBe(8_000_000); // output term
});

test("priceUsage / priceHoldBound are thin wrappers: they delegate to the pure fns over the table rate", () => {
  // Reconstruct the table's Rate from prices.json exactly as pricing.ts builds it, then assert the wrappers
  // equal the pure fn applied to it — pinning the delegation + the table construction without reaching into
  // module internals (findRate is private).
  const m = (usd: number) => Math.round(usd * 1_000_000);
  const e = PRICES["claude-opus-4-8"]!;
  const rate: Rate = { input: m(e.input), output: m(e.output), cache_read: m(e.cache_read), cache_write: m(e.cache_write), cache_write_1h: e.provider === "anthropic" ? m(e.input) * 2 : 0 };
  const usage: Usage = { input_tokens: 1234, output_tokens: 567, cache_creation_input_tokens: 89, cache_creation_1h_input_tokens: 12, cache_read_input_tokens: 34 };
  expect(priceUsage("claude-opus-4-8", usage)).toBe(costOf(rate, usage));
  expect(priceHoldBound("claude-opus-4-8", 5000, 1000, { oneHourCache: true })).toBe(holdBoundOf(rate, 5000, 1000, { oneHourCache: true }));
  expect(priceHoldBound("claude-opus-4-8", 5000, 1000)).toBe(holdBoundOf(rate, 5000, 1000));
});

test("fallback: priced primary wins; unpriced primary falls back; neither throws", () => {
  // A priced response model is always used as-is, regardless of the fallback.
  fc.assert(
    fc.property(registeredArb, registeredArb, usageArb, (primary, fallback, usage) => {
      expect(priceUsage(primary, usage, fallback)).toBe(priceUsage(primary, usage));
    }),
  );
  // An unpriced response model bills via the (priced) request fallback — never free.
  fc.assert(
    fc.property(unpricedArb, registeredArb, usageArb, (bad, fallback, usage) => {
      expect(priceUsage(bad, usage, fallback)).toBe(priceUsage(fallback, usage));
    }),
  );
  // Neither priced → it throws (the gate makes this unreachable in practice).
  fc.assert(
    fc.property(unpricedArb, usageArb, (bad, usage) => {
      expect(() => priceUsage(bad, usage)).toThrow();
      expect(() => priceUsage(bad, usage, "also-not-real")).toThrow();
    }),
  );
});

// The reasoning classification drives the streaming-disconnect bill (usage.ts disconnectOutput): a
// reasoning model bills the output CAP (its thinking tokens never stream as text), a non-reasoning one
// the char estimate. The -chat variants are the NON-reasoning members of an otherwise reasoning family —
// classifying them as reasoning would bill an honest early disconnect the full cap.
test("isReasoningModel: reasoning families yes, their -chat variants no", () => {
  expect(isReasoningModel("o1")).toBe(true);
  expect(isReasoningModel("o3-mini")).toBe(true);
  expect(isReasoningModel("o4-mini")).toBe(true);
  expect(isReasoningModel("gpt-5")).toBe(true);
  expect(isReasoningModel("gpt-5.2-codex")).toBe(true);
  expect(isReasoningModel("gpt-5-chat-latest")).toBe(false);
  expect(isReasoningModel("gpt-5.2-chat-latest")).toBe(false);
  expect(isReasoningModel("gpt-4o")).toBe(false);
  expect(isReasoningModel("claude-opus-4-8")).toBe(false);
});

// The price-table merge is the tripwire for an id served by >1 provider: a duplicate across sources must
// THROW (else one source silently shadows the other). Exercises the throw the committed files never trigger.
test("mergeRawPrices throws on a duplicate id across sources, merges disjoint ones", () => {
  const e = { provider: "x", input: 1, output: 1, cache_read: 0, cache_write: 0 };
  expect(() => mergeRawPrices({ a: e }, { a: e })).toThrow(/duplicate priced model id/);
  expect(() => mergeRawPrices({ a: e, b: e })).not.toThrow(); // one source is internally id-unique
  expect(mergeRawPrices({ a: e }, { b: e }).map(([id]) => id).sort()).toEqual(["a", "b"]);
});
