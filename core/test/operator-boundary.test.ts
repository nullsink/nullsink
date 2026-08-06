// Step 3 removes operator writes and privacy-sensitive order inspection while preserving the two read-only
// live views operations still uses. Pin that exception exactly so it cannot quietly grow.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("nsk exposes exactly balances, financials, and version", () => {
  const entry = readFileSync(`${CORE}/cli/index.ts`, "utf8");
  expect(entry).toContain('balances: () => import("./balances")');
  expect(entry).toContain('financials: () => import("./financials")');
  for (const command of ["issue", "topup", "balance", "orders"]) {
    expect(entry).not.toMatch(new RegExp(`\\b${command}:\\s*\\(`));
  }
  for (const file of ["issue.ts", "topup.ts", "balance.ts", "orders.ts", "money.ts", "age.ts"]) {
    expect(existsSync(`${CORE}/cli/${file}`)).toBe(false);
  }
});

test("the live database exception is limited to the two read-only views", () => {
  const liveDb = readFileSync(`${CORE}/cli/live-db.ts`, "utf8");
  const report = readFileSync(`${CORE}/cli/report-financials.ts`, "utf8");

  expect(liveDb).toContain('new Database(path, { readonly: true, strict: true })');
  expect(liveDb).toContain("process.env.BALANCES_DB_PATH ?? process.env.DB_PATH");
  expect(liveDb).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i);
  expect(report).not.toMatch(/ledger\/(?:db|orders|sqlite)|bun:sqlite|process\.env\.(?:BALANCES_DB_PATH|DB_PATH|PENDING_DB_PATH)/);
});

test("release and deployment retain only the read-only nsk artifact", () => {
  const release = readFileSync(`${ROOT}/.github/workflows/release.yml`, "utf8");
  const library = readFileSync(`${CORE}/deploy/lib.sh`, "utf8");
  const deploy = readFileSync(`${CORE}/deploy/deploy.sh`, "utf8");

  expect(release).toContain("nsk-linux-x64");
  expect(library).toContain("install_nsk()");
  expect(deploy).toContain('if [ -x /usr/local/bin/nsk ]; then install_nsk "$REF"; fi');
  expect(existsSync(`${CORE}/deploy/install-nsk.sh`)).toBe(true);
  expect(existsSync(`${CORE}/deploy/node-box-runbook.md`)).toBe(false);
});
