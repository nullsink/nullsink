// The tokens table holds only a balance per token — no identity, no request history. (This DB also keeps
// the applied_orders idempotency ledger and a transient holds journal — see below.) We store the SHA-256
// of the token, never the token itself, so a DB leak yields no usable credentials. Balances are in
// MICRO-DOLLARS (see pricing.ts). WAL mode plus FULL synchronous commits make writes crash-safe.
import { openSqlite } from "./sqlite";

// hashToken lives in ./hash (pure, DB-free) so the metering/proxy path can hash a token without importing
// this balance store. Re-exported here for tests and the proxy composition root.
export { hashToken } from "./hash";

export type BeginSessionResult =
  | {
    outcome: "started" | "current";
    recoveredHolds: number;
    recoveredMicros: number;
  }
  | { outcome: "stale_session" };
export type SessionOpenHoldResult =
  | "opened"
  | "already_open"
  | "stale_session"
  | "conflict"
  | "invalid_amount"
  | "unknown_token"
  | "insufficient_balance";
export type SessionSettleHoldResult =
  | "settled"
  | "already_settled"
  | "stale_session"
  | "conflict"
  | "unknown_hold"
  | "invalid_charge";

// Build a balance store bound to one SQLite path. The proxy composition root calls openDb(DB_PATH); tests
// call openDb(":memory:") for an isolated store per case (prepared statements close over `db`, so each
// store is fully self-contained). Importing this module opens NOTHING — openDb() owns activation.
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

  // Compatibility bridge for the extraction release: old binaries ignore these nullable columns, while every
  // socket-backed hold populates them. This keeps pre-traffic rollback possible until activation is proven.
  const holdColumns = new Set(
    db.query<{ name: string }, []>("PRAGMA table_info(holds)").all().map((column) => column.name),
  );
  if (!holdColumns.has("session_id")) db.run("ALTER TABLE holds ADD COLUMN session_id TEXT");
  if (!holdColumns.has("opened_at")) db.run("ALTER TABLE holds ADD COLUMN opened_at INTEGER");

  // Exactly one current proxy boot session. A new session atomically refunds every hold left by the previous
  // one before becoming current; retrying the same session is a no-op and therefore cannot refund live work.
  db.run(`CREATE TABLE IF NOT EXISTS ledger_session (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  recovered_holds INTEGER NOT NULL DEFAULT 0,
  recovered_micros INTEGER NOT NULL DEFAULT 0
)`);
  const sessionColumns = new Set(
    db.query<{ name: string }, []>("PRAGMA table_info(ledger_session)").all().map((column) => column.name),
  );
  if (!sessionColumns.has("recovered_holds"))
    db.run("ALTER TABLE ledger_session ADD COLUMN recovered_holds INTEGER NOT NULL DEFAULT 0");
  if (!sessionColumns.has("recovered_micros"))
    db.run("ALTER TABLE ledger_session ADD COLUMN recovered_micros INTEGER NOT NULL DEFAULT 0");

  // A superseded proxy session must never become current again. Without this durable fence, a delayed
  // startSession retry from an old proxy could reclaim leadership and refund the real current proxy's live
  // holds. Proxy sessions change only at process startup, so retaining one UUID per retired process is tiny.
  db.run(`CREATE TABLE IF NOT EXISTS retired_ledger_sessions (
  session_id TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL
)`);

  // Settlement tombstones live only for the current session. They make a lost settle response replay-safe
  // without retaining token hashes: beginSession(new) deletes them after the old proxy can no longer issue
  // valid mutations.
  db.run(`CREATE TABLE IF NOT EXISTS settled_holds (
  hold_id       TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  charged_micros INTEGER NOT NULL,
  settled_at    INTEGER NOT NULL
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
  // silently drops low digits — unacceptable for a money figure. liabilityTotal() parses it to BigInt.
  // COUNT stays a number (a token count is never near that ceiling).
  const liabilityStmt = db.query<{ tokens: number; micros: string }, []>(
    "SELECT COUNT(*) AS tokens, CAST(COALESCE(SUM(balance), 0) AS TEXT) AS micros FROM tokens",
  );
  const insertHoldStmt = db.query(
    "INSERT INTO holds (hold_id, hash, micros) VALUES (?, ?, ?)",
  );
  const insertSessionHoldStmt = db.query(
    "INSERT INTO holds (hold_id, hash, micros, session_id, opened_at) VALUES (?, ?, ?, ?, ?)",
  );
  const getHoldStmt = db.query<{ hash: string; micros: number; session_id: string | null }, [string]>(
    "SELECT hash, micros, session_id FROM holds WHERE hold_id = ?",
  );
  const deleteHoldStmt = db.query("DELETE FROM holds WHERE hold_id = ?");
  const listHoldsStmt = db.query<{ hash: string; micros: number }, []>(
    "SELECT hash, micros FROM holds",
  );
  const clearHoldsStmt = db.query("DELETE FROM holds");
  const getSessionStmt = db.query<{
    session_id: string;
    started_at: number;
    recovered_holds: number;
    recovered_micros: number;
  }, []>(
    "SELECT session_id, started_at, recovered_holds, recovered_micros FROM ledger_session WHERE singleton = 1",
  );
  const setSessionStmt = db.query(
    "INSERT INTO ledger_session " +
      "(singleton, session_id, started_at, recovered_holds, recovered_micros) VALUES (1, ?, ?, ?, ?) " +
      "ON CONFLICT(singleton) DO UPDATE SET session_id = excluded.session_id, " +
      "started_at = excluded.started_at, recovered_holds = excluded.recovered_holds, " +
      "recovered_micros = excluded.recovered_micros",
  );
  const getRetiredSessionStmt = db.query<{ session_id: string }, [string]>(
    "SELECT session_id FROM retired_ledger_sessions WHERE session_id = ?",
  );
  const retireSessionStmt = db.query(
    "INSERT INTO retired_ledger_sessions (session_id, retired_at) VALUES (?, ?)",
  );
  const getSettledHoldStmt = db.query<{ session_id: string; charged_micros: number }, [string]>(
    "SELECT session_id, charged_micros FROM settled_holds WHERE hold_id = ?",
  );
  const insertSettledHoldStmt = db.query(
    "INSERT INTO settled_holds (hold_id, session_id, charged_micros, settled_at) VALUES (?, ?, ?, ?)",
  );
  const clearSettledHoldsStmt = db.query("DELETE FROM settled_holds");

  function getBalance(hash: string): number | null {
    return getStmt.get(hash)?.balance ?? null;
  }

  function currentSession(): string | null {
    return getSessionStmt.get()?.session_id ?? null;
  }

  // The startup barrier. Fencing the previous session, refunding its abandoned holds, clearing its replay
  // tombstones, and publishing the new current session are one SQLite transaction. The caller may admit
  // traffic only after this returns a definite result. A retired session is permanently stale: this prevents
  // a delayed ambiguous retry from reclaiming leadership after another proxy has already taken over.
  function beginSession(sessionId: string, atMs: number): BeginSessionResult {
    const apply = db.transaction(() => {
      const current = getSessionStmt.get();
      if (current?.session_id === sessionId)
        return {
          outcome: "current",
          recoveredHolds: current.recovered_holds,
          recoveredMicros: current.recovered_micros,
        } as const;
      if (getRetiredSessionStmt.get(sessionId)) return { outcome: "stale_session" } as const;
      const rows = listHoldsStmt.all();
      let recoveredMicros = 0;
      for (const row of rows) {
        creditStmt.run(row.hash, row.micros);
        recoveredMicros += row.micros;
      }
      clearHoldsStmt.run();
      clearSettledHoldsStmt.run();
      if (current) retireSessionStmt.run(current.session_id, atMs);
      setSessionStmt.run(sessionId, atMs, rows.length, recoveredMicros);
      return { outcome: "started", recoveredHolds: rows.length, recoveredMicros } as const;
    });
    return apply();
  }

  function getSessionBalance(sessionId: string, hash: string): { stale: true } | { stale: false; balance: number | null } {
    if (currentSession() !== sessionId) return { stale: true };
    return { stale: false, balance: getBalance(hash) };
  }

  // Add micros back for an unused hold or a newly settled payment. No caller passes a negative (over-cost is
  // clamped at the hold — handler.ts billActual — so there's no clawback path).
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

  // Replay-safe session hold. Checking an existing hold happens before debit: an exact duplicate is definite
  // success, while any payload mismatch is a conflict and never moves money.
  function openSessionHold(
    sessionId: string,
    hash: string,
    micros: number,
    holdId: string,
    atMs: number,
  ): SessionOpenHoldResult {
    const apply = db.transaction(() => {
      if (currentSession() !== sessionId) return "stale_session" as const;
      if (!Number.isSafeInteger(micros) || micros < 0) return "invalid_amount" as const;
      const existing = getHoldStmt.get(holdId);
      if (existing) {
        return existing.session_id === sessionId && existing.hash === hash && existing.micros === micros
          ? "already_open" as const
          : "conflict" as const;
      }
      if (getSettledHoldStmt.get(holdId)) return "conflict" as const;
      const balance = getStmt.get(hash)?.balance;
      if (balance === undefined) return "unknown_token" as const;
      if (balance < micros) return "insufficient_balance" as const;
      if (holdStmt.run(micros, hash, micros).changes !== 1)
        throw new Error(`balance changed during hold open: ${holdId}`);
      insertSessionHoldStmt.run(holdId, hash, micros, sessionId, atMs);
      return "opened" as const;
    });
    return apply();
  }

  // Close a hold idempotently. The caller supplies only the actual charge; the ledger loads the authoritative
  // token + reserved amount, validates the charge, computes the refund, and deletes the row in ONE transaction.
  // This is both safer today and the narrow Step-5 wire contract: a proxy can never name a different token or
  // ask the ledger to refund more than it reserved. A repeat finds no row and is a no-op, so a hold is settled
  // AT MOST once even when natural completion races shutdown drain.
  function settleHold(holdId: string, chargedMicros: number): boolean {
    const apply = db.transaction(() => {
      const hold = getHoldStmt.get(holdId);
      if (!hold) return false; // already settled / never opened
      if (!Number.isSafeInteger(chargedMicros) || chargedMicros < 0 || chargedMicros > hold.micros)
        throw new RangeError(`invalid hold charge: ${chargedMicros}`);
      if (deleteHoldStmt.run(holdId).changes !== 1) throw new Error(`hold disappeared during settlement: ${holdId}`);
      const refundMicros = hold.micros - chargedMicros;
      if (refundMicros > 0) creditStmt.run(hold.hash, refundMicros);
      return true;
    });
    return apply();
  }

  // Replay-safe session settlement. The durable tombstone is inserted in the SAME transaction as the refund
  // and hold deletion, so a response lost after commit can be retried to a definite already_settled outcome.
  function settleSessionHold(
    sessionId: string,
    holdId: string,
    chargedMicros: number,
    atMs: number,
  ): SessionSettleHoldResult {
    const apply = db.transaction(() => {
      if (currentSession() !== sessionId) return "stale_session" as const;
      const settled = getSettledHoldStmt.get(holdId);
      if (settled) {
        return settled.session_id === sessionId && settled.charged_micros === chargedMicros
          ? "already_settled" as const
          : "conflict" as const;
      }
      const hold = getHoldStmt.get(holdId);
      if (!hold) return "unknown_hold" as const;
      if (hold.session_id !== sessionId) return "conflict" as const;
      if (!Number.isSafeInteger(chargedMicros) || chargedMicros < 0 || chargedMicros > hold.micros)
        return "invalid_charge" as const;
      if (deleteHoldStmt.run(holdId).changes !== 1)
        throw new Error(`hold disappeared during session settlement: ${holdId}`);
      const refundMicros = hold.micros - chargedMicros;
      if (refundMicros > 0) creditStmt.run(hold.hash, refundMicros);
      insertSettledHoldStmt.run(holdId, sessionId, chargedMicros, atMs);
      return "settled" as const;
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

  return {
    db,
    getBalance,
    credit,
    creditOnce,
    openHold,
    settleHold,
    recoverHolds,
    liabilityTotal,
    currentSession,
    beginSession,
    getSessionBalance,
    openSessionHold,
    settleSessionHold,
  };
}

export type BalanceStore = ReturnType<typeof openDb>;

// Default on-disk path. The proxy composition root passes this to openDb(); no store is opened at import
// time. Callers construct and inject their own store instead.
export const DB_PATH = process.env.DB_PATH ?? "/var/lib/nullsink-proxy/balances.db";
