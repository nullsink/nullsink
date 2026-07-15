// Pending orders: the transient map from a per-order receive address — identified by the rail's integer
// index (Monero subaddress minor index / Bitcoin HD derivation index) — to the token hash it funds, plus
// the expected coin amount and USD credit, and the address itself (the rail watches it; the buyer pays it).
//
// The payment↔token link lives only in this SEPARATE database from balances.db — a balances.db leak must
// never reveal who funded which token. While an order is open, its index→hash link is money-critical and
// irreplaceable (the chain shows a payment to an address, not our token hash), so this DB is durable (WAL,
// systemd StateDirectory) and belongs in backups. Settlement moves the link into the durable credit outbox;
// a definite delivery ack tombstones it. An unpaid reap drops it immediately.
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
  seen_at: number | null; // unix ms the rail FIRST reported any inbound for this order (final or not), else
  // NULL. Durable "someone is paying this" memory: it is what spares the order from the unfunded fast-reap,
  // across process restarts. See settle.ts.
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
  seen_at         INTEGER,
  PRIMARY KEY (rail, order_index)
)`);

  // A token's hash can have an open order (the /order-status + balance-page-resume lookup path). One
  // hash → at most a few in-flight orders, but the table is keyed by order_index, so index the hash for
  // that reverse lookup. Cheap on a table bounded by MAX_OPEN_ORDERS.
  db.run(`CREATE INDEX IF NOT EXISTS idx_pending_hash ON pending_orders (hash)`);

  // --- The payment→prompt-world credit crossing + the sales book — both PAYMENT-world state, so they
  //     live here in pending.db and never in the prompt world's balances.db. ---

  // credit_outbox: the durable, exactly-once credit hand-off. settle() writes a row here in the SAME
  // transaction that closes the order; the sender (credit-sender.ts) drains unacked rows into the balance
  // ledger's creditOnce over the owner-only unix socket. Keyed by the rail's opaque
  // idempotency_key — the very key creditOnce dedupes on — so a redelivery is a no-op at the receiver. acked_at
  // stays NULL until the credit lands. A definite ack atomically replaces hash/micros with an unlinkable-to-
  // token tombstone while retaining the transaction-derived key for idempotency; partial indexes stay live-only.
  db.run(`CREATE TABLE IF NOT EXISTS credit_outbox (
  idempotency_key TEXT PRIMARY KEY,
  hash            TEXT NOT NULL,
  micros          INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  acked_at        INTEGER
)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_outbox_unacked ON credit_outbox (created_at) WHERE acked_at IS NULL`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_outbox_unacked_hash ON credit_outbox (hash) WHERE acked_at IS NULL`);
  // revenue: append-only sales book (cli/financials.ts data source). One row per credited payment: WHEN, the
  // coin (`asset` + `scale` = atomic-units-per-whole) and how much of it landed (`asset_atomic`), and the USD
  // credit issued. Holds NO token hash / address / identity — a "$X sale at time T", not a request log. It
  // lives here rather than in balances.db so coin amounts, locked rates, and txid-derived keys stay out of
  // the prompt world; settle() writes it in the outbox transaction (booked iff a credit is enqueued).
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

  // Atomic slot + hash claim: the row lands only if the global open-order count is under `maxOpen` AND no
  // live order OR undelivered credit already owns this token hash. WAL serializes writers, so concurrent
  // processes see each other's committed claim. The outbox predicate closes the race where another process
  // settles the preceding order between the handler's early lookup and this insert. Do not enforce this with
  // a UNIQUE migration: older databases may legitimately contain duplicate hashes, and refusing to open that
  // money-critical state would be worse than preserving it while blocking new duplicates.
  const tryInsertStmt = db.query(
    "INSERT INTO pending_orders (rail, order_index, address, hash, expected_atomic, credit_micros, received_atomic, created_at, rate_usd) " +
      "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM pending_orders) < ? " +
      "AND NOT EXISTS (SELECT 1 FROM pending_orders WHERE hash = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM credit_outbox WHERE hash = ? AND acked_at IS NULL)",
  );
  const openStmt = db.query<PendingOrder, []>("SELECT * FROM pending_orders");
  const openByRailStmt = db.query<PendingOrder, [string]>("SELECT * FROM pending_orders WHERE rail = ?");
  // Unscoped fallback: prefer an order that has money on it. New writes are single-flight per hash, but a
  // pre-upgrade database can contain several, so `(seen_at IS NOT NULL) DESC` surfaces the SEEN one ahead of
  // a newer EMPTY one. created_at DESC only tie-breaks within the same seen/unseen class.
  const byHashStmt = db.query<PendingOrder, [string]>(
    "SELECT * FROM pending_orders WHERE hash = ? ORDER BY (seen_at IS NOT NULL) DESC, created_at DESC LIMIT 1",
  );
  const byHashAddrStmt = db.query<PendingOrder, [string, string]>(
    "SELECT * FROM pending_orders WHERE hash = ? AND address = ? LIMIT 1",
  );
  const countStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pending_orders");
  const markSeenStmt = db.query<never, [number, string, number]>(
    "UPDATE pending_orders SET seen_at = ? WHERE rail = ? AND order_index = ? AND seen_at IS NULL",
  );
  const deleteStmt = db.query("DELETE FROM pending_orders WHERE rail = ? AND order_index = ?");
  const purgeStmt = db.query("DELETE FROM pending_orders WHERE created_at < ?");
  const purgeByRailStmt = db.query("DELETE FROM pending_orders WHERE created_at < ? AND rail = ?");
  const enqueueCreditStmt = db.query(
    "INSERT OR IGNORE INTO credit_outbox (idempotency_key, hash, micros, created_at) VALUES (?, ?, ?, ?)",
  );
  const listUnackedCreditsStmt = db.query<{ idempotency_key: string; hash: string; micros: number }, []>(
    "SELECT idempotency_key, hash, micros FROM credit_outbox WHERE acked_at IS NULL ORDER BY created_at ASC",
  );
  const hasUnackedCreditForHashStmt = db.query<{ present: number }, [string]>(
    "SELECT 1 AS present FROM credit_outbox WHERE hash = ? AND acked_at IS NULL LIMIT 1",
  );
  const ackCreditStmt = db.query(
    "UPDATE credit_outbox SET acked_at = ?, hash = '', micros = 0 WHERE idempotency_key = ?",
  );
  const rearmLegacyAckedCreditsStmt = db.query(
    "UPDATE credit_outbox SET acked_at = NULL WHERE acked_at IS NOT NULL AND hash <> ''",
  );
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

  // Atomically claim an open-order slot + token hash and record the order. Returns false if the global cap
  // was reached or this hash already has a live order/undelivered credit. This is the cross-process
  // backstop; the handler's in-memory reservations shed same-process races before the irreversible wallet
  // address creation.
  // `seen_at` is absent from the input by construction: a brand-new order has never been seen paying. It
  // back-fills NULL and only settle()'s markSeen ever sets it.
  function tryAddOrder(o: Omit<PendingOrder, "seen_at">, maxOpen: number): boolean {
    return (
      tryInsertStmt.run(o.rail, o.order_index, o.address, o.hash, o.expected_atomic, o.credit_micros, o.received_atomic, o.created_at, o.rate_usd, maxOpen, o.hash, o.hash)
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

  // The best single still-open order for a token hash, or null. Powers /order-status's UNSCOPED fallback,
  // for a client that can't name the order (an old cached bundle, a curl user). "Best" = seen-before-unseen
  // then newest (see byHashStmt), so a paid order is never shadowed by an empty newer sibling. Read-only and
  // privacy-safe: the hash already crossed the wire to /buy, and this ORDER row is dropped at settle.
  // The endpoint separately checks the short-lived unacked outbox before collapsing delivered/reaped/
  // never-existed into `closed`; this lookup itself returns null for all of them.
  function latestOpenOrderByHash(hash: string): PendingOrder | null {
    return byHashStmt.get(hash) ?? null;
  }

  // The still-open order a client is TRACKING, scoped to the exact (hash, pay_to address) /buy returned, or
  // null. A hash may have several open orders at once; the address disambiguates the one-to-many so a status
  // read reflects the order the payer is actually looking at, never a newer empty sibling. Same privacy
  // property as above: a non-matching address is indistinguishable from a closed/never-existed order.
  function openOrderByHashAddress(hash: string, address: string): PendingOrder | null {
    return byHashAddrStmt.get(hash, address) ?? null;
  }

  // Drop an order's row — on its first confirmed payment (pay-once) or a reap. Also drops the index→hash
  // link. Composite-keyed: deletes ONLY (rail, orderIndex), never the other rail's row at the same index.
  // `rail` defaults to 'monero' so legacy single-rail callers stay correct without
  // passing it; settle passes the real rail explicitly. Returns whether a row was deleted.
  function removeOrder(orderIndex: number, rail: string = "monero"): boolean {
    return deleteStmt.run(rail, orderIndex).changes > 0;
  }

  // Record the FIRST sighting of any inbound for this order — the durable half of settle()'s reap guard.
  // `seen_at IS NULL` in the WHERE makes it write-once: later ticks re-observing the same deposit are no-ops,
  // so a slowly-confirming payment doesn't rewrite the row every 30s. A missing/closed order matches nothing.
  // Returns true iff this call was the sighting that stuck.
  function markSeen(orderIndex: number, rail: string, atMs: number): boolean {
    return markSeenStmt.run(atMs, rail, orderIndex).changes > 0;
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

  // While a settled order's durable credit is still crossing to the balance ledger, /order-status must not
  // collapse it into the same `closed` state as an unpaid reap. The row already carries the hash for delivery;
  // this lookup retains no additional link and becomes false as soon as the receiver definitely acks.
  function hasUnackedCreditForHash(hash: string): boolean {
    return hasUnackedCreditForHashStmt.get(hash)?.present === 1;
  }

  // Mark a credit delivered (the receiver returned applied / already_applied) and erase the payment↔token
  // payload in the same statement. The transaction-derived key + timestamps remain for idempotency, but no
  // longer carry the token hash or amount.
  // Idempotent: a re-ack keeps the tombstone scrubbed and merely refreshes its ack time.
  function ackCredit(key: string, atMs: number): void {
    ackCreditStmt.run(atMs, key);
  }

  // Explicit PAYMENTS-startup migration for databases created before definite acks scrubbed their delivery
  // payload. The payment process cannot inspect balances.db, so it must NOT erase an old acked payload: the
  // paired ledger may have been rewound. Re-arm every retained real credit; creditOnce makes an already-
  // applied delivery a no-op, and the next definite ack writes the privacy tombstone. Kept out of store-open
  // so read-only operator CLI commands never mutate delivery state. Returns the number of rows re-armed.
  function rearmLegacyAckedCredits(): number {
    return rearmLegacyAckedCreditsStmt.run().changes;
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

  // Sales rows in [fromMs, toMs) (default: everything). The cli/financials.ts data source.
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
    db, tryAddOrder, openOrders, openCount, latestOpenOrderByHash, openOrderByHashAddress, removeOrder, purgeStale, markSeen,
    enqueueCredit, listUnackedCredits, hasUnackedCreditForHash, ackCredit, rearmLegacyAckedCredits,
    oldestUnackedCreditAt, recordRevenue, listRevenue, commitSettlement,
  };
}

export type OrdersStore = ReturnType<typeof openOrderStore>;

// Default on-disk path (pending.db beside balances.db, or PENDING_DB_PATH). The composition root
// (src/payments.ts) and `nsk orders` pass this to openOrderStore(); nothing opens at import time — see the
// note in ledger/db.ts on why the two-process design forbids a module-load singleton.
export const PENDING_DB_PATH = process.env.PENDING_DB_PATH ?? defaultPendingPath();

function defaultPendingPath(): string {
  const balances = process.env.DB_PATH ?? "/var/lib/nullsink/balances.db";
  const slash = balances.lastIndexOf("/");
  return slash === -1 ? "pending.db" : balances.slice(0, slash + 1) + "pending.db";
}
