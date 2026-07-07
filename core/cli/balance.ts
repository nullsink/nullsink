// Check a token's remaining balance by its HASH, for support (`nsk balance <hash>`). The operator works in
// hashes (what `nsk balances` lists, what the buy flow uses); the raw token never touches this CLI — token
// holders check their own balance over the API (GET /balance with the token in x-api-key).
import { openDb, DB_PATH } from "../src/ledger/db";
import { toDollars } from "./money";

export function runBalance(args: string[]): void {
  const hash = args[0];
  if (!hash) {
    console.error("usage: nsk balance <hash>");
    process.exit(1);
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    console.error("invalid hash (expected 64 lowercase hex chars; `nsk balances --format json` lists them in full)");
    process.exit(1);
  }

  // Open the ledger HERE (inside run, after the root guard in cli/index.ts) — never at module top, so a
  // usage error above exits without opening the DB and the guard-before-open ordering can't regress.
  const { getBalance } = openDb(DB_PATH);
  const micros = getBalance(hash);
  if (micros === null) {
    console.log("unknown token");
    process.exit(1);
  }
  console.log(`$${toDollars(micros).toFixed(6)}`);
}
