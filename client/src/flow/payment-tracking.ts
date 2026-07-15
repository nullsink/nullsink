import {
  quoteClockNow,
  quoteExpiresAt,
  quoteTrackingUntil,
  type OrderStatus,
  type Quote,
  type ReadFailure,
} from "../lib/api.ts";

// Payment tracking is intentionally a small state machine rather than parallel `status`, `checking`, and
// error booleans. A status failure and a credit-verification failure are mutually exclusive states, so the
// UI cannot accidentally render a stale negative status beside a money-safety warning.
export type TrackingWindow = "payable" | "grace" | "fallback" | "elapsed";

type PositiveStatus = OrderStatus & { state: "detected" | "confirming" | "finalizing" };
type VerifyingStatus = OrderStatus & { state: "finalizing" | "closed" };
type StatusContract = "unverified" | "v2" | "legacy";
type ExternalIntent = "none" | "tentative" | "committed";

type Evidence = {
  latest: OrderStatus | null;
  // Monotonic evidence: once the server has seen a payment, a later transient/waiting response must never
  // make the UI regress to "not seen". The backend's durable seen_at has the same monotonic rule.
  lastPositive: PositiveStatus | null;
  // Sticky per quote. Once this page observes an older/unknown order-status envelope it cannot infer the
  // missing outbox history from a later response, so only an explicit quote reset may leave recovery mode.
  statusContract: StatusContract;
  // A v2 response is not a clock handshake unless it also carries the server's current time. Initiation stays
  // hidden until QuotePay validates that timestamp against this quote and records the fresh response here.
  freshHandshake: boolean;
  // Opening a pre-filled third-party swap is observable payment intent: the destination has left this page and
  // may be paid later. Definite activation is absorbing. Native context-menu/drag gestures are tentative because
  // the browser does not report whether the user completed or canceled them; they fail closed but may be explicitly
  // canceled while the quote is otherwise still safe to initiate.
  externalIntent: ExternalIntent;
};

export type TrackingState =
  | { kind: "ready"; window: TrackingWindow; evidence: Evidence }
  | { kind: "checking-status"; window: TrackingWindow; evidence: Evidence }
  | { kind: "checking-credit"; window: TrackingWindow; evidence: Evidence; status: VerifyingStatus }
  | { kind: "status-error"; window: TrackingWindow; evidence: Evidence; error: ReadFailure }
  | { kind: "credit-error"; window: TrackingWindow; evidence: Evidence; status: VerifyingStatus; error: ReadFailure }
  // Replacement is an explicit outcome, never a side effect of the browser clock crossing a deadline.
  | { kind: "terminal"; window: "elapsed"; evidence: Evidence };

export type TrackingAction =
  | { type: "reset"; window: TrackingWindow }
  | { type: "clock"; window: TrackingWindow }
  | { type: "external-intent"; tentative?: boolean }
  | { type: "external-intent-cancelled" }
  | { type: "check-started" }
  | { type: "status-received"; status: OrderStatus }
  | { type: "status-failed"; error: ReadFailure }
  | { type: "credit-check-deferred" }
  | { type: "credit-checked"; funded: boolean }
  | { type: "credit-failed"; error: ReadFailure };

const EMPTY_EVIDENCE: Evidence = {
  latest: null,
  lastPositive: null,
  statusContract: "unverified",
  freshHandshake: false,
  externalIntent: "none",
};

export function trackingWindowAt(quote: Quote | null, now = quote ? quoteClockNow(quote) : Date.now()): TrackingWindow {
  if (!quote) return "elapsed";
  const expiresAt = quoteExpiresAt(quote);
  const trackingUntil = quoteTrackingUntil(quote);
  if (now < expiresAt) return "payable";
  // New servers author this from the same duration used by the unfunded reaper. During a mixed-version
  // deployment an older response can omit it; `fallback` keeps tracking rather than recreating the old,
  // unsafe behavior of abandoning a possibly-sent payment at expires_at.
  if (
    trackingUntil === undefined ||
    !Number.isFinite(trackingUntil) ||
    trackingUntil < expiresAt
  )
    return "fallback";
  return now < trackingUntil ? "grace" : "elapsed";
}

export function initialTracking(window: TrackingWindow): TrackingState {
  return { kind: "ready", window, evidence: EMPTY_EVIDENCE };
}

function isPositive(status: OrderStatus): status is PositiveStatus {
  return status.state === "detected" || status.state === "confirming" || status.state === "finalizing";
}

function evidenceOf(state: TrackingState): Evidence {
  return state.evidence;
}

function withStatus(evidence: Evidence, status: OrderStatus): Evidence {
  const freshContract =
    status.contract === 2 && Number.isFinite(status.server_now) && (status.server_now ?? -1) >= 0;
  return {
    latest: status,
    lastPositive: isPositive(status) ? status : evidence.lastPositive,
    // Legacy is absorbing for this quote. A rollback can erase the evidence that a credit was queued, and
    // seeing v2 again later cannot prove no legacy `closed` response raced that delivery.
    statusContract:
      evidence.statusContract === "legacy" || !freshContract ? "legacy" : "v2",
    freshHandshake: evidence.freshHandshake || freshContract,
    externalIntent: evidence.externalIntent,
  };
}

const WINDOW_RANK: Record<TrackingWindow, number> = { payable: 0, grace: 1, fallback: 1, elapsed: 2 };

function advanceWindow(current: TrackingWindow, next: TrackingWindow): TrackingWindow {
  // A wall-clock correction must never redisplay a single-use payment address after this quote hid it.
  // Grace/fallback are alternate server-version paths at the same stage; keep whichever this quote entered.
  return WINDOW_RANK[next] > WINDOW_RANK[current] ? next : current;
}

