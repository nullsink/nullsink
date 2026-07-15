// credit_outbox + payment-world revenue accessors on the orders store. These are the
// durable-crossing primitives the settle() rewrite builds on: enqueue is at-most-once per idempotency_key
// (INSERT OR IGNORE, never throws), the sender drains unacked rows oldest-first and acks them, and revenue
// now books here in pending.db instead of balances.db.
import { afterEach, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openOrderStore } from "../src/ledger/orders";
import { openDb } from "../src/ledger/db";
import { drainCreditOutbox } from "./support/drain";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const HASH = "a".repeat(64);
const MIGRATION_DB = `/tmp/nullsink-outbox-migration-${process.pid}.db`;

function removeDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // Not present.
    }
  }
}

afterEach(() => removeDb(MIGRATION_DB));

test("enqueueCredit is idempotent per idempotency_key (INSERT OR IGNORE): first wins, repeat is a no-op", () => {
  const o = openOrderStore(":memory:");
  expect(o.enqueueCredit("tx:1", HASH, 5_000_000, 100)).toBe(true); // fresh
  expect(o.enqueueCredit("tx:1", HASH, 9_999_999, 200)).toBe(false); // same key → ignored, NOT overwritten
  const rows = o.listUnackedCredits();
  expect(rows).toEqual([{ idempotency_key: "tx:1", hash: HASH, micros: 5_000_000 }]); // original amount kept
});

test("listUnackedCredits returns unacked rows oldest-first; ackCredit removes a row from the work list", () => {
  const o = openOrderStore(":memory:");
  o.enqueueCredit("tx:b", HASH, 2_000_000, 200);
  o.enqueueCredit("tx:a", HASH, 1_000_000, 100); // enqueued later but older created_at → sorts FIRST
  expect(o.listUnackedCredits().map((r) => r.idempotency_key)).toEqual(["tx:a", "tx:b"]);
  o.ackCredit("tx:a", 500);
  expect(o.listUnackedCredits().map((r) => r.idempotency_key)).toEqual(["tx:b"]); // acked row drops out
  expect(
    o.db.query<{ hash: string; micros: number; acked_at: number }, [string]>(
      "SELECT hash, micros, acked_at FROM credit_outbox WHERE idempotency_key = ?",
    ).get("tx:a"),
  ).toEqual({ hash: "", micros: 0, acked_at: 500 }); // delivery payload is scrubbed, key remains
  o.ackCredit("tx:a", 999); // re-ack is harmless
  expect(o.listUnackedCredits().map((r) => r.idempotency_key)).toEqual(["tx:b"]);
});

test("payments startup safely re-arms historical acked payloads, then a definite ack tombstones them", () => {
  removeDb(MIGRATION_DB);
  const legacy = openOrderStore(MIGRATION_DB);
  legacy.enqueueCredit("acked", HASH, 5_000_000, 100);
  legacy.enqueueCredit("live", "b".repeat(64), 7_000_000, 200);
  // Recreate the pre-migration ack shape: delivery marked complete, payload still retained.
  legacy.db.run("UPDATE credit_outbox SET acked_at = 300 WHERE idempotency_key = 'acked'");
  legacy.db.close();

  const migrated = openOrderStore(MIGRATION_DB);
  // Opening the store is schema-only: an operator's read-only `nsk` command must not mutate delivery state.
  expect(
    migrated.db.query<{ idempotency_key: string; hash: string; micros: number; acked_at: number | null }, []>(
      "SELECT idempotency_key, hash, micros, acked_at FROM credit_outbox ORDER BY created_at",
    ).all(),
  ).toEqual([
    { idempotency_key: "acked", hash: HASH, micros: 5_000_000, acked_at: 300 },
    { idempotency_key: "live", hash: "b".repeat(64), micros: 7_000_000, acked_at: null },
  ]);
  expect(migrated.rearmLegacyAckedCredits()).toBe(1);
  expect(migrated.listUnackedCredits()).toEqual([
    { idempotency_key: "acked", hash: HASH, micros: 5_000_000 },
    { idempotency_key: "live", hash: "b".repeat(64), micros: 7_000_000 },
  ]);
  migrated.ackCredit("acked", 400);
  expect(
    migrated.db.query<{ hash: string; micros: number; acked_at: number }, [string]>(
      "SELECT hash, micros, acked_at FROM credit_outbox WHERE idempotency_key = ?",
    ).get("acked"),
  ).toEqual({ hash: "", micros: 0, acked_at: 400 });
  migrated.db.close();
});

