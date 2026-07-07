// List in-flight payment orders (`nsk orders [--rail monero|bitcoin] [--format table|csv|json]`) — the
// operator's live view of the pending_orders table (orders quoted by /buy, awaiting on-chain payment), beside
// `nsk balances` (settled credit) and `nsk financials` (booked sales). Reads the orders store (pending.db),
// writes nothing. Run on the box as the service user: `sudo -u nullsink nsk orders`.
//
// Follows the `nsk balances` convention: `table` abbreviates the hash + pay-to address for reading; `csv`/`json`
// carry them in full for export (rows to stdout, the `#` summary to stderr, so `> orders.csv` is a clean file).
// The link is the operator's to see and is transient — rows self-clear at the reaper; see cli/README.md.
//
// Rows sort oldest-first (longest-waiting on top). The footer counts open orders per rail and totals the QUOTED
// credit — what we'd credit if every open order paid in full; most self-clear at the reaper, so it's a
// speculative ceiling well above settled liability. For one order's live confirmation depth, query
// /order-status by token hash (the poller keeps that in memory).
import { openOrderStore, PENDING_DB_PATH, type PendingOrder } from "../src/ledger/orders";
import { formatUsd, formatCoin } from "../src/ledger/financials";
import { RAIL_META, RAIL_NAMES, type RailMeta } from "../src/rails/catalog";
import { formatAge } from "./age";
import { optVal, parseFormat } from "./format";

const HASH_PREFIX = 16; // token-hash hex chars shown before the ellipsis in the table — matches `nsk balances`
const ADDR_PREFIX = 12; // pay-to address chars shown before the ellipsis in the table

// Column layout for the table view: header label + whether to right-align (numbers/amounts read better right).
const COLUMNS = [
  { key: "rail", head: "rail", right: false },
  { key: "idx", head: "idx", right: true },
  { key: "hash", head: "hash", right: false },
  { key: "pay_to", head: "pay_to", right: false },
  { key: "credit", head: "credit", right: true },
  { key: "expected", head: "expected", right: true },
  { key: "age", head: "age", right: true },
] as const;

// Expected coin amount at the rail's OWN scale (formatCoin) + its ticker. Falls back to raw atomic units for a
// row whose rail isn't in the catalog (shouldn't happen) rather than guessing a scale.
function expectedCoin(o: PendingOrder): { amount: string; unit: string } {
  const meta: RailMeta | undefined = RAIL_META[o.rail];
  return meta ? { amount: formatCoin(o.expected_atomic, meta.scale), unit: meta.unit } : { amount: String(o.expected_atomic), unit: "" };
}

export function runOrders(args: string[]): void {
  const format = parseFormat(args);

  // Validate --rail against the known-rail set (mirrors parseFormat): a typo errors; a known-but-inactive rail
  // (e.g. bitcoin on a monero-only box) is fine — openOrders just returns no rows for it.
  const rail = optVal(args, "--rail");
  if (rail !== undefined && !RAIL_NAMES.includes(rail)) {
    console.error(`unknown --rail ${rail} (expected: ${RAIL_NAMES.join(" | ")})`);
    process.exit(1);
  }

  // openOrders() returns rows in arbitrary rowid order; sort oldest-first so the listing is deterministic and
  // the orders nearest expiry/reaping read off the top. Store opened inside run, post-guard (see cli/index.ts).
  const { openOrders } = openOrderStore(PENDING_DB_PATH);
  const rows = openOrders(rail).sort((a, b) => a.created_at - b.created_at);

  // Footer/summary figures, shared by every format: open count, per-rail breakdown, and the QUOTED credit
  // total (Σ credit_micros, exact BigInt — the MAX_OPEN_ORDERS ceiling crosses Number.MAX_SAFE_INTEGER).
  const perRail = new Map<string, number>();
  for (const o of rows) perRail.set(o.rail, (perRail.get(o.rail) ?? 0) + 1);
  const quotedMicros = rows.reduce((s, o) => s + BigInt(o.credit_micros), 0n);
  const railBreakdown = [...perRail].map(([r, n]) => `${r}=${n}`).join(" ");

  if (format === "csv") {
    // FULL hash + address for export; summary to stderr so `> orders.csv` is clean (same convention as
    // balances/financials). Addresses + hex hashes contain no commas, so no escaping is needed.
    console.log("rail,order_index,hash,address,credit_usd,expected,unit,created");
    for (const o of rows) {
      const e = expectedCoin(o);
      console.log(`${o.rail},${o.order_index},${o.hash},${o.address},${formatUsd(o.credit_micros)},${e.amount},${e.unit},${new Date(o.created_at).toISOString()}`);
    }
    console.error(`# open=${rows.length} quoted_usd=${formatUsd(quotedMicros)} by_rail=[${railBreakdown || "(none)"}]`);
  } else if (format === "json") {
    console.log(
      JSON.stringify(
        {
          orders: rows.map((o) => {
            const e = expectedCoin(o);
            return { rail: o.rail, order_index: o.order_index, hash: o.hash, address: o.address, credit_usd: formatUsd(o.credit_micros), expected: e.amount, unit: e.unit, created: new Date(o.created_at).toISOString() };
          }),
          totals: { open: rows.length, quoted_usd: formatUsd(quotedMicros), by_rail: Object.fromEntries(perRail) },
        },
        null,
        2,
      ),
    );
  } else if (rows.length === 0) {
    console.log("(no open orders)");
  } else {
    const now = Date.now();
    const cells = rows.map((o) => {
      const e = expectedCoin(o);
      return {
        rail: o.rail,
        idx: String(o.order_index),
        hash: `${o.hash.slice(0, HASH_PREFIX)}…`,
        pay_to: `${o.address.slice(0, ADDR_PREFIX)}…`,
        credit: `$${formatUsd(o.credit_micros)}`,
        expected: e.unit ? `${e.amount} ${e.unit}` : e.amount,
        age: formatAge(now - o.created_at),
      };
    });

    // Pad each column to its widest cell so columns line up, like `nsk balances`.
    const widths = COLUMNS.map((c) => Math.max(c.head.length, ...cells.map((cell) => cell[c.key].length)));
    const line = (vals: readonly string[]) =>
      "  " + COLUMNS.map((c, i) => (c.right ? vals[i].padStart(widths[i]) : vals[i].padEnd(widths[i]))).join("  ");

    console.log(
      [
        line(COLUMNS.map((c) => c.head)),
        line(widths.map((w) => "-".repeat(w))),
        ...cells.map((cell) => line(COLUMNS.map((c) => cell[c.key]))),
        ``,
        `  ${rows.length} open · ${railBreakdown} · $${formatUsd(quotedMicros)} quoted (unpaid)`,
        `  · live confirmation depth isn't in this DB — query /order-status by token hash`,
      ].join("\n"),
    );
  }
}
