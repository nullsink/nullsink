import { expect, setSystemTime, test } from "bun:test";
import { quoteClockNow } from "../lib/api.ts";
import type { OrderStatus, Quote } from "../lib/api.ts";
import {
  canCancelTentativeExternalPaymentIntent,
  hasExternalPaymentIntent,
  hasTentativeExternalPaymentIntent,
  initialTracking,
  lastPositiveStatus,
  latestStatus,
  requiresStatusCompatibilityRecovery,
  shouldTrackPayment,
  trackingReducer,
  trackingWindowAt,
} from "./payment-tracking.ts";

const v2 = (status: Omit<OrderStatus, "contract" | "server_now"> & { server_now?: number }): OrderStatus => ({
  contract: 2,
  server_now: Date.now(),
  ...status,
});

test("the reducer makes stale negative status and a status error mutually exclusive", () => {
  let state = initialTracking("payable");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "waiting" }) });
  expect(latestStatus(state)?.state).toBe("waiting");

  state = trackingReducer(state, { type: "status-failed", error: { kind: "server", status: 503 } });
  expect(state.kind).toBe("status-error");
  expect(latestStatus(state)).toBeNull(); // the UI has no stale "not seen" value available to render
});

test("a waiting order remains trackable through grace and a late sighting survives the grace boundary", () => {
  let state = initialTracking("grace");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "waiting" }) });
  expect(shouldTrackPayment(state)).toBe(true);

  state = trackingReducer(state, {
    type: "status-received",
    status: v2({ state: "detected", confirmations: 0, required: 3 }),
  });
  state = trackingReducer(state, { type: "clock", window: "elapsed" });

  expect(lastPositiveStatus(state)?.state).toBe("detected");
  expect(shouldTrackPayment(state)).toBe(true); // seen orders outlive the unfunded-order grace server-side too
});

test("an unseen idle order stays retryable after grace until a successful server closing cycle", () => {
  let state = initialTracking("grace");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "waiting" }) });
  state = trackingReducer(state, { type: "clock", window: "elapsed" });
  expect(shouldTrackPayment(state)).toBe(true); // a local clock transition is not authoritative

  state = trackingReducer(state, { type: "status-failed", error: { kind: "server", status: 503 } });
  expect(shouldTrackPayment(state)).toBe(true); // a boundary-time failure must remain retryable

  state = trackingReducer(state, { type: "status-received", status: v2({ state: "closed" }) });
  expect(state.kind).toBe("checking-credit");
  expect(shouldTrackPayment(state)).toBe(true);

  state = trackingReducer(state, { type: "credit-checked", funded: false });
  expect(state.kind).toBe("terminal");
  expect(shouldTrackPayment(state)).toBe(false);

  const terminal = state;
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "detected" }) });
  expect(state).toBe(terminal); // a late promise cannot reopen the terminal quote
});

test("a funded balance result can never produce the replacement terminal state", () => {
  let state = initialTracking("elapsed");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "closed" }) });
  state = trackingReducer(state, { type: "credit-checked", funded: true });
  expect(state.kind).toBe("ready");
  expect(shouldTrackPayment(state)).toBe(true);
});

test("clock windows are monotone so a corrected wall clock cannot redisplay an expired address", () => {
  let state = initialTracking("payable");
  state = trackingReducer(state, { type: "clock", window: "grace" });
  state = trackingReducer(state, { type: "clock", window: "payable" });
  expect(state.window).toBe("grace");

  state = trackingReducer(state, { type: "clock", window: "elapsed" });
  state = trackingReducer(state, { type: "clock", window: "payable" });
  expect(state.window).toBe("elapsed");
  expect(shouldTrackPayment(state)).toBe(true); // still polling; only initiation stays hidden
});

test("a server close monotonically hides initiation through a later status failure", () => {
  let state = initialTracking("payable");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "closed" }) });
  expect(state.window).toBe("grace");
  state = trackingReducer(state, { type: "credit-checked", funded: false });
  state = trackingReducer(state, { type: "check-started" });
  state = trackingReducer(state, { type: "status-failed", error: { kind: "server", status: 503 } });
  expect(state.window).toBe("grace");
  expect(state.kind).toBe("status-error");
});

