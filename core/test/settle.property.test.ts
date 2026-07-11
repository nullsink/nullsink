// Property tests for the settlement core (src/settle.ts). We drive it with generated, rail-normalised
// inbound lists against fresh in-memory balance/order stores — no wallet-rpc, no server. The headline
// properties are metamorphic (replay and reorder must not change the outcome), which need no oracle and
// directly pin the money-safety guarantees: idempotent crediting and order-independent aggregation. The
// rail now owns finality + the idempotency key, so settle sees only `final` + `idempotencyKey` (the
// under-confirmed/locked/double-spend logic is pinned in monero.property.test.ts).
import { test, expect } from "bun:test";
import fc from "fast-check";
import { unlinkSync } from "node:fs";
import { openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { settle, type SettleConfig } from "../src/ledger/settle";
import { drainCreditOutbox } from "./support/drain";
import type { Incoming } from "../src/rails/types";
import type { PendingOrder } from "../src/ledger/orders";
import { ATOMIC_PER_XMR } from "../src/rails/units";

const CONF = 10;
const NOW = 1_000_000_000_000;
const SEED_MAX = Number.MAX_SAFE_INTEGER; // tests seed orders via tryAddOrder with an unbounded cap
const CFG: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: NOW }; // threshold now-backstop = 0; nothing purged
const HASHES = ["h1", "h2", "h3"];

type GenOrder = { sub: number; hash: string; expected: number; credit: number };

const orderArb = fc.record({
  sub: fc.nat({ max: 9 }),
  hash: fc.constantFrom(...HASHES),
  // expected ≥ 1e6 keeps every credited share (round(credit × amount/expected)) — and so the running
  // balance — within Number.MAX_SAFE_INTEGER, so "settlement is independent of inbound order" below holds
  // by EXACT integer addition. With expected as small as 1 atomic, a large `amount` makes a single share
  // exceed 2^53, where float64 addition is non-associative and reorder ≠ same total — a property of floats,
  // not a settle bug. The huge-atomic regime (where order-independence is mathematically impossible) is
  // covered by "credit stays finite … even for huge atomic amounts", which only asserts finite/non-negative.
  expected: fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }),
  credit: fc.integer({ min: 1, max: 50_000_000 }),
});

// Rail-normalised inbound. idempotencyKey embeds (txid, orderIndex) like the Monero rail does, so two
// inbounds with the same tag+index aggregate, while one tag across two indices stays two keys.
const transferArb: fc.Arbitrary<Incoming> = fc
  .record({
    orderIndex: fc.nat({ max: 9 }),
    txidTag: fc.constantFrom("tx1", "tx2", "tx3", "tx4"),
    amount: fc.integer({ min: 1, max: 2_000_000_000_000 }),
    confirmations: fc.nat({ max: 20 }),
    final: fc.boolean(),
  })
  .map((t) => ({
    orderIndex: t.orderIndex,
    idempotencyKey: `${t.txidTag}:${t.orderIndex}`,
    amount: t.amount,
    confirmations: t.confirmations,
    final: t.final,
  }));

// First-wins dedupe by order index (PRIMARY KEY) so addOrder never collides.
function dedupe(orders: GenOrder[]): GenOrder[] {
  const seen = new Set<number>();
  return orders.filter((o) => (seen.has(o.sub) ? false : (seen.add(o.sub), true)));
}

function fresh(orders: GenOrder[]) {
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  for (const o of orders)
    store.tryAddOrder({
      rail: "monero", order_index: o.sub,
      address: `addr${o.sub}`,
      hash: o.hash,
      expected_atomic: o.expected,
      credit_micros: o.credit,
      received_atomic: 0,
      created_at: NOW,
      rate_usd: 0,
    }, SEED_MAX);
  return { balances, store };
}

