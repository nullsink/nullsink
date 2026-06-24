// monero.ts:80-86 — the transfer-normalisation guards (double_spend_seen / confirmations / locked / amount)
// are behaviorally pinned by monero.property.test.ts, but its rows are always well-formed objects, so the
// `t?.x` optional-chaining survived (it only differs on a null/garbled row). Pin the defensive intent: a
// malformed `in` entry must not crash the poller.
import { test, expect, spyOn } from "bun:test";
import { makeMonero } from "../src/rails/monero";

const CONF = 10;
const CFG = { rpcUrl: "http://rpc.test/json_rpc", accountIndex: 0, confirmations: CONF, timeoutMs: 1000 };
const rpcOk = (result: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "0", result }), { status: 200 })) as unknown as typeof fetch;

test("incomingTransfers tolerates a malformed/null transfer row without throwing", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  const good = { txid: "t", amount: 5, confirmations: CONF, subaddr_index: { minor: 1 }, locked: false, double_spend_seen: false };
  const { incomingTransfers } = makeMonero({ ...CFG, fetchImpl: rpcOk({ in: [null, good] }) });
  // A non-optional `t.amount` / `t.locked` / `String(t.txid)` mutant throws on the null row; the optional
  // chaining degrades it to a benign zero-amount entry instead.
  const out = await incomingTransfers();
  expect(out).toContainEqual({ orderIndex: 0, idempotencyKey: ":0", amount: 0, confirmations: 0, final: false });
  expect(out).toContainEqual({ orderIndex: 1, idempotencyKey: "t:1", amount: 5, confirmations: CONF, final: true });
  errSpy.mockRestore();
});
