// Model-based (stateful) property test for the balance store. fast-check generates random sequences
// of credit / hold / creditOnce / openHold / settleHold / recoverHolds / purgeApplied / getBalance and runs
// each against BOTH the real SQLite store (a fresh :memory: db per sequence) and a pure in-memory reference
// model. After every command we assert the two agree, so any divergence — a botched atomic debit, a
// double-credit, a purge that forgets too much, a hold refunded twice — surfaces as a shrunk, minimal
// failing sequence (with a seed to repro).
//
// The interesting invariants this exercises, without enumerating cases by hand:
//   - hold() debits iff the token is known AND the balance covers it (overdraft race / unknown token)
//   - openHold() debits + journals atomically iff the balance covers it (else writes nothing)
//   - settleHold() closes a hold AT MOST once — a repeat finds no row and refunds nothing (drain race)
//   - recoverHolds() refunds every open hold IN FULL and clears the journal (crash recovery), then no-ops
//   - creditOnce() applies exactly once per orderId — repeats are no-ops (poller re-scan idempotency)
//   - purgeApplied() drops only markers strictly older than the cutoff, after which that orderId can
//     legitimately credit again (the backstop-horizon re-credit path)
//   - credit() with a negative amount claws back and may drive a balance negative (hold under-estimate)
import { test, expect } from "bun:test";
import fc from "fast-check";
import { openDb, type BalanceStore } from "../src/ledger/db";

// applied: orderId -> applied_at, mirroring the applied_orders table so we can model purge precisely.
// holds: hold_id -> {hash, micros}, mirroring the holds journal so we can model open / settle / recover.
type Model = {
  balances: Map<string, number>;
  applied: Map<string, number>;
  holds: Map<string, { hash: string; micros: number }>;
};

// Small fixed pools so collisions actually happen — that's what exercises idempotency and the
// conditional debit. With unique values every op would hit a distinct row and prove nothing.
const hashArb = fc.constantFrom("h1", "h2", "h3");
const orderArb = fc.constantFrom("o1", "o2", "o3", "o4");
const holdIdArb = fc.constantFrom("k1", "k2", "k3", "k4"); // hold_id pool — collisions exercise settle/recover
const microsArb = fc.integer({ min: -1000, max: 1000 }); // signed: credit can claw back
const holdArb = fc.nat({ max: 1000 }); // holds are never negative in real use
const atMsArb = fc.nat({ max: 1000 });

class CreditCmd implements fc.Command<Model, BalanceStore> {
  constructor(readonly hash: string, readonly micros: number) {}
  check = () => true;
  run(m: Model, r: BalanceStore): void {
    r.credit(this.hash, this.micros);
    m.balances.set(this.hash, (m.balances.get(this.hash) ?? 0) + this.micros);
    expect(r.getBalance(this.hash)).toBe(m.balances.get(this.hash)!);
  }
  toString = () => `credit(${this.hash}, ${this.micros})`;
}

class HoldCmd implements fc.Command<Model, BalanceStore> {
  constructor(readonly hash: string, readonly micros: number) {}
  check = () => true;
  run(m: Model, r: BalanceStore): void {
    const known = m.balances.has(this.hash);
    const bal = m.balances.get(this.hash) ?? 0;
    const expected = known && bal >= this.micros; // debit only when the (known) balance covers it
    expect(r.hold(this.hash, this.micros)).toBe(expected);
    if (expected) m.balances.set(this.hash, bal - this.micros);
  }
  toString = () => `hold(${this.hash}, ${this.micros})`;
}

class CreditOnceCmd implements fc.Command<Model, BalanceStore> {
  constructor(
    readonly hash: string,
    readonly micros: number,
    readonly orderId: string,
    readonly atMs: number,
  ) {}
  check = () => true;
  run(m: Model, r: BalanceStore): void {
    const fresh = !m.applied.has(this.orderId);
    expect(r.creditOnce(this.hash, this.micros, this.orderId, this.atMs)).toBe(fresh);
    if (fresh) {
      m.applied.set(this.orderId, this.atMs);
      m.balances.set(this.hash, (m.balances.get(this.hash) ?? 0) + this.micros);
    }
    expect(r.getBalance(this.hash)).toBe(m.balances.get(this.hash) ?? null);
  }
  toString = () => `creditOnce(${this.hash}, ${this.micros}, ${this.orderId}, ${this.atMs})`;
}

class PurgeAppliedCmd implements fc.Command<Model, BalanceStore> {
  constructor(readonly beforeMs: number) {}
  check = () => true;
  run(m: Model, r: BalanceStore): void {
    r.purgeApplied(this.beforeMs);
    for (const [id, at] of m.applied) if (at < this.beforeMs) m.applied.delete(id);
  }
  toString = () => `purgeApplied(${this.beforeMs})`;
}

class GetBalanceCmd implements fc.Command<Model, BalanceStore> {
  constructor(readonly hash: string) {}
  check = () => true;
  run(m: Model, r: BalanceStore): void {
    expect(r.getBalance(this.hash)).toBe(m.balances.get(this.hash) ?? null);
  }
  toString = () => `getBalance(${this.hash})`;
}

class OpenHoldCmd implements fc.Command<Model, BalanceStore> {
  constructor(
    readonly hash: string,
    readonly micros: number,
    readonly holdId: string,
  ) {}
  // Never open a hold_id that's already open: the real INSERT would throw on the PK, and production mints a
  // fresh uuid per request, so a reused open id can't occur there either.
  check = (m: Model) => !m.holds.has(this.holdId);
  run(m: Model, r: BalanceStore): void {
    const known = m.balances.has(this.hash);
    const bal = m.balances.get(this.hash) ?? 0;
    const expected = known && bal >= this.micros; // debit + journal only when the known balance covers it
    expect(r.openHold(this.hash, this.micros, this.holdId)).toBe(expected);
    if (expected) {
      m.balances.set(this.hash, bal - this.micros);
      m.holds.set(this.holdId, { hash: this.hash, micros: this.micros });
    }
    expect(r.getBalance(this.hash)).toBe(m.balances.get(this.hash) ?? null);
  }
  toString = () => `openHold(${this.hash}, ${this.micros}, ${this.holdId})`;
}

