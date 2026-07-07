// Mint a new token worth N dollars and print it ONCE. Run via the operator CLI (`nsk issue <dollars>`),
// manually after a payment lands. The dollars→token decision is where your margin lives (credit fewer
// dollars than the payment was worth); the proxy never sees it. The raw token is shown only here — only its
// hash is stored.
import { openDb, DB_PATH, hashToken } from "../src/ledger/db";
import { requireDollars, toMicros } from "./money";
import { mintToken } from "./mint";

export function runIssue(args: string[]): void {
  const dollars = requireDollars(args[0], "usage: nsk issue <dollars>   (e.g. 17)");

  // Mint via the shared cli/mint: 0sink_ + base64url(32 random bytes) + a 4-char typo checksum.
  const token = mintToken();
  // Open the ledger inside run (post-guard, see cli/index.ts) and credit the freshly minted token's hash.
  const { credit } = openDb(DB_PATH);
  credit(hashToken(token), toMicros(dollars));

  console.log(`Issued $${dollars.toFixed(2)}. Give the user this token (shown once):\n`);
  console.log(`  ${token}\n`);
  console.log("They set it as their API key (Anthropic or OpenAI) and point the SDK at the proxy URL.");
}
