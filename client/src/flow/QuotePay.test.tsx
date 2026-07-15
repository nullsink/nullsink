/// <reference lib="dom" />
// Payment-state integration coverage. QuotePay deliberately keeps transport/status/credit outcomes in the
// reducer; these tests leave the component mounted after callbacks so stuck transitions remain observable.
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { OrderStatus, Quote } from "../lib/api.ts";
import * as realApi from "../lib/api.ts";
import * as realToken from "../lib/token.ts";

const v2 = (status: Omit<OrderStatus, "contract" | "server_now"> & { server_now?: number }): OrderStatus => ({
  contract: 2,
  server_now: Date.now(),
  ...status,
});

// checkNow drives exactly two network calls; stub both so we control the funded / not-yet-funded outcome.
const fetchOrderStatus = mock((_hash: string, _address?: string): Promise<OrderStatus> => Promise.resolve(v2({ state: "closed" })));
const checkBalance = mock((_token: string): Promise<number | null> => Promise.resolve(null));

// Replace the whole api module BEFORE QuotePay is imported (mock.module is not hoisted). buyErrorMessage
// and trocadorSwapUrl are also pulled in by QuotePay's render path, so stub them too.
mock.module("../lib/api.ts", () => ({
  ...realApi,
  fetchOrderStatus,
  checkBalance,
  buyErrorMessage: (code: string) => code,
  paymentStatusErrorMessage: (error: { kind: string }) => `status failure: ${error.kind}`,
  creditVerificationErrorMessage: (error: { kind: string }) => `credit failure: ${error.kind}`,
  toReadFailure: (error: unknown) => error as { kind: string; status: number },
  trocadorSwapUrl: (_q: Quote) => "https://trocador.app/anonpay/?stub=1",
}));
// Make hashToken deterministic and crypto-free so the test doesn't depend on a WebCrypto impl.
mock.module("../lib/token.ts", () => ({
  ...realToken,
  hashToken: (_token: string) => Promise.resolve("aa".repeat(32)),
}));

// Import after the mocks are registered so QuotePay binds them.
const { QuotePay } = await import("./QuotePay.tsx");

const quoteCreatedAt = Date.now();
const quote: Quote = {
  contract: 2,
  pay_to: "bc1qstubaddressfortest",
  amount: "0.00050000",
  unit: "BTC",
  pay_uri: "bitcoin:bc1qstubaddressfortest?amount=0.00050000",
  rate_usd: 150,
  confirmations_required: 3,
  created_at: quoteCreatedAt,
  expires_at: quoteCreatedAt + 60 * 60 * 1000, // 1h out — not expired, and fits the expiry timer's setTimeout
  tracking_until: quoteCreatedAt + 90 * 60 * 1000,
};

function renderPay(onFunded: (b: number) => void, baseline = 0, payQuote = quote) {
  return render(
    <QuotePay
      token="0sink_testtoken"
      quote={payQuote}
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
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
  checkBalance.mockReset();
  checkBalance.mockImplementation(() => Promise.resolve(null));
});

// THE REGRESSION: a funded check must clear the spinner and leave the button usable. onFunded here does
// NOT unmount (unlike the real parent), so a stuck `checking` flag is observable. Pre-fix this failed.
test("funded check clears the spinner and re-enables the button (regression)", async () => {
  fetchOrderStatus
    .mockImplementationOnce(() => Promise.resolve(v2({ state: "waiting" })))
    .mockImplementation(() => Promise.resolve(v2({ state: "finalizing", confirmations: 10, required: 10 })));
  checkBalance.mockImplementation(() => Promise.resolve(7.5)); // > baseline 0 → funded

  let funded: number | null = null;
  renderPay((b) => { funded = b; });

  const button = await screen.findByRole("button", { name: "check" });
  expect(button).not.toBeDisabled(); // enabled before the click
  fireEvent.click(button);

  await waitFor(() => expect(funded).toBe(7.5)); // funded path taken (the early `return`)
  await waitFor(() => expect(screen.getByRole("button", { name: "check" })).not.toBeDisabled());
});

