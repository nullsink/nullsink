// PROTOTYPE — a new test TYPE: scheduler-driven concurrency (linearizability) testing of the balance store.
//
// The existing db.property.test.ts model-runs commands SEQUENTIALLY. This complements it: fast-check's
// `scheduler()` drives many async "actors" against ONE shared :memory: store and explores their possible
// INTERLEAVINGS (with shrinking to a minimal failing schedule). It models the real prod concurrency the
// sequential test can't: a request's openHold→(await)→settleHold racing OTHER requests on the same token,
// and the poller's creditOnce landing in between. The invariants are conservation + non-negativity + no
// stranded hold, computed from each op's OBSERVED return — so they hold for ANY correct atomic ledger and
// FAIL if a debit/credit ever stops being atomic (e.g. a future refactor splits openHold into read-await-write,
// letting two actors both pass the balance check and overdraft).
import { test, expect } from "bun:test";
import fc from "fast-check";
import { openDb } from "../src/ledger/db";

const HASHES = ["h1", "h2", "h3"];

// A request actor: reserve a max-cost hold, yield, then settle it refunding (cost − actualCost).
type Req = { hash: string; cost: number; actual: number };
// A poller actor: an idempotent credit keyed by orderId (re-applies are no-ops).
type Cred = { hash: string; amount: number; orderId: string };

const reqArb = fc.record({
  hash: fc.constantFrom(...HASHES),
  cost: fc.integer({ min: 1, max: 500 }),
  actual: fc.nat({ max: 500 }),
});
const credArb = fc.record({
  hash: fc.constantFrom(...HASHES),
  amount: fc.integer({ min: 1, max: 400 }),
  orderId: fc.constantFrom("o1", "o2", "o3", "o4"), // small pool → re-applies collide → exercise idempotency
});

test("balance store is linearizable under arbitrary async interleaving (conservation, non-negative, no strand)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(reqArb, { minLength: 1, maxLength: 8 }),
      fc.array(credArb, { minLength: 0, maxLength: 6 }),
      // Seed each hash modestly so holds genuinely contend (some openHolds will be refused) rather than
      // every hold trivially fitting.
      fc.record({ h1: fc.nat({ max: 800 }), h2: fc.nat({ max: 800 }), h3: fc.nat({ max: 800 }) }),
      async (s, reqs, creds, seed) => {
        const r = openDb(":memory:");
        for (const h of HASHES) if (seed[h as keyof typeof seed] > 0) r.credit(h, seed[h as keyof typeof seed]);

        const seededTotal: Record<string, number> = { ...seed };
        const appliedCredit: Record<string, number> = { h1: 0, h2: 0, h3: 0 };
        const netDebit: Record<string, number> = { h1: 0, h2: 0, h3: 0 };
        let holdSeq = 0;

        // Each actor interleaves at `await s.schedule(...)` points; the scheduler picks the order and shrinks.
        const runReq = async (q: Req, i: number) => {
          const holdId = `H${i}-${holdSeq++}`;
          const refund = q.cost - Math.min(q.actual, q.cost); // refund ∈ [0, cost]; net debit = min(actual,cost)
          await s.schedule(Promise.resolve(), `req${i}:open`);
          const opened = r.openHold(q.hash, q.cost, holdId);
          await s.schedule(Promise.resolve(), `req${i}:settle`);
          if (opened) {
            const settled = r.settleHold(holdId, q.hash, refund);
            expect(settled).toBe(true); // a hold that opened MUST settle exactly once
            netDebit[q.hash] += q.cost - refund;
          }
        };
        const runCred = async (c: Cred, i: number) => {
          await s.schedule(Promise.resolve(), `cred${i}`);
          const fresh = r.creditOnce(c.hash, c.amount, c.orderId, 1000 + i);
          if (fresh) appliedCredit[c.hash] += c.amount;
        };

        const tasks = [
          ...reqs.map((q, i) => runReq(q, i)),
          ...creds.map((c, i) => runCred(c, i)),
        ];
        await s.waitAll();
        await Promise.all(tasks);

        // No hold left open after every request settled — a strand would double-refund at the next boot.
        expect(r.recoverHolds()).toEqual({ count: 0, micros: 0 });

        // Conservation + non-negativity, per hash, computed purely from observed op outcomes.
        for (const h of HASHES) {
          const expected = (seededTotal[h] ?? 0) + appliedCredit[h] - netDebit[h];
          const bal = r.getBalance(h) ?? 0;
          expect(bal).toBe(expected);
          expect(bal).toBeGreaterThanOrEqual(0); // never overdrawn under any interleaving
        }
        r.db.close();
      },
    ),
    { numRuns: 300 },
  );
});
