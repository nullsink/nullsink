// Human-reviewable billing contract for failures and cancellation.
//
// These tests intentionally read as business outcomes rather than implementation units. They exercise the
// real handler, response streams, hold journal, balance, and aggregate metrics through in-memory stores and a
// deterministic fake provider. If the policy changes, review the scenario name + assertions before changing
// production code.
import { expect, spyOn, test } from "bun:test";
import { createHandler, type HandlerDeps, type RailView } from "./support/handler-combined";
import type { Usage } from "../src/cost";
import { byteBoundHold } from "../src/hold";
import { hashToken, openDb, type BalanceStore } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import * as metrics from "../src/metrics";

type Upstream = (url: string, init: RequestInit) => Promise<Response>;
const INITIAL = 10_000_000_000;
const enc = new TextEncoder();

// Independent acceptance oracle: these committed USD/Mtoken rates are copied from the public rate card,
// not read through production priceUsage/costOf. Since one USD/Mtoken equals one microdollar/token, the
// contract can calculate its expected ledger debit directly and catch a shared pricing-code regression.
const CONTRACT_RATES = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, cacheWrite1h: 0 },
} as const;

function contractCost(model: string, usage: Usage): number {
  if (!(model in CONTRACT_RATES)) throw new Error(`contract rate missing for ${model}`);
  const rate = CONTRACT_RATES[model as keyof typeof CONTRACT_RATES];
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheWrite1h = Math.min(usage.cache_creation_1h_input_tokens ?? 0, cacheWrite);
  return Math.floor(
    (usage.input_tokens ?? 0) * rate.input
      + (usage.output_tokens ?? 0) * rate.output
      + (usage.cache_read_input_tokens ?? 0) * rate.cacheRead
      + (cacheWrite - cacheWrite1h) * rate.cacheWrite
      + cacheWrite1h * rate.cacheWrite1h,
  );
}

function makeHandler(upstreamFetch: Upstream, over: Partial<HandlerDeps> = {}) {
  const balances = openDb(":memory:");
  const deps: HandlerDeps = {
    anthropic: { apiKey: "anthropic-key", baseUrl: "https://anthropic.example", version: "2023-06-01", estimateHold: byteBoundHold },
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
    upstreamFetch: upstreamFetch as typeof fetch,
    rails: new Map<string, RailView>([["monero", {
      name: "monero",
      createAddress: async () => ({ address: "8contract", orderIndex: 0 }),
      rateUsd: async () => 150,
      scale: 1_000_000_000_000,
      unit: "XMR",
      confirmations: 10,
      paymentUri: (address, amount) => `monero:${address}?tx_amount=${amount}`,
    }]]),
    defaultRail: "monero",
    ...over,
  };
  return { handler: createHandler(deps), balances };
}

function anthropicRequest(token: string, body: object): Request {
  return new Request("https://proxy.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify(body),
  });
}

