// Steps 1 + 4 of the observability refactor. Step 1: a streaming settle() with no parseable usage is no longer a
// single "refunded in full" that pages — it splits three ways: shutdown DRAIN (routine, silent), mid-stream ABORT
// (WARN, billed when usage is evidenced and refunded otherwise), genuine clean-end-no-usage BREAK (ERROR); fixing the
// false-page where draining N live streams at restart paged N times. Step 4: each of those outcomes — plus the
// clean serve and the input-floor partial — is now COUNTED into a disjoint bucket (served / servedPartial /
// streamAborted / bill.refundedInFull), so `req` reconciles for streams too. These tests pin both.
import { test, expect, spyOn } from "bun:test";
import * as metrics from "../src/metrics";
import { createHandler, type HandlerDeps, type RailView } from "./support/handler-combined";
import { openDb, hashToken } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { byteBoundHold } from "../src/hold";
import { priceUsage } from "../src/cost";

function makeHandler(upstreamFetch: (url: string, init: any) => Promise<Response>, over: Partial<HandlerDeps> = {}) {
  const balances = openDb(":memory:");
  const deps: HandlerDeps = {
    anthropic: { apiKey: "k", baseUrl: "https://up.example", version: "2023-06-01", estimateHold: byteBoundHold },
    upstreamTimeoutMs: 1000,
    margin: 1.15, buyMinUsd: 5, buyMaxUsd: 2000, orderTtlMs: 4 * 60 * 60 * 1000, maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096, maxMessagesBodyBytes: 33_554_432, balances, orders: openOrderStore(":memory:"),
    upstreamFetch: upstreamFetch as typeof fetch,
    rails: new Map<string, RailView>([["monero", { name: "monero", createPayment: async () => ({ payTo: "8a", orderIndex: 0 }), rateUsd: async () => 150, scale: 1e12, unit: "XMR", confirmations: 10, paymentUri: (a, amt) => `monero:${a}?tx_amount=${amt}` }]]),
    defaultRail: "monero",
    ...over,
  };
  return { handler: createHandler(deps), balances };
}
const enc = new TextEncoder();
const sse = (events: any[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const streamReq = (token: string) => new Request("https://proxy.local/v1/messages", {
  method: "POST", headers: { "content-type": "application/json", "x-api-key": token },
  body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
});
// upstream that yields a fixed SSE script then closes cleanly
const streamOf = (events: any[]) => async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(sse(events))); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
// upstream that yields one SSE event per client pull, leaving the stream open until the next pull
const streamEventByEvent = (events: any[]) => async () => new Response(new ReadableStream<Uint8Array>({
  start(c) { (c as any)._n = 0; },
  pull(c) {
    const event = events[(c as any)._n++];
    if (event) c.enqueue(enc.encode(sse([event])));
    else c.close();
  },
}), { status: 200, headers: { "content-type": "text/event-stream" } });
// upstream that yields one chunk then errors mid-stream
const streamThenError = () => async () => new Response(new ReadableStream<Uint8Array>({ start(c) { (c as any)._n = 0; }, pull(c) { const n = (c as any)._n++; if (n === 0) c.enqueue(enc.encode("event: ping\ndata: {}\n\n")); else c.error(new Error("midstream boom")); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
// upstream that yields a usage-bearing message_start then fails at the transport layer
const streamUsageThenError = () => async () => new Response(new ReadableStream<Uint8Array>({
  start(c) { (c as any)._n = 0; },
  pull(c) {
    const n = (c as any)._n++;
    if (n === 0) {
      c.enqueue(enc.encode(sse([
        { type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "message_delta", usage: { output_tokens: 3 } },
      ])));
    } else {
      c.error(new Error("midstream boom after message_start"));
    }
  },
}), { status: 200, headers: { "content-type": "text/event-stream" } });
const warnText = (spy: any) => spy.mock.calls.map((c: any[]) => String(c[0])).join("\n");

test("shutdown drain of a live no-usage stream → full refund, NO refunded-in-full page", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  metrics.reset(0);
  const inflight = new Set<(r?: "drain") => void>();
  // a stream that opens but never produces a frame → stays live (settle pending) until we drain it
  let cancelled = false;
  const liveStream = async () => new Response(new ReadableStream<Uint8Array>({
    start() {},
    cancel() { cancelled = true; },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const { handler, balances } = makeHandler(liveStream, { inflight });
  const hash = hashToken("pr_d");
  balances.credit(hash, 10_000_000_000);
  const before = balances.getBalance(hash)!;

  const res = await handler(streamReq("pr_d")); // never read → settle stays pending in inflight
  expect(res.status).toBe(200);
  expect(inflight.size).toBe(1);
  [...inflight][0]("drain"); // shutdown drain
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget upstream cancellation run

  expect(cancelled).toBe(true); // even a no-usage stall must release the upstream read during shutdown
  expect(balances.getBalance(hash)).toBe(before); // refunded
  expect(metrics.snapshot().bill.refundedInFull).toBe(0); // routine, NOT the metering-break page
  expect([metrics.snapshot().streamAborted, metrics.snapshot().served]).toEqual([1, 0]); // counted stream:aborted, NOT served
  expect(warnText(errSpy)).not.toContain("without parseable usage");
  errSpy.mockRestore();
});

test("mid-stream upstream error → WARN (aborted), NO refunded-in-full page", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  metrics.reset(0);
  const { handler, balances } = makeHandler(streamThenError());
  const hash = hashToken("pr_e");
  balances.credit(hash, 10_000_000_000);
  const before = balances.getBalance(hash)!;

  const res = await handler(streamReq("pr_e"));
  expect(res.status).toBe(200);
  try { await res.text(); } catch { /* the response stream errors mid-read */ }

  expect(balances.getBalance(hash)).toBe(before); // refunded
  expect(metrics.snapshot().bill.refundedInFull).toBe(0); // aborted, not a leak
  expect([metrics.snapshot().streamAborted, metrics.snapshot().served]).toEqual([1, 0]); // stream:aborted, NOT served
  const line = warnText(errSpy);
  expect(line).toContain("stream aborted mid-flight"); // WARN emitted
  expect(line).not.toContain("without parseable usage"); // NOT the page
  errSpy.mockRestore();
});

test("in-band upstream error after message_start → bills reported partial, not a clean serve", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    const events = [
      { type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "message_delta", usage: { output_tokens: 3 } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ];
    const { handler, balances } = makeHandler(streamOf(events));
    const hash = hashToken("pr_inband_after_start");
    balances.credit(hash, 10_000_000_000);
    const before = balances.getBalance(hash)!;

    const res = await handler(streamReq("pr_inband_after_start"));
    expect(res.status).toBe(200); // the upstream committed SSE headers before reporting overload
    await res.text();

    const outcome = metrics.snapshot();
    const partial = priceUsage("claude-opus-4-8", { input_tokens: 5, output_tokens: 3 });
    expect([
      balances.getBalance(hash),
      outcome.streamAborted,
      outcome.served,
      outcome.servedPartial,
    ]).toEqual([
      before - partial, // provider reported the work before failing; only that observed partial is charged
      0,
      0,
      1,
    ]);
    expect(warnText(errSpy)).toContain("billed metered partial");
  } finally {
    errSpy.mockRestore();
  }
});

test("transport error after message_start → bills reported partial, not a clean serve", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    const { handler, balances } = makeHandler(streamUsageThenError());
    const hash = hashToken("pr_transport_after_start");
    balances.credit(hash, 10_000_000_000);
    const before = balances.getBalance(hash)!;

    const res = await handler(streamReq("pr_transport_after_start"));
    expect(res.status).toBe(200);
    try { await res.text(); } catch { /* the response stream propagates the upstream transport failure */ }

    const outcome = metrics.snapshot();
    const partial = priceUsage("claude-opus-4-8", { input_tokens: 5, output_tokens: 3 });
    expect([
      balances.getBalance(hash),
      outcome.streamAborted,
      outcome.served,
      outcome.servedPartial,
    ]).toEqual([
      before - partial,
      0,
      0,
      1,
    ]);
    expect(warnText(errSpy)).toContain("billed metered partial");
  } finally {
    errSpy.mockRestore();
  }
});

test("client cancel after a post-message_start error → upstream failure bills only reported partial", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    const events = [
      { type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      { type: "ping" },
    ];
    const { handler, balances } = makeHandler(streamEventByEvent(events));
    const hash = hashToken("pr_error_cancel_after_start");
    balances.credit(hash, 10_000_000_000);
    const before = balances.getBalance(hash)!;

    const res = await handler(streamReq("pr_error_cancel_after_start"));
    const reader = res.body!.getReader();
    await reader.read(); // message_start → usage is now parseable
    await reader.read(); // in-band error → scanner marks the upstream failure
    await reader.cancel("client aborts on error");

    const outcome = metrics.snapshot();
    const partial = priceUsage("claude-opus-4-8", { input_tokens: 5, output_tokens: 0 });
    expect([
      balances.getBalance(hash),
      outcome.streamAborted,
      outcome.served,
      outcome.servedPartial,
    ]).toEqual([before - partial, 0, 0, 1]);
    expect(warnText(errSpy)).toContain("billed metered partial");
  } finally {
    errSpy.mockRestore();
  }
});

test("clean end with NO parseable usage → refunded-in-full page (the genuine money leak still pages)", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  metrics.reset(0);
  // content delivered, but no message_start → the Anthropic scanner can't parse usage → result() is null
  const { handler, balances } = makeHandler(streamOf([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, { type: "message_stop" }]));
  const hash = hashToken("pr_g");
  balances.credit(hash, 10_000_000_000);
  const before = balances.getBalance(hash)!;

  const res = await handler(streamReq("pr_g"));
  await res.text(); // clean end

  expect(balances.getBalance(hash)).toBe(before); // refunded
  expect(metrics.snapshot().bill.refundedInFull).toBe(1); // the genuine break — still pages
  // the leak is its OWN outcome: not served, not a stream:abort, not a partial — disjoint from all three
  expect([metrics.snapshot().served, metrics.snapshot().streamAborted, metrics.snapshot().servedPartial]).toEqual([0, 0, 0]);
  expect(warnText(errSpy)).toContain("without parseable usage");
  errSpy.mockRestore();
});

test("clean end WITH parseable usage → served (the happy path), not a partial/abort/leak", async () => {
  metrics.reset(0);
  // message_start carries model + input usage; message_delta the output → the Anthropic scanner meters it → served
  const events = [{ type: "message_start", message: { model: "claude-opus-4-8", usage: { input_tokens: 5, output_tokens: 0 } } }, { type: "message_delta", usage: { output_tokens: 3 } }, { type: "message_stop" }];
  const { handler, balances } = makeHandler(streamOf(events));
  balances.credit(hashToken("pr_ok"), 10_000_000_000);

  const res = await handler(streamReq("pr_ok"));
  await res.text(); // clean end → settle bills actual

  const s = metrics.snapshot();
  expect([s.served, s.servedPartial, s.streamAborted, s.bill.refundedInFull]).toEqual([1, 0, 0, 0]); // exactly served
});

test("client disconnects on a live no-usage stream → served:partial (input-floor bill), not served/abort/leak", async () => {
  metrics.reset(0);
  // a stream that opens but never produces a usage frame; the client then disconnects after we forwarded the prompt
  const liveStream = async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const { handler, balances } = makeHandler(liveStream);
  const hash = hashToken("pr_p");
  balances.credit(hash, 10_000_000_000);
  const before = balances.getBalance(hash)!;

  const res = await handler(streamReq("pr_p"));
  await res.body!.cancel("client gone"); // the handler's cancel() → clientDisconnected → input-floor settle

  const s = metrics.snapshot();
  expect([s.servedPartial, s.served, s.streamAborted, s.bill.refundedInFull]).toEqual([1, 0, 0, 0]); // exactly served:partial
  expect(balances.getBalance(hash)).toBeLessThan(before); // billed the input floor (not a full refund)
});
