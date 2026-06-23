// Rail selection (src/rails/index.ts). selectRails parses the PAY_RAILS comma list into the active rails in
// order (the first is the /buy default); selectRail keeps the legacy single-name path. Importing the barrel
// is side-effect-free (binds no port, starts no timer), so these need no wallet/node.
import { test, expect } from "bun:test";
import { selectRails, selectRail } from "../src/rails";
import { moneroRail } from "../src/rails/monero";
import { bitcoinRail } from "../src/rails/bitcoin";

test("selectRails parses a comma list in order; the first key is the default", () => {
  const m = selectRails("monero,bitcoin");
  expect([...m.keys()]).toEqual(["monero", "bitcoin"]);
  expect(m.get("monero")!.name).toBe("monero");
  expect(m.get("bitcoin")!.name).toBe("bitcoin");
});

test("selectRails trims whitespace and ignores empty entries", () => {
  expect([...selectRails(" bitcoin , monero , ").keys()]).toEqual(["bitcoin", "monero"]);
});

test("selectRails throws on an unknown rail and on an empty list", () => {
  expect(() => selectRails("monero,dogecoin")).toThrow(/dogecoin/);
  expect(() => selectRails("")).toThrow(/empty/);
  expect(() => selectRails("  ,  ")).toThrow(/empty/);
});

test("selectRail still resolves a single rail (legacy PAY_RAIL path)", () => {
  expect(selectRail("monero").name).toBe("monero");
  expect(() => selectRail("nope")).toThrow(/nope/);
});

test("each rail emits its coin's payment-URI scheme + amount param (what the buyer's wallet/QR encodes)", () => {
  // The handler builds the QR/pay link from rail.paymentUri(address, amount). A wrong scheme or amount param
  // sends the buyer's coin to the wrong place; every handler test injects a synthesized rail, so the REAL
  // singletons' URIs are pinned only here. amount is the pre-formatted string the handler passes.
  expect(moneroRail.paymentUri("4xyzADDR", "1.5")).toBe("monero:4xyzADDR?tx_amount=1.5");
  expect(bitcoinRail.paymentUri("bc1qADDR", "0.001")).toBe("bitcoin:bc1qADDR?amount=0.001");
  expect([moneroRail.unit, bitcoinRail.unit]).toEqual(["XMR", "BTC"]); // coin-correct display unit too
});
