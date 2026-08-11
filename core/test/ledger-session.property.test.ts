import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  openDb,
  type SessionOpenHoldResult,
  type SessionSettleHoldResult,
} from "../src/ledger/db";

const HASH = "a".repeat(64);
const SESSIONS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;
const HOLDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
] as const;

type Op =
  | { kind: "begin"; session: number }
  | { kind: "open"; session: number; hold: number; micros: number }
  | { kind: "settle"; session: number; hold: number; charge: number };

test("session state machine conserves balances across replay, conflict, stale calls, and session changes", () => {
  const op = fc.oneof(
    fc.record({ kind: fc.constant("begin" as const), session: fc.integer({ min: 0, max: 1 }) }),
    fc.record({
      kind: fc.constant("open" as const),
      session: fc.integer({ min: 0, max: 1 }),
      hold: fc.integer({ min: 0, max: 2 }),
      micros: fc.integer({ min: 0, max: 400 }),
    }),
    fc.record({
      kind: fc.constant("settle" as const),
      session: fc.integer({ min: 0, max: 1 }),
      hold: fc.integer({ min: 0, max: 2 }),
      charge: fc.integer({ min: 0, max: 400 }),
    }),
  );

  fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 150 }), (ops: Op[]) => {
    const ledger = openDb(":memory:");
    ledger.credit(HASH, 1_000);
    let balance = 1_000;
    let totalCharged = 0;
    let current: string | null = null;
    const active = new Map<string, { session: string; micros: number }>();
    const settled = new Map<string, { session: string; charge: number }>();

    for (let i = 0; i < ops.length; i++) {
      const operation = ops[i]!;
      const session = SESSIONS[operation.session]!;
      if (operation.kind === "begin") {
        if (current === session) {
          expect(ledger.beginSession(session, i).outcome).toBe("current");
        } else {
          const recovered = [...active.values()].reduce((sum, hold) => sum + hold.micros, 0);
          const result = ledger.beginSession(session, i);
          expect(result).toEqual({
            outcome: "started",
            recoveredHolds: active.size,
            recoveredMicros: recovered,
          });
          balance += recovered;
          active.clear();
          settled.clear();
          current = session;
        }
      } else if (operation.kind === "open") {
        const holdId = HOLDS[operation.hold]!;
        let expected: SessionOpenHoldResult;
        if (current !== session) expected = "stale_session";
        else if (active.has(holdId)) {
          const existing = active.get(holdId)!;
          expected = existing.session === session && existing.micros === operation.micros ? "already_open" : "conflict";
        } else if (settled.has(holdId)) expected = "conflict";
        else if (balance < operation.micros) expected = "insufficient_balance";
        else {
          expected = "opened";
          balance -= operation.micros;
          active.set(holdId, { session, micros: operation.micros });
        }
        expect(ledger.openSessionHold(session, HASH, operation.micros, holdId, i)).toBe(expected);
      } else {
        const holdId = HOLDS[operation.hold]!;
        let expected: SessionSettleHoldResult;
        if (current !== session) expected = "stale_session";
        else if (settled.has(holdId)) {
          const existing = settled.get(holdId)!;
          expected = existing.session === session && existing.charge === operation.charge ? "already_settled" : "conflict";
        } else if (!active.has(holdId)) expected = "unknown_hold";
        else {
          const hold = active.get(holdId)!;
          if (hold.session !== session) expected = "conflict";
          else if (operation.charge > hold.micros) expected = "invalid_charge";
          else {
            expected = "settled";
            balance += hold.micros - operation.charge;
            totalCharged += operation.charge;
            active.delete(holdId);
            settled.set(holdId, { session, charge: operation.charge });
          }
        }
        expect(ledger.settleSessionHold(session, holdId, operation.charge, i)).toBe(expected);
      }

      expect(ledger.getBalance(HASH)).toBe(balance);
      expect(balance).toBeGreaterThanOrEqual(0);
      const reserved = [...active.values()].reduce((sum, hold) => sum + hold.micros, 0);
      expect(balance + reserved + totalCharged).toBe(1_000);
    }
    ledger.db.close();
  }), { numRuns: 200 });
});
