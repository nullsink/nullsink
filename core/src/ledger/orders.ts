// Pending orders: the transient map from a per-order receive address — identified by the rail's integer
// index (Monero subaddress minor index / Bitcoin HD derivation index) — to the token hash it funds, plus
// the expected coin amount and USD credit, and the address itself (the rail watches it; the buyer pays it).
//
// The ONLY place the payment↔token link lives, so it's deliberately a SEPARATE database from balances.db —
// a balances.db leak must never reveal who funded which token. While in-flight the index→hash link is
// money-critical and irreplaceable (the chain shows a payment to an address, not our token hash), so this
// DB is durable (WAL, systemd StateDirectory) and belongs in backups. The link is dropped the moment an
// order settles — under pay-once its FIRST confirmed payment (settle.ts) — or when it's reaped.
//
// Crediting is exactly-once via creditOnce() in db.ts, keyed by the rail's opaque idempotencyKey (Monero
// "txid:minor", Bitcoin "txid:orderIndex") — NOT a txid alone, since one tx can pay two of our addresses.
import { openSqlite } from "./sqlite";

export type PendingOrder = {
  rail: string; // the pay rail that owns this order ("monero" | "bitcoin" | …) — half of the composite PK
  order_index: number; // the rail's per-order index (Monero subaddress minor / Bitcoin HD derivation index)
  address: string; // the pay-to address for this order — shown to the buyer; the rail watches it
  hash: string;
  expected_atomic: number; // coin atomic units (PayRail.scale per whole coin) for credit_usd × MARGIN
  credit_micros: number; // USD credit for the full expected amount
  received_atomic: number; // retained for row shape; vestigial under pay-once (closes on first payment)
  created_at: number; // unix ms
  rate_usd: number; // coin/USD rate LOCKED at quote time — so settle can book gross (USD paid) from the
  // rate in force then, making the revenue book's gross figure independent of any later MARGIN change.
};

