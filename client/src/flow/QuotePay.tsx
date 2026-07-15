import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { OrderStatus, Quote } from "../lib/api.ts";
import {
  advanceQuoteClockTo,
  buyErrorMessage,
  checkBalance,
  creditVerificationErrorMessage,
  fetchOrderStatus,
  paymentStatusErrorMessage,
  quoteClockNow,
  quoteExpiresAt,
  quoteTrackingUntil,
  toReadFailure,
  trocadorSwapUrl,
} from "../lib/api.ts";
import { hashToken } from "../lib/token.ts";
import { Copy, Qr, RateSource } from "../ui.tsx";
import { EXT } from "../lib/links.ts";
import {
  canCancelTentativeExternalPaymentIntent,
  initialTracking,
  hasExternalPaymentIntent,
  hasTentativeExternalPaymentIntent,
  hasFreshStatusHandshake,
  isChecking,
  lastPositiveStatus,
  latestStatus,
  requiresStatusCompatibilityRecovery,
  shouldTrackPayment,
  trackingReducer,
  trackingWindowAt,
  type TrackingState,
  type TrackingWindow,
} from "./payment-tracking.ts";

// The payment step, provenance-blind. The key panel lives above (in KeyFlow); here it's
// just: send THIS amount to THIS address, then watch it land. Success = balance > baseline.
//
// Status is AMBIENT, with a privacy split. /order-status is polled by the token's HASH (~45s,
// visible tab only, plus on tab-refocus) — the hash already crossed the wire at /buy, so the poll
// leaks nothing new, and the payer sees "confirming n/N" move on its own during a ~30 minute
// irreversible wait instead of staring at a static line. The RAW token is different: it goes to
// /balance only after v2 progress says the order is plausibly credited (finalizing/closed). During a
// mixed-version recovery, automatic cycles remain hash-only and only an explicit check spends the raw token.
// A fresh v2 server-time handshake is also required before any payment-initiation detail is exposed.
//
// EXPIRY uses server-authored durations on a monotonic browser clock. At expires_at the amount/address/QR
// disappear so a new payment cannot start. tracking_until asks for a closing status cycle, but never stops
// tracking by itself: waiting/error responses remain retryable until the server says the order is closed and
// an authoritative balance read succeeds. Once a payment is seen, tracking remains live until credit lands.

// Hash-poll cadence. Blocks land every couple of minutes (XMR) to ~10 (BTC), so 45s keeps the line moving without
// hammering the order-status read path.
const POLL_MS = 45_000;

