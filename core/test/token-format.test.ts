// token-format.ts — the shared token format + non-crypto typo checksum. These KNOWN VECTORS are the contract
// that the core minter (cli/mint.ts) and the in-browser client minter (client/src/lib/token.ts) both honor
// by importing this exact module. A vector change here is a token wire-format change.
import { test, expect } from "bun:test";
import { tokenChecksum, isValidTokenFormat } from "../src/token-format";

test("checksum: known vectors", () => {
  expect(tokenChecksum("a".repeat(43))).toBe("ZkL6");
  expect(tokenChecksum("0".repeat(43))).toBe("wr5n");
  expect(tokenChecksum("rate000000000000000000000000000000000000000")).toBe("zT6N");
});

test("checksum is sensitive to its input (a typo changes it)", () => {
  expect(tokenChecksum("a".repeat(43))).not.toBe(tokenChecksum("0".repeat(43)));
});

test("isValidTokenFormat: accepts a correct token, rejects shape + checksum errors", () => {
  const random = "a".repeat(43);
  const good = "0sink_" + random + tokenChecksum(random);
  expect(isValidTokenFormat(good)).toBe(true);
  expect(isValidTokenFormat("0sink_" + random + "0000")).toBe(false); // shape-valid suffix, wrong checksum
  expect(isValidTokenFormat("nope_" + random + tokenChecksum(random))).toBe(false); // wrong prefix
  expect(isValidTokenFormat("0sink_short")).toBe(false); // wrong length
});