function openAIRequest(token: string, body: object): Request {
  return new Request("https://proxy.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function fund(balances: BalanceStore, token: string): void {
  balances.credit(hashToken(token), INITIAL);
}

function debit(balances: BalanceStore, token: string): number {
  return INITIAL - balances.getBalance(hashToken(token))!;
}

function holdsCount(balances: BalanceStore): number {
  return (balances.db.query("SELECT COUNT(*) AS n FROM holds").get() as { n: number }).n;
}

function reconciledOutcomeCount(): number {
  const s = metrics.snapshot();
  return s.served + s.servedPartial + s.streamAborted + s.bill.refundedInFull
    + Object.values(s.upstream).reduce((sum, n) => sum + n, 0);
}

function sseData(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function cleanStream(chunks: string[]): Upstream {
  return async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function transportFailureAfter(chunks: string[], onCancel?: () => void): Upstream {
  return async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { (controller as any)._index = 0; },
    pull(controller) {
      const index = (controller as any)._index++;
      if (index < chunks.length) controller.enqueue(enc.encode(chunks[index]!));
      else controller.error(new Error("provider transport broke"));
    },
    cancel() { onCancel?.(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function openUntilCancelled(chunks: string[], onCancel: () => void): Upstream {
  return async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { (controller as any)._index = 0; },
    pull(controller) {
      const index = (controller as any)._index++;
      if (index < chunks.length) controller.enqueue(enc.encode(chunks[index]!));
      // Deliberately remain open after the scripted chunks. The downstream cancellation is the terminal event.
    },
    cancel() { onCancel(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("HTTP contract · provider sends 200 headers then its buffered body breaks → user receives 502 and pays input only", async () => {
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    const partialMarker = "provider-partial-must-not-reach-user";
    const upstream: Upstream = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { (controller as any)._sent = false; },
      pull(controller) {
        if (!(controller as any)._sent) {
          (controller as any)._sent = true;
          controller.enqueue(enc.encode(`{\"content\":\"${partialMarker}`));
        } else {
          controller.error(new Error("body broke after 200 headers"));
        }
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const { handler, balances } = makeHandler(upstream);
    const token = "pr_contract_http_break";
    const body = { model: "claude-opus-4-8", max_tokens: 1000, messages: [{ role: "user", content: "hello" }] };
    fund(balances, token);

    const response = await handler(anthropicRequest(token, body));
    const responseText = await response.text();

    expect(response.status).toBe(502); // upstream's 200 was never forwarded
    expect(responseText).not.toContain(partialMarker); // buffered partial body remains private
    const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 4);
    const expected = contractCost(body.model, { input_tokens: estimatedInput, output_tokens: 0 });
    expect(debit(balances, token)).toBe(expected);
    expect(holdsCount(balances)).toBe(0);
    expect(metrics.snapshot().failure.bufferedInputFloor).toEqual({ count: 1, micros: expected });
    expect(reconciledOutcomeCount()).toBe(metrics.snapshot().requests);
  } finally {
    logSpy.mockRestore();
  }
});

test("HTTP cancellation contract · caller leaves before headers → accepted upstream work continues and exact terminal usage is billed", async () => {
  metrics.reset(0);
  let releaseUpstream!: () => void;
  let markStarted!: (signal: AbortSignal) => void;
  const released = new Promise<void>((resolve) => { releaseUpstream = resolve; });
  const started = new Promise<AbortSignal>((resolve) => { markStarted = resolve; });
  const reported = { prompt_tokens: 23, completion_tokens: 7 };
  const upstream: Upstream = async (_url, init) => {
    markStarted(init.signal as AbortSignal);
    await released;
    return new Response(JSON.stringify({ model: "gpt-5", usage: reported }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { handler, balances } = makeHandler(upstream);
  const token = "pr_contract_http_cancel";
  const body = { model: "gpt-5", max_completion_tokens: 100, messages: [{ role: "user", content: "hello" }] };
  const caller = new AbortController();
  fund(balances, token);

  const pending = handler(new Request("https://proxy.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: caller.signal,
  }));
  const upstreamSignal = await started;
  caller.abort("caller disconnected");
  expect(upstreamSignal.aborted).toBe(false); // inbound abort is intentionally not forwarded before headers
  releaseUpstream();
  const response = await pending;

  expect(response.status).toBe(200);
  expect(debit(balances, token)).toBe(contractCost(body.model, { input_tokens: 23, output_tokens: 7 }));
  expect(holdsCount(balances)).toBe(0);
});

test("SSE contract · provider sends 200 then transport breaks before usage/output → user has a broken 200 stream and pays nothing", async () => {
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    const { handler, balances } = makeHandler(transportFailureAfter([sseData([{ type: "ping" }])]));
    const token = "pr_contract_stream_refund";
    const body = { model: "claude-opus-4-8", max_tokens: 1000, stream: true, messages: [{ role: "user", content: "hello" }] };
    fund(balances, token);

    const response = await handler(anthropicRequest(token, body));
    expect(response.status).toBe(200); // SSE headers were already relayed
    await expect(response.text()).rejects.toThrow("provider transport broke");

    expect(debit(balances, token)).toBe(0);
    expect(holdsCount(balances)).toBe(0);
    expect(metrics.snapshot().failure.streamRefunded).toBe(1);
    expect(reconciledOutcomeCount()).toBe(metrics.snapshot().requests);
  } finally {
    logSpy.mockRestore();
  }
});

test("SSE contract · Anthropic reports cumulative usage then transport breaks → user pays exactly the reported partial", async () => {
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    const model = "claude-opus-4-8";
    const reported = { input_tokens: 31, output_tokens: 17 };
    const events = sseData([
      { type: "message_start", message: { model, usage: { input_tokens: reported.input_tokens, output_tokens: 0 } } },
      { type: "message_delta", usage: { output_tokens: reported.output_tokens } },
    ]);
    const { handler, balances } = makeHandler(transportFailureAfter([events]));
    const token = "pr_contract_anthropic_partial";
    fund(balances, token);

    const response = await handler(anthropicRequest(token, {
      model, max_tokens: 1000, stream: true, messages: [{ role: "user", content: "hello" }],
    }));
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow("provider transport broke");

    const expected = contractCost(model, reported);
    expect(debit(balances, token)).toBe(expected);
    expect(holdsCount(balances)).toBe(0);
    expect(metrics.snapshot().failure.streamReported).toEqual({ count: 1, micros: expected });
    expect(reconciledOutcomeCount()).toBe(metrics.snapshot().requests);
  } finally {
    logSpy.mockRestore();
  }
});

test("SSE contract · OpenAI reasoning stream emits visible text then fails → user pays visible estimate, never the output maximum", async () => {
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    const visible = "12345678";
    const body = { model: "gpt-5", max_completion_tokens: 10_000, stream: true, messages: [{ role: "user", content: "x".repeat(8000) }] };
    const events = sseData([
      { model: body.model, choices: [{ delta: { content: visible } }] },
      { type: "error", error: { type: "server_error", message: "failed after output" } },
    ]);
    const { handler, balances } = makeHandler(cleanStream([events]));
    const token = "pr_contract_openai_failure";
    fund(balances, token);

    const response = await handler(openAIRequest(token, body));
    expect(response.status).toBe(200);
    await response.text();

    const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 4);
    const expected = contractCost(body.model, { input_tokens: estimatedInput, output_tokens: Math.ceil(visible.length / 4) });
    expect(debit(balances, token)).toBe(expected);
    expect(debit(balances, token)).toBeLessThan(contractCost(body.model, { input_tokens: estimatedInput, output_tokens: body.max_completion_tokens }));
    expect(holdsCount(balances)).toBe(0);
    expect(metrics.snapshot().failure.streamEstimated).toEqual({ count: 1, micros: expected });
    expect(reconciledOutcomeCount()).toBe(metrics.snapshot().requests);
  } finally {
    logSpy.mockRestore();
  }
});

test("Cancellation contract · client cancels an OpenAI reasoning stream → upstream stops; charge is estimated input plus visible output, never a reservation ceiling", async () => {
  metrics.reset(0);
  let upstreamCancelled = false;
  const visible = "12345678";
  const body = { model: "gpt-5", max_completion_tokens: 1000, stream: true, messages: [{ role: "user", content: "x".repeat(8000) }] };
  const chunks = [
    sseData([{ model: body.model, choices: [{ delta: { role: "assistant", content: "" } }] }]),
    sseData([{ model: body.model, choices: [{ delta: { content: visible } }] }]),
  ];
  const { handler, balances } = makeHandler(openUntilCancelled(chunks, () => { upstreamCancelled = true; }));
  const token = "pr_contract_client_cancel";
  fund(balances, token);

  const response = await handler(openAIRequest(token, body));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel("caller left");

  expect(upstreamCancelled).toBe(true);
  const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 4);
  const expected = contractCost(body.model, {
    input_tokens: estimatedInput,
    output_tokens: Math.ceil(visible.length / 4),
  });
  expect(debit(balances, token)).toBe(expected);
  expect(debit(balances, token)).toBeLessThan(contractCost(body.model, {
    input_tokens: estimatedInput,
    output_tokens: body.max_completion_tokens,
  }));
  expect(holdsCount(balances)).toBe(0);
  expect([metrics.snapshot().servedPartial, metrics.snapshot().failure.streamReported.count, metrics.snapshot().failure.streamEstimated.count, metrics.snapshot().failure.streamRefunded]).toEqual([1, 0, 0, 0]);
  expect(reconciledOutcomeCount()).toBe(metrics.snapshot().requests);
});

test("Race contract · upstream failure observed before client cancellation wins → cancellation cannot trigger reasoning maximum", async () => {
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    let upstreamCancelled = false;
    const visible = "12345678";
    const body = { model: "gpt-5", max_completion_tokens: 10_000, stream: true, messages: [{ role: "user", content: "x".repeat(8000) }] };
    const firstChunk = sseData([
      { model: body.model, choices: [{ delta: { content: visible } }] },
      { type: "error", error: { type: "server_error", message: "failed" } },
    ]);
    const { handler, balances } = makeHandler(openUntilCancelled([firstChunk], () => { upstreamCancelled = true; }));
    const token = "pr_contract_error_cancel_race";
    fund(balances, token);

    const response = await handler(openAIRequest(token, body));
    const reader = response.body!.getReader();
    await reader.read(); // scanner observes visible output and the error in one upstream chunk
    await reader.cancel("caller closes after seeing provider error");

    expect(upstreamCancelled).toBe(true);
    const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 4);
    const expected = contractCost(body.model, {
      input_tokens: estimatedInput,
      output_tokens: Math.ceil(visible.length / 4),
    });
    expect(debit(balances, token)).toBe(expected);
    expect(holdsCount(balances)).toBe(0);
    expect(metrics.snapshot().failure.streamEstimated).toEqual({ count: 1, micros: expected });
    expect(reconciledOutcomeCount()).toBe(metrics.snapshot().requests);
  } finally {
    logSpy.mockRestore();
  }
});

test("Race matrix · observed upstream failure wins over deadline and shutdown drain", async () => {
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const localTerminal of ["deadline", "drain"] as const) {
      metrics.reset(0);
      const inflight = new Set<(reason?: "drain") => void>();
      let fireDeadline: (() => void) | undefined;
      const visible = "12345678";
      const body = { model: "gpt-5", max_completion_tokens: 10_000, stream: true, messages: [{ role: "user", content: "x".repeat(8000) }] };
      const firstChunk = sseData([
        { model: body.model, choices: [{ delta: { content: visible } }] },
        { type: "error", error: { type: "server_error", message: "failed" } },
      ]);
      const { handler, balances } = makeHandler(openUntilCancelled([firstChunk], () => {}), {
        inflight,
        scheduleStreamDeadline: (fire) => { fireDeadline = fire; return () => {}; },
      });
      const token = `pr_contract_error_${localTerminal}`;
      fund(balances, token);

      const response = await handler(openAIRequest(token, body));
      const reader = response.body!.getReader();
      await reader.read(); // scanner observes visible output and in-band failure
      if (localTerminal === "deadline") fireDeadline!();
      else for (const settle of [...inflight]) settle("drain");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 4);
      const expected = contractCost(body.model, { input_tokens: estimatedInput, output_tokens: 2 });
      expect([localTerminal, debit(balances, token)]).toEqual([localTerminal, expected]);
      expect([localTerminal, metrics.snapshot().failure.streamEstimated]).toEqual([
        localTerminal,
        { count: 1, micros: expected },
      ]);
      expect([localTerminal, holdsCount(balances)]).toEqual([localTerminal, 0]);
      await reader.cancel().catch(() => {}); // cleanup after the already-final settlement
    }
  } finally {
    logSpy.mockRestore();
  }
});

test("Metrics contract · failure charge dollars equal the hold-clamped ledger debit", async () => {
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    metrics.reset(0);
    const body = { model: "gpt-5", max_completion_tokens: 1, stream: true, messages: [{ role: "user", content: "hi" }] };
    const events = sseData([
      { model: body.model, choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } },
      { type: "error", error: { type: "server_error", message: "late failure" } },
    ]);
    const { handler, balances } = makeHandler(cleanStream([events]));
    const token = "pr_contract_metric_clamp";
    fund(balances, token);

    const response = await handler(openAIRequest(token, body));
    await response.text();

    const raw = JSON.stringify(body);
    const hold = byteBoundHold({ model: body.model, raw, body, maxTokens: body.max_completion_tokens }).micros;
    expect(debit(balances, token)).toBe(hold);
    expect(metrics.snapshot().failure.streamReported).toEqual({ count: 1, micros: hold });
    expect(metrics.snapshot().bill.holdExceeded).toBe(1);
    expect(holdsCount(balances)).toBe(0);
  } finally {
    logSpy.mockRestore();
  }
});
