// Exactly-once across the SOCKET path, as a property. credit-socket.test.ts covers the crossing with a handful
// of hand-picked cases; the money-property tests (settle/outbox/revenue) drive the TEST-ONLY in-process drain
// (ledger/drain.ts). Neither stresses the PRODUCTION drain — drainCreditOutboxOverSocket — under arbitrary
// interleavings of its distinctive failure mode: an AMBIGUOUS result (a timeout / lost response) where the proxy
// may or may not have committed. The dangerous case is "applied, but the ack was lost": the row stays unacked,
// the next tick re-sends the same idempotency_key, and only applied_orders on the receiver keeps it exactly-once.
//
// This wraps the REAL receiver (createCreditHandler) in a sender that randomly injects all three outcomes and
// asserts, over many generated runs: no credit is lost (the outbox fully drains) and none is double-applied (each
// hash's balance is exactly the sum of its distinct credits). The sender falls back to definite-success once the
// generated fault script is exhausted, so the fail-closed head-of-line stop can't wedge the run forever.
import { test, expect } from "bun:test";
import fc from "fast-check";
import { openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { createCreditHandler } from "../src/credit-server";
import { drainCreditOutboxOverSocket, type CreditSender } from "../src/credit-sender";
import { CREDIT_PATH, CREDIT_WIRE_HEADER, CREDIT_WIRE_VERSION } from "../src/credit-wire";

const NOW = 1_700_000_000_000;
const HASHES = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];

type Fault = "definite" | "ambiguous_before_apply" | "ambiguous_after_apply";

// A CreditSender that forwards to the real credit handler but injects faults from a script (one per send call).
// - definite: deliver, return the real applied/already_applied ack.
// - ambiguous_before_apply: the request never reached the proxy (connect refused / pre-arrival timeout) — nothing
//   is credited; return the same {ok:false} the real sender returns on such errors.
// - ambiguous_after_apply: the proxy DID commit the credit, but the response was lost — return {ok:false} anyway.
//   This is the exactly-once crucible: the retry must see already_applied and never double-credit.
function chaosSender(balances: ReturnType<typeof openDb>, script: Fault[]): CreditSender {
  const h = createCreditHandler(balances, () => NOW);
  let i = 0;
  return async (c) => {
    const fault: Fault = i < script.length ? script[i]! : "definite"; // exhausted → always succeed (terminates)
    i++;
    if (fault === "ambiguous_before_apply") return { ok: false, reason: "connect_refused" };
    const res = await h(
      new Request(`http://x${CREDIT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [CREDIT_WIRE_HEADER]: String(CREDIT_WIRE_VERSION) },
        body: JSON.stringify(c),
      }),
    );
    const body = (await res.json()) as { result?: string };
    if (fault === "ambiguous_after_apply") return { ok: false, reason: "lost_ack" }; // applied, but ack lost
    if (body.result === "applied" || body.result === "already_applied") return { ok: true, outcome: body.result };
    return { ok: false, reason: "unrecognized_response" };
  };
}

test("socket drain is exactly-once and loses nothing under arbitrary ambiguity interleavings", async () => {
  await fc.assert(
    fc.asyncProperty(
      // Distinct credits (deduped by idempotency_key below); each targets one of a few hashes and adds micros.
      fc.array(fc.record({ hashIdx: fc.integer({ min: 0, max: HASHES.length - 1 }), micros: fc.integer({ min: 1, max: 1_000_000 }) }), {
        minLength: 1,
        maxLength: 12,
      }),
      // The fault script: one outcome consumed per send attempt (retries consume more). Bounded, so the run ends.
      fc.array(fc.constantFrom<Fault>("definite", "ambiguous_before_apply", "ambiguous_after_apply"), { maxLength: 60 }),
      async (credits, script) => {
        const balances = openDb(":memory:");
        const orders = openOrderStore(":memory:");

        // Enqueue with distinct keys; track the expected exactly-once total per hash (enqueueCredit is idempotent
        // per key, but keys here are already distinct, so every credit counts once).
        const expected = new Map<string, number>();
        credits.forEach((c, idx) => {
          const hash = HASHES[c.hashIdx]!;
          if (orders.enqueueCredit(`tx:${idx}`, hash, c.micros, idx)) expected.set(hash, (expected.get(hash) ?? 0) + c.micros);
        });

        const send = chaosSender(balances, script);
        // Drain repeatedly (each tick may stop at the first ambiguous row) until the outbox is empty. The cap far
        // exceeds any generated script; hitting it would itself be a failure (a wedged queue = lost money).
        let ticks = 0;
        while (orders.listUnackedCredits().length > 0) {
          if (ticks++ > 400) throw new Error("outbox never drained — credit stuck");
          await drainCreditOutboxOverSocket(orders, send, NOW);
        }

        // No credit lost: the outbox drained clean.
        expect(orders.listUnackedCredits()).toEqual([]);
        // Exactly once: each hash holds precisely the sum of its distinct credits — no double-apply from a retried
        // lost-ack, and no missing credit.
        for (const [hash, total] of expected) expect(balances.getBalance(hash)).toBe(total);
        // Global check: total liability equals the sum of all credits and covers exactly the funded hashes, so no
        // phantom credit landed anywhere. liabilityTotal().micros is a bigint (sum), .tokens the funded-hash count.
        const sum = [...expected.values()].reduce((a, b) => a + b, 0);
        const liability = balances.liabilityTotal();
        expect(liability.micros).toBe(BigInt(sum));
        expect(liability.tokens).toBe(expected.size);

        balances.db.close();
        orders.db.close();
      },
    ),
    { numRuns: 200 },
  );
});
