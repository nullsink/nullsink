// The core privacy invariant (LOAD-BEARING). The customer's token is their money and their only identity.
// It crosses same-origin TLS for API authentication and balance checks, is hashed in-process, and is never
// persisted raw. Purchase and payment-status endpoints receive only its SHA-256 hash.
//
//   1. Generate in-browser: "0sink_" + base64url(32 bytes from crypto.getRandomValues) + a 4-char checksum.
//      crypto.getRandomValues, NEVER Math.random — the 256-bit unguessability (the 43 random chars) is what
//      keeps the public /balance validity-oracle safe. The checksum adds NO entropy.
//   2. Hash in-browser with SubtleCrypto: SHA-256(token) -> lowercase hex (64 chars).
//   3. POST only the hash to /buy and /order-status. Send the raw bearer only as same-origin TLS
//      authentication for metered API calls and /balance; the receiving process hashes it immediately.
//
// The FORMAT + checksum + paste-validation live in the shared pure leaf core/src/token-format.ts, imported
// here AND by the core CLI minter (core/cli/mint.ts) so a UI-minted token and a CLI-minted one are
// byte-identical to the backend. Only the random-bytes encoding differs (browser btoa here, Bun Buffer in core).
import { isValidTokenFormat, tokenChecksum } from "../../../core/src/token-format.ts";
export { isValidTokenFormat };

// base64url, no padding — matches Node's Buffer.toString("base64url").
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateToken(): string {
  const random = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return "0sink_" + random + tokenChecksum(random);
}

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The home key field's two meaningful states, derived from the raw input so KeyFlow's render and its submit()
// guard share one rule: a non-blank value that doesn't parse (malformed — show the typo warning, block the
// buy) vs. a valid token (willTopUp — the CTA becomes "add credit"). Blank is neither: the form mints a key.
export function keyFieldState(raw: string): { malformed: boolean; willTopUp: boolean } {
  const v = raw.trim();
  const valid = isValidTokenFormat(v);
  return { malformed: v.length > 0 && !valid, willTopUp: valid };
}