// Comparable snapshot of all observable state after a settle run.
function snapshot(balances: ReturnType<typeof openDb>, store: ReturnType<typeof openOrderStore>) {
  return {
    balances: HASHES.map((h) => balances.getBalance(h)),
    orders: store
      .openOrders()
      .map((o) => `${o.order_index}:${o.received_atomic}`)
      .sort(),
  };
}

// settle() now ENQUEUES credits into the outbox; the sender (drainCreditOutbox) delivers them to the balance
// ledger. These tests assert the end-to-end credit, so drive both — same 5-arg shape as the pre-outbox settle,
// so the crediting-logic tests below read unchanged. (Reap-only calls drain an empty outbox — a harmless no-op.)
const settleAndDrain = (inbounds: Incoming[], store: ReturnType<typeof openOrderStore>, balances: ReturnType<typeof openDb>, now: number, cfg: SettleConfig): void => {
  settle(inbounds, store, now, cfg);
  drainCreditOutbox(store, balances, now);
};

test("replaying the same inbounds credits exactly once (idempotent)", () => {
  fc.assert(
    fc.property(fc.array(orderArb, { maxLength: 5 }), fc.array(transferArb, { maxLength: 12 }), (rawOrders, transfers) => {
      const { balances, store } = fresh(dedupe(rawOrders));
      settleAndDrain(transfers, store, balances, NOW, CFG);
      const after1 = snapshot(balances, store);
      settleAndDrain(transfers, store, balances, NOW, CFG); // re-scan, as the poller does every tick
      settleAndDrain(transfers, store, balances, NOW, CFG);
      expect(snapshot(balances, store)).toEqual(after1);
    }),
    { numRuns: 400 },
  );
});

test("settlement is independent of inbound order", () => {
  fc.assert(
    fc.property(fc.array(orderArb, { maxLength: 5 }), fc.array(transferArb, { maxLength: 12 }), (rawOrders, transfers) => {
      const orders = dedupe(rawOrders);
      const a = fresh(orders);
      settleAndDrain(transfers, a.store, a.balances, NOW, CFG);
      const b = fresh(orders);
      settleAndDrain([...transfers].reverse(), b.store, b.balances, NOW, CFG);
      expect(snapshot(b.balances, b.store)).toEqual(snapshot(a.balances, a.store));
    }),
    { numRuns: 400 },
  );
});

test("non-final inbounds credit nothing", () => {
  const ineligibleArb = fc
    .record({
      orderIndex: fc.nat({ max: 4 }),
      txidTag: fc.constantFrom("tx1", "tx2"),
      amount: fc.integer({ min: 1, max: 1_000_000_000 }),
      confirmations: fc.nat({ max: 20 }),
    })
    .map((t) => ({ orderIndex: t.orderIndex, idempotencyKey: `${t.txidTag}:${t.orderIndex}`, amount: t.amount, confirmations: t.confirmations, final: false }));
  // Orders for indices 0..4 so the inbounds MATCH an order — proving the skip is about finality, not a
  // missing order.
  const orders: GenOrder[] = [0, 1, 2, 3, 4].map((sub) => ({ sub, hash: HASHES[sub % HASHES.length]!, expected: 1_000_000, credit: 1_000_000 }));
  fc.assert(
    fc.property(fc.array(ineligibleArb, { maxLength: 12 }), (transfers) => {
      const { balances, store } = fresh(orders);
      settleAndDrain(transfers, store, balances, NOW, CFG);
      for (const h of HASHES) expect(balances.getBalance(h)).toBeNull(); // nothing credited
      expect(store.openOrders().every((o) => o.received_atomic === 0)).toBe(true); // nothing consumed
    }),
    { numRuns: 300 },
  );
});