// Specificity guard: the not-yet-funded path (no early return) must also re-enable the button, and must
// NOT spend the raw token on /balance while the order is only "confirming".
test("not-yet-funded check re-enables the button without calling /balance", async () => {
  fetchOrderStatus
    .mockImplementationOnce(() => Promise.resolve(v2({ state: "waiting" })))
    .mockImplementation(() => Promise.resolve(v2({ state: "confirming", confirmations: 3, required: 10 })));

  let funded = false;
  renderPay(() => { funded = true; });

  const button = await screen.findByRole("button", { name: "check" });
  fireEvent.click(button);

  await waitFor(() => expect(screen.getByRole("button", { name: "check" })).not.toBeDisabled());
  expect(funded).toBe(false);
  expect(checkBalance).not.toHaveBeenCalled();
});

// Scoping remains load-bearing for pre-single-flight databases that already contain duplicate open hashes.
// QuotePay holds the quote (with pay_to) in memory, so checkNow must name the order THIS tab is tracking.
test("checkNow scopes the poll to THIS order: fetchOrderStatus is called with the quote's pay_to", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "confirming", confirmations: 1, required: 3 })));
  renderPay(() => {});
  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalled());
  // hashToken is stubbed to "aa".repeat(32); the address is the quote's pay_to. Dropping the arg in QuotePay fails this.
  expect(fetchOrderStatus).toHaveBeenCalledWith("aa".repeat(32), quote.pay_to);
});

// `detected` = the server durably saw an inbound (seen_at) but has no live confirmation count, because it
// restarted and its wallet is still resyncing. Telling a payer "not seen yet" here is how you get paid twice:
// pay-once already closed the order on the first deposit, so the second lands on no open order and is lost
// forever. This must never fall through to the "not seen yet" copy.
test("`detected` tells the payer we have their payment, and does not spend the token on /balance", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "detected" })));

  let funded = false;
  renderPay(() => { funded = true; });

  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/payment seen, re-checking.*don't resend/i),
  );
  expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/payment seen, re-checking.*don't resend/i);
  expect(screen.queryByText("not seen yet")).not.toBeInTheDocument();
  expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  expect(funded).toBe(false);
  expect(checkBalance).not.toHaveBeenCalled(); // `detected` is not `finalizing` — no premature token spend
});

test("a server-authoritative close hides a still-locally-payable address", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "closed" })));
  checkBalance.mockImplementation(() => Promise.resolve(null));
  renderPay(() => {});

  await waitFor(() => expect(checkBalance).toHaveBeenCalled());
  expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/credit isn't verified.*don't resend/i);
  expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();

  fetchOrderStatus.mockImplementation(() => Promise.reject({ kind: "server", status: 503 }));
  fireEvent.click(screen.getByRole("button", { name: "check" }));
  await waitFor(() => expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/don't resend/i));
  expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
});

test("observing an unversioned status locks a payable quote and keeps manual recovery available", async () => {
  // This is the previous backend's real status envelope: no `contract` discriminator. Even `waiting` is
  // enough to prove the UI/backend pair is mixed, so every initiation surface must disappear immediately.
  fetchOrderStatus.mockImplementation(() => Promise.resolve({ state: "waiting" }));
  renderPay(() => {});
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/tracking changed versions.*don't pay or resend.*stay locked/i),
  );
  expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "check" })).toBeInTheDocument();
  expect(checkBalance).not.toHaveBeenCalled();
});

test("an unknown state under the v2 number cannot authorize payment initiation", async () => {
  fetchOrderStatus.mockImplementation(() =>
    Promise.resolve({ contract: 2, server_now: Date.now(), state: "future-state" } as unknown as OrderStatus),
  );
  renderPay(() => {});

  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/tracking changed versions.*stay locked/i),
  );
  expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  expect(checkBalance).not.toHaveBeenCalled();
});

