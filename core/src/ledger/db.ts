// The tokens table holds only a balance per token — no identity, no request history. (This DB also keeps
// the applied_orders idempotency ledger and a transient holds journal — see below.) We store the SHA-256
// of the token, never the token itself, so a DB leak yields no usable credentials. Balances are in
// MICRO-DOLLARS (see pricing.ts). WAL mode lets the issuance CLIs write while the server reads, and is
// crash-safe.
import { openSqlite } from "./sqlite";

// sha256(token) as lowercase hex. The token is a bearer secret; only its hash ever touches disk. Pure
// (no DB) so it stays a free function.
export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

// Build a balance store bound to one SQLite path. Prod uses the singleton below; tests call
// openDb(":memory:") for an isolated store per case (prepared statements close over `db`, so each store
// is fully self-contained).
export function openDb(path: string) {
  const db = openSqlite(path); // WAL + busy_timeout + synchronous=FULL — see sqlite.ts
  db.run(`CREATE TABLE IF NOT EXISTS tokens (
  hash    TEXT PRIMARY KEY,
  balance INTEGER NOT NULL
)`);

  // Idempotency guard for payment crediting. Records already-credited deposits by the rail's opaque key, so
  // a crash between credit() and clearing the pending order can't double-credit when the poller re-scans the
  // same deposit. Holds ONLY that key + timestamp (no token hash, no amount), so a balances.db leak reveals
  // no payment↔token linkage. Bounded by purgeApplied() at the order backstop horizon.
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

  // Append-only sales book, for accounting / revenue recognition (cli/financials.ts reads it). One row per
  // credited payment: WHEN, which coin (`asset`) and how much of it landed (`asset_atomic`, with `scale` =
  // its atomic-units-per-whole, so the books render each coin exactly and stay self-contained), and how
  // much USD credit we issued for it. Holds NO token hash, NO address, NO identity — same privacy class as
  // the tokens table (a "$X sale at time T", not a request log). Written inside creditOnce's transaction so
  // it can't drift from the credit. Never purged (books are kept); it grows one row per sale, negligible.
  // Schema note: `asset`/`scale` (+ the `asset_atomic` rename) arrived with the rail seam. DO NOT delete +
  // rebuild balances.db — it holds LIVE token balances and the sales journal; the in-place migration below
  // ALTERs an older table instead. (tokens + applied_orders are schema-unchanged across the seam — they
  // need no migration.)
  db.run(`CREATE TABLE IF NOT EXISTS revenue (
  id           INTEGER PRIMARY KEY,
  at           INTEGER NOT NULL,
  asset        TEXT NOT NULL DEFAULT 'monero',
  asset_atomic INTEGER NOT NULL,
  scale        INTEGER NOT NULL DEFAULT 1000000000000,
  usd_micros   INTEGER NOT NULL,
  gross_micros INTEGER NOT NULL DEFAULT 0
)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_revenue_at ON revenue (at)`);

  // In-place migration from the pre-seam revenue schema (`xmr_atomic`, no `asset`/`scale`). Column-guarded →
  // idempotent. Existing rows ARE Monero sales, so the rename + the column defaults ('monero', 1e12) leave
  // the historical sales journal exactly correct. MUST run before the statements below (they reference the
  // new columns), and with the service STOPPED so the ALTER doesn't race a settle writing a revenue row.
  const rcols = db.query<{ name: string }, []>("PRAGMA table_info(revenue)").all();
  const rhave = new Set(rcols.map((c) => c.name));
  if (rhave.has("xmr_atomic") && !rhave.has("asset_atomic"))
    db.run("ALTER TABLE revenue RENAME COLUMN xmr_atomic TO asset_atomic");
  if (!rhave.has("asset")) db.run("ALTER TABLE revenue ADD COLUMN asset TEXT NOT NULL DEFAULT 'monero'");
  if (!rhave.has("scale")) db.run("ALTER TABLE revenue ADD COLUMN scale INTEGER NOT NULL DEFAULT 1000000000000");

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
  const purgeAppliedStmt = db.query("DELETE FROM applied_orders WHERE applied_at < ?");
  const recordRevenueStmt = db.query(
    "INSERT INTO revenue (at, asset, asset_atomic, scale, usd_micros, gross_micros) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const listRevenueStmt = db.query<{ at: number; asset: string; asset_atomic: number; scale: number; usd_micros: number; gross_micros: number }, [number, number]>(
    "SELECT at, asset, asset_atomic, scale, usd_micros, gross_micros FROM revenue WHERE at >= ? AND at < ? ORDER BY at ASC",
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

  // Try to debit `micros`. Returns true if the balance covered it (and was
  // debited), false if the token is unknown or had insufficient balance.
  function hold(hash: string, micros: number): boolean {
    return holdStmt.run(micros, hash, micros).changes > 0;
  }

  // Add micros back: refunds the unused hold, funds tokens (issue.ts / topup.ts). No caller passes a
  // negative (over-cost is clamped at the hold — handler.ts billActual — so there's no clawback path).
  function credit(hash: string, micros: number): void {
    creditStmt.run(hash, micros);
  }

  // Credit `micros` to `hash` exactly once per idempotency key `orderId` (the rail's opaque key). The
  // applied-orders insert and balance credit run in ONE transaction (same DB, atomic even under WAL), making
  // a repeated settle of the same deposit (poller re-scan) a no-op. Returns true if this call applied the
  // credit. When `revenue` is given, a revenue row is recorded in the SAME transaction — so a sale is booked
  // iff the credit lands, and a re-scan (blocked by the applied_orders guard) can't double-count revenue
  // either. See the revenue table / settle.ts for the revenue field meanings.
  function creditOnce(
    hash: string,
    micros: number,
    orderId: string,
    atMs: number,
    revenue?: { asset: string; assetAtomic: number; scale: number; grossMicros: number },
  ): boolean {
    const apply = db.transaction(() => {
      if (insertAppliedStmt.run(orderId, atMs).changes === 0) return false; // already credited
      creditStmt.run(hash, micros);
      if (revenue != null) recordRevenueStmt.run(atMs, revenue.asset, revenue.assetAtomic, revenue.scale, micros, revenue.grossMicros);
      return true;
    });
    return apply();
  }

  // Open a hold: debit `micros` AND journal it under `holdId`, in ONE transaction (same DB, atomic under
  // WAL), so the journal row is durable iff the debit happened. Returns true if the balance covered it
  // (debited + journaled); false (and nothing written) if the token is unknown or short. The row lets
  // recoverHolds() refund a hold whose request died before settling. Replaces the bare hold() on the metered
  // path; hold() stays for the issuance CLIs and tests that gate without journaling.
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

  // Drop applied markers older than `beforeMs`. Pending orders are reaped at the same backstop horizon
  // and can't be re-polled after, so their idempotency markers are then safe to forget.
  function purgeApplied(beforeMs: number): void {
    purgeAppliedStmt.run(beforeMs);
  }

  // Sales book rows in [fromMs, toMs) (default: everything). For cli/financials.ts. `usd_micros` is the
  // credit issued (the deferred-revenue liability created); `gross_micros` is the USD paid, valued at the
  // order's locked rate — exact and independent of any later MARGIN change.
  function listRevenue(
    fromMs = 0,
    toMs = Number.MAX_SAFE_INTEGER,
  ): { at: number; asset: string; asset_atomic: number; scale: number; usd_micros: number; gross_micros: number }[] {
    return listRevenueStmt.all(fromMs, toMs);
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

  return { db, getBalance, hold, credit, creditOnce, openHold, settleHold, recoverHolds, purgeApplied, listRevenue, liabilityTotal, listBalances };
}

export type BalanceStore = ReturnType<typeof openDb>;

const DB_PATH = process.env.DB_PATH ?? "/var/lib/nullsink/balances.db";

// Prod singleton. index.ts consumes `balances` as a whole store for the handler/poller; re-exporting its
// methods as named bindings preserves the original import surface (`import { hold, credit, ... }`) for
// the CLIs, so no call sites change.
export const balances = openDb(DB_PATH);
export const { getBalance, hold, credit, creditOnce, openHold, settleHold, recoverHolds, purgeApplied, listRevenue, liabilityTotal, listBalances } = balances;
