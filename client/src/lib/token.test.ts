// The shared token-format leaf, exercised through the client minter: a freshly generated token must pass the
// client's own paste-validation (both now resolve to core/src/token-format.ts), and a tampered one must not.
// Also pins that the cross-package import resolves in the client's test environment.
import { test, expect } from "bun:test";
import { generateToken, isValidTokenFormat } from "./token.ts";

test("generateToken produces a token that isValidTokenFormat accepts", () => {
  for (let i = 0; i < 100; i++) {
    expect(isValidTokenFormat(generateToken())).toBe(true);
  }
});

test("a tampered checksum is rejected", () => {
  const t = generateToken();
  const last = t[t.length - 1];
  const tampered = t.slice(0, -1) + (last === "A" ? "B" : "A"); // last checksum char no longer matches
  expect(isValidTokenFormat(tampered)).toBe(false);
});