test("proportional credit sums per-idempotency-key amounts then rounds once", () => {
  // Realistic regime: amounts bounded by `expected` so shares stay safe integers and the arithmetic is
  // exact. (Extreme atomics that exceed i64 — and force SQLite to store floats — are property E's job.)
  const scenario = fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }).chain((expected) =>
    fc.record({
      expected: fc.constant(expected),
      credit: fc.integer({ min: 1, max: 50_000_000 }),
      outs: fc.array(
        fc.record({ txid: fc.constantFrom("tx1", "tx2", "tx3"), amount: fc.integer({ min: 1, max: expected }) }),
        { minLength: 1, maxLength: 8 },
      ),
    }),
  );
  fc.assert(
    fc.property(scenario, ({ expected, credit, outs }) => {
        const order: GenOrder = { sub: 0, hash: "h1", expected, credit };
        const { balances, store } = fresh([order]);
        const transfers: Incoming[] = outs.map((o) => ({
          orderIndex: 0,
          idempotencyKey: `${o.txid}:0`,
          amount: o.amount,
          confirmations: CONF,
          final: true,
        }));
        settleAndDrain(transfers, store, balances, NOW, CFG);
        // Oracle: group by key (txid:0), sum amounts, round the share ONCE per key, total the rounded shares.
        const perKey = new Map<string, number>();
        for (const o of outs) perKey.set(o.txid, (perKey.get(o.txid) ?? 0) + o.amount);
        let want = 0;
        for (const amt of perKey.values()) want += Math.round(credit * (amt / expected));
        expect(balances.getBalance("h1")).toBe(want);
      },
    ),
    { numRuns: 500 },
  );
});

test("an exactly-fully-paid order is dropped (>= boundary, not >)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }), fc.integer({ min: 1, max: 50_000_000 }), (expected, credit) => {
      const { balances, store } = fresh([{ sub: 0, hash: "h1", expected, credit }]);
      // amount === expected: received reaches expected exactly → must drop the row.
      settleAndDrain([{ orderIndex: 0, idempotencyKey: "tx1:0", amount: expected, confirmations: CONF, final: true }], store, balances, NOW, CFG);
      expect(store.openOrders().length).toBe(0);
      expect(balances.getBalance("h1")).toBe(credit); // round(credit × expected/expected) === credit
    }),
    { numRuns: 300 },
  );
});

test("credit stays finite and non-negative even for huge atomic amounts", () => {
  const huge = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
  fc.assert(
    fc.property(huge, fc.integer({ min: 1, max: 50_000_000 }), huge, (expected, credit, amount) => {
      const { balances, store } = fresh([{ sub: 0, hash: "h1", expected, credit }]);
      settleAndDrain([{ orderIndex: 0, idempotencyKey: "tx1:0", amount, confirmations: CONF, final: true }], store, balances, NOW, CFG);
      const bal = balances.getBalance("h1")!;
      expect(Number.isFinite(bal)).toBe(true);
      expect(bal).toBeGreaterThanOrEqual(0);
    }),
    { numRuns: 300 },
  );
});

test("pay-once: any final payment credits proportionally and closes the order (partial included)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }), // expected (kept ≥1e6 so shares stay safe ints)
      fc.integer({ min: 1, max: 50_000_000 }),
      fc.integer({ min: 1, max: 4_000_000_000_000 }),
      (expected, credit, amount) => {
        const { balances, store } = fresh([{ sub: 0, hash: "h1", expected, credit }]);
        settleAndDrain([{ orderIndex: 0, idempotencyKey: "tx1:0", amount, confirmations: CONF, final: true }], store, balances, NOW, CFG);
        // Single-use address: the order closes on the FIRST final payment — partial or full — and a later
        // top-up is a new order. Credit is still proportional to the locked quote either way.
        expect(store.openOrders().length).toBe(0);
        expect(balances.getBalance("h1")).toBe(Math.round(credit * (amount / expected)));
      },
    ),
    { numRuns: 400 },
  );
});

