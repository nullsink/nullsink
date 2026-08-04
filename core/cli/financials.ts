// Read-only live financial view: payment-side sales plus ledger-side outstanding liability. This is a
// deliberate transitional cross-domain reader; Step 5 replaces it with service-owned read interfaces.
import { formatCoin, formatUsd, summarizeRevenue } from "../src/ledger/financials";
import { optVal, parseFormat } from "./format";
import { readFinancials } from "./live-db";

function parseBound(arg: string | undefined, fallback: number, label: string): number {
  if (arg == null) return fallback;
  const milliseconds = Date.parse(arg);
  if (!Number.isFinite(milliseconds)) {
    console.error(`invalid ${label} "${arg}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  return milliseconds;
}

export function runFinancials(args: string[]): void {
  const format = parseFormat(args);
  const fromMs = parseBound(optVal(args, "--since"), 0, "--since");
  const toMs = parseBound(optVal(args, "--until"), Number.MAX_SAFE_INTEGER, "--until");
  const { rows, liability } = readFinancials(fromMs, toMs);
  const { perCoin, creditMicros, grossMicros } = summarizeRevenue(rows);
  const range =
    `${fromMs === 0 ? "(start)" : new Date(fromMs).toISOString()} → ` +
    `${toMs === Number.MAX_SAFE_INTEGER ? "(now)" : new Date(toMs).toISOString()}`;
  const received =
    [...perCoin].map(([asset, amount]) => `${asset}=${formatCoin(amount.atomic, amount.scale)}`).join(" ") ||
    "(none)";

  if (format === "csv") {
    console.log("date,asset,coin,usd_credited,usd_gross");
    for (const row of rows) {
      console.log(
        `${new Date(row.at).toISOString()},${row.asset},${formatCoin(row.asset_atomic, row.scale)},` +
          `${formatUsd(row.usd_micros)},${formatUsd(row.gross_micros)}`,
      );
    }
    console.error(
      `# range ${range}\n` +
        `# sales=${rows.length} received=[${received}] credit_usd=${formatUsd(creditMicros)} gross_usd=${formatUsd(grossMicros)}\n` +
        `# outstanding tokens=${liability.tokens} prepaid_usd=${formatUsd(liability.micros)}`,
    );
  } else if (format === "json") {
    console.log(
      JSON.stringify(
        {
          range: {
            from: fromMs === 0 ? null : new Date(fromMs).toISOString(),
            to: toMs === Number.MAX_SAFE_INTEGER ? null : new Date(toMs).toISOString(),
          },
          sales: rows.map((row) => ({
            date: new Date(row.at).toISOString(),
            asset: row.asset,
            coin: formatCoin(row.asset_atomic, row.scale),
            usd_credited: formatUsd(row.usd_micros),
            usd_gross: formatUsd(row.gross_micros),
          })),
          totals: {
            sales: rows.length,
            received: Object.fromEntries(
              [...perCoin].map(([asset, amount]) => [asset, formatCoin(amount.atomic, amount.scale)]),
            ),
            credit_usd: formatUsd(creditMicros),
            gross_usd: formatUsd(grossMicros),
          },
          outstanding: { tokens: liability.tokens, prepaid_usd: formatUsd(liability.micros) },
        },
        null,
        2,
      ),
    );
  } else {
    const receivedLines = perCoin.size
      ? [...perCoin].map(([asset, amount]) =>
          `      ${asset.padEnd(8)} ${formatCoin(amount.atomic, amount.scale)}`,
        )
      : ["      (none)"];
    console.log(
      [
        `nullsink financials  ·  ${range}`,
        "",
        "  SALES (booked at credit time)",
        `    sales            : ${rows.length}`,
        "    received by coin :",
        ...receivedLines,
        `    credit issued    : $${formatUsd(creditMicros)}`,
        `    gross (USD paid) : $${formatUsd(grossMicros)}`,
        "",
        "  OUTSTANDING (now)",
        `    tokens w/ credit : ${liability.tokens}`,
        `    prepaid credit   : $${formatUsd(liability.micros)}`,
      ].join("\n"),
    );
  }
}
