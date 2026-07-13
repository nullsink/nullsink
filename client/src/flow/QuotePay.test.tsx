/// <reference lib="dom" />
// Regression coverage for the QuotePay "check" button. The bug: checkNow() did `onFunded(bal); return;`
// on the funded path, skipping the trailing setChecking(false) — so `checking` stayed true and the button
// stayed disabled forever. It was invisible in the live app ONLY because the parent unmounts QuotePay on
// onFunded. These tests pass an onFunded that does NOT unmount, making the stuck flag observable, and
// assert the spinner clears. The fix moved setChecking(false) into a finally{}.
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { OrderStatus, Quote } from "../lib/api.ts";

// checkNow drives exactly two network calls; stub both so we control the funded / not-yet-funded outcome.
const fetchOrderStatus = mock((_hash: string, _address?: string): Promise<OrderStatus> => Promise.resolve({ state: "closed" }));
const checkBalance = mock((_token: string): Promise<number | null> => Promise.resolve(null));

// Replace the whole api module BEFORE QuotePay is imported (mock.module is not hoisted). buyErrorMessage
// and trocadorSwapUrl are also pulled in by QuotePay's render path, so stub them too.
mock.module("../lib/api.ts", () => ({
  fetchOrderStatus,
  checkBalance,
  buyErrorMessage: (code: string) => code,
  trocadorSwapUrl: (_q: Quote) => "https://trocador.app/anonpay/?stub=1",
}));
// Make hashToken deterministic and crypto-free so the test doesn't depend on a WebCrypto impl.
mock.module("../lib/token.ts", () => ({
  hashToken: (_token: string) => Promise.resolve("aa".repeat(32)),
}));

// Import after the mocks are registered so QuotePay binds them.
const { QuotePay } = await import("./QuotePay.tsx");

const quote: Quote = {
  pay_to: "bc1qstubaddressfortest",
  amount: "0.00050000",
  unit: "BTC",
  pay_uri: "bitcoin:bc1qstubaddressfortest?amount=0.00050000",
  rate_usd: 150,
  confirmations_required: 3,
  expires_at: Date.now() + 60 * 60 * 1000, // 1h out — not expired, and fits the expiry timer's setTimeout
};

function renderPay(onFunded: (b: number) => void, baseline = 0) {
  return render(
    <QuotePay
      token="0sink_testtoken"
      quote={quote}
      baseline={baseline}
      busy={false}
      errorCode={null}
      onRetry={() => {}}
      onFunded={onFunded}
    />,
  );
}

beforeEach(() => {
  fetchOrderStatus.mockReset();
  checkBalance.mockReset();
});

// THE REGRESSION: a funded check must clear the spinner and leave the button usable. onFunded here does
// NOT unmount (unlike the real parent), so a stuck `checking` flag is observable. Pre-fix this failed.
test("funded check clears the spinner and re-enables the button (regression)", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve({ state: "finalizing", confirmations: 10, required: 10 }));
  checkBalance.mockImplementation(() => Promise.resolve(7.5)); // > baseline 0 → funded

  let funded: number | null = null;
  renderPay((b) => { funded = b; });

  const button = screen.getByRole("button", { name: "check" });
  expect(button).not.toBeDisabled(); // enabled before the click
  fireEvent.click(button);

  await waitFor(() => expect(funded).toBe(7.5)); // funded path taken (the early `return`)
  await waitFor(() => expect(button).not.toBeDisabled()); // ...and the spinner cleared regardless
});

// Specificity guard: the not-yet-funded path (no early return) must also re-enable the button, and must
// NOT spend the raw token on /balance while the order is only "confirming".
test("not-yet-funded check re-enables the button without calling /balance", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve({ state: "confirming", confirmations: 3, required: 10 }));

  let funded = false;
  renderPay(() => { funded = true; });

  const button = screen.getByRole("button", { name: "check" });
  fireEvent.click(button);

  await waitFor(() => expect(button).not.toBeDisabled());
  expect(funded).toBe(false);
  expect(checkBalance).not.toHaveBeenCalled();
});

// Scoping: a hash can have several open orders at once, so the poll must name the one THIS tab is tracking.
// QuotePay holds the quote (with pay_to) in memory, so checkNow passes it — otherwise the read collapses to
// "newest wins" and an empty newer order shadows the paid one the payer is watching.
test("checkNow scopes the poll to THIS order: fetchOrderStatus is called with the quote's pay_to", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve({ state: "confirming", confirmations: 1, required: 3 }));
  renderPay(() => {});
  fireEvent.click(screen.getByRole("button", { name: "check" }));
  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalled());
  // hashToken is stubbed to "aa".repeat(32); the address is the quote's pay_to. Dropping the arg in QuotePay fails this.
  expect(fetchOrderStatus).toHaveBeenCalledWith("aa".repeat(32), quote.pay_to);
});

// `detected` = the server durably saw an inbound (seen_at) but has no live confirmation count, because it
// restarted and its wallet is still resyncing. Telling a payer "not seen yet" here is how you get paid twice:
// pay-once already closed the order on the first deposit, so the second lands on no open order and is lost
// forever. This must never fall through to the "not seen yet" copy.
test("`detected` tells the payer we have their payment, and does not spend the token on /balance", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve({ state: "detected" }));

  let funded = false;
  renderPay(() => { funded = true; });

  const button = screen.getByRole("button", { name: "check" });
  fireEvent.click(button);

  await waitFor(() => expect(button).not.toBeDisabled());
  // Rendered twice on purpose: the visible line and the sr-only live region announce the same settled status.
  expect(screen.getAllByText("payment seen, re-checking…")).toHaveLength(2);
  expect(screen.queryByText("not seen yet")).not.toBeInTheDocument();
  expect(funded).toBe(false);
  expect(checkBalance).not.toHaveBeenCalled(); // `detected` is not `finalizing` — no premature token spend
});

test("a transient status failure warns the payer not to send again and keeps the check usable", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.reject({ kind: "rate_limited", status: 429, retryAfterSec: 1 }));
  renderPay(() => {});

  const button = screen.getByRole("button", { name: "check" });
  fireEvent.click(button);

  expect(await screen.findByText(/don't resend/i)).toBeInTheDocument();
  await waitFor(() => expect(button).not.toBeDisabled());
  expect(checkBalance).not.toHaveBeenCalled();
});