test("unfunded fast-reap drops abandoned orders but spares ones with seen (even non-final) activity", () => {
  const REAP = 60 * 60 * 1000;
  const cfg: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: 24 * REAP, unfundedReapMs: REAP };
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  const mk = (sub: number, hash: string, createdAt: number): Omit<PendingOrder, "seen_at"> => ({
    rail: "monero", order_index: sub, address: `addr${sub}`, hash, expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: createdAt, rate_usd: 0,
  });
  store.tryAddOrder(mk(0, "h1", NOW - REAP - 1), SEED_MAX); // old + NO activity → reaped
  store.tryAddOrder(mk(1, "h2", NOW - REAP - 1), SEED_MAX); // old but a sighting this tick → spared
  store.tryAddOrder(mk(2, "h3", NOW - REAP + 1000), SEED_MAX); // younger than the cutoff → spared (not yet abandoned)
  // A non-final (still-confirming) payment to index 1: it's in get_transfers `in` (monotonic — never
  // flickers out), so it marks index 1 active and spares it, but final=false so it does NOT yet credit.
  const seen: Incoming = { orderIndex: 1, idempotencyKey: "txP:1", amount: 500_000, confirmations: 3, final: false };
  settleAndDrain([seen], store, balances, NOW, cfg);
  expect(store.openOrders().map((o) => o.order_index).sort()).toEqual([1, 2]);
  expect(balances.getBalance("h2")).toBeNull(); // non-final → credited nothing yet
});

// The unfunded fast-reap uses STRICT `<` (o.created_at < now - unfundedReapMs). An order created EXACTLY at the
// cutoff must be SPARED — a one-tick-early reap drops a payment that may still be confirming. The NOW±offset
// cases above don't hit the boundary; pin `<` vs `<=` here (a settle.ts mutation survivor).
test("unfunded fast-reap spares an order created EXACTLY at the cutoff (strict <, not <=)", () => {
  const REAP = 60 * 60 * 1000;
  const cfg: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", rail: "monero", backstopMs: 24 * REAP, unfundedReapMs: REAP };
  const store = openOrderStore(":memory:");
  store.tryAddOrder({ rail: "monero", order_index: 0, address: "a0", hash: "h1", expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: NOW - REAP, rate_usd: 0 }, SEED_MAX); // == cutoff → spared
  store.tryAddOrder({ rail: "monero", order_index: 1, address: "a1", hash: "h2", expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: NOW - REAP - 1, rate_usd: 0 }, SEED_MAX); // older → reaped
  settle([], store, NOW, cfg); // no deposits → the unfunded reap runs
  expect(store.openOrders().map((o) => o.order_index).sort()).toEqual([0]); // 0 spared (== cutoff), 1 reaped (< cutoff)
  store.db.close();
});

test("cross-tick: an order spared by a sighting survives a later EMPTY tick, then credits", () => {
  // Bug-2 regression. A transient empty get_transfers (wallet rescan / node resync → rails/monero.ts
  // coerces a missing `in` to []) must NOT fast-reap an order a PRIOR tick already saw paying.
  const REAP = 60 * 60 * 1000;
  const cfg: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: 24 * REAP, unfundedReapMs: REAP };
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  // Paid near the deadline: the order is ALREADY past the unfunded cutoff.
  store.tryAddOrder({ rail: "monero", order_index: 0, address: "a0", hash: "h1", expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: NOW - REAP - 1, rate_usd: 0 }, SEED_MAX);
  const pay = (confirmations: number): Incoming => ({ orderIndex: 0, idempotencyKey: "txP:0", amount: 1_000_000, confirmations, final: confirmations >= CONF });
  // Tick A: a non-final sighting → persists seen_at + spares it, credits nothing yet.
  settleAndDrain([pay(3)], store, balances, NOW, cfg);
  expect(store.openOrders().length).toBe(1);
  expect(store.openOrders()[0]!.seen_at).toBe(NOW);
  // Tick B: the wallet goes transiently blind (empty list). The pre-fix per-tick reaper would drop the order.
  settleAndDrain([], store, balances, NOW, cfg);
  expect(store.openOrders().length).toBe(1);
  // Tick C: the payment goes final → credited + closed (pay-once).
  settleAndDrain([pay(CONF)], store, balances, NOW, cfg);
  expect(balances.getBalance("h1")).toBe(1_000_000);
  expect(store.openOrders().length).toBe(0);
});

