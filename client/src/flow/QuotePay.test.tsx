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
const fetchOrderStatus = mock((_hash: string): Promise<OrderStatus> => Promise.resolve({ state: "closed" }));
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
