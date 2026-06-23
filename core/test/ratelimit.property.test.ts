// Tests for the global token bucket (src/ratelimit.ts). The clock is injected so refill is exercised
// deterministically — no real time, no sleeps.
import { test, expect } from "bun:test";
import fc from "fast-check";
import { makeTokenBucket } from "../src/ratelimit";

test("allows up to `capacity` immediate consumes, then denies", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), (capacity) => {
      const bucket = makeTokenBucket({ capacity, refillPerSec: 0, now: () => 0 }); // frozen clock, no refill
      for (let i = 0; i < capacity; i++) expect(bucket.tryConsume()).toBe(true);
      expect(bucket.tryConsume()).toBe(false); // bucket drained
    }),
    { numRuns: 200 },
  );
});

test("refills at refillPerSec, capped at capacity", () => {
  let t = 0;
  const bucket = makeTokenBucket({ capacity: 2, refillPerSec: 1, now: () => t });
  expect(bucket.tryConsume()).toBe(true); // 2 → 1
  expect(bucket.tryConsume()).toBe(true); // 1 → 0
  expect(bucket.tryConsume()).toBe(false); // empty
  t = 1000; // 1s → +1 token
  expect(bucket.tryConsume()).toBe(true); // 1 → 0
  expect(bucket.tryConsume()).toBe(false); // empty again
  t = 10_000; // 10s elapsed → would be +10, but capped at capacity (2)
  expect(bucket.tryConsume()).toBe(true);
  expect(bucket.tryConsume()).toBe(true);
  expect(bucket.tryConsume()).toBe(false); // never more than `capacity` banked
});

test("a steady arrival rate at the refill rate is sustained indefinitely", () => {
  let t = 0;
  const bucket = makeTokenBucket({ capacity: 1, refillPerSec: 10, now: () => t }); // 10/sec sustained
  for (let i = 0; i < 50; i++) {
    t += 100; // one request every 100ms = exactly 10/sec
    expect(bucket.tryConsume()).toBe(true);
  }
});