test("repeated automatic legacy closed polls stay hash-only; only explicit check sends the saved key", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve({ state: "closed" }));
  renderPay(() => {});

  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(
      /automatic checks use only the order hash; select check to verify credit with your saved key/i,
    ),
  );
  await screen.findByRole("button", { name: "check" });
  expect(checkBalance).not.toHaveBeenCalled();

  // Refocus is an automatic cycle, just like the 45-second timer, and must remain hash-only indefinitely.
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(fetchOrderStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "check" })).not.toBeDisabled());
  expect(checkBalance).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "check" }));
  await waitFor(() => expect(checkBalance).toHaveBeenCalledTimes(1));
});

test("opening the prefilled swap absorbs payment intent and later progress remains visible", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
  renderPay(() => {});

  const swap = await screen.findByRole("link", { name: /swap to BTC.*locks quote/i });
  expect(swap).toHaveAttribute("href", "https://trocador.app/anonpay/?stub=1");
  swap.addEventListener("click", (event) => event.preventDefault(), { once: true });
  fireEvent.click(swap);

  expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/swap opened.*don't also pay directly/i);
  expect(checkBalance).not.toHaveBeenCalled();

  fetchOrderStatus.mockImplementation(() =>
    Promise.resolve(v2({ state: "confirming", confirmations: 1, required: 3 })),
  );
  fireEvent.click(screen.getByRole("button", { name: "check" }));
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(
      /payment seen, confirming 1\/3.*don't resend/i,
    ),
  );
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
});

const committedSwapLaunches = [
  [
    "middle-click",
    (link: HTMLElement) =>
      fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })),
  ],
  // Enter on a semantic anchor culminates in a detail=0 click; no custom key handler should suppress it.
  ["keyboard Enter", (link: HTMLElement) => fireEvent.click(link, { button: 0, detail: 0 })],
] as const;

for (const [gesture, launch] of committedSwapLaunches) {
  test(`${gesture} swap launch absorbs payment intent and removes every second payment path`, async () => {
    fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
    renderPay(() => {});

    const swap = await screen.findByRole("link", { name: /swap to BTC.*locks quote/i });
    // Keep the semantic anchor and its real href under test without asking happy-dom to navigate externally.
    swap.addEventListener("click", (event) => event.preventDefault(), { once: true });
    launch(swap);

    // The exact node and href remain connected for the browser's already-started native default action,
    // while aria-hidden removes it as a second interactive path in this page.
    expect(swap.isConnected).toBe(true);
    expect(swap).toHaveAttribute("href", "https://trocador.app/anonpay/?stub=1");
    expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
    expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(
      /swap opened.*don't also pay directly or open another swap/i,
    );
    expect(checkBalance).not.toHaveBeenCalled();
  });
}

const tentativeSwapLaunches = [
  ["pointer context-menu", (link: HTMLElement) => fireEvent.contextMenu(link, { button: 2, detail: 1 })],
  // Browsers expose Shift+F10/the context-menu key as a contextmenu event without a pointing-device button.
  ["keyboard context-menu", (link: HTMLElement) => fireEvent.contextMenu(link, { button: 0, detail: 0 })],
  ["drag to another tab", (link: HTMLElement) => fireEvent.dragStart(link)],
] as const;

for (const [gesture, launch] of tentativeSwapLaunches) {
  test(`${gesture} is fail-closed, preserves the native link action, and permits explicit cancel recovery`, async () => {
    fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
    renderPay(() => {});

    const swap = await screen.findByRole("link", { name: /swap to BTC.*locks quote/i });
    // A first ambiguous native gesture must not be canceled: the browser still owns its menu/drag action.
    expect(launch(swap)).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(
        /swap launch may have started.*don't also pay directly/i,
      ),
    );

    expect(swap.isConnected).toBe(true);
    expect(swap).toHaveAttribute("href", "https://trocador.app/anonpay/?stub=1");
    expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
    expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
    expect(checkBalance).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /I canceled.*restore payment options/i }));
    expect(await screen.findByRole("link", { name: /swap to BTC.*locks quote/i })).toBe(swap);
    expect(document.querySelector(".pay-to")).toHaveTextContent(quote.pay_to);
    expect(screen.getByText(quote.amount)).toBeInTheDocument();
  });
}

