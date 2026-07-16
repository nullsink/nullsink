/// <reference lib="dom" />
// Integration coverage for the money path's two guarantees that today live only in code shape + comments:
//   1. submit() ROUTING — a blank field mints, a valid pasted token tops up (baseline snapshot + no
//      save-gate), and a malformed key blocks the buy entirely.
//   2. The App MOUNT INVARIANT — the single <KeyFlow/> is never remounted when the page flips
//      landing → focused checkout. A remount would reset KeyFlow to phase "home" and wipe the in-flight
//      quote + poll mid-payment; the only thing guarding it is App.tsx's structure (KeyFlow rendered
//      unconditionally, only <HomeOrient/> conditional) + a comment. This pins it so a future refactor
//      that wraps KeyFlow in `{!checkout && …}` or keys it on `checkout` fails CI instead of shipping.
// The pure classifier keyFieldState is unit-tested in token.test.ts; this asserts the components HONOR it.
import { test, expect, mock, beforeEach } from "bun:test";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as realApi from "../lib/api.ts";
import * as realToken from "../lib/token.ts";
import type { Quote, Rails } from "../lib/api.ts";

// window.scrollTo is a no-op here; KeyFlow snaps scroll to top on every phase change (a layout effect),
// which this test exercises. Neutralize it so the effect can't throw in the headless DOM.
window.scrollTo = (() => {}) as typeof window.scrollTo;

const QUOTE: Quote = {
  pay_to: "8BstubMoneroAddressForTest",
  amount: "0.12345678",
  unit: "XMR",
  pay_uri: "monero:8BstubMoneroAddressForTest?tx_amount=0.12345678",
  rate_usd: 150,
  confirmations_required: 10,
  expires_at: Date.now() + 60 * 60 * 1000, // 1h out — not expired, and fits QuotePay's expiry setTimeout
};
const RAILS: Rails = { default: "monero", rails: [{ name: "monero", unit: "XMR", confirmations: 10 }] };

// Stub ONLY the network; keep every pure export real (constants, usd, buyErrorMessage, trocadorSwapUrl) so
// the form, AmountStep, HomeOrient and QuotePay render against the true contract. requestQuote/checkBalance
// are captured so we can assert WHICH token a submit routed to.
const requestQuote = mock((_hash: string, _amount: number, _rail?: string): Promise<Quote> => Promise.resolve(QUOTE));
const checkBalance = mock((_token: string): Promise<number | null> => Promise.resolve(null));
const getRails = mock((): Promise<Rails> => Promise.resolve(RAILS));
const fetchOrderStatus = mock((_hash: string) => Promise.resolve({ state: "waiting" as const }));
mock.module("../lib/api.ts", () => ({ ...realApi, requestQuote, checkBalance, getRails, fetchOrderStatus }));

// Keep the REAL generateToken + keyFieldState (the routing logic under test); stub only hashToken so the
// test doesn't depend on a WebCrypto impl and the hash KeyFlow sends is observable.
const hashToken = mock((tok: string): Promise<string> => Promise.resolve("hash:" + tok));
mock.module("../lib/token.ts", () => ({ ...realToken, hashToken }));

// Import the components AFTER the mocks register so they bind the stubs.
const { KeyFlow } = await import("./KeyFlow.tsx");
const { App } = await import("../App.tsx");

const ORIENT = /API proxy for frontier/i; // a marker that exists ONLY in the (conditional) orient column
const VALID_TOKEN = realToken.generateToken(); // passes isValidTokenFormat by construction → a top-up

beforeEach(() => {
  requestQuote.mockClear();
  checkBalance.mockClear();
  hashToken.mockClear();
});

// Tick the lone terms checkbox on the home form, then press the named CTA.
function agreeAndClick(name: RegExp) {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name }));
}

