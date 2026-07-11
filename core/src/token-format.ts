// Token FORMAT + the non-cryptographic typo checksum: the single source of truth shared by the core CLI
// minter (cli/mint.ts) and the in-browser client minter (client/src/lib/token.ts), so a CLI-minted token
// and a UI-minted one are byte-identical to the backend and the client can reject a mistyped paste before
// it is funded.
//
// PURE LEAF: ZERO imports. No Buffer, no bun:sqlite, no crypto, no env. Keep it that way. The client bundles
// this file into the browser, so any non-browser-safe dependency added here would break the client build.
//
// Format: "0sink_" + base64url(32 random bytes) + a 4-char checksum.
//   - The 43 base64url random chars carry the entire 256 bits of entropy (the security).
//   - The checksum is a SYNC, NON-cryptographic typo guard (FNV-1a over the 43 random chars -> low 24 bits
//     -> 4 base64url chars). It adds NO entropy and is NOT a security feature; it only lets the client reject
//     a mistyped/garbled paste before the token is hashed + funded (a wrong token funds an unspendable hash,
//     unrecoverable by design). The server hashes the whole string and never inspects it.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"; // base64url order

const TOKEN_RE = /^0sink_[A-Za-z0-9_-]{47}$/; // "0sink_" + 43 random chars + 4 checksum chars

// FNV-1a (32-bit) over the chars, low 24 bits -> 4 base64url chars. Math.imul keeps the 32-bit multiply
// exact and identical across JS engines (browser + Bun) — that cross-engine identity is the whole contract.
export function tokenChecksum(random: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < random.length; i++) h = Math.imul(h ^ random.charCodeAt(i), 0x01000193);
  const v = (h >>> 0) & 0xffffff;
  return ALPHABET[(v >> 18) & 63]! + ALPHABET[(v >> 12) & 63]! + ALPHABET[(v >> 6) & 63]! + ALPHABET[v & 63]!;
}

// A correctly minted token: "0sink_" + 43 base64url random chars + a 4-char checksum OF those 43. The regex
// gates the shape; the checksum compare catches a typo'd / partial paste before it can be funded.
export function isValidTokenFormat(token: string): boolean {
  if (!TOKEN_RE.test(token)) return false;
  const random = token.slice(6, 49);
  return tokenChecksum(random) === token.slice(49);
}
