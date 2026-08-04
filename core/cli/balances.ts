// Read-only live liability view. Table output abbreviates stable token hashes; CSV/JSON expose full hashes
// for deliberate on-box investigation. Run as the service user so SQLite sidecars retain the right owner.
import { formatUsd } from "../src/ledger/financials";
import { parseFormat } from "./format";
import { readBalances } from "./live-db";

const HASH_PREFIX = 16;

export function runBalances(args: string[]): void {
  const format = parseFormat(args);
  const { rows, tokens, micros } = readBalances();

  if (format === "csv") {
    console.log("hash,usd_balance");
    for (const row of rows) console.log(`${row.hash},${formatUsd(row.balance)}`);
    console.error(`# tokens=${tokens} prepaid_usd=${formatUsd(micros)}`);
  } else if (format === "json") {
    console.log(
      JSON.stringify(
        {
          balances: rows.map((row) => ({ hash: row.hash, usd_balance: formatUsd(row.balance) })),
          totals: { tokens, prepaid_usd: formatUsd(micros) },
        },
        null,
        2,
      ),
    );
  } else if (rows.length === 0) {
    console.log("(no tokens)");
  } else {
    const cells = rows.map((row) => ({
      hash: `${row.hash.slice(0, HASH_PREFIX)}…`,
      amount: `$${formatUsd(row.balance)}`,
    }));
    const hashWidth = Math.max("hash".length, ...cells.map((cell) => cell.hash.length));
    const amountWidth = Math.max("balance".length, ...cells.map((cell) => cell.amount.length));
    const renderRow = (hash: string, amount: string) =>
      `  ${hash.padEnd(hashWidth)}  ${amount.padStart(amountWidth)}`;
    console.log(
      [
        renderRow("hash", "balance"),
        renderRow("-".repeat(hashWidth), "-".repeat(amountWidth)),
        ...cells.map((cell) => renderRow(cell.hash, cell.amount)),
        "",
        `  ${tokens} token${tokens === 1 ? "" : "s"}  ·  $${formatUsd(micros)} outstanding`,
      ].join("\n"),
    );
  }
}
