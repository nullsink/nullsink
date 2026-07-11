// Compile the books for accounting / legal: a SALES JOURNAL (every credited payment, valued in USD at
// receipt) plus the current OUTSTANDING-CREDIT liability. Reads only the two local ledgers (the sales journal
// in pending.db, the liability in balances.db) — no identity, no per-customer data, no wallet RPC,
// writes nothing. Run on the box as the service user (DB
// ownership), like the other CLIs:
//
//   nsk financials [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--format table|csv|json]
//
// --since/--until bound the sales window [since, until) by UTC date (default: all of time). CSV prints the
// journal to stdout (pipe to a file) and the summary to stderr, so `> sales.csv` yields a clean import file.
import { openDb, DB_PATH } from "../src/ledger/db";
import { openOrderStore, PENDING_DB_PATH } from "../src/ledger/orders";
import { summarizeRevenue, formatCoin, formatUsd } from "../src/ledger/financials";
import { optVal, parseFormat } from "./format";

function parseBound(arg: string | undefined, fallback: number, label: string): number {
  if (arg == null) return fallback;
  const ms = Date.parse(arg);
  if (!Number.isFinite(ms)) {
    console.error(`invalid ${label} "${arg}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  return ms;
}

export function runFinancials(args: string[]): void {
  const format = parseFormat(args);

  const fromMs = parseBound(optVal(args, "--since"), 0, "--since");
  const toMs = parseBound(optVal(args, "--until"), Number.MAX_SAFE_INTEGER, "--until");

  // Two DBs (opened inside run, post-guard): the sales book is payment-world state in pending.db, while
  // the outstanding-credit liability is the balance ledger in balances.db.
  const { listRevenue } = openOrderStore(PENDING_DB_PATH);
  const { liabilityTotal } = openDb(DB_PATH);
  const rows = listRevenue(fromMs, toMs);
  const liability = liabilityTotal();

  // Exact fixed-point formatting via BigInt. A going concern's LIFETIME total crosses Number.MAX_SAFE_INTEGER
  // at ~9007 XMR of atomic units (and ~$9B of credit-micros), past which float addition / toFixed silently
  // drop low-order digits — unacceptable for books. Per-row values are small, but the totals below are summed
  // as BigInt and rendered here exactly (integer division + zero-padded remainder).
  //
  // Each sale row carries its own coin `scale` (atomic-units-per-whole), so the book renders every coin
  // exactly without a hard-coded constant — and amounts of DIFFERENT coins are never summed into one total
  // (only the USD figures, which are coin-independent, sum across the whole journal).
  const usd = formatUsd;
  const coin = formatCoin;

  // Per-coin received totals (kept separate — you can't add XMR to BTC); USD credit/gross sum across all.
  // The grouping lives in src/ledger/financials.ts so it's unit-tested (test/financials.test.ts).
  const { perCoin: byAsset, creditMicros: totalCreditMicros, grossMicros } = summarizeRevenue(rows);

  const rangeLabel =
    `${fromMs === 0 ? "(start)" : new Date(fromMs).toISOString()} → ` +
    `${toMs === Number.MAX_SAFE_INTEGER ? "(now)" : new Date(toMs).toISOString()}`;

  // "asset=amount" per coin, for the one-line summaries.
  const receivedSummary = [...byAsset].map(([asset, a]) => `${asset}=${coin(a.atomic, a.scale)}`).join(" ") || "(none)";

  if (format === "csv") {
    console.log("date,asset,coin,usd_credited,usd_gross");
    for (const r of rows)
      console.log(`${new Date(r.at).toISOString()},${r.asset},${coin(r.asset_atomic, r.scale)},${usd(r.usd_micros)},${usd(r.gross_micros)}`);
    console.error(
      `# range ${rangeLabel}\n` +
        `# sales=${rows.length} received=[${receivedSummary}] credit_usd=${usd(totalCreditMicros)} gross_usd=${usd(grossMicros)}\n` +
        `# outstanding tokens=${liability.tokens} prepaid_usd=${usd(liability.micros)}`,
    );
  } else if (format === "json") {
    console.log(
      JSON.stringify(
        {
          range: {
            from: fromMs === 0 ? null : new Date(fromMs).toISOString(),
            to: toMs === Number.MAX_SAFE_INTEGER ? null : new Date(toMs).toISOString(),
          },
          sales: rows.map((r) => ({ date: new Date(r.at).toISOString(), asset: r.asset, coin: coin(r.asset_atomic, r.scale), usd_credited: usd(r.usd_micros), usd_gross: usd(r.gross_micros) })),
          totals: {
            sales: rows.length,
            received: Object.fromEntries([...byAsset].map(([asset, a]) => [asset, coin(a.atomic, a.scale)])),
            credit_usd: usd(totalCreditMicros),
            gross_usd: usd(grossMicros),
          },
          outstanding: { tokens: liability.tokens, prepaid_usd: usd(liability.micros) },
        },
        null,
        2,
      ),
    );
  } else {
    const receivedLines = byAsset.size
      ? [...byAsset].map(([asset, a]) => `      ${asset.padEnd(8)} ${coin(a.atomic, a.scale)}`)
      : ["      (none)"];
    console.log(
      [
        `nullsink financials  ·  ${rangeLabel}`,
        ``,
        `  SALES (booked at credit time)`,
        `    sales            : ${rows.length}`,
        `    received by coin :`,
        ...receivedLines,
        `    credit issued    : $${usd(totalCreditMicros)}   (net — deferred-revenue liability created)`,
        `    gross (USD paid) : $${usd(grossMicros)}   (valued at each sale's locked rate)`,
        ``,
        `  OUTSTANDING (now)`,
        `    tokens w/ credit : ${liability.tokens}`,
        `    prepaid credit   : $${usd(liability.micros)}   (deferred revenue still owed in service)`,
        ``,
        `  notes`,
        `    · COGS (Anthropic/OpenAI spend) lives in each provider console, not here — pull it for margin math.`,
        `    · revenue rows start when this feature shipped; any earlier sales live only in the wallet.`,
        `    · manual issuance (nsk issue / topup) adds credit with no sale row — affects liability, not sales.`,
      ].join("\n"),
    );
  }
}