// "expires in 23h 58m" — minutes-granular, never negative (the expired notice takes over at 0).
function fmtLeft(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function isKnownOrderState(state: unknown): state is OrderStatus["state"] {
  return (
    state === "waiting" ||
    state === "detected" ||
    state === "confirming" ||
    state === "finalizing" ||
    state === "closed"
  );
}

function isFreshStatusForQuote(status: OrderStatus, quote: Quote): status is OrderStatus & { contract: 2; server_now: number } {
  const createdAt = quote.created_at;
  return (
    quote.contract === 2 &&
    !quote._initiation_clock_untrusted &&
    Number.isFinite(createdAt) &&
    status.contract === 2 &&
    isKnownOrderState(status.state) &&
    Number.isFinite(status.server_now) &&
    status.server_now! >= createdAt!
  );
}

function statusMessage(state: TrackingState, baseline: number): string {
  if (requiresStatusCompatibilityRecovery(state))
    return "Payment tracking changed versions. Don't pay or resend. Automatic checks use only the order hash; select check to verify credit with your saved key. This quote will stay locked.";
  if (state.kind === "status-error") {
    const error = paymentStatusErrorMessage(state.error);
    return hasExternalPaymentIntent(state)
      ? `${error} The swap already uses this single-use quote; don't also pay directly or open another swap.`
      : error;
  }
  if (state.kind === "credit-error") return creditVerificationErrorMessage(state.error);
  if (!hasFreshStatusHandshake(state))
    return "Verifying this quote with the payment service before showing its single-use payment details.";

  const latest = latestStatus(state);
  const positive = lastPositiveStatus(state);
  // Positive evidence is monotonic. If a future backend regression returns waiting after detected, or closed
  // while credit delivery is still queued, keep the last money-safe positive description.
  const effective = latest?.state === "detected" || latest?.state === "confirming" || latest?.state === "finalizing"
    ? latest
    : positive ?? latest;

  let text: string;
  if (!effective) text = baseline > 0 ? "watching for your top-up" : "watching for your payment";
  else if (effective.state === "confirming")
    text = `payment seen, confirming ${effective.confirmations}/${effective.required}`;
  else if (effective.state === "finalizing") text = "confirmed, verifying credit";
  else if (effective.state === "detected") text = "payment seen, re-checking";
  else if (effective.state === "closed")
    text = "credit isn't verified yet — don't resend; check again shortly";
  else text = baseline > 0 ? "no top-up landed yet" : "not seen yet";

  if (positive)
    return state.window === "payable" ? `${text}. Don't resend.` : `Quote expired. ${text}. Don't resend.`;
  if (hasTentativeExternalPaymentIntent(state))
    return "A swap launch may have started for this single-use quote. Don't also pay directly. If you canceled the menu or drag without opening a swap, you can restore payment options below.";
  if (hasExternalPaymentIntent(state))
    return "Swap opened for this single-use quote. Don't also pay directly or open another swap; we're checking for its payment.";
  if (effective?.state === "closed") return text;
  if (state.window === "payable") return text;
  return "Quote expired. Don't pay this address. If you already sent payment, don't resend; we're still checking.";
}

export function QuotePay({
  token,
  quote,
  baseline,
  busy,
  errorCode,
  onRetry,
  onFunded,
}: {
  token: string;
  quote: Quote | null;
  baseline: number;
  busy: boolean;
  errorCode: string | null;
  onRetry: () => void;
  onFunded: (balanceUsd: number) => void;
}) {
  const [tracking, dispatch] = useReducer(trackingReducer, trackingWindowAt(quote), initialTracking);
  const [, forceTick] = useState(0); // bump to re-render the minutes-granular countdown
  // A cycle is owned by one quote generation. Resetting the quote may start a new cycle before the old
  // promise settles, so store the generation rather than a boolean: an old finally block can never unlock
  // or commit into its replacement.
  const inFlight = useRef<number | null>(null);
  const quoteGeneration = useRef(0);
  const mounted = useRef(false);
  // Both are synchronous mirrors of absorbing reducer evidence. They protect the network boundary and a
  // same-turn double-click before React has committed the corresponding state update.
  const compatibilityRecovery = useRef(false);
  const swapIntentStarted = useRef(false);
  const handshakeEstablished = useRef(false);

  // Ownership guards are layout effects so a quote replacement or unmount invalidates pending promises in
  // the commit itself. Passive-effect cleanup leaves a microtask-sized gap in which an old status result can
  // cross the raw-token /balance boundary after the visible quote has already changed.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      quoteGeneration.current++;
      inFlight.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    quoteGeneration.current++;
    inFlight.current = null;
    compatibilityRecovery.current = false;
    swapIntentStarted.current = false;
    handshakeEstablished.current = false;
    return () => {
      quoteGeneration.current++;
      inFlight.current = null;
    };
  }, [token, quote]);

  // Keep the reducer's display/check window synchronized with monotonic, server-relative boundaries.
  // Missing/invalid relative timing uses the fail-safe mixed-version fallback. visibilitychange is the
  // robust path when background tabs throttle timers.
  useEffect(() => {
    if (!quote) {
      dispatch({ type: "reset", window: "elapsed" });
      return;
    }
    const expiresAt = quoteExpiresAt(quote);
    const trackingUntil = quoteTrackingUntil(quote);
    const refresh = () => {
      forceTick((n) => n + 1);
      dispatch({ type: "clock", window: trackingWindowAt(quote) });
    };
    const advanceToBoundary = (at: number, boundaryWindow: TrackingWindow) => {
      // Floor the elapsed clock for later reads, but do not ask it whether this boundary passed. A timeout
      // that was armed for the full remaining duration is itself monotonic evidence: when it wakes overdue,
      // recomputing from clocks that both under-report sleep could incorrectly redisplay the address.
      advanceQuoteClockTo(quote, at);
      forceTick((n) => n + 1);
      dispatch({ type: "clock", window: boundaryWindow });
    };
    dispatch({ type: "reset", window: trackingWindowAt(quote) });
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const scheduleBoundary = (at: number | undefined, boundaryWindow: TrackingWindow) => {
      if (at === undefined || !Number.isFinite(at)) return () => {};
      const MAX_TIMER_MS = 2_147_000_000;
      let timer: number | undefined;
      let cancelled = false;
      const arm = () => {
        if (cancelled) return;
        const ms = at - quoteClockNow(quote);
        if (ms <= 0) {
          advanceToBoundary(at, boundaryWindow);
          return;
        }
        const clamped = ms > MAX_TIMER_MS;
        timer = window.setTimeout(() => {
          if (cancelled) return;
          if (clamped) {
            // This callback represents only the browser's maximum delay, not the actual boundary.
            refresh();
            arm();
          } else {
            advanceToBoundary(at, boundaryWindow);
          }
        }, Math.min(ms, MAX_TIMER_MS));
      };
      arm();
      return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    };
    const afterExpiry: TrackingWindow =
      trackingUntil === undefined || !Number.isFinite(trackingUntil) || trackingUntil < expiresAt
        ? "fallback"
        : "grace";
    const cancelExpiryTimer = scheduleBoundary(expiresAt, afterExpiry);
    const cancelTrackingTimer =
      afterExpiry === "grace" ? scheduleBoundary(trackingUntil, "elapsed") : () => {};
    const clock = window.setInterval(refresh, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      cancelExpiryTimer();
      cancelTrackingTimer();
      clearInterval(clock);
    };
  }, [quote?.pay_to, quote?.created_at, quote?.expires_at, quote?.tracking_until, quote?._request_started_at, quote?._request_started_wall_at]);

  // Ambient status: poll /order-status by HASH while the pay screen is visible — see the header for the
  // privacy split. Skipped while the tab is hidden (a polite request pattern, and a backgrounded payer
  // can't read the answer anyway) and re-fired immediately when the tab returns. Entering the post-expiry
  // grace fires one immediate check: the payable details are already gone, but a just-sent transfer must
  // not wait another full interval for its first chance to become detected.
  const keepTracking = quote !== null && shouldTrackPayment(tracking);
  const freshHandshake = hasFreshStatusHandshake(tracking);
  useEffect(() => {
    if (!quote || !keepTracking) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void checkNow(false);
    };
    const id = window.setInterval(tick, POLL_MS);
    // A quote is initiation-closed until a new payment service returns its current server time. This immediate
    // hash-only read repairs a request that sat suspended before the browser could take its first clock sample.
    if (!freshHandshake || tracking.window !== "payable") tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checkNow closes over this order's stable props
  }, [quote, keepTracking, tracking.window, freshHandshake]);

  async function checkNow(explicit: boolean) {
    if (inFlight.current !== null || !quote || document.visibilityState !== "visible") return;
    const generation = quoteGeneration.current;
    const activeQuote = quote;
    inFlight.current = generation;
    dispatch({ type: "check-started" });
    try {
      const hash = await hashToken(token);
      if (!mounted.current || generation !== quoteGeneration.current || document.visibilityState !== "visible")
        return;
      const st = await fetchOrderStatus(hash, activeQuote.pay_to);
      // This is the privacy boundary: status is hash-only, while the next request carries the spendable
      // bearer token. A hidden/unmounted/replaced quote must retry when visible instead of crossing it.
      if (!mounted.current || generation !== quoteGeneration.current || document.visibilityState !== "visible")
        return;
      const freshContract = isFreshStatusForQuote(st, activeQuote);
      if (freshContract) {
        if (!handshakeEstablished.current) {
          // Let the expiry timer that was armed before the status request take its task first. This matters
          // when a response was queued immediately before device sleep and both browser clocks under-report
          // the wake: the timer's completion is independent evidence that the payment boundary passed.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          if (!mounted.current || generation !== quoteGeneration.current || document.visibilityState !== "visible")
            return;
        }
        // `server_now - created_at` is elapsed server time at response creation. Network transit only makes the
        // quote older, so flooring the private relative clock to this value is conservative.
        advanceQuoteClockTo(activeQuote, st.server_now - activeQuote.created_at!);
        dispatch({ type: "clock", window: trackingWindowAt(activeQuote) });
        handshakeEstablished.current = true;
      } else {
        // Sticky for this quote: a later v2 response cannot prove no legacy `closed` raced credit delivery.
        compatibilityRecovery.current = true;
      }
      // Downgrade an incomplete/clock-incoherent envelope before it reaches the reducer. Contract 2 without
      // server_now is the immediately-previous backend, not a fresh handshake for this client.
      const compatibleStatus: OrderStatus = freshContract ? st : { ...st, contract: undefined };
      dispatch({ type: "status-received", status: compatibleStatus });
      // Only spend the raw token on /balance when the payment is plausibly done. `closed` means the
      // order row is gone (credited / reaped / never existed) — /balance is the authoritative tiebreak. In
      // compatibility recovery the automatic timer remains hash-only; the user must explicitly select check.
      if (st.state === "finalizing" || st.state === "closed") {
        if (compatibilityRecovery.current && !explicit) {
          dispatch({ type: "credit-check-deferred" });
          return;
        }
        // Keep this immediately adjacent to the raw-token read. No await or state transition may open a
        // window for a visibility/quote generation change between the guard and request initiation.
        if (!mounted.current || generation !== quoteGeneration.current || document.visibilityState !== "visible")
          return;
        let bal: number | null;
        try {
          bal = await checkBalance(token);
        } catch (error) {
          if (!mounted.current || generation !== quoteGeneration.current) return;
          // The status read succeeded; it is specifically the final credit verification that failed.
          dispatch({ type: "credit-failed", error: toReadFailure(error) });
          return;
        }
        if (!mounted.current || generation !== quoteGeneration.current) return;
        const fundedBalance = bal !== null && bal > baseline ? bal : null;
        dispatch({ type: "credit-checked", funded: fundedBalance !== null });
        if (fundedBalance !== null) {
          onFunded(fundedBalance);
          return;
        }
      }
    } catch (error) {
      if (!mounted.current || generation !== quoteGeneration.current) return;
      // Never let a transient status-read failure imply that payment was not received. The reducer retains
      // only positive evidence and moves to one exclusive error state, so stale waiting copy cannot leak
      // beside the do-not-resend warning.
      dispatch({ type: "status-failed", error: toReadFailure(error) });
    } finally {
      if (inFlight.current === generation) inFlight.current = null;
    }
  }

  if (!quote) {
    return (
      <div className="section">
        {busy && (
          <div className="status">
            <div className="watch">requesting a payment address…</div>
          </div>
        )}
        {!busy && errorCode && (
          <>
            <div className="notice" role="alert">{buyErrorMessage(errorCode)}</div>
            <button className="btn-primary" type="button" onClick={onRetry}>
              try again →
            </button>
          </>
        )}
      </div>
    );
  }

  const checking = isChecking(tracking);
  const message = statusMessage(tracking, baseline);
  const expired = tracking.window !== "payable";
  const externalIntent = hasExternalPaymentIntent(tracking);
  const initiationClosed =
    expired ||
    !freshHandshake ||
    externalIntent ||
    requiresStatusCompatibilityRecovery(tracking) ||
    lastPositiveStatus(tracking) !== null ||
    latestStatus(tracking)?.state === "closed";
  const recordSwapIntent = (tentative = false): boolean => {
    if (swapIntentStarted.current) return false;
    swapIntentStarted.current = true;
    if (tentative) {
      // Let the browser establish its native context menu or drag operation before React changes the
      // presentation. The synchronous ref still rejects a same-turn second launch.
      const generation = quoteGeneration.current;
      window.setTimeout(() => {
        if (!mounted.current || generation !== quoteGeneration.current || !swapIntentStarted.current) return;
        dispatch({ type: "external-intent", tentative: true });
      }, 0);
    } else {
      dispatch({ type: "external-intent" });
    }
    return true;
  };
  const tentativeExternalIntent = hasTentativeExternalPaymentIntent(tracking);
  const canCancelTentativeIntent = canCancelTentativeExternalPaymentIntent(tracking);
  const cancelTentativeSwapIntent = () => {
    if (!canCancelTentativeIntent) return;
    swapIntentStarted.current = false;
    dispatch({ type: "external-intent-cancelled" });
  };

  const swapLink = (locked: boolean) => (
    <p className={locked ? "swap-line sr-only" : "swap-line"} aria-hidden={locked || undefined}>
      <a
        href={trocadorSwapUrl(quote)}
        {...EXT}
        tabIndex={locked ? -1 : undefined}
        onClick={(event) => {
          if (!recordSwapIntent()) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button === 1 && !recordSwapIntent()) event.preventDefault();
        }}
        onContextMenu={(event) => {
          // Native "Open Link in New Tab" (including Shift+F10/the context-menu key) does not
          // dispatch click or auxclick back to the page. Treat it as possible intent without
          // canceling the browser's menu; the user can explicitly recover if they only inspected it.
          if (!recordSwapIntent(true)) event.preventDefault();
        }}
        onDragStart={(event) => {
          // A link dragged to the tab strip can navigate without click/auxclick too. Keep the first
          // native drag usable and fail closed if the browser does not reveal whether it was dropped.
          if (!recordSwapIntent(true)) event.preventDefault();
        }}
      >
        hold a different coin? swap to {quote.unit} (locks quote) ↗
      </a>
      <span className="fn-ref"> *</span>
    </p>
  );

  // Replacement appears only after a successful closing status+balance cycle produced the reducer's
  // terminal outcome. A local clock transition, waiting response, or read failure can never reach here.
  if (expired && !keepTracking) {
    return (
      <div className="section">
        <div className="notice" role="alert">
          This quote is closed. Don&apos;t pay its address. If you already sent payment, don&apos;t resend; check this
          key&apos;s balance later. Otherwise, get a new quote.
        </div>
        {errorCode && <div className="notice" role="alert">{buyErrorMessage(errorCode)}</div>}
        <button className="btn-primary" type="button" disabled={busy} onClick={onRetry}>
          {busy ? "requesting…" : "new quote →"}
        </button>
      </div>
    );
  }

  // Every initiation surface disappears before the fresh server-clock handshake, at expires_at, when a
  // pre-filled swap is opened, on the first positive sighting, or when the server closes the order. Pay-once
  // means a second transfer can never be treated as a harmless top-up.
  if (initiationClosed) {
    const hiddenReason = requiresStatusCompatibilityRecovery(tracking)
      ? "Payment details stay hidden because this page and the payment service do not share the same tracking contract."
      : !freshHandshake
        ? "Payment details stay hidden until the payment service verifies this quote is still current."
        : tentativeExternalIntent
          ? "Payment details are hidden because a swap may have opened from the browser menu or drag. Don't also pay directly."
          : externalIntent
            ? "Payment details are hidden because the swap now owns this single-use quote. Don't also pay directly."
            : "Payment details are hidden because this single-use address is no longer safe to pay. Don't resend.";
    return (
      <section className="section">
        {/* Keep the exact anchor node and href connected until the browser finishes the first native
            context-menu/drag action. It is visually and semantically hidden, and all later events fail closed. */}
        {externalIntent && swapLink(true)}
        <div className="notice">
          <span role="status" aria-label="payment status" className="watch">{message}</span>
        </div>
        <div className="status status-expired">
          <span className="pay-meta">
            {hiddenReason}
          </span>
          <button className="copy acid" type="button" disabled={checking} onClick={() => void checkNow(true)}>
            {checking ? "checking…" : "check"}
          </button>
        </div>
        {tentativeExternalIntent && canCancelTentativeIntent && (
          <button className="copy" type="button" onClick={cancelTentativeSwapIntent}>
            I canceled — restore payment options
          </button>
        )}
        {tentativeExternalIntent && canCancelTentativeIntent && (
          <p className="pay-meta">Only restore if no swap page opened. If one did, keep this quote locked.</p>
        )}
        <p className="pay-meta">
          payment progress is checked automatically by order hash. after confirmation, this page may use your
          saved key to verify the credited balance; during a version mismatch that happens only when you select check.
        </p>
      </section>
    );
  }

  const expiry = new Date(quote.expires_at);
  const expiresAt = quoteExpiresAt(quote);

  return (
    <section className="section">
      {/* Pay-with-another-coin: a short link right under the key (above the payment details) so a holder of another coin
          spots the escape hatch immediately. Opened in a NEW TAB so the KeyFlow beforeunload guard never
          fires (leaving with a freshly-minted unfunded key loses it); noreferrer also strips
          the Referer. The URL carries no token/hash — only the address + amount + affiliate ref. The
          third-party + rate fine print is the (*) footnote at the bottom. */}
      {swapLink(false)}

      <div className="pay">
        <Qr data={quote.pay_uri} />
        <div className="pay-main">
          {/* Relative, ticking countdown — "in 23h 58m" beats two timestamps the payer has to
              subtract in their head; the dateTime attr keeps the absolute moment machine-readable. */}
          <div className="pay-label">
            <span>
              <span className="hl">expires</span>{" "}
              <time dateTime={expiry.toISOString()}>in {fmtLeft(expiresAt - quoteClockNow(quote))}</time>
            </span>
          </div>
          <div className="pay-amount">
            <span className="num">{quote.amount}</span> {quote.unit} <Copy value={quote.amount} />
          </div>
          {/* The first/last 4 of the address are lit acid: that's how a payer cross-checks an
              address against their wallet (ends first), so the eye lands exactly there. The string
              itself is untouched — copy carries it whole. */}
          <div className="pay-to">
            <span>
              <span className="addr-end">{quote.pay_to.slice(0, 4)}</span>
              {quote.pay_to.slice(4, -4)}
              <span className="addr-end">{quote.pay_to.slice(-4)}</span>
            </span>{" "}
            <Copy value={quote.pay_to} />
          </div>
          <div className="pay-meta"><RateSource unit={quote.unit} /></div>
          {/* Pay-once: the order closes on its FIRST confirmed payment, so a second send to this address
              cannot be credited. The privacy page says "single-use address"; the payer deciding how to
              send is looking HERE, so the constraint has to be on this screen. */}
          <div className="pay-meta">send the exact amount in one payment — this address is single-use.</div>
        </div>
      </div>

      {/* The line moves on its own (hash poll); the button forces an immediate cycle for the
          impatient. The fine-print line under it states the privacy split out loud — the design
          choice is a feature, so say it. */}
      <div className="status">
        {/* One visible, authoritative live region. Errors replace stale status instead of rendering beside
            it; the button carries the transient checking pulse so background polls do not spam announcements. */}
        <span className="watch" role="status" aria-label="payment status">{message}</span>
        <button className="copy acid" type="button" disabled={checking} onClick={() => void checkNow(true)}>
          {checking ? "checking…" : "check"}
        </button>
      </div>
      <p className="pay-meta">
        payment progress is checked automatically by order hash. after confirmation, this page may use your
        saved key to verify the credited balance.
      </p>

      {/* The (*) footnote names the data hand-off before the payer chooses the third-party path. */}
      <p className="swap-note">
        <span className="fn-ref">*</span> opening the swap sends this address, amount, destination coin and
        network to trocador; trocador and its partner also receive ordinary connection data such as your IP
        and keep data under their own policies. it locks this quote: don&apos;t also pay directly or open another
        swap. swapped credit can land slightly over or under the quote, depending on rate and fees.
      </p>
    </section>
  );
}