test("trackingWindowAt uses the additive server horizon and fails safe when an older response omits it", () => {
  const quote: Quote = {
    pay_to: "addr",
    amount: "1.00000000",
    unit: "BTC",
    pay_uri: "bitcoin:addr?amount=1.00000000",
    rate_usd: 1,
    confirmations_required: 3,
    expires_at: 1_000,
    tracking_until: 2_000,
  };
  expect(trackingWindowAt(quote, 999)).toBe("payable");
  expect(trackingWindowAt(quote, 1_000)).toBe("grace");
  expect(trackingWindowAt(quote, 2_000)).toBe("elapsed");
  expect(trackingWindowAt({ ...quote, tracking_until: undefined }, 2_000)).toBe("fallback");
});

test("server durations run on the monotonic request clock, independent of device wall-clock skew", () => {
  const skewed: Quote = {
    pay_to: "addr",
    amount: "1.00000000",
    unit: "BTC",
    pay_uri: "bitcoin:addr?amount=1.00000000",
    rate_usd: 1,
    confirmations_required: 3,
    created_at: 10_000,
    expires_at: 11_000,
    tracking_until: 12_000,
    _request_started_at: 9_000_000,
    _request_started_wall_at: 900_000_000,
  };
  expect(trackingWindowAt(skewed, 999)).toBe("payable");
  expect(trackingWindowAt(skewed, 1_000)).toBe("grace");
  expect(trackingWindowAt(skewed, 2_000)).toBe("elapsed");
});

test("wall elapsed time expires a quote across device sleep even if the monotonic clock pauses", () => {
  const wallStart = Date.now();
  const quote: Quote = {
    pay_to: "addr",
    amount: "1.00000000",
    unit: "BTC",
    pay_uri: "bitcoin:addr?amount=1.00000000",
    rate_usd: 1,
    confirmations_required: 3,
    created_at: 10_000,
    expires_at: 11_000,
    tracking_until: 12_000,
    _request_started_at: performance.now(),
    _request_started_wall_at: wallStart,
  };
  try {
    setSystemTime(new Date(wallStart + 2_000));
    expect(quoteClockNow(quote)).toBeGreaterThanOrEqual(2_000);
    expect(trackingWindowAt(quote)).toBe("elapsed");
  } finally {
    setSystemTime();
  }
});

test("rollback plus suspended monotonic time cannot extend a four-hour quote", () => {
  const HOUR = 60 * 60 * 1_000;
  let wallNow = 100 * HOUR;
  let monotonicNow = 1_000 * HOUR;
  const realDateNow = Date.now;
  const ownPerformanceNow = Object.getOwnPropertyDescriptor(performance, "now");
  Date.now = () => wallNow;
  Object.defineProperty(performance, "now", { configurable: true, value: () => monotonicNow });
  const rollbackQuote: Quote = {
    pay_to: "addr",
    amount: "1.00000000",
    unit: "BTC",
    pay_uri: "bitcoin:addr?amount=1.00000000",
    rate_usd: 1,
    confirmations_required: 3,
    created_at: 10_000,
    expires_at: 10_000 + 4 * HOUR,
    tracking_until: 10_000 + 6 * HOUR,
    _request_started_at: monotonicNow,
    _request_started_wall_at: wallNow,
  };

  try {
    // Three active hours pass on both clocks.
    wallNow += 3 * HOUR;
    monotonicNow += 3 * HOUR;
    expect(quoteClockNow(rollbackQuote)).toBe(3 * HOUR);

    // The wall clock is corrected two hours backwards. Sampling records the correction as a new anchor but
    // cannot reduce the elapsed floor established above.
    wallNow -= 2 * HOUR;
    expect(quoteClockNow(rollbackQuote)).toBe(3 * HOUR);

    // The device then sleeps for two hours on a platform where performance.now pauses. The wall delta from
    // the corrected anchor is still real elapsed time, producing five hours total: the 4h quote is in grace.
    wallNow += 2 * HOUR;
    expect(quoteClockNow(rollbackQuote)).toBe(5 * HOUR);
    expect(trackingWindowAt(rollbackQuote)).toBe("grace");
  } finally {
    Date.now = realDateNow;
    if (ownPerformanceNow) Object.defineProperty(performance, "now", ownPerformanceNow);
    else delete (performance as { now?: () => number }).now;
  }
});

test("the mixed-version fallback stays fail-safe because an old server cannot signal queued credit", () => {
  let state = initialTracking("fallback");
  state = trackingReducer(state, { type: "status-received", status: { state: "closed" } });
  expect(requiresStatusCompatibilityRecovery(state)).toBe(true);
  expect(state.kind).toBe("checking-credit");
  expect(shouldTrackPayment(state)).toBe(true);

  state = trackingReducer(state, { type: "credit-checked", funded: false });
  expect(state.kind).toBe("ready");
  expect(state.window).toBe("fallback");
  expect(shouldTrackPayment(state)).toBe(true);
});

