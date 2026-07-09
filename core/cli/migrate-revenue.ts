// The one-time stage-2 cutover migration (D5), as an nsk subcommand so it can actually RUN on the box.
//
//   nsk migrate-revenue                    # SAFE DRY-RUN: report what would move, write nothing
//   nsk migrate-revenue --apply            # perform the migration
//   nsk migrate-revenue --apply <balances.db> <pending.db>   # explicit paths (rehearsal on copies)
//
// Two steps, both from src/ledger/migrate-revenue.ts:
//   migrateRevenue   — copy the `revenue` sales book from balances.db (prompt world) into pending.db
//                      (payment world). balances.db is only READ; its old table is left in place, which is
//                      what keeps a rollback to a pre-cutover binary readable.
//   reconcileOutbox  — seed credit_outbox with an acked tombstone per already-applied key, so a pre-cutover
//                      zombie order can't re-settle post-cutover and DOUBLE-BOOK its sale.
//
// RUN WITH THE APP STOPPED. The migration takes pending.db's write lock, and reconcileOutbox must land before
// the settlement poller's first tick can settle anything. Dry-run first, and rehearse on copies of the real
// databases (scripts/rehearse-migration.ts, off-box) before touching production. See deploy/cutover-runbook.md.
//
// Why this exists as a subcommand at all: the box is source-free — no Bun, no src/, and the release tarball
// ships only deploy/ — so scripts/migrate-revenue.ts cannot run there. nsk is built from the same tag as the
// server, opens both databases, and already refuses to run as root (cli/guard.ts), which is exactly the
// guard a migration of WAL-mode money databases needs.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DB_PATH } from "../src/ledger/db";
import { openOrderStore, PENDING_DB_PATH } from "../src/ledger/orders";
import { migrateRevenue, reconcileOutbox } from "../src/ledger/migrate-revenue";

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

// Read-only reconnaissance for the dry run. Deliberately does NOT call openOrderStore: that CREATEs tables and
// runs ALTERs, so it would mutate pending.db — a dry run must not.
function surveyReadOnly(balancesPath: string, pendingPath: string) {
  const bal = new Database(balancesPath, { readonly: true });
  const pend = new Database(pendingPath, { readonly: true });
  const hasTable = (db: Database, name: string): boolean =>
    db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(name)!.n > 0;

  const srcRows = hasTable(bal, "revenue") ? bal.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM revenue").get()!.n : 0;
  const srcGross = srcRows ? bal.query<{ g: number }, []>("SELECT COALESCE(SUM(gross_micros), 0) AS g FROM revenue").get()!.g : 0;
  const applied = hasTable(bal, "applied_orders") ? bal.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM applied_orders").get()!.n : 0;
  const dstRows = hasTable(pend, "revenue") ? pend.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM revenue").get()!.n : 0;

  bal.close();
  pend.close();
  return { srcRows, srcGross, applied, dstRows };
}

export function runMigrateRevenue(args: string[]): void {
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  const balancesPath = positional[0] ?? DB_PATH;
  const pendingPath = positional[1] ?? PENDING_DB_PATH;

  for (const p of [balancesPath, pendingPath]) {
    if (!existsSync(p)) {
      console.error(`nsk migrate-revenue: missing ${p}`);
      process.exit(1);
    }
  }

  const survey = surveyReadOnly(balancesPath, pendingPath);

  // Already migrated? Say so and stop. Re-running would throw inside migrateRevenue anyway, but a clear
  // message beats a stack trace on a box at 2am — and an operator re-running this is the common case.
  if (survey.dstRows > 0) {
    console.error(`nsk migrate-revenue: pending.db already holds ${survey.dstRows} revenue row(s) — already migrated. Nothing to do.`);
    process.exit(1);
  }

  console.log("");
  console.log("════════ REVENUE MIGRATION (balances.db → pending.db) ════════");
  console.log(`  balances : ${balancesPath}`);
  console.log(`  pending  : ${pendingPath}`);
  console.log(`  sales rows to copy       : ${survey.srcRows}   gross = ${usd(survey.srcGross)}`);
  console.log(`  outbox tombstones to seed: ${survey.applied}   (acked, never delivered — the double-book defense)`);

  if (!apply) {
    console.log("");
    console.log("DRY RUN — nothing was written. Re-run with --apply to migrate.");
    console.log("Stop the app first, and rehearse on copies of these files. See deploy/cutover-runbook.md.");
    console.log("");
    return;
  }

  const balancesDb = new Database(balancesPath); // read-only use — migrateRevenue only SELECTs from it
  const orders = openOrderStore(pendingPath);
  const { copied } = migrateRevenue(balancesDb, orders);
  const { seeded } = reconcileOutbox(balancesDb, orders);
  const dstRows = orders.listRevenue();
  const dstGross = dstRows.reduce((a, r) => a + r.gross_micros, 0);
  balancesDb.close();
  orders.db.close();

  // Reconcile counts AND gross before declaring success: a partial copy that silently drops rows would
  // understate the books forever, and the source table is left in place precisely so this can be checked.
  const ok = (b: boolean) => (b ? "✓" : "✗ MISMATCH");
  console.log("");
  console.log(`  copied     : ${copied}   ${ok(copied === survey.srcRows)}`);
  console.log(`  dest rows  : ${dstRows.length}   ${ok(dstRows.length === survey.srcRows)}`);
  console.log(`  dest gross : ${usd(dstGross)}   ${ok(dstGross === survey.srcGross)}`);
  console.log(`  tombstones : ${seeded}`);
  const pass = copied === survey.srcRows && dstRows.length === survey.srcRows && dstGross === survey.srcGross;
  console.log(pass ? "RESULT: ✓ revenue moved, counts + gross reconcile." : "RESULT: ✗ INVESTIGATE — a figure diverged.");
  console.log("");
  if (!pass) process.exit(1);
}