test("durable seen_at: a RESTART cannot fast-reap an order the wallet already saw being paid", () => {
  // The restart form of the regression above, and a real money-loss path. The sighting used to live in the
  // poller's in-process Set, rebuilt EMPTY on every start — and the first tick fires immediately, precisely
  // when the local wallet/node is most likely still resyncing. A resyncing wallet reports an empty inbound
  // list as a SUCCESS (rails/monero.ts coerces a missing `in` to []), which pollRail cannot distinguish from
  // "nobody paid", so it flows straight into settle(). Unseen + past the cutoff → reaped → the irreplaceable
  // index→hash link is gone → the customer's confirmed deposit can never be credited. Our OWN deploy and
  // restore procedures restart this process, so this is not a rare event.
  //
  // settle() now holds NO cross-call state, so we cannot fake a restart by discarding a Set. Do it honestly:
  // CLOSE the store and reopen it from the same file. Only a real on-disk column survives that.
  const REAP = 60 * 60 * 1000;
  const cfg: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: 24 * REAP, unfundedReapMs: REAP };
  const path = `/tmp/nullsink-seenat-${process.pid}.db`;
  for (const s of ["", "-wal", "-shm"]) try { unlinkSync(path + s); } catch { /* absent */ }
  const balances = openDb(":memory:");
  const pay = (confirmations: number): Incoming => ({ orderIndex: 0, idempotencyKey: "txP:0", amount: 1_000_000, confirmations, final: confirmations >= CONF });

  // --- process 1: one non-final sighting, then it dies (crash / deploy / restore) ---
  const p1 = openOrderStore(path);
  p1.tryAddOrder({ rail: "monero", order_index: 0, address: "a0", hash: "h1", expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: NOW - REAP - 1, rate_usd: 0 }, SEED_MAX);
  settleAndDrain([pay(3)], p1, balances, NOW, cfg);
  expect(p1.openOrders()[0]!.seen_at).toBe(NOW);
  p1.db.close(); // the process dies

  // --- process 2: reopened from disk, blind first poll (wallet still resyncing) ---
  const p2 = openOrderStore(path);
  expect(p2.openOrders()[0]!.seen_at).toBe(NOW); // the sighting survived the restart, on disk
  settleAndDrain([], p2, balances, NOW + 1000, cfg);
  expect(p2.openOrders().length).toBe(1); // spared — nothing in memory could have known

  // ...and once the wallet catches up, the deposit still credits.
  settleAndDrain([pay(CONF)], p2, balances, NOW + 2000, cfg);
  expect(balances.getBalance("h1")).toBe(1_000_000);
  expect(p2.openOrders().length).toBe(0);
  p2.db.close();
  for (const s of ["", "-wal", "-shm"]) try { unlinkSync(path + s); } catch { /* absent */ }
});

test("durable seen_at is write-once and does not spare a never-seen order", () => {
  const REAP = 60 * 60 * 1000;
  const cfg: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", rail: "monero", backstopMs: 24 * REAP, unfundedReapMs: REAP };
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  store.tryAddOrder({ rail: "monero", order_index: 0, address: "a0", hash: "h1", expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: NOW - REAP - 1, rate_usd: 0 }, SEED_MAX);
  store.tryAddOrder({ rail: "monero", order_index: 1, address: "a1", hash: "h2", expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: NOW - REAP - 1, rate_usd: 0 }, SEED_MAX);
  // Order 1 is sighted twice; the FIRST timestamp must stick (no per-tick rewrite of a slow confirmation).
  const pay = (i: number): Incoming => ({ orderIndex: i, idempotencyKey: `txP:${i}`, amount: 1, confirmations: 1, final: false });
  expect(store.markSeen(1, "monero", NOW)).toBe(true);
  expect(store.markSeen(1, "monero", NOW + 5000)).toBe(false); // write-once
  settleAndDrain([pay(1)], store, balances, NOW + 9000, cfg);
  const open = store.openOrders();
  expect(open.map((o) => o.order_index)).toEqual([1]); // 0 was NEVER seen → reaped; 1 sighted → spared
  expect(open[0]!.seen_at).toBe(NOW); // first sighting, not the later ones
  expect(store.markSeen(99, "monero", NOW)).toBe(false); // no such order → no-op
  store.db.close();
});

