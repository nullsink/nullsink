// The shared token-format leaf, exercised through the client minter: a freshly generated token must pass the
// client's own paste-validation (both now resolve to core/src/token-format.ts), and a tampered one must not.
// Also pins that the cross-package import resolves in the client's test environment.
import { test, expect } from "bun:test";
import { generateToken, isValidTokenFormat, hashToken, keyFieldState } from "./token.ts";

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

// The home key field's three buckets, shared by KeyFlow's render and submit() so the CTA, the typo warning,
// and the buy-guard can never disagree about one input.
test("keyFieldState classifies blank, valid, and malformed input", () => {
  // blank (or whitespace-only) is neither — the form will mint a fresh key
  expect(keyFieldState("")).toEqual({ malformed: false, willTopUp: false });
  expect(keyFieldState("   ")).toEqual({ malformed: false, willTopUp: false });
  // a valid token is a top-up; surrounding whitespace is trimmed first
  const tok = generateToken();
  expect(keyFieldState(tok)).toEqual({ malformed: false, willTopUp: true });
  expect(keyFieldState(`  ${tok}  `)).toEqual({ malformed: false, willTopUp: true });
  // a non-blank value that doesn't parse is malformed (blocks the buy, shows the typo warning)
  expect(keyFieldState("not-a-key")).toEqual({ malformed: true, willTopUp: false });
});

// LOAD-BEARING: the browser hash (crypto.subtle) MUST equal what the server/CLI store (Bun.CryptoHasher),
// or /buy would fund a hash the token can never spend — silent, unrecoverable money loss. Pin canonical
// SHA-256 agreement across the two implementations. (Mutation can't reach this — it's a cross-impl invariant.)
test("hashToken matches the server/CLI SHA-256 for the same token", async () => {
  for (const t of ["0sink_fixed_example", generateToken(), "x".repeat(64)]) {
    const browser = await hashToken(t);
    const server = new Bun.CryptoHasher("sha256").update(t).digest("hex"); // what gen-token.ts / db.ts use
    expect(browser).toBe(server);
    expect(browser).toMatch(/^[0-9a-f]{64}$/);
  }
});