test("a rollback to an unversioned closed response cannot release an elapsed v2 quote", async () => {
  const now = Date.now();
  const elapsed: Quote = { ...quote, expires_at: now - 2_000, tracking_until: now - 1_000 };
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
  checkBalance.mockImplementation(() => Promise.resolve(null));
  renderPay(() => {}, 0, elapsed);

  await screen.findByRole("button", { name: "check" });
  fetchOrderStatus.mockImplementation(() => Promise.resolve({ state: "closed" }));
  fireEvent.click(screen.getByRole("button", { name: "check" }));
  await waitFor(() => expect(checkBalance).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/tracking changed versions.*stay locked/i);
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "check" })).toBeInTheDocument();
});

test("the actual prior quote shape (tracking_until but no created_at) is initiation-closed and nonterminal", async () => {
  const now = Date.now();
  const priorQuote: Quote = {
    ...quote,
    expires_at: now + 60 * 60 * 1_000,
    tracking_until: now + 90 * 60 * 1_000,
    _initiation_clock_untrusted: true,
  };
  fetchOrderStatus.mockImplementation(() => Promise.resolve({ state: "closed" }));
  checkBalance.mockImplementation(() => Promise.resolve(null));
  renderPay(() => {}, 0, priorQuote);

  // requestQuote marks this exact wire shape untrusted. Its future wall-clock fields cannot make an address
  // payable, and an old backend's `closed` response cannot turn it into a replacement offer.
  expect(screen.queryByText(priorQuote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(priorQuote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalled());
  expect(checkBalance).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/tracking changed versions.*stay locked/i),
  );
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();
  const check = await screen.findByRole("button", { name: "check" });
  await waitFor(() => expect(check).not.toBeDisabled());
  fireEvent.click(check);
  await waitFor(() => expect(checkBalance).toHaveBeenCalledTimes(1));
});

test("a transient status failure replaces stale negative status with one accessible don't-resend warning", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
  renderPay(() => {});

  const button = await screen.findByRole("button", { name: "check" });
  expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent("not seen yet");

  fetchOrderStatus.mockImplementation(() => Promise.reject({ kind: "rate_limited", status: 429, retryAfterSec: 1 }));
  fireEvent.click(button);

  expect(await screen.findByRole("status", { name: "payment status" })).toHaveTextContent("status failure: rate_limited");
  expect(screen.queryByText("not seen yet")).not.toBeInTheDocument();
  expect(screen.getAllByText("status failure: rate_limited")).toHaveLength(1);
  await waitFor(() => expect(button).not.toBeDisabled());
  expect(checkBalance).not.toHaveBeenCalled();
});

test("a failed final balance verification names that step, not payment status", async () => {
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "finalizing", confirmations: 3, required: 3 })));
  checkBalance.mockImplementation(() => Promise.reject({ kind: "server", status: 503 }));
  renderPay(() => {});

  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent("credit failure: server"),
  );
  expect(screen.queryByText(/status failure/i)).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "check" })).not.toBeDisabled());
});

test("hiding while the hash-only status read is pending blocks the raw-token read until a visible retry", async () => {
  const originalVisibility = document.visibilityState;
  let resolveStatus!: (status: OrderStatus) => void;
  fetchOrderStatus
    .mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }))
    .mockImplementationOnce(() => Promise.resolve(v2({ state: "finalizing", confirmations: 3, required: 3 })));
  checkBalance.mockImplementation(() => Promise.resolve(8));
  let funded: number | null = null;

  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    renderPay((balance) => { funded = balance; });
    await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      resolveStatus(v2({ state: "finalizing", confirmations: 3, required: 3 }));
      await Promise.resolve();
    });
    expect(checkBalance).not.toHaveBeenCalled();
    expect(funded).toBeNull();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(checkBalance).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(funded).toBe(8));
  } finally {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: originalVisibility });
  }
});

test("unmounting while status is pending never starts a background raw-token read", async () => {
  let resolveStatus!: (status: OrderStatus) => void;
  fetchOrderStatus.mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve; }));
  checkBalance.mockImplementation(() => Promise.resolve(9));
  let funded = false;

  const view = renderPay(() => { funded = true; });
  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => {
    resolveStatus(v2({ state: "closed" }));
    await Promise.resolve();
  });

  expect(checkBalance).not.toHaveBeenCalled();
  expect(funded).toBe(false);
});

