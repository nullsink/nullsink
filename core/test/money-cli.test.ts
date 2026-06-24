// cli/money.ts:3 — `toMicros = Math.round(dollars * 1e6)` is the dollars→ledger boundary for every
// issued/topped-up credit; the `Math.round` survived (untested), and a drop to truncation drifts every credit
// by sub-cents.
import { test, expect } from "bun:test";
import { toMicros, toDollars } from "../cli/money";

test("toMicros rounds (not truncates) dollars to micro-dollars", () => {
  expect(toMicros(1.9999995)).toBe(2_000_000); // truncation would give 1_999_999
  expect(toMicros(0.0000015)).toBe(2); // 1.5 → 2 (half-up); truncation → 1
  expect(toMicros(0.0000004)).toBe(0); // 0.4 → 0
  expect(toMicros(2.5)).toBe(2_500_000);
});

test("toDollars is the inverse for whole micro amounts", () => {
  expect(toDollars(2_500_000)).toBe(2.5);
  expect(toDollars(toMicros(7.25))).toBe(7.25);
});
