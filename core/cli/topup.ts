// Add N dollars to an existing token, identified by its HASH — the operator works in hashes (what `nsk
// balances` lists, what the buy flow uses); the raw token never touches this CLI. Run on the box
// (`nsk topup <hash> <dollars>`), manually after a repeat payment. Refuses an unknown hash rather than
// minting a phantom, unspendable balance (no one holds its preimage) — use `nsk issue` to create a token.
import { credit, getBalance } from "../src/ledger/db";
import { requireDollars, toDollars, toMicros } from "./money";

export function runTopup(args: string[]): void {
  const USAGE = "usage: nsk topup <hash> <dollars>";
  const hash = args[0];
  if (!hash) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    console.error("invalid hash (expected 64 lowercase hex chars; `nsk balances --format json` lists them in full)");
    process.exit(1);
  }
  const dollars = requireDollars(args[1], USAGE);

  if (getBalance(hash) === null) {
    console.error("unknown token — mint one with `nsk issue`");
    process.exit(1);
  }
  credit(hash, toMicros(dollars));
  const balance = toDollars(getBalance(hash) ?? 0);
  console.log(`Added $${dollars.toFixed(2)}. New balance: $${balance.toFixed(2)}.`);
}
