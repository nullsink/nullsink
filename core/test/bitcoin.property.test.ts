// Tests for the Bitcoin pay rail (src/rails/bitcoin.ts) against an injected fetch returning canned bitcoind
// JSON-RPC responses — no node. Pins the watcher's money-relevant logic: BTC→sats conversion, finality by
// confirmation depth, the bitcoin:txid:orderIndex idempotency key (so multi-output txs aggregate under pay-once),
// label→order mapping, and watched-order filtering.
import { test, expect, spyOn } from "bun:test";
import { makeBitcoin, BitcoinError } from "../src/rails/bitcoin";

const CONF = 3;
const CFG = { rpcUrl: "http://rpc.test/wallet/x", confirmations: CONF, timeoutMs: 1000 };

// Route a canned result per RPC method; an unknown method returns a JSON-RPC error (→ BitcoinError).
function router(handlers: Record<string, (params: any[]) => unknown>): typeof fetch {
  return (async (_url: string, init: any) => {
    const { method, params } = JSON.parse(init.body);
    if (!(method in handlers))
      return new Response(JSON.stringify({ result: null, error: { code: -32601, message: `no ${method}` }, id: "0" }), { status: 200 });
    return new Response(JSON.stringify({ result: handlers[method]!(params), error: null, id: "0" }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("createAddress mints, reads its derivation index, and labels the address with it", async () => {
  const calls: any[] = [];
  const fetchImpl = router({
    getnewaddress: () => "bc1qexample",
    getaddressinfo: () => ({ hdkeypath: "m/84h/0h/0h/0/7" }),
    setlabel: (p) => {
      calls.push(p);
      return null;
    },
  });
  const { createAddress } = makeBitcoin({ ...CFG, fetchImpl });
  expect(await createAddress("pr")).toEqual({ address: "bc1qexample", orderIndex: 7 });
  expect(calls).toEqual([["bc1qexample", "7"]]); // labelled with its index for the poller's reverse-map
});

test("createAddress throws BitcoinError when the derivation index can't be read", async () => {
  // setlabel is mocked to SUCCEED, so the throw must come from the index guard (an empty hdkeypath), not a
  // missing RPC — without the guard, Number("") === 0 would silently key the order to index 0.
  const fetchImpl = router({ getnewaddress: () => "bc1q", getaddressinfo: () => ({ hdkeypath: "" }), setlabel: () => null });
  await expect(makeBitcoin({ ...CFG, fetchImpl }).createAddress()).rejects.toBeInstanceOf(BitcoinError);
});

test("incomingTransfers maps watched UTXOs: sats, txid:index key, final by confirmations, filters the rest", async () => {
  const fetchImpl = router({
    listunspent: () => [
      { txid: "aa", vout: 0, address: "bc1a", label: "7", amount: 0.001, confirmations: 3 }, // final (>=3)
      { txid: "bb", vout: 1, address: "bc1b", label: "8", amount: 0.1, confirmations: 1 }, // not final; 0.1 BTC rounds exactly
      { txid: "cc", vout: 0, address: "bc1c", label: "9", amount: 0.01, confirmations: 10 }, // label 9 not watched → skipped
    ],
  });
  const { incomingTransfers } = makeBitcoin({ ...CFG, fetchImpl });
  expect(await incomingTransfers([7, 8])).toEqual([
    { orderIndex: 7, idempotencyKey: "bitcoin:aa:7", amount: 100_000, confirmations: 3, final: true },
    { orderIndex: 8, idempotencyKey: "bitcoin:bb:8", amount: 10_000_000, confirmations: 1, final: false },
  ]);
});

test("two outputs of one tx to the same order share one idempotency key (settle aggregates them)", async () => {
  const fetchImpl = router({
    listunspent: () => [
      { txid: "dd", vout: 0, address: "bc1x", label: "4", amount: 0.002, confirmations: 5 },
      { txid: "dd", vout: 1, address: "bc1x", label: "4", amount: 0.003, confirmations: 5 },
    ],
  });
  const got = await makeBitcoin({ ...CFG, fetchImpl }).incomingTransfers([4]);
  expect(got.map((i) => i.idempotencyKey)).toEqual(["bitcoin:dd:4", "bitcoin:dd:4"]); // → settle sums to 500_000 sats, one credit
  expect(got.reduce((s, i) => s + i.amount, 0)).toBe(500_000);
});

test("incomingTransfers skips dust and makes no RPC call when nothing is watched", async () => {
  const dust = router({ listunspent: () => [{ txid: "ee", vout: 0, address: "z", label: "1", amount: 0, confirmations: 5 }] });
  expect(await makeBitcoin({ ...CFG, fetchImpl: dust }).incomingTransfers([1])).toEqual([]);

  let called = false;
  const spy = (async () => {
    called = true;
    return new Response("{}");
  }) as unknown as typeof fetch;
  expect(await makeBitcoin({ ...CFG, fetchImpl: spy }).incomingTransfers([])).toEqual([]);
  expect(called).toBe(false); // empty watch → no full-wallet scan
});

test("rpc surfaces HTTP and JSON-RPC errors as BitcoinError", async () => {
  const http500 = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await expect(makeBitcoin({ ...CFG, fetchImpl: http500 }).createAddress()).rejects.toThrow("bitcoind HTTP 500");
  await expect(makeBitcoin({ ...CFG, fetchImpl: router({}) }).createAddress()).rejects.toBeInstanceOf(BitcoinError);
});

test("incomingTransfers drops a UTXO whose sats exceed safe-integer precision (never mis-credits)", async () => {
  // The BTC analog of Monero's lossy-amount guard: amount is a float BTC value; amount × 1e8 can exceed
  // Number.MAX_SAFE_INTEGER, where Math.round would lose precision. Such a UTXO must be SKIPPED + warned,
  // never credited from a lossy conversion — while a normal UTXO in the same batch still credits.
  const warnSpy = spyOn(console, "error").mockImplementation(() => {}); // log.warn → console.error
  const fetchImpl = router({
    listunspent: () => [
      { txid: "ff", vout: 0, address: "bc1u", label: "5", amount: 1e8, confirmations: 5 }, // 1e8 BTC → 1e16 sats: unsafe
      { txid: "gg", vout: 0, address: "bc1v", label: "6", amount: 0.001, confirmations: 5 }, // safe → still credited
    ],
  });
  const got = await makeBitcoin({ ...CFG, fetchImpl }).incomingTransfers([5, 6]);
  expect(got).toEqual([{ orderIndex: 6, idempotencyKey: "bitcoin:gg:6", amount: 100_000, confirmations: 5, final: true }]);
  expect(warnSpy).toHaveBeenCalled();
  warnSpy.mockRestore();
});

test("createAddress throws on a NON-numeric derivation index (would otherwise NaN-key the order)", async () => {
  // Complements the empty-hdkeypath case above: a last path segment that isn't a number → pathIndex returns
  // NaN → the guard throws, rather than Number(...) silently producing a colliding key. setlabel is mocked to
  // succeed, so the throw can ONLY come from the index guard.
  const fetchImpl = router({ getnewaddress: () => "bc1q", getaddressinfo: () => ({ hdkeypath: "m/84h/0h/0h/0/x" }), setlabel: () => null });
  await expect(makeBitcoin({ ...CFG, fetchImpl }).createAddress()).rejects.toBeInstanceOf(BitcoinError);
});

test("finality is >= the threshold exactly: threshold-1 is not final, the threshold is", async () => {
  // Pins the BTC reorg-defense boundary the way settle's >= boundary is pinned: confirmations === threshold-1
  // is NOT creditable, confirmations === threshold IS. (CONF = 3 here.)
  const fetchImpl = router({
    listunspent: () => [
      { txid: "h1", vout: 0, address: "a", label: "1", amount: 0.001, confirmations: CONF - 1 }, // 2 → not final
      { txid: "h2", vout: 0, address: "b", label: "2", amount: 0.001, confirmations: CONF }, //     3 → final
    ],
  });
  const got = await makeBitcoin({ ...CFG, fetchImpl }).incomingTransfers([1, 2]);
  expect(got.map((i) => [i.orderIndex, i.final])).toEqual([
    [1, false],
    [2, true],
  ]);
});