test("a status result from a replaced quote cannot spend the token; the new quote remains retryable", async () => {
  let resolveOldStatus!: (status: OrderStatus) => void;
  fetchOrderStatus
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOldStatus = resolve; }))
    .mockImplementationOnce(() => Promise.resolve(v2({ state: "waiting" })));
  checkBalance.mockImplementation(() => Promise.resolve(11));
  let funded: number | null = null;
  const view = renderPay((balance) => { funded = balance; });

  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalledTimes(1));
  const replacement = {
    ...quote,
    pay_to: "bc1qreplacementaddressfortest",
    pay_uri: "bitcoin:bc1qreplacementaddressfortest?amount=0.00050000",
  };
  view.rerender(
    <QuotePay
      token="0sink_testtoken"
      quote={replacement}
      baseline={0}
      busy={false}
      errorCode={null}
      onRetry={() => {}}
      onFunded={(balance) => { funded = balance; }}
    />,
  );

  await act(async () => {
    resolveOldStatus(v2({ state: "finalizing", confirmations: 3, required: 3 }));
    await Promise.resolve();
  });
  expect(checkBalance).not.toHaveBeenCalled();
  expect(funded).toBeNull();
  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalledTimes(2));

  fetchOrderStatus.mockImplementationOnce(() =>
    Promise.resolve(v2({ state: "finalizing", confirmations: 3, required: 3 })),
  );
  const button = await screen.findByRole("button", { name: "check" });
  fireEvent.click(button);
  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalledTimes(3));
  expect(fetchOrderStatus).toHaveBeenLastCalledWith("aa".repeat(32), replacement.pay_to);
  await waitFor(() => expect(checkBalance).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(funded).toBe(11));
});

test("expiry hides every payment-initiation surface but keeps an unseen order polling through server grace", async () => {
  const now = Date.now();
  const expiredInGrace: Quote = {
    ...quote,
    expires_at: now - 1_000,
    tracking_until: now + 30 * 60 * 1000,
  };
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
  renderPay(() => {}, 0, expiredInGrace);

  // Entering grace triggers an immediate hash-only status read. The raw token remains reserved for a
  // finalizing/closed response, and all address/amount/swap surfaces are gone.
  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalledWith("aa".repeat(32), quote.pay_to));
  await waitFor(() => expect(screen.getByRole("button", { name: "check" })).not.toBeDisabled());
  expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/quote expired.*don't pay.*don't resend.*still checking/i);
  expect(screen.queryByText(quote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(quote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  expect(checkBalance).not.toHaveBeenCalled();

  // A payment sent just before expiry may still look waiting at the deadline. When the backend spots it
  // during its configured grace, the same tracker advances instead of abandoning it for a fresh quote.
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "confirming", confirmations: 1, required: 3 })));
  fireEvent.click(screen.getByRole("button", { name: "check" }));
  await waitFor(() => expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/quote expired.*payment seen, confirming 1\/3.*don't resend/i));
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();
  expect(checkBalance).not.toHaveBeenCalled();
});