test("legacy re-arm repairs a missing receiver marker and harmlessly dedupes one already applied", () => {
  const store = openOrderStore(":memory:");
  const balances = openDb(":memory:");
  const otherHash = "b".repeat(64);
  store.enqueueCredit("already", HASH, 5_000_000, 100);
  store.enqueueCredit("missing", otherHash, 7_000_000, 200);
  // Both rows have the old shape: acked in pending.db while still retaining delivery payloads.
  store.db.run("UPDATE credit_outbox SET acked_at = 300");
  expect(balances.creditOnce(HASH, 5_000_000, "already", 250)).toBe(true);

  expect(store.rearmLegacyAckedCredits()).toBe(2);
  drainCreditOutbox(store, balances, 400);
  expect(balances.getBalance(HASH)).toBe(5_000_000); // existing marker prevented a double credit
  expect(balances.getBalance(otherHash)).toBe(7_000_000); // missing marker was repaired
  expect(store.listUnackedCredits()).toEqual([]);
  expect(
    store.db.query<{ n: number }, []>(
      "SELECT count(*) AS n FROM credit_outbox WHERE acked_at IS NOT NULL AND hash = '' AND micros = 0",
    ).get()?.n,
  ).toBe(2); // both definite outcomes cleared their active delivery payload
});

test("acking every row leaves an empty work list (the drained-clean state)", () => {
  const o = openOrderStore(":memory:");
  o.enqueueCredit("k1", HASH, 1, 1);
  o.enqueueCredit("k2", HASH, 2, 2);
  o.ackCredit("k1", 10);
  o.ackCredit("k2", 10);
  expect(o.listUnackedCredits()).toEqual([]);
});

test("recordRevenue books a sale row; listRevenue round-trips it with the coin's own scale", () => {
  const o = openOrderStore(":memory:");
  o.recordRevenue(1000, "monero", 50_000_000_000, ATOMIC_PER_XMR, 7_500_000, 8_250_000);
  expect(o.listRevenue()).toEqual([
    { at: 1000, asset: "monero", asset_atomic: 50_000_000_000, scale: ATOMIC_PER_XMR, usd_micros: 7_500_000, gross_micros: 8_250_000 },
  ]);
});

test("a bitcoin sale books in sats at its own scale (not mislabelled as XMR)", () => {
  const o = openOrderStore(":memory:");
  const SATS_PER_BTC = 100_000_000;
  o.recordRevenue(500, "bitcoin", 100_000, SATS_PER_BTC, 60_000_000, 60_000_000);
  expect(o.listRevenue()).toEqual([
    { at: 500, asset: "bitcoin", asset_atomic: 100_000, scale: SATS_PER_BTC, usd_micros: 60_000_000, gross_micros: 60_000_000 },
  ]);
});

// The crossing's money-safety crux. The outbox is at-least-once delivery; creditOnce's applied_orders is the
// idempotent receiver. A crash between creditOnce committing and ackCredit leaves the row unacked → the sender
// re-delivers next tick, and the receiver must credit AT MOST once.
test("crash before ack: re-delivery credits exactly once (applied_orders dedupes the redelivery)", () => {
  const store = openOrderStore(":memory:");
  const balances = openDb(":memory:");
  store.enqueueCredit("tx:1", HASH, 5_000_000, 100);
  // Simulate a crash mid-drain: the credit APPLIED (creditOnce committed to balances.db) but the outbox row's
  // ackCredit never ran — so the row is still unacked.
  expect(balances.creditOnce(HASH, 5_000_000, "tx:1", 100)).toBe(true);
  expect(store.listUnackedCredits()).toHaveLength(1);
  // Next tick's drain re-delivers the still-unacked row: creditOnce sees the marker → already_applied → no
  // second credit, and the row finally acks.
  drainCreditOutbox(store, balances, 200);
  expect(balances.getBalance(HASH)).toBe(5_000_000); // credited exactly once, not 10_000_000
  expect(store.listUnackedCredits()).toEqual([]); // outbox drained clean
});

// Double-booking defense at the row level: commitSettlement books revenue ONLY when the outbox enqueue is fresh. If the key
// already exists (e.g. a zombie deposit re-processed after the ledger already credited it), the INSERT OR IGNORE is a no-op → no second
// sale is booked and the original credit amount is preserved — while the order still closes.
test("commitSettlement books no second sale when the outbox key already exists (INSERT OR IGNORE + fresh guard)", () => {
  const store = openOrderStore(":memory:");
  store.tryAddOrder({ rail: "monero", order_index: 3, address: "a3", hash: HASH, expected_atomic: 1_000_000, credit_micros: 5_000_000, received_atomic: 0, created_at: 100, rate_usd: 0 }, Number.MAX_SAFE_INTEGER);
  store.enqueueCredit("k", HASH, 5_000_000, 100); // key already enqueued (simulate the zombie's credit)
  store.commitSettlement("k", HASH, 5_000_000, 200, { asset: "monero", assetAtomic: 1_000_000, scale: ATOMIC_PER_XMR, grossMicros: 999 }, 3, "monero");
  expect(store.listRevenue()).toHaveLength(0); // NOT booked — the enqueue wasn't fresh
  expect(store.listUnackedCredits()).toEqual([{ idempotency_key: "k", hash: HASH, micros: 5_000_000 }]); // original row intact
  expect(store.openOrders()).toHaveLength(0); // order still closed regardless
});