test("a final payment to an order PAST the reap cutoff is credited, not reaped", () => {
  // The money-safety crux of the confirmed-only reap: when a final payment lands in the same tick that an
  // order is already older than the unfunded window, it must be CREDITED + closed (pay-once), never
  // dropped by the reaper. Relies on settle crediting (and removing the row) BEFORE the unfunded reap
  // re-reads the open orders — a load-bearing ordering this test locks in.
  const REAP = 60 * 60 * 1000;
  const cfg: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: 24 * REAP, unfundedReapMs: REAP };
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  store.tryAddOrder({ rail: "monero", order_index: 0, address: "a0", hash: "h1", expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: NOW - REAP - 1, rate_usd: 0 }, SEED_MAX); // past the cutoff
  settleAndDrain([{ orderIndex: 0, idempotencyKey: "txC:0", amount: 1_000_000, confirmations: CONF, final: true }], store, balances, NOW, cfg);
  expect(balances.getBalance("h1")).toBe(1_000_000); // credited, not stranded
  expect(store.openOrders().length).toBe(0); // closed by pay-once, not reaped-without-credit
});

// One tx paying TWO of our addresses: each output must credit its own order. This is the exact money-loss
// scenario the design warns about (keying by txid alone would drop the second as already-applied) — the
// rail gives them DISTINCT idempotency keys (txid:index). The metamorphic properties above catch it
// indirectly; this pins it with a direct per-order oracle.
test("one tx paying two of our addresses credits both orders correctly", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }),
      fc.integer({ min: 1, max: 50_000_000 }),
      fc.integer({ min: 1, max: 2_000_000_000_000 }),
      fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }),
      fc.integer({ min: 1, max: 50_000_000 }),
      fc.integer({ min: 1, max: 2_000_000_000_000 }),
      (expected1, credit1, amt1, expected2, credit2, amt2) => {
        const a1 = Math.min(amt1, expected1); // keep within the exact safe-int regime
        const a2 = Math.min(amt2, expected2);
        const { balances, store } = fresh([
          { sub: 1, hash: "h1", expected: expected1, credit: credit1 },
          { sub: 2, hash: "h2", expected: expected2, credit: credit2 },
        ]);
        const transfers: Incoming[] = [
          { orderIndex: 1, idempotencyKey: "txX:1", amount: a1, confirmations: CONF, final: true },
          { orderIndex: 2, idempotencyKey: "txX:2", amount: a2, confirmations: CONF, final: true },
        ];
        settleAndDrain(transfers, store, balances, NOW, CFG);
        expect(balances.getBalance("h1")).toBe(Math.round(credit1 * (a1 / expected1)));
        expect(balances.getBalance("h2")).toBe(Math.round(credit2 * (a2 / expected2)));
      },
    ),
    { numRuns: 300 },
  );
});

