// The core-side token minter for the local gen-token.ts tool, so a locally minted token is byte-identical
// to a UI-minted one (client/src/lib/token.ts) and passes the client's paste-validation. The FORMAT + the
// non-crypto typo checksum live in the shared pure leaf src/token-format.ts, imported by BOTH this minter and
// the client; only the random-bytes generation differs (Bun Buffer here, browser btoa in the client).
import { tokenChecksum } from "../src/token-format";

export function mintToken(): string {
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  return "0sink_" + random + tokenChecksum(random);
}