// THE INVARIANT: a mint submit flips the page to focused checkout. If App remounted KeyFlow when `checkout`
// went true, KeyFlow would reset to "home" and the pay screen would never appear. Reaching "Your new key"
// (and the orient column being gone) proves the single instance survived the flip.
test("App reaches the pay screen on mint — KeyFlow is not remounted across the landing→checkout flip", async () => {
  render(<App />);
  // findBy (not getBy) for the first assertion: it flushes KeyFlow's getRails() mount effect inside act.
  expect(await screen.findByText(ORIENT)).toBeInTheDocument(); // landing: orient column present
  await agreeAndClick(/mint key/i);

  expect(await screen.findByRole("heading", { name: /your new key/i })).toBeInTheDocument();
  expect(screen.queryByText(ORIENT)).not.toBeInTheDocument(); // orient column unmounted (focused checkout)
  expect(requestQuote).toHaveBeenCalledTimes(1);
});

// ROUTING — blank field → MINT: a fresh key, no balance lookup (nothing to snapshot), the "new key" screen.
test("a blank key field routes submit to mint (no /balance call, new-key screen)", async () => {
  render(<KeyFlow />);
  const cta = await screen.findByRole("button", { name: /mint key/i });
  expect(cta).not.toBeDisabled();

  await agreeAndClick(/mint key/i);

  expect(await screen.findByRole("heading", { name: /your new key/i })).toBeInTheDocument();
  expect(requestQuote).toHaveBeenCalledTimes(1);
  expect(checkBalance).not.toHaveBeenCalled(); // a mint has no baseline to capture
});

// ROUTING — valid pasted token → TOP-UP: the CTA flips to "add credit", submit snapshots the baseline via
// /balance with the RAW pasted token and quotes its hash, then goes straight to QuotePay (NO save-gate).
test("a valid pasted token routes submit to top-up (baseline snapshot, no save-gate)", async () => {
  render(<KeyFlow />);
  await screen.findByRole("button", { name: /mint key/i }); // starts as mint…

  const field = screen.getByLabelText(/leave blank to mint a new key/i);
  fireEvent.change(field, { target: { value: VALID_TOKEN } });
  expect(await screen.findByRole("button", { name: /add credit/i })).toBeInTheDocument(); // …flips to top-up

  await agreeAndClick(/add credit/i);

  await waitFor(() => expect(checkBalance).toHaveBeenCalledWith(VALID_TOKEN)); // baseline = raw token
  expect(requestQuote).toHaveBeenCalledTimes(1);
  expect(requestQuote.mock.calls[0][0]).toBe("hash:" + VALID_TOKEN); // quote is keyed by the pasted token's hash
  expect(await screen.findByRole("heading", { name: /add credit/i })).toBeInTheDocument();
  expect(screen.queryByText(/I saved my key/i)).not.toBeInTheDocument(); // top-ups skip the mint save-gate
});

// A top-up's success is balance > baseline. If the baseline read fails, substituting zero lets an old
// positive balance satisfy that check before the new payment is credited. Fail before /buy instead.
test("a failed top-up baseline read does not request a quote", async () => {
  checkBalance.mockImplementation(() => Promise.reject({ kind: "server", status: 503 }));
  render(<KeyFlow />);
  await screen.findByRole("button", { name: /mint key/i });

  fireEvent.change(screen.getByLabelText(/leave blank to mint a new key/i), { target: { value: VALID_TOKEN } });
  await act(async () => {
    agreeAndClick(/add credit/i);
  });

  expect(await screen.findByText(/balance service is temporarily unavailable/i)).toBeInTheDocument();
  expect(requestQuote).not.toHaveBeenCalled();
  expect(hashToken).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: /add credit/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /add credit/i })).not.toBeDisabled();
});

// ROUTING — malformed key → BLOCKED: the typo warning shows, the CTA is disabled, and even a direct form
// submit (bypassing the disabled button) is stopped by submit()'s guard, so no quote is ever requested.
test("a malformed key blocks the buy (typo warning, disabled CTA, submit guard holds)", async () => {
  const { container } = render(<KeyFlow />);
  await screen.findByRole("button", { name: /mint key/i });

  const field = screen.getByLabelText(/leave blank to mint a new key/i);
  fireEvent.change(field, { target: { value: "not-a-valid-key" } });

  expect(await screen.findByText(/doesn't look valid/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /mint key/i })).toBeDisabled();

  fireEvent.click(screen.getByRole("checkbox")); // agree, to prove it's the malformed guard (not the terms gate) that blocks
  fireEvent.submit(container.querySelector("form")!);

  expect(requestQuote).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: /your new key/i })).not.toBeInTheDocument();
});
