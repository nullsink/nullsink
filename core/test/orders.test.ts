// The age formatter behind `nsk orders` (cli/age.ts): a millisecond span → a compact human string, the
// magnitude choosing the unit, a zero remainder dropped, and clock skew (a negative span) clamped to "0s".
import { test, expect } from "bun:test";
import { formatAge } from "../cli/age";

test("formatAge picks the unit by magnitude", () => {
  expect(formatAge(0)).toBe("0s");
  expect(formatAge(45_000)).toBe("45s");
  expect(formatAge(59_999)).toBe("59s"); // sub-minute rounds down
  expect(formatAge(60_000)).toBe("1m");
  expect(formatAge(12 * 60_000)).toBe("12m");
  expect(formatAge(60 * 60_000)).toBe("1h");
  expect(formatAge(3 * 3_600_000 + 20 * 60_000)).toBe("3h20m");
  expect(formatAge(24 * 3_600_000)).toBe("1d");
  expect(formatAge(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d4h");
});

test("formatAge drops a zero remainder", () => {
  expect(formatAge(5 * 3_600_000)).toBe("5h"); // no trailing 0m
  expect(formatAge(3 * 86_400_000)).toBe("3d"); // no trailing 0h
});

test("formatAge clamps a negative span (clock skew) to 0s", () => {
  expect(formatAge(-5_000)).toBe("0s");
});
