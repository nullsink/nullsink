// Generate a token + its hash LOCALLY, for the hash-only buy flow: the buyer keeps the token
// (their bearer secret, used as the x-api-key) and sends only the hash to POST /buy. The server
// funds the hash through normal settlement and never sees the raw token.
//
// Standalone on purpose: imports only the DB-free cli/mint and inlines sha256 (same as db.ts hashToken)
// rather than importing src/ledger/db, so running it never opens balances.db — the buyer needs nothing but Bun.
import { mintToken } from "./mint";

const token = mintToken();
const hash = new Bun.CryptoHasher("sha256").update(token).digest("hex");

console.log("Token — keep secret, set as your x-api-key (shown once):\n");
console.log(`  ${token}\n`);
console.log('Hash — send this to POST /buy as "hash":\n');
console.log(`  ${hash}\n`);
