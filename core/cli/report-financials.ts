// Render the finalized, aggregate-only report produced by deploy/backup.sh. This is deliberately a LOCAL
// operator tool: it accepts a copied report file or stdin, opens no database, and needs no production
// credentials beyond whatever read-only transport obtained the JSON. Exact micro-dollar strings stay BigInt
// end-to-end, so presentation cannot round money.
//
//   bun core/cli/report-financials.ts report-YYYYMMDDTHHMMSSZ.json
//   ssh production 'cat /path/to/latest-report.json' | bun core/cli/report-financials.ts -
import { readFileSync } from "node:fs";
import { formatUsd } from "../src/ledger/financials";

type RevenueRow = {
  date: string;
  asset: string;
  sales: number;
  credited_micros: string;
  gross_micros: string;
};

type FinancialReport = {
  schema_version: 1;
  snapshot: {
    created_at: string;
    artifact: string;
    validation: string;
  };
  finance: {
    revenue_by_day_asset: RevenueRow[];
    liability: {
      outstanding_micros: string;
    };
  };
  operations: {
    open_orders: {
      count: number;
      credit_micros: string;
      payment_seen: number;
    };
    undelivered_credits: {
      count: number;
      micros: string;
      oldest_age_seconds: number | null;
    };
  };
};

const USAGE = "usage: bun core/cli/report-financials.ts REPORT.json|- [--since YYYY-MM-DD] [--until YYYY-MM-DD]";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MICROS = /^(0|[1-9]\d*)$/;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function moneyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !MICROS.test(value)) {
    throw new Error(`${label} must be non-negative integer micros`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function dateString(value: unknown, label: string): string {
  if (typeof value !== "string" || !DATE.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return value;
}

export function parseFinancialReport(raw: string): FinancialReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("report is not valid JSON");
  }
  const root = record(parsed);
  exactKeys(root, ["schema_version", "snapshot", "finance", "operations"], "report");
  if (root.schema_version !== 1) throw new Error(`unsupported report schema: ${String(root.schema_version)}`);

  const snapshot = record(root.snapshot);
  exactKeys(snapshot, ["created_at", "artifact", "validation"], "snapshot");
  if (typeof snapshot.created_at !== "string" || Number.isNaN(Date.parse(snapshot.created_at))) {
    throw new Error("snapshot.created_at must be an ISO timestamp");
  }
  if (typeof snapshot.artifact !== "string" || !/^backup-\d{8}T\d{6}Z\.tar(?:\.age)?$/.test(snapshot.artifact)) {
    throw new Error("snapshot.artifact is invalid");
  }
  if (snapshot.validation !== "restore-dry-run-ok") throw new Error("snapshot is not restore-validated");

  const finance = record(root.finance);
  exactKeys(finance, ["revenue_by_day_asset", "liability"], "finance");
  if (!Array.isArray(finance.revenue_by_day_asset)) {
    throw new Error("finance.revenue_by_day_asset must be an array");
  }
  const rows = finance.revenue_by_day_asset.map((value, index): RevenueRow => {
    const row = record(value);
    exactKeys(row, ["date", "asset", "sales", "credited_micros", "gross_micros"], `revenue row ${index}`);
    if (typeof row.asset !== "string" || !/^[a-z][a-z0-9_-]*$/.test(row.asset)) {
      throw new Error(`revenue row ${index}.asset is invalid`);
    }
    return {
      date: dateString(row.date, `revenue row ${index}.date`),
      asset: row.asset,
      sales: count(row.sales, `revenue row ${index}.sales`),
      credited_micros: moneyString(row.credited_micros, `revenue row ${index}.credited_micros`),
      gross_micros: moneyString(row.gross_micros, `revenue row ${index}.gross_micros`),
    };
  });

  const liability = record(finance.liability);
  exactKeys(liability, ["outstanding_micros"], "finance.liability");
  const operations = record(root.operations);
  exactKeys(operations, ["open_orders", "undelivered_credits"], "operations");
  const openOrders = record(operations.open_orders);
  exactKeys(openOrders, ["count", "credit_micros", "payment_seen"], "operations.open_orders");
  const undelivered = record(operations.undelivered_credits);
  exactKeys(
    undelivered,
    ["count", "micros", "oldest_age_seconds"],
    "operations.undelivered_credits",
  );
  if (
    undelivered.oldest_age_seconds !== null &&
    (typeof undelivered.oldest_age_seconds !== "number" ||
      !Number.isSafeInteger(undelivered.oldest_age_seconds) ||
      undelivered.oldest_age_seconds < 0)
  ) {
    throw new Error("operations.undelivered_credits.oldest_age_seconds must be null or a non-negative integer");
  }
  return {
    schema_version: 1,
    snapshot: {
      created_at: snapshot.created_at,
      artifact: snapshot.artifact,
      validation: snapshot.validation,
    },
    finance: {
      revenue_by_day_asset: rows,
      liability: {
        outstanding_micros: moneyString(
          liability.outstanding_micros,
          "finance.liability.outstanding_micros",
        ),
      },
    },
    operations: {
      open_orders: {
        count: count(openOrders.count, "operations.open_orders.count"),
        credit_micros: moneyString(
          openOrders.credit_micros,
          "operations.open_orders.credit_micros",
        ),
        payment_seen: count(openOrders.payment_seen, "operations.open_orders.payment_seen"),
      },
      undelivered_credits: {
        count: count(undelivered.count, "operations.undelivered_credits.count"),
        micros: moneyString(undelivered.micros, "operations.undelivered_credits.micros"),
        oldest_age_seconds: undelivered.oldest_age_seconds,
      },
    },
  };
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

export function renderFinancialReport(
  report: FinancialReport,
  options: { since?: string | null; until?: string | null } = {},
): string {
  const since = options.since ?? null;
  const until = options.until ?? null;
  const rows = report.finance.revenue_by_day_asset.filter(
    (row) => (since === null || row.date >= since) && (until === null || row.date < until),
  );
  const sales = rows.reduce((sum, row) => sum + row.sales, 0);
  const credited = rows.reduce((sum, row) => sum + BigInt(row.credited_micros), 0n);
  const gross = rows.reduce((sum, row) => sum + BigInt(row.gross_micros), 0n);
  const cells = rows.map((row) => ({
    date: row.date,
    asset: row.asset,
    sales: String(row.sales),
    credited: `$${formatUsd(BigInt(row.credited_micros))}`,
    gross: `$${formatUsd(BigInt(row.gross_micros))}`,
  }));
  const widths = {
    date: Math.max(10, ...cells.map((row) => row.date.length)),
    asset: Math.max(5, ...cells.map((row) => row.asset.length)),
    sales: Math.max(5, ...cells.map((row) => row.sales.length)),
    credited: Math.max(8, ...cells.map((row) => row.credited.length)),
    gross: Math.max(6, ...cells.map((row) => row.gross.length)),
  };
  const lines = [
    `nullsink financials · snapshot ${report.snapshot.created_at}`,
    `range: ${since ?? "beginning"} → ${until ?? "snapshot"}`,
    "",
    `${pad("date", widths.date)}  ${pad("asset", widths.asset)}  ${pad("sales", widths.sales, true)}  ${pad("credited", widths.credited, true)}  ${pad("gross", widths.gross, true)}`,
  ];
  if (cells.length === 0) lines.push("(no revenue rows)");
  for (const row of cells) {
    lines.push(
      `${pad(row.date, widths.date)}  ${pad(row.asset, widths.asset)}  ${pad(row.sales, widths.sales, true)}  ${pad(row.credited, widths.credited, true)}  ${pad(row.gross, widths.gross, true)}`,
    );
  }
  lines.push(
    "",
    `sales: ${sales} · credited: $${formatUsd(credited)} · gross: $${formatUsd(gross)}`,
    `outstanding liability at snapshot: $${formatUsd(BigInt(report.finance.liability.outstanding_micros))}`,
    `open orders: ${report.operations.open_orders.count} · credit: $${formatUsd(BigInt(report.operations.open_orders.credit_micros))} · payment seen: ${report.operations.open_orders.payment_seen}`,
    `undelivered credits: ${report.operations.undelivered_credits.count} · amount: $${formatUsd(BigInt(report.operations.undelivered_credits.micros))} · oldest: ${report.operations.undelivered_credits.oldest_age_seconds === null ? "none" : `${report.operations.undelivered_credits.oldest_age_seconds}s`}`,
    `source: ${report.snapshot.artifact} · ${report.snapshot.validation}`,
  );
  return lines.join("\n");
}

function parseOptions(args: string[]): {
  source: string;
  since: string | null;
  until: string | null;
} {
  const source = args[0];
  if (source === undefined) throw new Error(USAGE);
  let since: string | null = null;
  let until: string | null = null;
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== "--since" && flag !== "--until") throw new Error(`unexpected argument: ${flag}`);
    if (value === undefined) throw new Error(`${flag} requires YYYY-MM-DD`);
    if (flag === "--since") {
      if (since !== null) throw new Error("--since was provided more than once");
      since = dateString(value, "--since");
    } else {
      if (until !== null) throw new Error("--until was provided more than once");
      until = dateString(value, "--until");
    }
  }
  if (since !== null && until !== null && since >= until) throw new Error("--since must be before --until");
  return { source, since, until };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--help" || args[0] === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const { source, since, until } = parseOptions(args);
    const report = parseFinancialReport(readFileSync(source === "-" ? 0 : source, "utf8"));
    console.log(renderFinancialReport(report, { since, until }));
  } catch (error) {
    console.error(`financials: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
