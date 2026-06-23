// List every token's remaining balance (`nsk balances [--format table|csv|json]`) — the per-token view of
// outstanding credit, for support / ops. Reads only the local ledger (balances.db), writes nothing: each row
// is the stored SHA-256 hash (NEVER the token — only the hash is on disk; see src/ledger/db.ts) and its
// micro-dollar balance, so it holds no usable credential and no identity. The count/total footer is
// liabilityTotal() — the SAME figures `nsk financials` reports as OUTSTANDING — so the two views can't
// disagree. Run on the box as the service user, like the other CLIs (a root read leaves root-owned WAL
// sidecars the service can't write):
//
//   sudo -u nullsink nsk balances --format table
//
// Rows sort by balance, largest first. `table` (default) is a human view: a short hash PREFIX + balance.
// `csv`/`json` carry the FULL 64-char hash for export (csv prints the rows to stdout and the summary to
// stderr, so `> balances.csv` yields a clean import file — same convention as `nsk financials`).
import { listBalances, liabilityTotal } from "../src/ledger/db";
import { formatUsd } from "../src/ledger/financials";
import { parseFormat } from "./format";

// Hash prefix shown in the table view: 16 hex chars = 64 bits, unambiguous for any realistic token count and
// narrow enough to read. csv/json print the full hash.
const HASH_PREFIX = 16;

export function runBalances(args: string[]): void {
  const format = parseFormat(args);

  const rows = listBalances();
  const { tokens, micros } = liabilityTotal(); // count + total — reconciles with `nsk financials`

  if (format === "csv") {
    console.log("hash,usd_balance");
    for (const r of rows) console.log(`${r.hash},${formatUsd(r.balance)}`);
    console.error(`# tokens=${tokens} prepaid_usd=${formatUsd(micros)}`);
  } else if (format === "json") {
    console.log(
      JSON.stringify(
        {
          balances: rows.map((r) => ({ hash: r.hash, usd_balance: formatUsd(r.balance) })),
          totals: { tokens, prepaid_usd: formatUsd(micros) },
        },
        null,
        2,
      ),
    );
  } else if (rows.length === 0) {
    console.log("(no tokens)");
  } else {
    // Pad the hash column to its widest cell and right-align the dollar column so the decimals line up.
    const cells = rows.map((r) => ({ hash: `${r.hash.slice(0, HASH_PREFIX)}…`, amt: `$${formatUsd(r.balance)}` }));
    const hashW = Math.max("hash".length, ...cells.map((c) => c.hash.length));
    const amtW = Math.max("balance".length, ...cells.map((c) => c.amt.length));
    const row = (h: string, a: string) => `  ${h.padEnd(hashW)}  ${a.padStart(amtW)}`;
    console.log(
      [
        row("hash", "balance"),
        row("-".repeat(hashW), "-".repeat(amtW)),
        ...cells.map((c) => row(c.hash, c.amt)),
        ``,
        `  ${tokens} token${tokens === 1 ? "" : "s"}  ·  $${formatUsd(micros)} outstanding`,
      ].join("\n"),
    );
  }
}