// Build a pending-orders store bound to one SQLite path. The composition root calls openOrderStore(path);
// tests call openOrderStore(":memory:") for an isolated store per case (prepared statements close over
// `db`). Importing this module opens nothing.
export function openOrderStore(path: string) {
  // synchronous=FULL matters doubly here: this store holds the IRREPLACEABLE payment↔token link (the
  // deposit is on-chain; a lost row = a paid user we can never credit). See sqlite.ts for the shared PRAGMAs.
  const db = openSqlite(path);
  db.run(`CREATE TABLE IF NOT EXISTS pending_orders (
  rail            TEXT NOT NULL DEFAULT 'monero',
  order_index     INTEGER NOT NULL,
  address         TEXT NOT NULL,
  hash            TEXT NOT NULL,
  expected_atomic INTEGER NOT NULL,
  credit_micros   INTEGER NOT NULL,
  received_atomic INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  rate_usd        REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (rail, order_index)
)`);

  // In-place migration from the pre-seam schema (integer `subaddr_index` PK, no `address`). DO NOT delete +
  // rebuild pending.db — it holds LIVE, irreplaceable payment↔token links for paid-but-unconfirmed orders
  // (a dropped row = a paid user we can never credit). The CREATE above is a no-op when an old table exists,
  // so detect its columns and ALTER. Column-guarded → idempotent (a no-op on an already-migrated DB).
  // `address` back-fills to '' for migrated Monero orders, which is correct: settlement matches on
  // order_index, never the address (the Monero rail's incomingTransfers takes the index). Run with the
  // service STOPPED so the ALTER takes the write lock without racing the poller.
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(pending_orders)").all();
  const have = new Set(cols.map((c) => c.name));
  if (have.has("subaddr_index") && !have.has("order_index"))
    db.run("ALTER TABLE pending_orders RENAME COLUMN subaddr_index TO order_index");
  if (!have.has("address")) db.run("ALTER TABLE pending_orders ADD COLUMN address TEXT NOT NULL DEFAULT ''");

  // Composite-PK migration for multi-rail. The pre-multi-rail table keyed on `order_index` ALONE, but two
  // rails allocate that integer independently (Monero subaddress minor vs Bitcoin HD index), so concurrently
  // they collide on the PK. Re-key to PRIMARY KEY (rail, order_index). SQLite can't ALTER a PK, so rebuild —
  // existing rows are all Monero, so they back-fill rail='monero' and keep their index (and keep settling).
  // Runs AFTER the seam migration above (it needs order_index/address to exist) and BEFORE the statements
  // below (they bind to the final table); guarded on the absence of `rail` → idempotent; wrapped in ONE
  // transaction so a crash mid-rebuild rolls back rather than losing the table.
  if (!db.query<{ name: string }, []>("PRAGMA table_info(pending_orders)").all().some((c) => c.name === "rail")) {
    db.transaction(() => {
      db.run(`CREATE TABLE pending_orders_new (
  rail            TEXT NOT NULL DEFAULT 'monero',
  order_index     INTEGER NOT NULL,
  address         TEXT NOT NULL,
  hash            TEXT NOT NULL,
  expected_atomic INTEGER NOT NULL,
  credit_micros   INTEGER NOT NULL,
  received_atomic INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  rate_usd        REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (rail, order_index)
)`);
      db.run(
        "INSERT INTO pending_orders_new (rail, order_index, address, hash, expected_atomic, credit_micros, received_atomic, created_at, rate_usd) " +
          "SELECT 'monero', order_index, address, hash, expected_atomic, credit_micros, received_atomic, created_at, rate_usd FROM pending_orders",
      );
      db.run("DROP TABLE pending_orders");
      db.run("ALTER TABLE pending_orders_new RENAME TO pending_orders");
    })();
  }

  // A token's hash can have an open order (the /order-status + balance-page-resume lookup path). One
  // hash → at most a few in-flight orders, but the table is keyed by order_index, so index the hash for
  // that reverse lookup. Cheap on a table bounded by MAX_OPEN_ORDERS.
  db.run(`CREATE INDEX IF NOT EXISTS idx_pending_hash ON pending_orders (hash)`);

  // --- Stage-2 payment→prompt-world crossing (D3) + the sales book (D5) — both PAYMENT-world state, so they
  //     live here in pending.db and never in the prompt world's balances.db. ---

  // credit_outbox: the durable, exactly-once credit hand-off. settle() writes a row here in the SAME
  // transaction that closes the order; a sender drains unacked rows into the balance ledger's creditOnce
  // (in-process today; a peer-authed unix socket once the proxy splits out). Keyed by the rail's opaque
  // idempotency_key — the very key creditOnce dedupes on — so a redelivery is a no-op at the receiver. acked_at
  // stays NULL until the credit lands; the partial index keeps the sender's "what's unsent" scan O(unacked).
  db.run(`CREATE TABLE IF NOT EXISTS credit_outbox (
  idempotency_key TEXT PRIMARY KEY,
  hash            TEXT NOT NULL,
  micros          INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  acked_at        INTEGER
)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_outbox_unacked ON credit_outbox (created_at) WHERE acked_at IS NULL`);

  // revenue: append-only sales book (cli/financials.ts data source). One row per credited payment: WHEN, the
  // coin (`asset` + `scale` = atomic-units-per-whole) and how much of it landed (`asset_atomic`), and the USD
  // credit issued. Holds NO token hash / address / identity — a "$X sale at time T", not a request log. D5
  // moves it OFF balances.db to here so coin amounts, locked rates, and txid-derived keys stay out of the prompt
  // world; settle() writes it in the outbox transaction (booked iff a credit is enqueued). Schema matches the
  // pre-split balances.db revenue table byte-for-byte, so the one-time cross-DB copy at cutover is a plain move.
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

  // Atomic slot-claiming insert: the row lands ONLY if the open-order count is still under `maxOpen`,
  // evaluated inside the same statement. WAL serializes writers, so two concurrent claims run one-at-a-
  // time and the second sees the first's committed row in its COUNT — closing the openCount()→addOrder
  // TOCTOU a bare check-then-insert leaves open across the rate/wallet awaits. The COUNT spans ALL rails:
  // MAX_OPEN_ORDERS is a deliberately GLOBAL cap (a shared DoS bound), not per-rail.
  const tryInsertStmt = db.query(
    "INSERT INTO pending_orders (rail, order_index, address, hash, expected_atomic, credit_micros, received_atomic, created_at, rate_usd) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM pending_orders) < ?",
  );
  const openStmt = db.query<PendingOrder, []>("SELECT * FROM pending_orders");
  const openByRailStmt = db.query<PendingOrder, [string]>("SELECT * FROM pending_orders WHERE rail = ?");
  const byHashStmt = db.query<PendingOrder, [string]>(
    "SELECT * FROM pending_orders WHERE hash = ? ORDER BY created_at DESC LIMIT 1",
  );
  const countStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pending_orders");
  const deleteStmt = db.query("DELETE FROM pending_orders WHERE rail = ? AND order_index = ?");
  const purgeStmt = db.query("DELETE FROM pending_orders WHERE created_at < ?");
  const purgeByRailStmt = db.query("DELETE FROM pending_orders WHERE created_at < ? AND rail = ?");
  const enqueueCreditStmt = db.query(
    "INSERT OR IGNORE INTO credit_outbox (idempotency_key, hash, micros, created_at) VALUES (?, ?, ?, ?)",
  );
  const listUnackedCreditsStmt = db.query<{ idempotency_key: string; hash: string; micros: number }, []>(
    "SELECT idempotency_key, hash, micros FROM credit_outbox WHERE acked_at IS NULL ORDER BY created_at ASC",
  );
  const ackCreditStmt = db.query("UPDATE credit_outbox SET acked_at = ? WHERE idempotency_key = ?");
  // Served by the partial index (created_at WHERE acked_at IS NULL), so it stays O(1)-ish as the book grows.
  const oldestUnackedStmt = db.query<{ at: number }, []>(
    "SELECT created_at AS at FROM credit_outbox WHERE acked_at IS NULL ORDER BY created_at ASC LIMIT 1",
  );
  const recordRevenueStmt = db.query(
    "INSERT INTO revenue (at, asset, asset_atomic, scale, usd_micros, gross_micros) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const listRevenueStmt = db.query<{ at: number; asset: string; asset_atomic: number; scale: number; usd_micros: number; gross_micros: number }, [number, number]>(
    "SELECT at, asset, asset_atomic, scale, usd_micros, gross_micros FROM revenue WHERE at >= ? AND at < ? ORDER BY at ASC",
  );

  // Atomically claim an open-order slot and record the order, ONLY if fewer than `maxOpen` are currently
  // open. Returns true if stored, false if the ceiling was already reached (caller rejects with
  // busy_try_later). The authoritative, race-free cap gate; the handler's cheap openCount() pre-check
  // only sheds the bulk before the wallet round-trip.
  function tryAddOrder(o: PendingOrder, maxOpen: number): boolean {
    return (
      tryInsertStmt.run(o.rail, o.order_index, o.address, o.hash, o.expected_atomic, o.credit_micros, o.received_atomic, o.created_at, o.rate_usd, maxOpen)
        .changes > 0
    );
  }

  // Every in-flight order, optionally scoped to one rail. Settled orders are deleted (pay-once), so all
  // present rows are still awaiting payment. The concurrent poller calls openOrders(rail) so a rail only
  // ever sees — and settles/reaps — its own orders; an un-scoped call returns every rail's orders.
  function openOrders(rail?: string): PendingOrder[] {
    return rail === undefined ? openStmt.all() : openByRailStmt.all(rail);
  }

  function openCount(): number {
    return countStmt.get()?.n ?? 0;
  }

  // The most-recent still-open order for a token hash, or null. Powers /order-status (show this order's
  // confirmation progress) — read-only and privacy-safe: the hash already crossed the wire to /buy, and
  // the row is dropped at settle, so a closed/never-existed order is indistinguishable (returns null).
  function latestOpenOrderByHash(hash: string): PendingOrder | null {
    return byHashStmt.get(hash) ?? null;
  }

  // Drop an order's row — on its first confirmed payment (pay-once) or a reap. Also drops the index→hash
  // link. Composite-keyed: deletes ONLY (rail, orderIndex), never the other rail's row at the same index.
  // `rail` defaults to 'monero' so legacy single-rail callers (and the migration test) stay correct without
  // passing it; settle passes the real rail explicitly. Returns whether a row was deleted.
  function removeOrder(orderIndex: number, rail: string = "monero"): boolean {
    return deleteStmt.run(rail, orderIndex).changes > 0;
  }

  // Bulk-reap orders created before `beforeMs`, optionally scoped to one rail (so a rail's backstop tick
  // can't reap the other rail's rows) — settle() uses this for the absolute backstop horizon
  // (ORDER_BACKSTOP_MS). Past the horizon we stop watching the address, so a late payment won't auto-credit.
  function purgeStale(beforeMs: number, rail?: string): void {
    if (rail === undefined) purgeStmt.run(beforeMs);
    else purgeByRailStmt.run(beforeMs, rail);
  }

  // --- credit_outbox + revenue accessors (see the table definitions above). ---

  // Enqueue a credit for delivery to the balance ledger. INSERT OR IGNORE keyed on idempotency_key: a repeat
  // (a re-scan of the same deposit, or a settle re-run) is a no-op and — crucially — never THROWS, so it can't
  // roll back the enclosing settle transaction and wedge the order open. Returns true iff a NEW row was
  // enqueued, so the caller books revenue only then ("booked iff a credit is requested").
  function enqueueCredit(key: string, hash: string, micros: number, atMs: number): boolean {
    return enqueueCreditStmt.run(key, hash, micros, atMs).changes > 0;
  }

  // Unacked outbox rows, oldest first — the sender's work list (each drained into creditOnce, then ackCredit'd).
  function listUnackedCredits(): { idempotency_key: string; hash: string; micros: number }[] {
    return listUnackedCreditsStmt.all();
  }

  // Mark a credit delivered (the receiver returned applied / already_applied). Idempotent; a re-ack is harmless.
  function ackCredit(key: string, atMs: number): void {
    ackCreditStmt.run(atMs, key);
  }

  // created_at of the OLDEST undelivered credit, or null when the outbox is drained. The health signal for the
  // crossing: two /healthz probes can't see a wedged credit socket or a stalled sender, but credits piling up
  // here can — the payments root alerts on this age.
  function oldestUnackedCreditAt(): number | null {
    return oldestUnackedStmt.get()?.at ?? null;
  }

  // Book a sale (see the revenue table). settle() calls this inside the same transaction as the outbox enqueue.
  function recordRevenue(atMs: number, asset: string, assetAtomic: number, scale: number, usdMicros: number, grossMicros: number): void {
    recordRevenueStmt.run(atMs, asset, assetAtomic, scale, usdMicros, grossMicros);
  }

  // Sales rows in [fromMs, toMs) (default: everything). For cli/financials.ts, now a pending.db reader (D5).
  function listRevenue(fromMs = 0, toMs = Number.MAX_SAFE_INTEGER): { at: number; asset: string; asset_atomic: number; scale: number; usd_micros: number; gross_micros: number }[] {
    return listRevenueStmt.all(fromMs, toMs);
  }

  // The settle path, as ONE atomic pending.db transaction: enqueue the credit (INSERT OR IGNORE — idempotent
  // per key, never throws so it can't roll the txn back), book revenue IFF the enqueue was NEW ("booked iff a
  // credit is requested" — mirrors the old creditOnce guard, so a re-processed key can't double-count), and
  // close the order. The whole money-critical step is a single write on ONE database — the two-DB credit→remove
  // window the old zombie handling guarded against is gone. removeOrder runs unconditionally (pay-once close;
  // also cleans up a would-be zombie). Synchronous, so settle keeps its no-await invariant.
  function commitSettlement(
    key: string,
    hash: string,
    micros: number,
    atMs: number,
    revenue: { asset: string; assetAtomic: number; scale: number; grossMicros: number },
    orderIndex: number,
    rail: string,
  ): void {
    const apply = db.transaction(() => {
      const fresh = enqueueCreditStmt.run(key, hash, micros, atMs).changes > 0;
      if (fresh) recordRevenueStmt.run(atMs, revenue.asset, revenue.assetAtomic, revenue.scale, micros, revenue.grossMicros);
      deleteStmt.run(rail, orderIndex);
    });
    apply();
  }

  return {
    db, tryAddOrder, openOrders, openCount, latestOpenOrderByHash, removeOrder, purgeStale,
    enqueueCredit, listUnackedCredits, ackCredit, oldestUnackedCreditAt, recordRevenue, listRevenue, commitSettlement,
  };
}

export type OrdersStore = ReturnType<typeof openOrderStore>;

// Default on-disk path (pending.db beside balances.db, or PENDING_DB_PATH). The composition root
// (src/index.ts) and `nsk orders` pass this to openOrderStore(); nothing opens at import time — see the
// note in ledger/db.ts on why the stage-2 split forbids a module-load singleton.
export const PENDING_DB_PATH = process.env.PENDING_DB_PATH ?? defaultPendingPath();

function defaultPendingPath(): string {
  const balances = process.env.DB_PATH ?? "/var/lib/nullsink/balances.db";
  const slash = balances.lastIndexOf("/");
  return slash === -1 ? "pending.db" : balances.slice(0, slash + 1) + "pending.db";
}
