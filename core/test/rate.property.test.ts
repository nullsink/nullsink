// Property + example tests for the XMR/USD rate source (src/rate.ts). makeRate takes an injected
// fetch, so we drive the parser, the sane-band guard, the cache, and the error paths with no network.
import { test, expect } from "bun:test";
import fc from "fast-check";
import { makeRate, parseRate, parseCoinGecko, RateError } from "../src/rails/rate";

const CFG = { url: "https://rate.test", cacheMs: 0, timeoutMs: 1000, minUsd: 1, maxUsd: 100_000 };

// Kraken ticker shape; c[0] is the last price (always a string on the wire).
const kraken = (price: unknown) => ({ result: { XXMRZUSD: { c: [String(price), "0"], v: ["x"] } } });
const fetchJson = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("parseRate extracts c[0] for well-formed bodies, throws otherwise", () => {
  fc.assert(
    fc.property(fc.double(), (price) => {
      if (Number.isFinite(price) && price > 0) expect(parseRate(kraken(price))).toBe(price);
      else expect(() => parseRate(kraken(price))).toThrow(RateError);
    }),
    { numRuns: 1000 },
  );
});

test("parseRate rejects malformed shapes", () => {
  const bad = [null, undefined, {}, { result: null }, { result: {} }, { result: { P: {} } }, { result: { P: { c: [] } } }, { result: { P: { c: ["abc"] } } }, { result: { P: { c: ["0"] } } }, { result: { P: { c: ["-5"] } } }];
  for (const body of bad) expect(() => parseRate(body)).toThrow(RateError);
});

test("xmrUsd returns the price when in band", () => {
  fc.assert(
    fc.asyncProperty(fc.double({ min: 1, max: 100_000, noNaN: true, noDefaultInfinity: true }), async (price) => {
      const xmrUsd = makeRate({ ...CFG, fetchImpl: fetchJson(kraken(price)) });
      expect(await xmrUsd()).toBe(price);
    }),
  );
});

test("xmrUsd always returns an in-band value or throws RateError (never out of band)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.double(), async (price) => {
      const xmrUsd = makeRate({ ...CFG, fetchImpl: fetchJson(kraken(price)) });
      try {
        const v = await xmrUsd();
        expect(v).toBeGreaterThanOrEqual(CFG.minUsd);
        expect(v).toBeLessThanOrEqual(CFG.maxUsd);
      } catch (e) {
        expect(e).toBeInstanceOf(RateError);
      }
    }),
    { numRuns: 1000 },
  );
});

test("an HTTP error from the source throws RateError", async () => {
  const xmrUsd = makeRate({ ...CFG, fetchImpl: fetchJson({}, 503) });
  await expect(xmrUsd()).rejects.toBeInstanceOf(RateError);
});

test("the value is cached within cacheMs and refetched when caching is disabled", async () => {
  let calls = 0;
  const prices = [150, 999];
  const counting: typeof fetch = (async () => {
    const p = prices[Math.min(calls, 1)];
    calls++;
    return new Response(JSON.stringify(kraken(p)), { status: 200 });
  }) as unknown as typeof fetch;

  const cached = makeRate({ ...CFG, cacheMs: 60_000, fetchImpl: counting });
  expect(await cached()).toBe(150);
  expect(await cached()).toBe(150); // second call served from cache
  expect(calls).toBe(1);

  calls = 0;
  const fresh = makeRate({ ...CFG, cacheMs: 0, fetchImpl: counting });
  expect(await fresh()).toBe(150);
  expect(await fresh()).toBe(999); // caching off → refetch sees the new price
  expect(calls).toBe(2);
});

test("parseCoinGecko reads monero.usd for well-formed bodies, throws otherwise", () => {
  expect(parseCoinGecko({ monero: { usd: 312.5 } })).toBe(312.5);
  for (const body of [null, {}, { monero: {} }, { monero: { usd: 0 } }, { monero: { usd: -1 } }, { monero: { usd: "x" } }])
    expect(() => parseCoinGecko(body)).toThrow(RateError);
});

test("single-flight: concurrent refreshes collapse onto one fetch", async () => {
  let calls = 0;
  let release!: (r: Response) => void;
  const gate = new Promise<Response>((r) => (release = r));
  // Counts each call but doesn't resolve until released — so both callers are in flight together.
  const slow: typeof fetch = (async () => {
    calls++;
    return gate;
  }) as unknown as typeof fetch;
  const xmrUsd = makeRate({ ...CFG, cacheMs: 60_000, fetchImpl: slow });
  const p1 = xmrUsd();
  const p2 = xmrUsd(); // arrives while p1's fetch is in flight → must join it, not start a second
  release(new Response(JSON.stringify(kraken(200)), { status: 200 }));
  expect(await p1).toBe(200);
  expect(await p2).toBe(200);
  expect(calls).toBe(1);
});

test("single-flight: a failed refresh is not cached and the next call retries", async () => {
  let calls = 0;
  const flaky: typeof fetch = (async () => {
    calls++;
    return calls === 1
      ? new Response("{}", { status: 503 }) // first refresh fails
      : new Response(JSON.stringify(kraken(180)), { status: 200 });
  }) as unknown as typeof fetch;
  const xmrUsd = makeRate({ ...CFG, cacheMs: 60_000, fetchImpl: flaky });
  await expect(xmrUsd()).rejects.toBeInstanceOf(RateError);
  expect(await xmrUsd()).toBe(180); // retried (failure wasn't cached, in-flight slot was cleared)
  expect(calls).toBe(2);
});

// The fallback list routes by url so one fetchImpl can stand in for several venues.
const fanOut = (fn: (url: string) => Response): typeof fetch =>
  (async (url: any) => fn(String(url))) as unknown as typeof fetch;

test("failover: a failing primary falls through to the next source", async () => {
  const xmrUsd = makeRate({
    ...CFG,
    fetchImpl: fanOut((url) =>
      url.includes("primary")
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ monero: { usd: 321 } }), { status: 200 }),
    ),
    url: "https://primary/x",
    fallbacks: [{ url: "https://coingecko/x", parse: parseCoinGecko, name: "coingecko" }],
  });
  expect(await xmrUsd()).toBe(321);
});

test("failover: an out-of-band primary value falls through to an in-band source", async () => {
  const xmrUsd = makeRate({
    ...CFG,
    fetchImpl: fanOut((url) =>
      url.includes("primary")
        ? new Response(JSON.stringify(kraken(10_000_000)), { status: 200 }) // absurd → out of band
        : new Response(JSON.stringify({ monero: { usd: 300 } }), { status: 200 }),
    ),
    url: "https://primary/x",
    fallbacks: [{ url: "https://coingecko/x", parse: parseCoinGecko, name: "coingecko" }],
  });
  expect(await xmrUsd()).toBe(300);
});

test("failover: when every source fails, RateError is thrown", async () => {
  const xmrUsd = makeRate({
    ...CFG,
    fetchImpl: fanOut(() => new Response("{}", { status: 500 })),
    url: "https://primary/x",
    fallbacks: [{ url: "https://secondary/x", parse: parseCoinGecko, name: "secondary" }],
  });
  await expect(xmrUsd()).rejects.toBeInstanceOf(RateError);
});
