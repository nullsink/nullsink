// cli/mint.ts — the core-side token minter. The format + checksum (and their known vectors) are tested in
// token-format.test.ts, the shared leaf both minters import; here we only assert mintToken produces
// well-formed, checksum-correct, unique tokens.
import { test, expect } from "bun:test";
import { mintToken } from "../cli/mint";
import { tokenChecksum, isValidTokenFormat } from "../src/token-format";

test("mintToken: 0sink_ + 43 random + 4 checksum, valid + round-trips + unique", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const t = mintToken();
    expect(isValidTokenFormat(t)).toBe(true);
    expect(tokenChecksum(t.slice(6, 49))).toBe(t.slice(49)); // checksum covers exactly the 43 random chars
    seen.add(t);
  }
  expect(seen.size).toBe(1000); // 256-bit random part → no collisions
});