test("a first v2 server clock already beyond expiry never authorizes payment details", async () => {
  const createdAt = 1_000_000;
  const serverExpired: Quote = {
    ...quote,
    created_at: createdAt,
    expires_at: createdAt + 1_000,
    tracking_until: createdAt + 60_000,
    _request_started_at: performance.now(),
    _request_started_wall_at: Date.now(),
  };
  fetchOrderStatus.mockImplementation(() =>
    Promise.resolve(v2({ state: "waiting", server_now: createdAt + 1_001 })),
  );

  renderPay(() => {}, 0, serverExpired);
  expect(screen.queryByText(serverExpired.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(serverExpired.amount)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/quote expired.*don't pay/i),
  );
  expect(screen.queryByText(serverExpired.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(serverExpired.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  expect(checkBalance).not.toHaveBeenCalled();
});

test("elapsed waiting and status failures stay live; only closed plus a successful balance read offers replacement", async () => {
  const now = Date.now();
  const elapsed: Quote = { ...quote, expires_at: now - 2_000, tracking_until: now - 1_000 };
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
  renderPay(() => {}, 0, elapsed);

  // Entering elapsed requests an immediate closing read, but a still-open order is not replaceable.
  await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole("button", { name: "check" })).not.toBeDisabled());
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();

  // A failure at the exact boundary remains visible and retryable rather than becoming a terminal screen.
  fetchOrderStatus.mockImplementation(() => Promise.reject({ kind: "server", status: 503 }));
  fireEvent.click(screen.getByRole("button", { name: "check" }));
  expect(await screen.findByRole("status", { name: "payment status" })).toHaveTextContent("status failure: server");
  await waitFor(() => expect(screen.getByRole("button", { name: "check" })).not.toBeDisabled());
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();

  // Only the server-authoritative close followed by a successful unchanged balance read can terminate.
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "closed" })));
  checkBalance.mockImplementation(() => Promise.resolve(null));
  fireEvent.click(screen.getByRole("button", { name: "check" }));
  expect(await screen.findByRole("button", { name: /new quote/i })).toBeInTheDocument();
});

test("a queued credit stays live at elapsed until balance delivery is definite", async () => {
  const now = Date.now();
  const elapsed: Quote = { ...quote, expires_at: now - 2_000, tracking_until: now - 1_000 };
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "finalizing", confirmations: 3, required: 3 })));
  checkBalance.mockImplementation(() => Promise.resolve(null));
  renderPay(() => {}, 0, elapsed);

  await waitFor(() => expect(checkBalance).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole("button", { name: "check" })).not.toBeDisabled());
  expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/confirmed, verifying credit/i);
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();
});

test("a late sighting after the local horizon wins over replacement", async () => {
  const now = Date.now();
  const elapsed: Quote = { ...quote, expires_at: now - 2_000, tracking_until: now - 1_000 };
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "confirming", confirmations: 1, required: 3 })));
  renderPay(() => {}, 0, elapsed);

  await waitFor(() =>
    expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/payment seen, confirming 1\/3/i),
  );
  expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();
  expect(checkBalance).not.toHaveBeenCalled();
});

test("a hidden tab cannot terminate at the horizon before its visible closing read", async () => {
  const originalVisibility = document.visibilityState;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  try {
    const now = Date.now();
    const elapsed: Quote = { ...quote, expires_at: now - 2_000, tracking_until: now - 1_000 };
    fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting" })));
    renderPay(() => {}, 0, elapsed);

    await Promise.resolve();
    expect(fetchOrderStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetchOrderStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /new quote/i })).not.toBeInTheDocument();
  } finally {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: originalVisibility });
  }
});

test("the first handshake yields to an overdue expiry timer when both clocks under-report wake time", async () => {
  // Put both request anchors far ahead of their live clocks. quoteClockNow therefore stays pinned at zero,
  // modeling a wake where wall time was rolled back and performance.now did not count sleep, while the real
  // browser timeout still reaches its ten-millisecond target.
  const timedQuote: Quote = {
    ...quote,
    created_at: 50_000,
    expires_at: 50_010,
    tracking_until: 50_000 + 60 * 60 * 1_000,
    _request_started_at: performance.now() + 60 * 60 * 1_000,
    _request_started_wall_at: Date.now() + 60 * 60 * 1_000,
  };
  fetchOrderStatus.mockImplementation(() => Promise.resolve(v2({ state: "waiting", server_now: 50_000 })));

  renderPay(() => {}, 0, timedQuote);
  expect(screen.queryByText(timedQuote.amount)).not.toBeInTheDocument();
  await act(async () => { await Bun.sleep(25); });

  // Recomputing trackingWindowAt here would still say payable. The timer's own completion is the structural
  // boundary evidence that makes every payment-initiation surface disappear.
  expect(screen.queryByText(timedQuote.pay_to)).not.toBeInTheDocument();
  expect(screen.queryByText(timedQuote.amount)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /swap to/i })).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "payment status" })).toHaveTextContent(/quote expired/i);
  expect(realApi.quoteClockNow(timedQuote)).toBeGreaterThanOrEqual(10);
});
