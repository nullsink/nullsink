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
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import * as realApi from "../lib/api.ts";
import * as realToken from "../lib/token.ts";
import type { OrderStatus, Quote, Rails } from "../lib/api.ts";

// window.scrollTo is a no-op here; KeyFlow snaps scroll to top on every phase change (a layout effect),
// which this test exercises. Neutralize it so the effect can't throw in the headless DOM.
window.scrollTo = (() => {}) as typeof window.scrollTo;

const QUOTE_CREATED_AT = Date.now();
const QUOTE: Quote = {
  contract: 2,
  pay_to: "8BstubMoneroAddressForTest",
  amount: "0.12345678",
  unit: "XMR",
  pay_uri: "monero:8BstubMoneroAddressForTest?tx_amount=0.12345678",
  rate_usd: 150,
  confirmations_required: 10,
  created_at: QUOTE_CREATED_AT,
  expires_at: QUOTE_CREATED_AT + 60 * 60 * 1000, // 1h out — not expired, and fits QuotePay's expiry setTimeout
  tracking_until: QUOTE_CREATED_AT + 90 * 60 * 1000,
};
const RAILS: Rails = { default: "monero", rails: [{ name: "monero", unit: "XMR", confirmations: 10 }] };
const MULTI_RAILS: Rails = {
  default: "monero",
  rails: [
    { name: "monero", unit: "XMR", confirmations: 10 },
    { name: "bitcoin", unit: "BTC", confirmations: 3 },
  ],
};

// Stub ONLY the network; keep every pure export real (constants, usd, buyErrorMessage, trocadorSwapUrl) so
// the form, AmountStep, HomeOrient and QuotePay render against the true contract. requestQuote/checkBalance
// are captured so we can assert WHICH token a submit routed to.
const requestQuote = mock((_hash: string, _amount: number, _rail?: string): Promise<Quote> => Promise.resolve(QUOTE));
const checkBalance = mock((_token: string): Promise<number | null> => Promise.resolve(null));
const getRails = mock((): Promise<Rails> => Promise.resolve(RAILS));
const fetchOrderStatus = mock((_hash: string): Promise<OrderStatus> =>
  Promise.resolve({ contract: 2, server_now: Date.now(), state: "waiting" }),
);
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
const SECOND_VALID_TOKEN = realToken.generateToken();

beforeEach(() => {
  requestQuote.mockReset();
  requestQuote.mockImplementation(() => Promise.resolve(QUOTE));
  checkBalance.mockReset();
  checkBalance.mockImplementation(() => Promise.resolve(null));
  hashToken.mockReset();
  hashToken.mockImplementation((tok: string) => Promise.resolve("hash:" + tok));
  getRails.mockReset();
  getRails.mockImplementation(() => Promise.resolve(RAILS));
  fetchOrderStatus.mockReset();
  fetchOrderStatus.mockImplementation(() =>
    Promise.resolve({ contract: 2, server_now: Date.now(), state: "waiting" as const }),
  );
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

test("a deferred buy freezes its full intent and two same-turn submits open only one quote", async () => {
  let resolveQuote!: (quote: Quote) => void;
  requestQuote.mockImplementation(() => new Promise((resolve) => { resolveQuote = resolve; }));
  getRails.mockImplementation(() => Promise.resolve(MULTI_RAILS));

  const { container } = render(<KeyFlow />);
  const bitcoin = await screen.findByRole("button", { name: /bitcoin BTC/i });
  fireEvent.click(screen.getByRole("button", { name: "$25" }));
  fireEvent.click(bitcoin);
  fireEvent.click(screen.getByRole("checkbox"));

  const form = container.querySelector("form")!;
  // One outer act keeps React's `busy` update uncommitted between these events. Only the synchronous ref
  // can collapse this exact browser-turn double submit.
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });

  await waitFor(() => expect(requestQuote).toHaveBeenCalledTimes(1));
  expect(hashToken).toHaveBeenCalledTimes(1);
  expect(requestQuote.mock.calls[0][1]).toBe(25);
  expect(requestQuote.mock.calls[0][2]).toBe("bitcoin");

  const token = screen.getByLabelText(/leave blank to mint a new key/i);
  const customAmount = screen.getByLabelText(/custom amount in USD/i);
  const submit = screen.getByRole("button", { name: /requesting/i });
  expect(token).toBeDisabled();
  expect(customAmount).toBeDisabled();
  expect(bitcoin).toBeDisabled();
  expect(screen.getByRole("button", { name: "$50" })).toBeDisabled();
  expect(submit).toBeDisabled();

  // Programmatic events cannot mutate the frozen request either; its explicit snapshots stay authoritative.
  fireEvent.change(token, { target: { value: VALID_TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: "$50" }));
  fireEvent.click(screen.getByRole("button", { name: /monero XMR/i }));
  fireEvent.submit(form);
  expect(token).toHaveValue("");
  expect(requestQuote).toHaveBeenCalledTimes(1);
  expect(requestQuote.mock.calls[0][1]).toBe(25);
  expect(requestQuote.mock.calls[0][2]).toBe("bitcoin");

  await act(async () => {
    resolveQuote(QUOTE);
    await Promise.resolve();
  });
  expect(await screen.findByRole("heading", { name: /your new key/i })).toBeInTheDocument();
});