// The backstop horizon: stale unpaid orders are reaped, and a re-scan after an order has closed can't open a
// double-credit window (the order is gone, so settle enqueues nothing; applied_orders is never purged).
// The exact window length is immaterial here — the test only needs a finite, positive backstop (settle's
// default CFG neutralizes it with backstopMs=NOW ⇒ cutoff 0). Use the prod ORDER_BACKSTOP_MS default (24h).
test("backstop reaps stale orders and re-scan after purge never double-credits", () => {
  const BACKSTOP = 24 * 60 * 60 * 1000;
  const cfg: SettleConfig = { scale: ATOMIC_PER_XMR, asset: "monero", backstopMs: BACKSTOP };
  fc.assert(
    fc.property(
      fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }),
      fc.integer({ min: 1, max: 50_000_000 }),
      (expected, credit) => {
        const balances = openDb(":memory:");
        const store = openOrderStore(":memory:");
        // index0: created before the cutoff, unpaid → must be reaped. index1: just inside → must be kept.
        store.tryAddOrder({ rail: "monero", order_index: 0, address: "a0", hash: "h1", expected_atomic: expected, credit_micros: credit, received_atomic: 0, created_at: NOW - BACKSTOP - 1, rate_usd: 0 }, SEED_MAX);
        store.tryAddOrder({ rail: "monero", order_index: 1, address: "a1", hash: "h2", expected_atomic: expected, credit_micros: credit, received_atomic: 0, created_at: NOW - BACKSTOP + 1000, rate_usd: 0 }, SEED_MAX);

        settleAndDrain([], store, balances, NOW, cfg); // no deposits: reap the stale order, keep the fresh one
        expect(store.openOrders().map((o) => o.order_index).sort()).toEqual([1]);

        // Fully pay the surviving order (drops its row, leaves the idempotency marker at applied=NOW).
        const pay: Incoming = { orderIndex: 1, idempotencyKey: "txB:1", amount: expected, confirmations: CONF, final: true };
        settleAndDrain([pay], store, balances, NOW, cfg);
        expect(balances.getBalance("h2")).toBe(credit);
        expect(store.openOrders().length).toBe(0);

        // Re-scan the SAME deposit long after the order closed (past the backstop): the order is gone, so
        // settle enqueues nothing and the balance must not move.
        settleAndDrain([pay], store, balances, NOW + BACKSTOP + 1, cfg);
        expect(balances.getBalance("h2")).toBe(credit);
      },
    ),
    { numRuns: 200 },
  );
});

// The old two-DB crash zombie (credit committed to balances.db, removeOrder to pending.db not yet) is GONE:
// settle now enqueues the credit, books revenue, and closes the order in ONE pending.db transaction. Pin the
// atomic outcome + its idempotency under a poller re-scan, and exactly-once delivery through the sender.
test("settle enqueues credit + books revenue + closes the order atomically; re-scan and re-drain stay exactly-once", () => {
  const { balances, store } = fresh([{ sub: 1, hash: "h1", expected: 1_000_000, credit: 5_000_000 }]);
  const pay: Incoming = { orderIndex: 1, idempotencyKey: "tx1:1", amount: 1_000_000, confirmations: CONF, final: true };
  settle([pay], store, NOW, CFG);
  // one outbox credit + one revenue row + the order closed, all from the single settle transaction:
  expect(store.listUnackedCredits()).toEqual([{ idempotency_key: "tx1:1", hash: "h1", micros: 5_000_000 }]);
  expect(store.listRevenue().length).toBe(1);
  expect(store.openCount()).toBe(0);
  // a poller re-scan of the same (now-closed) deposit enqueues nothing new and books no second sale:
  settle([pay], store, NOW, CFG);
  expect(store.listUnackedCredits().length).toBe(1);
  expect(store.listRevenue().length).toBe(1);
  // the sender delivers it to the balance ledger exactly once, even across repeated drains:
  drainCreditOutbox(store, balances, NOW);
  drainCreditOutbox(store, balances, NOW);
  expect(balances.getBalance("h1")).toBe(5_000_000);
});