export function trackingReducer(state: TrackingState, action: TrackingAction): TrackingState {
  // Terminal is absorbing. A status promise or visibility callback already queued during effect cleanup
  // cannot reopen a closed quote; only an explicit new-quote reset creates another state machine.
  if (state.kind === "terminal" && action.type !== "reset") return state;
  switch (action.type) {
    case "reset":
      return initialTracking(action.window);
    case "clock":
      // The absorbing guard above already handles this at runtime; repeat the narrowing so TypeScript also
      // preserves terminal's stronger `window: "elapsed"` invariant when checking the spread below.
      if (state.kind === "terminal") return state;
      return { ...state, window: advanceWindow(state.window, action.window) };
    case "external-intent":
      return {
        ...state,
        evidence: {
          ...evidenceOf(state),
          externalIntent:
            evidenceOf(state).externalIntent === "committed" || !action.tentative
              ? "committed"
              : "tentative",
        },
      };
    case "external-intent-cancelled":
      // Only a browser gesture whose completion is unknowable can be canceled, and only while every other
      // initiation invariant still permits this quote. A definite click, positive sighting, close, expiry, or
      // compatibility rollback remains absorbing regardless of what a late UI event requests.
      if (!canCancelTentativeExternalPaymentIntent(state)) return state;
      return { ...state, evidence: { ...evidenceOf(state), externalIntent: "none" } };
    case "check-started":
      return { kind: "checking-status", window: state.window, evidence: evidenceOf(state) };
    case "status-received": {
      const evidence = withStatus(evidenceOf(state), action.status);
      // `closed` is server-authoritative permission to stop initiating payment even when the local quote
      // clock still says payable. Advance monotonically so a later status-read failure cannot redisplay the
      // address. A mixed-version fallback stays fallback (equal rank) and therefore remains non-terminal.
      const window = action.status.state === "closed" ? advanceWindow(state.window, "grace") : state.window;
      if (action.status.state === "finalizing" || action.status.state === "closed")
        return { kind: "checking-credit", window, evidence, status: action.status as VerifyingStatus };
      return { kind: "ready", window, evidence };
    }
    case "status-failed":
      // Do not preserve a stale waiting/closed response across an error. Positive evidence is safe and useful;
      // negative evidence beside "don't resend" is exactly the contradictory state this reducer prevents.
      return {
        kind: "status-error",
        window: state.window,
        evidence: {
          ...evidenceOf(state),
          latest: evidenceOf(state).lastPositive,
        },
        error: action.error,
      };
    case "credit-check-deferred":
      // A legacy finalizing/closed envelope is enough to lock initiation, but an ambient poll must remain
      // hash-only. Return to a retryable state so the explicit check control can authorize the raw-key read.
      if (state.kind !== "checking-credit") return state;
      return { kind: "ready", window: state.window, evidence: state.evidence };
    case "credit-checked": {
      if (state.kind !== "checking-credit") return state;
      // A local deadline alone is never permission to replace an order. Terminate only after the payment
      // service says THIS order is closed and the authoritative balance read also succeeds unchanged. Any
      // positive sighting remains tracked until credit appears. A mixed-version fallback cannot terminate:
      // an old server also lacks the queued-credit `finalizing` signal, so `closed` could race delivery.
      if (
        !action.funded &&
        state.status.state === "closed" &&
        state.evidence.lastPositive === null &&
        state.evidence.statusContract === "v2" &&
        state.evidence.freshHandshake &&
        state.window === "elapsed"
      )
        return { kind: "terminal", window: "elapsed", evidence: state.evidence };
      return { kind: "ready", window: state.window, evidence: state.evidence };
    }
    case "credit-failed":
      if (state.kind !== "checking-credit") return state;
      return {
        kind: "credit-error",
        window: state.window,
        evidence: state.evidence,
        status: state.status,
        error: action.error,
      };
  }
}

export function latestStatus(state: TrackingState): OrderStatus | null {
  return evidenceOf(state).latest;
}

export function lastPositiveStatus(state: TrackingState): PositiveStatus | null {
  return evidenceOf(state).lastPositive;
}

export function isChecking(state: TrackingState): boolean {
  return state.kind === "checking-status" || state.kind === "checking-credit";
}

export function requiresStatusCompatibilityRecovery(state: TrackingState): boolean {
  return evidenceOf(state).statusContract === "legacy";
}

export function hasFreshStatusHandshake(state: TrackingState): boolean {
  const evidence = evidenceOf(state);
  return evidence.statusContract === "v2" && evidence.freshHandshake;
}

export function hasExternalPaymentIntent(state: TrackingState): boolean {
  return evidenceOf(state).externalIntent !== "none";
}

export function hasTentativeExternalPaymentIntent(state: TrackingState): boolean {
  return evidenceOf(state).externalIntent === "tentative";
}

export function canCancelTentativeExternalPaymentIntent(state: TrackingState): boolean {
  const evidence = evidenceOf(state);
  return (
    state.kind !== "terminal" &&
    state.window === "payable" &&
    evidence.externalIntent === "tentative" &&
    evidence.lastPositive === null &&
    evidence.latest?.state !== "closed" &&
    evidence.statusContract === "v2" &&
    evidence.freshHandshake
  );
}

export function shouldTrackPayment(state: TrackingState): boolean {
  // Clock transitions only hide initiation surfaces and request a closing check. Waiting responses and
  // failures remain retryable past the horizon; only the reducer's closed+balance terminal outcome stops.
  return state.kind !== "terminal";
}