test("the synchronous gate releases for a terminal order's new-quote request", async () => {
  const oldQuote: Quote = {
    ...QUOTE,
    pay_to: "8BoldExpiredAddressForTest",
    pay_uri: "monero:8BoldExpiredAddressForTest?tx_amount=0.12345678",
    expires_at: Date.now() - 2_000,
    tracking_until: Date.now() - 1_000,
  };
  const replacement: Quote = {
    ...QUOTE,
    pay_to: "8BnewReplacementAddressForTest",
    pay_uri: "monero:8BnewReplacementAddressForTest?tx_amount=0.12345678",
  };
  let resolveReplacement!: (quote: Quote) => void;
  requestQuote
    .mockImplementationOnce(() => Promise.resolve(oldQuote))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveReplacement = resolve; }));
  fetchOrderStatus
    .mockImplementationOnce(() => Promise.resolve({ contract: 2, server_now: Date.now(), state: "closed" as const }))
    .mockImplementation(() => Promise.resolve({ contract: 2, server_now: Date.now(), state: "waiting" as const }));

  render(<KeyFlow />);
  await screen.findByRole("button", { name: /mint key/i });
  await agreeAndClick(/mint key/i);
  expect(await screen.findByRole("heading", { name: /your new key/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /I saved my key/i }));
  const newQuote = await screen.findByRole("button", { name: /new quote/i });

  act(() => {
    fireEvent.click(newQuote);
    fireEvent.click(newQuote);
  });
  await waitFor(() => expect(requestQuote).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: /requesting/i })).toBeDisabled();

  await act(async () => {
    resolveReplacement(replacement);
    await Promise.resolve();
  });
  expect(await screen.findByRole("link", { name: /swap to XMR/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();
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
  await screen.findByRole("link", { name: /swap to XMR/i }); // let the fresh status handshake settle inside act
});

test("a top-up baseline read failure aborts before hashing or requesting a quote", async () => {
  let rejectBaseline!: (error: unknown) => void;
  checkBalance.mockImplementation(() => new Promise((_resolve, reject) => { rejectBaseline = reject; }));
  render(<KeyFlow />);
  await screen.findByRole("button", { name: /mint key/i });

  fireEvent.change(screen.getByLabelText(/leave blank to mint a new key/i), { target: { value: VALID_TOKEN } });
  await agreeAndClick(/add credit/i);
  await waitFor(() => expect(checkBalance).toHaveBeenCalledWith(VALID_TOKEN));
  await act(async () => {
    rejectBaseline({ kind: "server", status: 503 });
    await Promise.resolve();
  });

  await waitFor(() => expect(screen.getByRole("status", { name: "balance status" })).toHaveTextContent(/balance service is temporarily unavailable/i));
  expect(checkBalance).toHaveBeenCalledTimes(1);
  expect(checkBalance).toHaveBeenCalledWith(VALID_TOKEN); // raw token goes only to the authoritative /balance read
  expect(hashToken).not.toHaveBeenCalled();
  expect(requestQuote).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: /add credit/i })).not.toBeInTheDocument();
});

test("a slow balance result for token A cannot appear after the field changes to token B", async () => {
  let resolveFirst!: (balance: number | null) => void;
  checkBalance.mockImplementation((token: string) =>
    token === VALID_TOKEN
      ? new Promise<number | null>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve(9),
  );
  render(<KeyFlow />);
  await screen.findByRole("button", { name: /mint key/i });
  const field = screen.getByLabelText(/leave blank to mint a new key/i);

  fireEvent.change(field, { target: { value: VALID_TOKEN } });
  fireEvent.click(screen.getByRole("button", { name: /check balance/i }));
  await waitFor(() => expect(checkBalance).toHaveBeenCalledWith(VALID_TOKEN));

  fireEvent.change(field, { target: { value: SECOND_VALID_TOKEN } });
  expect(screen.getByRole("button", { name: /check balance/i })).not.toBeDisabled();
  await act(async () => {
    resolveFirst(42);
    await Promise.resolve();
  });
  expect(screen.queryByText(/\$42\.00/)).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "balance status" })).toBeEmptyDOMElement();

  fireEvent.click(screen.getByRole("button", { name: /check balance/i }));
  await waitFor(() => expect(screen.getByRole("status", { name: "balance status" })).toHaveTextContent("balance: $9.00"));
  expect(checkBalance).toHaveBeenLastCalledWith(SECOND_VALID_TOKEN);
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
