// Handler-level state-machine coverage for terminal races. Scanner properties already prove that network
// chunking cannot alter usage; this property proves that client cancel, shutdown drain, and the settle
// deadline cannot settle one live hold twice or change the first terminal decision.
import { expect, test } from "bun:test";
import fc from "fast-check";
import { createHandler, type HandlerDeps, type RailView } from "./support/handler-combined";
import { byteBoundHold } from "../src/hold";
import { hashToken, openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import * as metrics from "../src/metrics";

type Terminal = "cancel" | "drain" | "deadline";
type Evidence = "none" | "estimated" | "reported";
const INITIAL = 10_000_000_000;
const enc = new TextEncoder();

const terminalOrders: Terminal[][] = [
  ["cancel", "drain", "deadline"],
  ["cancel", "deadline", "drain"],
  ["drain", "cancel", "deadline"],
  ["drain", "deadline", "cancel"],
  ["deadline", "cancel", "drain"],
  ["deadline", "drain", "cancel"],
];

// Independent gpt-5 acceptance oracle: $1.25/M input and $10/M output become the same number of
// microdollars per token. Deliberately does not call production pricing code.
const gpt5Cost = (input: number, output: number) => Math.floor(input * 1.25 + output * 10);

function makeHandler(
  upstreamFetch: typeof fetch,
  inflight: Set<(reason?: "drain") => void>,
  captureDeadline: (fire: () => void) => void,
) {
  const balances = openDb(":memory:");
  const deps: HandlerDeps = {
    openai: { apiKey: "openai-key", baseUrl: "https://openai.example", estimateHold: byteBoundHold },
    upstreamTimeoutMs: 1000,
    margin: 1.15,
    buyMinUsd: 5,
    buyMaxUsd: 2000,
    orderTtlMs: 4 * 60 * 60 * 1000,
    maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096,
    maxMessagesBodyBytes: 33_554_432,
    balances,
    orders: openOrderStore(":memory:"),
    upstreamFetch,
    inflight,
    scheduleStreamDeadline: (fire) => {
      captureDeadline(fire);
      return () => {};
    },
    rails: new Map<string, RailView>([["monero", {
      name: "monero",
      createAddress: async () => ({ address: "8property", orderIndex: 0 }),
      rateUsd: async () => 150,
      scale: 1_000_000_000_000,
      unit: "XMR",
      confirmations: 10,
      paymentUri: (address, amount) => `monero:${address}?tx_amount=${amount}`,
    }]]),
    defaultRail: "monero",
  };
  return { handler: createHandler(deps), balances };
}

function eventFor(evidence: Evidence): string {
  const event = evidence === "none"
    ? { model: "gpt-5", choices: [{ delta: { role: "assistant", content: "" } }] }
    : evidence === "estimated"
      ? { model: "gpt-5", choices: [{ delta: { content: "12345678" } }] }
      : { model: "gpt-5", choices: [], usage: { prompt_tokens: 37, completion_tokens: 11 } };
  return `data: ${JSON.stringify(event)}\n\n`;
}

test("property · first terminal event wins across real handler cancel/drain/deadline permutations", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom<Evidence>("none", "estimated", "reported"),
    async (evidence) => {
      for (const order of terminalOrders) {
        metrics.reset(0);
        const inflight = new Set<(reason?: "drain") => void>();
        let fireDeadline: (() => void) | undefined;
        const upstreamFetch = (async () => new Response(new ReadableStream<Uint8Array>({
          start(controller) { (controller as any)._sent = false; },
          pull(controller) {
            if (!(controller as any)._sent) {
              (controller as any)._sent = true;
              controller.enqueue(enc.encode(eventFor(evidence)));
            }
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
        const { handler, balances } = makeHandler(upstreamFetch, inflight, (fire) => { fireDeadline = fire; });
        const token = `pr_terminal_${evidence}_${order.join("_")}`;
        const body = {
          model: "gpt-5",
          max_completion_tokens: 40_000,
          stream: true,
          messages: [{ role: "user", content: "x".repeat(800) }],
        };
        balances.credit(hashToken(token), INITIAL);
        const response = await handler(new Request("https://proxy.local/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }));
        const reader = response.body!.getReader();
        await reader.read(); // make the chosen evidence visible to the production scanner

        for (const terminal of order) {
          if (terminal === "cancel") await reader.cancel("property cancel").catch(() => {});
          if (terminal === "drain") for (const settle of [...inflight]) settle("drain");
          if (terminal === "deadline") fireDeadline!();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));

        const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 4);
        const expected = evidence === "reported"
          ? gpt5Cost(37, 11)
          : evidence === "estimated"
            ? gpt5Cost(estimatedInput, 2)
            : order[0] === "drain" ? 0 : gpt5Cost(estimatedInput, 0);
        const debit = INITIAL - balances.getBalance(hashToken(token))!;
        const snapshot = metrics.snapshot();
        const primaryOutcomes = snapshot.served + snapshot.servedPartial + snapshot.streamAborted
          + snapshot.bill.refundedInFull + Object.values(snapshot.upstream).reduce((sum, n) => sum + n, 0);
        const holds = (balances.db.query("SELECT COUNT(*) AS n FROM holds").get() as { n: number }).n;

        expect(debit).toBe(expected);
        expect(debit).toBeLessThanOrEqual(byteBoundHold({
          model: body.model,
          raw: JSON.stringify(body),
          body,
          maxTokens: body.max_completion_tokens,
        }).micros);
        expect(holds).toBe(0);
        expect(primaryOutcomes).toBe(1);
        expect(snapshot.requests).toBe(1);
      }
    },
  ), { examples: [["none"], ["estimated"], ["reported"]], numRuns: 12 });
});