// Task 3: settle scopes every pending_orders read/reap to cfg.rail, so one rail's tick can never reap the
// other rail's same-index order (the cross-rail money-loss path). Single-rail prod passes rail=its own name.
test("settle is rail-scoped: a monero tick reaps only monero orders, never the other rail's same-index order", () => {
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  const REAP = 60 * 60 * 1000; // 1h unfunded horizon
  const mk = (rail: string, idx: number): Omit<PendingOrder, "seen_at"> => ({ rail, order_index: idx, address: `${rail}${idx}`, hash: `h-${rail}`, expected_atomic: 1_000_000, credit_micros: 1_000_000, received_atomic: 0, created_at: NOW - REAP - 1, rate_usd: 0 });
  store.tryAddOrder(mk("monero", 5), SEED_MAX); // same index 5 on both rails, both stale + unfunded
  store.tryAddOrder(mk("bitcoin", 5), SEED_MAX);

  // a monero settle tick (no inbounds) reaps the stale monero order but must NOT touch bitcoin's index-5:
  settleAndDrain([], store, balances, NOW, { scale: ATOMIC_PER_XMR, asset: "monero", rail: "monero", backstopMs: NOW, unfundedReapMs: REAP });
  expect(store.openOrders("monero").length).toBe(0); // monero-5 reaped
  expect(store.openOrders("bitcoin").length).toBe(1); // bitcoin-5 untouched by the monero tick

  // the bitcoin tick reaps its own:
  settleAndDrain([], store, balances, NOW, { scale: 100_000_000, asset: "bitcoin", rail: "bitcoin", backstopMs: NOW, unfundedReapMs: REAP });
  expect(store.openOrders("bitcoin").length).toBe(0);
  store.db.close();
  balances.db.close();
});

// THE load-bearing concurrency invariant: settle() must be synchronous so the poller's per-rail settle calls
// can't interleave on the shared DBs. If an await ever creeps in, settle returns a Promise and this fails.
test("settle() is synchronous — returns undefined, never a thenable (the poller's serialization invariant)", () => {
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  const ret = settle([], store, NOW, CFG);
  expect(ret).toBeUndefined();
  expect(typeof (ret as unknown as { then?: unknown })?.then).not.toBe("function");
  store.db.close();
  balances.db.close();
});

// The core concurrency claim: two rails crediting the SAME order_index (and even the SAME txid) in one cycle
// each credit their own token exactly once and close only their own row — no cross-rail aliasing or strand.
test("two rails settle the same order_index + same txid: each credits its own hash, neither strands", () => {
  const balances = openDb(":memory:");
  const store = openOrderStore(":memory:");
  store.tryAddOrder({ rail: "monero", order_index: 5, address: "m5", hash: "hmon", expected_atomic: 1_000_000, credit_micros: 5_000_000, received_atomic: 0, created_at: NOW, rate_usd: 0 }, SEED_MAX);
  store.tryAddOrder({ rail: "bitcoin", order_index: 5, address: "b5", hash: "hbtc", expected_atomic: 1_000_000, credit_micros: 5_000_000, received_atomic: 0, created_at: NOW, rate_usd: 0 }, SEED_MAX);
  // Same index 5 AND same txid "T". Monero's key is the legacy "T:5"; bitcoin's rail prefixes it to
  // "bitcoin:T:5". If both were "T:5", the shared applied_orders would dedupe the second → strand bitcoin.
  // The poller calls settle ONCE PER RAIL:
  settleAndDrain([{ orderIndex: 5, idempotencyKey: "T:5", amount: 1_000_000, confirmations: CONF, final: true }], store, balances, NOW, { ...CFG, rail: "monero" });
  settleAndDrain([{ orderIndex: 5, idempotencyKey: "bitcoin:T:5", amount: 1_000_000, confirmations: CONF, final: true }], store, balances, NOW, { ...CFG, asset: "bitcoin", rail: "bitcoin" });
  expect(balances.getBalance("hmon")).toBe(5_000_000); // monero credited its own hash
  expect(balances.getBalance("hbtc")).toBe(5_000_000); // bitcoin credited too — the prefix kept the keys distinct
  expect(store.openOrders("monero").length).toBe(0); // each closed only its own row
  expect(store.openOrders("bitcoin").length).toBe(0);
  store.db.close();
  balances.db.close();
});