class SettleHoldCmd implements fc.Command<Model, BalanceStore> {
  constructor(readonly holdId: string, readonly refundRaw: number) {}
  check = () => true;
  run(m: Model, r: BalanceStore): void {
    const open = m.holds.get(this.holdId);
    // An open hold settles against its OWN hash with a refund clamped to [0, micros] (what handler.ts does);
    // an unopened id is a no-op regardless of the args.
    const hash = open ? open.hash : "h1";
    const refund = open ? Math.max(0, Math.min(this.refundRaw, open.micros)) : this.refundRaw;
    expect(r.settleHold(this.holdId, hash, refund)).toBe(open != null);
    if (open) {
      m.holds.delete(this.holdId);
      if (refund > 0) m.balances.set(hash, (m.balances.get(hash) ?? 0) + refund);
      expect(r.getBalance(hash)).toBe(m.balances.get(hash)!);
    }
  }
  toString = () => `settleHold(${this.holdId}, ${this.refundRaw})`;
}

class RecoverHoldsCmd implements fc.Command<Model, BalanceStore> {
  check = () => true;
  run(m: Model, r: BalanceStore): void {
    let micros = 0;
    for (const h of m.holds.values()) micros += h.micros;
    const res = r.recoverHolds();
    expect(res.count).toBe(m.holds.size);
    expect(res.micros).toBe(micros);
    for (const { hash, micros: hm } of m.holds.values())
      m.balances.set(hash, (m.balances.get(hash) ?? 0) + hm);
    m.holds.clear();
  }
  toString = () => `recoverHolds()`;
}

const commands = [
  fc.tuple(hashArb, microsArb).map(([h, v]) => new CreditCmd(h, v)),
  fc.tuple(hashArb, holdArb).map(([h, v]) => new HoldCmd(h, v)),
  fc
    .tuple(hashArb, microsArb, orderArb, atMsArb)
    .map(([h, v, o, t]) => new CreditOnceCmd(h, v, o, t)),
  fc.tuple(hashArb, holdArb, holdIdArb).map(([h, v, k]) => new OpenHoldCmd(h, v, k)),
  fc.tuple(holdIdArb, microsArb).map(([k, v]) => new SettleHoldCmd(k, v)),
  fc.constant(null).map(() => new RecoverHoldsCmd()),
  atMsArb.map((t) => new PurgeAppliedCmd(t)),
  hashArb.map((h) => new GetBalanceCmd(h)),
];

test("balance store matches the reference model across random op sequences", () => {
  fc.assert(
    fc.property(fc.commands(commands, { size: "+1" }), (cmds) => {
      const setup = () => ({
        model: {
          balances: new Map<string, number>(),
          applied: new Map<string, number>(),
          holds: new Map<string, { hash: string; micros: number }>(),
        },
        real: openDb(":memory:"),
      });
      fc.modelRun(setup, cmds);
    }),
    { numRuns: 500 },
  );
});

// --- Explicit hold-lifecycle cases (documentation + the crash-recovery invariant in plain form) ---

test("recoverHolds refunds every open hold in full — a crash restores balances", () => {
  const r = openDb(":memory:");
  r.credit("h1", 1000);
  r.credit("h2", 500);
  expect(r.openHold("h1", 300, "H1")).toBe(true);
  expect(r.openHold("h2", 500, "H2")).toBe(true);
  expect(r.getBalance("h1")).toBe(700); // debited up front
  expect(r.getBalance("h2")).toBe(0);
  // Simulate a hard crash: the requests never settle. Boot recovery refunds the strays in full.
  expect(r.recoverHolds()).toEqual({ count: 2, micros: 800 });
  expect(r.getBalance("h1")).toBe(1000);
  expect(r.getBalance("h2")).toBe(500);
  // Idempotent: a second recovery finds an empty journal and is a no-op.
  expect(r.recoverHolds()).toEqual({ count: 0, micros: 0 });
  expect(r.getBalance("h1")).toBe(1000);
});

test("settleHold refunds once and is idempotent — a drain racing the natural settle can't double-refund", () => {
  const r = openDb(":memory:");
  r.credit("h1", 1000);
  expect(r.openHold("h1", 400, "H")).toBe(true); // balance 600
  // actual cost 250 → refund 150
  expect(r.settleHold("H", "h1", 150)).toBe(true);
  expect(r.getBalance("h1")).toBe(750);
  // A second settle (e.g. the shutdown drain after the natural one) → no-op, no double refund.
  expect(r.settleHold("H", "h1", 150)).toBe(false);
  expect(r.getBalance("h1")).toBe(750);
  // And boot recovery ignores the already-closed hold.
  expect(r.recoverHolds()).toEqual({ count: 0, micros: 0 });
  expect(r.getBalance("h1")).toBe(750);
});

test("openHold writes no journal row and makes no debit when the balance can't cover it", () => {
  const r = openDb(":memory:");
  r.credit("h1", 100);
  expect(r.openHold("h1", 200, "H")).toBe(false); // insufficient
  expect(r.getBalance("h1")).toBe(100); // untouched
  expect(r.openHold("unknown", 50, "H2")).toBe(false); // unknown token
  expect(r.recoverHolds()).toEqual({ count: 0, micros: 0 }); // nothing was journaled
});
