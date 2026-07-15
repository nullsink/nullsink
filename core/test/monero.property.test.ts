// Property + example tests for the wallet-rpc client (src/rails/monero.ts). makeMonero takes an injected
// fetch, so we feed canned JSON-RPC responses. Two money-safety properties: outputs whose amount exceeds
// JS safe-integer precision are DROPPED (never mis-credited from a lossy parse), and the rail OWNS finality
// — it computes `final` (confs ≥ threshold AND not locked), supplies the opaque idempotencyKey, and drops
// double-spend-flagged outputs entirely (they can never credit, so they must never surface).
import { test, expect, spyOn } from "bun:test";
import fc from "fast-check";
import { makeMonero, MoneroError } from "../src/rails/monero";

const CONF = 10;
const CFG = { rpcUrl: "http://rpc.test/json_rpc", accountIndex: 0, confirmations: CONF, timeoutMs: 1000 };
const rpcOk = (result: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "0", result }), { status: 200 })) as unknown as typeof fetch;
const rpcErr = (error: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "0", error }), { status: 200 })) as unknown as typeof fetch;
const httpErr = (status: number): typeof fetch =>
  (async () => new Response("nope", { status })) as unknown as typeof fetch;

// Each raw row carries a `safe` flag so the test knows whether incomingTransfers should keep it.
const rawArb = fc.record({
  txid: fc.string(),
  confirmations: fc.nat({ max: 100 }),
  minor: fc.nat({ max: 50 }),
  locked: fc.boolean(),
  ds: fc.boolean(),
  kind: fc.oneof(
    fc.record({ safe: fc.constant(true), amount: fc.maxSafeNat() }),
    fc.record({ safe: fc.constant(false), amount: fc.double({ min: 9_007_199_254_740_992, max: 1e25, noNaN: true, noDefaultInfinity: true }) }),
  ),
});

test("incomingTransfers drops unsafe amounts + double-spends, computes final, and maps the rest", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {}); // silence the per-drop warning
  await fc.assert(
    fc.asyncProperty(fc.array(rawArb, { maxLength: 12 }), async (rows) => {
      const inList = rows.map((r) => ({
        txid: r.txid,
        amount: r.kind.amount,
        confirmations: r.confirmations,
        subaddr_index: { minor: r.minor },
        locked: r.locked,
        double_spend_seen: r.ds,
      }));
      const { incomingTransfers } = makeMonero({ ...CFG, fetchImpl: rpcOk({ in: inList }) });
      const want = rows
        .filter((r) => r.kind.safe && !r.ds) // unsafe amounts dropped, double-spends dropped
        .map((r) => ({
          orderIndex: r.minor,
          idempotencyKey: `${r.txid}:${r.minor}`,
          amount: r.kind.amount,
          confirmations: r.confirmations,
          final: r.confirmations >= CONF && !r.locked,
        }));
      expect(await incomingTransfers()).toEqual(want);
    }),
    { numRuns: 400 },
  );
  errSpy.mockRestore();
});

test("incomingTransfers scopes get_transfers to given order indices, omitting the filter otherwise", async () => {
  const seen: any[] = [];
  const capture = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body).params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "0", result: { in: [] } }), { status: 200 });
  }) as unknown as typeof fetch;
  const { incomingTransfers } = makeMonero({ ...CFG, fetchImpl: capture });

  await incomingTransfers([3, 7]);
  await incomingTransfers();
  await incomingTransfers([]); // the poller must never do this — [] would mean "all", a full scan

  expect(seen[0]).toEqual({ in: true, account_index: 0, subaddr_indices: [3, 7] });
  expect(seen[1]).toEqual({ in: true, account_index: 0 });
  expect(seen[2]).toEqual({ in: true, account_index: 0 });
});

test("unsafe-transfer diagnostics never journal a transaction id", async () => {
  const warnSpy = spyOn(console, "error").mockImplementation(() => {});
  const txid = "TXID-SECRET-never-log";
  const { incomingTransfers } = makeMonero({
    ...CFG,
    fetchImpl: rpcOk({ in: [{ txid, amount: Number.MAX_SAFE_INTEGER + 1, subaddr_index: { minor: 1 } }] }),
  });
  expect(await incomingTransfers()).toEqual([]);
  const journal = warnSpy.mock.calls.map((c: any[]) => String(c[0])).join("\n");
  expect(journal).not.toContain(txid);
  expect(journal).not.toContain(String(Number.MAX_SAFE_INTEGER + 1));
  warnSpy.mockRestore();
});

test("incomingTransfers applies defaults for missing fields (and isn't final at 0 confs)", async () => {
  const { incomingTransfers } = makeMonero({ ...CFG, fetchImpl: rpcOk({ in: [{ amount: 100 }] }) });
  expect(await incomingTransfers()).toEqual([{ orderIndex: 0, idempotencyKey: ":0", amount: 100, confirmations: 0, final: false }]);
});

test("incomingTransfers returns [] when result.in is absent or not an array", async () => {
  expect(await makeMonero({ ...CFG, fetchImpl: rpcOk({}) }).incomingTransfers()).toEqual([]);
  expect(await makeMonero({ ...CFG, fetchImpl: rpcOk({ in: "nope" }) }).incomingTransfers()).toEqual([]);
});

test("createAddress maps a valid response", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string(), fc.nat({ max: 1000 }), async (address, idx) => {
      const { createAddress } = makeMonero({ ...CFG, fetchImpl: rpcOk({ address, address_index: idx }) });
      expect(await createAddress("lbl")).toEqual({ address, orderIndex: idx });
    }),
  );
});

test("createAddress throws MoneroError on an unexpected response shape", async () => {
  const bad = [{}, { address: "8" }, { address_index: 1 }, { address: 5, address_index: 1 }, { address: "8", address_index: "x" }, null];
  for (const result of bad) {
    const { createAddress } = makeMonero({ ...CFG, fetchImpl: rpcOk(result) });
    await expect(createAddress()).rejects.toBeInstanceOf(MoneroError);
  }
});

test("rpc surfaces HTTP and JSON-RPC errors as MoneroError", async () => {
  await expect(makeMonero({ ...CFG, fetchImpl: httpErr(500) }).createAddress()).rejects.toThrow("wallet-rpc HTTP 500");
  await expect(makeMonero({ ...CFG, fetchImpl: rpcErr({ code: -1, message: "boom" }) }).incomingTransfers()).rejects.toThrow("boom");
});
