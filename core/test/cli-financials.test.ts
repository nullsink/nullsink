// The operator financial view consumes only the finalized aggregate report produced by backup.sh. It must
// reject schema expansion and preserve exact micro-dollar values without opening either live database.
import { expect, test } from "bun:test";
import { parseFinancialReport, renderFinancialReport } from "../cli/financials";

function fixture(): Record<string, unknown> {
  return {
    schema_version: 1,
    snapshot: {
      created_at: "2026-07-24T08:00:00Z",
      artifact: "backup-20260724T080000Z.tar.age",
      validation: "restore-dry-run-ok",
    },
    finance: {
      revenue_by_day_asset: [
        {
          date: "2026-07-23",
          asset: "bitcoin",
          sales: 2,
          credited_micros: "15000000",
          gross_micros: "16500000",
        },
        {
          date: "2026-07-24",
          asset: "monero",
          sales: 1,
          credited_micros: "8000000",
          gross_micros: "8800487",
        },
      ],
      liability: { outstanding_micros: "3405787" },
    },
    operations: {
      open_orders: { count: 0, credit_micros: "0", payment_seen: 0 },
      undelivered_credits: { count: 0, micros: "0", oldest_age_seconds: null },
    },
  };
}

test("renders exact aggregate financials from a finalized report", () => {
  const report = parseFinancialReport(JSON.stringify(fixture()));
  const output = renderFinancialReport(report);

  expect(output).toContain("2026-07-23  bitcoin");
  expect(output).toContain("2026-07-24  monero");
  expect(output).toContain("sales: 3 · credited: $23.000000 · gross: $25.300487");
  expect(output).toContain("outstanding liability at snapshot: $3.405787");
  expect(output).toContain("source: backup-20260724T080000Z.tar.age · restore-dry-run-ok");
});

test("date filters are half-open and do not alter snapshot liability", () => {
  const report = parseFinancialReport(JSON.stringify(fixture()));
  const output = renderFinancialReport(report, { since: "2026-07-24", until: "2026-07-25" });

  expect(output).not.toContain("2026-07-23  bitcoin");
  expect(output).toContain("2026-07-24  monero");
  expect(output).toContain("sales: 1 · credited: $8.000000 · gross: $8.800487");
  expect(output).toContain("outstanding liability at snapshot: $3.405787");
});

test("rejects unsupported or expanded report schemas", () => {
  const unsupported = fixture();
  unsupported.schema_version = 2;
  expect(() => parseFinancialReport(JSON.stringify(unsupported))).toThrow("unsupported report schema");

  const expanded = fixture();
  (expanded.finance as Record<string, unknown>).token_balances = [];
  expect(() => parseFinancialReport(JSON.stringify(expanded))).toThrow("finance has unexpected fields");
});

test("rejects inexact or invalid money fields", () => {
  const report = fixture();
  const finance = report.finance as {
    liability: { outstanding_micros: string };
  };
  finance.liability.outstanding_micros = "3.405787";
  expect(() => parseFinancialReport(JSON.stringify(report))).toThrow(
    "finance.liability.outstanding_micros must be non-negative integer micros",
  );
});
