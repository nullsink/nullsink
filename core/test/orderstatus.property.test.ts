// Tests for the live /order-status progress tracker (src/orderstatus.ts). It holds no money and no
// durable state — these pin the merge semantics that keep the buyer's "confirming n/N" indicator honest:
// fold a tick's inbounds per order, never wipe an entry on a transient-empty tick, and forget an entry the
// moment its order closes (so a credited/reaped order can't linger as a ghost). Outputs that can never
// credit (e.g. Monero double-spend) are dropped by the rail, so they never reach this tracker — that's
// pinned in monero.property.test.ts, not here.
import { test, expect } from "bun:test";
import fc from "fast-check";
import { makeOrderStatus } from "../src/ledger/orderstatus";

test("folds a tick's inbounds per order: sums amounts, takes the max confirmations", () => {
  const s = makeOrderStatus();
  s.update(
    [
      { orderIndex: 0, amount: 100, confirmations: 2 },
      { orderIndex: 0, amount: 50, confirmations: 5 }, // same order → summed, max confs
      { orderIndex: 1, amount: 7, confirmations: 1 },
    ],
    [0, 1],
  );
  expect(s.get(0)).toEqual({ received_atomic: 150, confirmations: 5 });
  expect(s.get(1)).toEqual({ received_atomic: 7, confirmations: 1 });
  expect(s.get(2)).toBeUndefined();
});

test("an empty tick keeps last-known progress while the order is still open (transient-empty guard)", () => {
  const s = makeOrderStatus();
  s.update([{ orderIndex: 0, amount: 100, confirmations: 3 }], [0]);
  // The view-only wallet goes transiently blind mid-rescan (rails/monero.ts) — the order is still open, so
  // its progress must survive rather than flicker back to "waiting".
  s.update([], [0]);
  expect(s.get(0)).toEqual({ received_atomic: 100, confirmations: 3 });
});

test("an order reported again overwrites with the fresh aggregate (confirmations rise)", () => {
  const s = makeOrderStatus();
  s.update([{ orderIndex: 0, amount: 100, confirmations: 3 }], [0]);
  s.update([{ orderIndex: 0, amount: 100, confirmations: 8 }], [0]);
  expect(s.get(0)).toEqual({ received_atomic: 100, confirmations: 8 });
});

test("an entry is forgotten once its order closes (dropped from the open set)", () => {
  const s = makeOrderStatus();
  s.update([{ orderIndex: 0, amount: 100, confirmations: 12 }], [0]);
  expect(s.get(0)).toBeDefined();
  s.update([], []); // order credited/reaped → no longer open
  expect(s.get(0)).toBeUndefined();
});

test("a closed order drops even when this tick still reports its deposit (post-settle open set wins)", () => {
  // The poller computes the open set AFTER settle removed the just-credited order, so even if the wallet
  // still lists the deposit this tick, an order no longer open must not linger in the status map.
  const s = makeOrderStatus();
  s.update([{ orderIndex: 0, amount: 100, confirmations: 12 }], []);
  expect(s.get(0)).toBeUndefined();
});

test("after any update the map holds only currently-open orders", () => {
  const transferArb = fc.record({
    orderIndex: fc.nat({ max: 9 }),
    amount: fc.nat({ max: 1_000_000_000 }),
    confirmations: fc.nat({ max: 20 }),
  });
  fc.assert(
    fc.property(
      fc.array(transferArb, { maxLength: 20 }),
      fc.uniqueArray(fc.nat({ max: 9 }), { maxLength: 10 }),
      (transfers, openArr) => {
        const s = makeOrderStatus();
        s.update(transfers, openArr);
        const open = new Set(openArr);
        for (let i = 0; i <= 9; i++) {
          const p = s.get(i);
          if (p) {
            expect(open.has(i)).toBe(true); // never an entry outside the open set
            expect(p.received_atomic).toBeGreaterThanOrEqual(0);
            expect(p.confirmations).toBeGreaterThanOrEqual(0);
          }
        }
      },
    ),
    { numRuns: 300 },
  );
});

test("rail namespacing: two rails' same order_index never collide, and a per-rail forget spares the other", () => {
  const s = makeOrderStatus();
  s.update([{ orderIndex: 5, amount: 100, confirmations: 2 }], [5], "monero");
  s.update([{ orderIndex: 5, amount: 7, confirmations: 9 }], [5], "bitcoin"); // same index, other rail
  expect(s.get(5, "monero")).toEqual({ received_atomic: 100, confirmations: 2 });
  expect(s.get(5, "bitcoin")).toEqual({ received_atomic: 7, confirmations: 9 });

  // a monero tick that closes monero-5 must NOT forget bitcoin-5:
  s.update([], [], "monero");
  expect(s.get(5, "monero")).toBeUndefined();
  expect(s.get(5, "bitcoin")).toEqual({ received_atomic: 7, confirmations: 9 });
});
