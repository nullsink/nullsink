// The tokens table holds only a balance per token — no identity, no request history. (This DB also keeps
// the applied_orders idempotency ledger and a transient holds journal — see below.) We store the SHA-256
// of the token, never the token itself, so a DB leak yields no usable credentials. Balances are in
// MICRO-DOLLARS (see pricing.ts). WAL mode lets the issuance CLIs write while the server reads, and is
// crash-safe.
import { openSqlite } from "./sqlite";

// hashToken lives in ./hash (pure, DB-free) so the metering/proxy path can hash a token without importing
// this balance store. Re-exported here for the CLIs + tests that already open this store anyway.
export { hashToken } from "./hash";

// Build a balance store bound to one SQLite path. Each composition root (or a CLI subcommand, post-guard)
// calls openDb(DB_PATH); tests call openDb(":memory:") for an isolated store per case (prepared statements
// close over `db`, so each store is fully self-contained). Importing this module opens NOTHING — the DB is
// opened only when openDb() is actually called.
export function openDb(path: string) {
  const db = openSqlite(path); // WAL + busy_timeout + synchronous=FULL — see sqlite.ts
  db.run(`CREATE TABLE IF NOT EXISTS tokens (
  hash    TEXT PRIMARY KEY,
  balance INTEGER NOT NULL
)`);

  // Idempotency guard for payment crediting. Records already-applied credits by the rail's opaque key, so an
  // outbox re-delivery (a sender retry after a crash before ack) or a poller re-scan can't double-credit. Holds
  // ONLY that key + timestamp (no token hash, no amount), so a balances.db leak reveals no payment↔token
  // linkage. NOT auto-purged: dropping a marker while a retry is still in flight would double-credit;
  // markers are kept forever — at ~50 bytes/marker that is cheap at any plausible volume.
  db.run(`CREATE TABLE IF NOT EXISTS applied_orders (
  order_id   TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`);

  // Crash-recovery journal for up-front holds. handler.ts debits the MAXIMUM a metered request could cost
  // before forwarding (the hold), then refunds down to the actual cost when the response settles. openHold
  // writes this row in the SAME transaction as that debit, and settleHold deletes it in the same transaction
  // as the refund — so a row exists IFF a hold is outstanding. A row therefore survives only when the process
  // dies (SIGKILL / OOM / power loss) between debit and settle; recoverHolds() refunds every survivor in full
  // at the next boot. Holds only the token hash (already in `tokens`) + reserved micros; transient (gone on
  // settle), so it adds no lasting identity surface beyond what `tokens` already holds.
  db.run(`CREATE TABLE IF NOT EXISTS holds (
  hold_id TEXT PRIMARY KEY,
  hash    TEXT NOT NULL,
  micros  INTEGER NOT NULL
)`);

  // The sales book (`revenue`) is PAYMENTS TRUST DOMAIN state and lives in pending.db (see ledger/orders.ts),
  // not here — so coin amounts, locked rates, and txid-derived keys never enter the proxy trust domain. settle()
  // books it in the outbox transaction; this store only credits balances.

  const getStmt = db.query<{ balance: number }, [string]>(
    "SELECT balance FROM tokens WHERE hash = ?",
  );
  // Atomic conditional debit: succeeds only if the balance covers the amount. The `balance >= ?` guard
  // is inside the UPDATE, so concurrent requests on one token can't both pass on a balance covering only
  // one — closing the overdraft race.
  const holdStmt = db.query(
    "UPDATE tokens SET balance = balance - ? WHERE hash = ? AND balance >= ?",
  );
  const creditStmt = db.query(
    "INSERT INTO tokens (hash, balance) VALUES (?, ?) " +
      "ON CONFLICT(hash) DO UPDATE SET balance = balance + excluded.balance",
  );
  const insertAppliedStmt = db.query(
    "INSERT OR IGNORE INTO applied_orders (order_id, applied_at) VALUES (?, ?)",
  );
  // CAST the SUM to TEXT so it returns as an exact decimal string, not a JS number: a going concern's lifetime
  // outstanding total crosses Number.MAX_SAFE_INTEGER at ~$9B of credit-micros, past which a number SUM
  // silently drops low digits — unacceptable for a money figure (cli/financials.ts renders this exactly).
  // liabilityTotal() parses it to BigInt. COUNT stays a number (a token count is never near that ceiling).
  const liabilityStmt = db.query<{ tokens: number; micros: string }, []>(
    "SELECT COUNT(*) AS tokens, CAST(COALESCE(SUM(balance), 0) AS TEXT) AS micros FROM tokens",
  );
  const listBalancesStmt = db.query<{ hash: string; balance: number }, []>(
    "SELECT hash, balance FROM tokens ORDER BY balance DESC, hash ASC",
  );
  const insertHoldStmt = db.query(
    "INSERT INTO holds (hold_id, hash, micros) VALUES (?, ?, ?)",
  );
  const deleteHoldStmt = db.query("DELETE FROM holds WHERE hold_id = ?");
  const listHoldsStmt = db.query<{ hash: string; micros: number }, []>(
    "SELECT hash, micros FROM holds",
  );
  const clearHoldsStmt = db.query("DELETE FROM holds");

  function getBalance(hash: string): number | null {
    return getStmt.get(hash)?.balance ?? null;
  }

  // Add micros back: refunds the unused hold, funds tokens (issue.ts / topup.ts). No caller passes a
  // negative (over-cost is clamped at the hold — handler.ts billActual — so there's no clawback path).
  function credit(hash: string, micros: number): void {
    creditStmt.run(hash, micros);
  }

  // Credit `micros` to `hash` exactly once per idempotency key `orderId` (the rail's opaque key). The
  // applied-orders insert and balance credit run in ONE transaction (same DB, atomic even under WAL), making
  // a repeated apply of the same deposit (a poller re-scan, or an outbox re-delivery from the sender) a no-op.
  // Returns true if this call applied the credit, false if `orderId` was already applied — BOTH mean the credit
  // is durably in the ledger (the sender acks on either). Revenue books payment-side (ledger/orders.ts), in
  // the outbox transaction, so this never touches the sales book.
  function creditOnce(hash: string, micros: number, orderId: string, atMs: number): boolean {
    const apply = db.transaction(() => {
      if (insertAppliedStmt.run(orderId, atMs).changes === 0) return false; // already credited
      creditStmt.run(hash, micros);
      return true;
    });
    return apply();
  }

  // Open a hold: debit `micros` AND journal it under `holdId`, in ONE transaction (same DB, atomic under
  // WAL), so the journal row is durable iff the debit happened. Returns true if the balance covered it
  // (debited + journaled); false (and nothing written) if the token is unknown or short. The row lets
  // recoverHolds() refund a hold whose request died before settling.
  function openHold(hash: string, micros: number, holdId: string): boolean {
    const apply = db.transaction(() => {
      if (holdStmt.run(micros, hash, micros).changes === 0) return false; // unknown token / insufficient
      insertHoldStmt.run(holdId, hash, micros);
      return true;
    });
    return apply();
  }

  // Close a hold idempotently: delete its journal row and, IF the row existed, refund `refundMicros` to
  // `hash` — both in one transaction. Returns true iff this call closed the hold. The delete IS the
  // idempotency guard: a repeat (the shutdown drain racing the natural settle, or any double-call) finds no
  // row and is a no-op, so a hold is refunded AT MOST once. The caller computes the refund (hold − actual
  // cost, clamped to [0, hold]; see handler.ts billActual).
  function settleHold(holdId: string, hash: string, refundMicros: number): boolean {
    const apply = db.transaction(() => {
      if (deleteHoldStmt.run(holdId).changes === 0) return false; // already settled / never opened
      if (refundMicros > 0) creditStmt.run(hash, refundMicros);
      return true;
    });
    return apply();
  }

  // Boot recovery: refund every open hold IN FULL and clear the journal, in one transaction; returns
  // {count, micros} for a one-line startup log. Call ONCE at startup, before serving — on a fresh boot there
  // are no live requests, so any surviving row is a hold stranded by an ungraceful death (SIGKILL / OOM /
  // power loss) between openHold() and settleHold(), and its request produced no billed response, so a full
  // refund is exact. Idempotent: a second call finds an empty table and returns {count: 0, micros: 0}.
  function recoverHolds(): { count: number; micros: number } {
    const apply = db.transaction(() => {
      const rows = listHoldsStmt.all();
      let micros = 0;
      for (const row of rows) {
        creditStmt.run(row.hash, row.micros);
        micros += row.micros;
      }
      clearHoldsStmt.run();
      return { count: rows.length, micros };
    });
    return apply();
  }

  // Outstanding prepaid credit across all tokens = the deferred-revenue liability (money owed in service).
  // `micros` is exact BigInt (the SUM is CAST to TEXT to dodge the number ceiling; see liabilityStmt);
  // `tokens` is a plain count. COUNT always returns a row, so the ?? is just a total-safety floor.
  function liabilityTotal(): { tokens: number; micros: bigint } {
    const row = liabilityStmt.get();
    return { tokens: row?.tokens ?? 0, micros: BigInt(row?.micros ?? "0") };
  }

  // Every token's (hash, micro-dollar balance), biggest balance first — the per-token view of outstanding
  // credit, for cli/balances.ts. Returns the stored SHA-256 hash, NEVER the token (only the hash is on disk;
  // see the file header), so it holds no usable credential and no identity — same privacy class as the tokens
  // table itself. Its sum is exactly liabilityTotal().micros, so the per-token listing and the aggregate
  // reconcile by construction.
  function listBalances(): { hash: string; balance: number }[] {
    return listBalancesStmt.all();
  }

  return { db, getBalance, credit, creditOnce, openHold, settleHold, recoverHolds, liabilityTotal, listBalances };
}

export type BalanceStore = ReturnType<typeof openDb>;

// Default on-disk path. The composition root (src/proxy.ts) and each nsk subcommand pass this to openDb();
// no store is opened at import time — a module-load singleton would reunify the two DBs across the process
// boundary (the proxy would open pending.db and payments would open balances.db just by importing a shared
// module). Callers construct + inject their own store instead.
export const DB_PATH = process.env.DB_PATH ?? "/var/lib/nullsink/balances.db";