test("deferring an automatic legacy credit check restores the explicit recovery control", () => {
  let state = initialTracking("payable");
  state = trackingReducer(state, { type: "status-received", status: { state: "closed" } });
  expect(state.kind).toBe("checking-credit");
  state = trackingReducer(state, { type: "credit-check-deferred" });
  expect(state.kind).toBe("ready");
  expect(requiresStatusCompatibilityRecovery(state)).toBe(true);
  expect(shouldTrackPayment(state)).toBe(true);
});

test("third-party payment intent is absorbing across later status and error transitions", () => {
  let state = initialTracking("payable");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "waiting" }) });
  state = trackingReducer(state, { type: "external-intent" });
  expect(hasExternalPaymentIntent(state)).toBe(true);
  state = trackingReducer(state, {
    type: "status-received",
    status: v2({ state: "confirming", confirmations: 1, required: 3 }),
  });
  state = trackingReducer(state, { type: "status-failed", error: { kind: "server", status: 503 } });
  state = trackingReducer(state, { type: "external-intent-cancelled" });
  expect(hasExternalPaymentIntent(state)).toBe(true);
  expect(lastPositiveStatus(state)?.state).toBe("confirming");
});

test("an ambiguous native swap gesture is fail-closed but explicitly recoverable while still safe", () => {
  let state = initialTracking("payable");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "waiting" }) });
  state = trackingReducer(state, { type: "external-intent", tentative: true });
  expect(hasExternalPaymentIntent(state)).toBe(true);
  expect(hasTentativeExternalPaymentIntent(state)).toBe(true);
  expect(canCancelTentativeExternalPaymentIntent(state)).toBe(true);

  state = trackingReducer(state, { type: "external-intent-cancelled" });
  expect(hasExternalPaymentIntent(state)).toBe(false);
});

test("tentative intent cannot be canceled after payment evidence appears", () => {
  let state = initialTracking("payable");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "waiting" }) });
  state = trackingReducer(state, { type: "external-intent", tentative: true });
  state = trackingReducer(state, {
    type: "status-received",
    status: v2({ state: "confirming", confirmations: 1, required: 3 }),
  });
  expect(canCancelTentativeExternalPaymentIntent(state)).toBe(false);
  state = trackingReducer(state, { type: "external-intent-cancelled" });
  expect(hasExternalPaymentIntent(state)).toBe(true);
});

test("a backend rollback is sticky and cannot terminalize an elapsed v2 quote", () => {
  let state = initialTracking("elapsed");
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "waiting" }) });
  expect(requiresStatusCompatibilityRecovery(state)).toBe(false);

  // The same loaded UI now reaches the previous backend. Its unversioned `closed` cannot distinguish an
  // acknowledged credit from one that is still crossing the old delivery path.
  state = trackingReducer(state, { type: "status-received", status: { state: "closed" } });
  state = trackingReducer(state, { type: "credit-checked", funded: false });
  expect(state.kind).toBe("ready");
  expect(state.window).toBe("elapsed");
  expect(requiresStatusCompatibilityRecovery(state)).toBe(true);
  expect(shouldTrackPayment(state)).toBe(true);

  // Returning to v2 cannot reconstruct what happened during the rollback interval. Recovery remains locked
  // to this quote until the page/flow performs an explicit reset.
  state = trackingReducer(state, { type: "status-received", status: v2({ state: "closed" }) });
  state = trackingReducer(state, { type: "credit-checked", funded: false });
  expect(state.kind).toBe("ready");
  expect(requiresStatusCompatibilityRecovery(state)).toBe(true);
  expect(shouldTrackPayment(state)).toBe(true);
});

test("the actual prior quote shape (tracking_until but no created_at) is tracked but never payable", () => {
  const wallNow = Date.now();
  const legacy: Quote = {
    pay_to: "old-server-address",
    amount: "1.00000000",
    unit: "BTC",
    pay_uri: "bitcoin:old-server-address?amount=1.00000000",
    rate_usd: 1,
    confirmations_required: 3,
    // The immediately previous backend already supplied tracking_until but not created_at. A device clock
    // hours behind that service could otherwise keep this address visible beyond its reap horizon.
    expires_at: wallNow + 60 * 60 * 1000,
    tracking_until: wallNow + 90 * 60 * 1000,
    _initiation_clock_untrusted: true,
  };

  expect(trackingWindowAt(legacy, wallNow)).toBe("fallback");
});
