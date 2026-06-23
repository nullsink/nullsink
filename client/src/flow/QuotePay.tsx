import { useEffect, useRef, useState } from "react";
import type { OrderStatus, Quote } from "../lib/api.ts";
import { buyErrorMessage, checkBalance, fetchOrderStatus, trocadorSwapUrl } from "../lib/api.ts";
import { hashToken } from "../lib/token.ts";
import { Copy, Qr, RateSource } from "../ui.tsx";
import { EXT } from "../lib/links.ts";

// The payment step, provenance-blind. The key panel lives above (in KeyFlow); here it's
// just: send THIS amount to THIS address, then watch it land. Success = balance > baseline.
//
// Status is AMBIENT, with a privacy split. /order-status is polled by the token's HASH (~45s,
// visible tab only, plus on tab-refocus) — the hash already crossed the wire at /buy, so the poll
// leaks nothing new, and the payer sees "confirming n/N" move on its own during a ~30 minute
// irreversible wait instead of staring at a static line. The RAW token is different: it goes to
// /balance only once the polled progress says the order is plausibly credited (finalizing/closed) —
// never on a timer of its own. That's the invariant that matters: no background traffic ever
// carries the spendable secret. The manual "check" button just forces an immediate cycle.
//
// EXPIRY is a purely local clock check against quote.expires_at (no fetch), shown as a live
// countdown: a 30s re-render tick plus a one-shot timer at the deadline and a re-check on tab
// refocus, so a user who left the tab open doesn't sit staring at stale payment details.

// Hash-poll cadence. Blocks land every couple of minutes (XMR) to ~10 (BTC), so 45s keeps the line moving without
// hammering the order-status read path.
const POLL_MS = 45_000;

// "expires in 23h 58m" — minutes-granular, never negative (the expired notice takes over at 0).
function fmtLeft(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
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
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [, forceTick] = useState(0); // bump to re-render so `expired` + the countdown re-read the wall clock
  const inFlight = useRef(false); // collapses overlapping cycles (auto-poll firing during a manual check)

  // Re-evaluated every render; flips the UI to the "expired" notice. The effect below forces a render
  // at the deadline and on tab-refocus so this updates without the user interacting and without any
  // network poll (expiry is knowable locally from expires_at).
  const expired = quote ? Date.now() >= quote.expires_at : false;

  useEffect(() => {
    if (!quote) return;
    const bump = () => forceTick((n) => n + 1);
    // Re-check when the tab regains focus — the robust path (a backgrounded tab throttles timers).
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisible);
    // One-shot flip at the deadline for a tab that's actively open when it lapses. Best-effort: long
    // background timers get throttled — which is exactly why visibilitychange above also re-checks.
    const msLeft = quote.expires_at - Date.now();
    const timer = msLeft > 0 ? window.setTimeout(bump, msLeft) : undefined;
    // Keep the "expires in Xh Ym" countdown fresh — local clock only, no network.
    const countdown = window.setInterval(bump, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(countdown);
    };
  }, [quote]);

  // Ambient status: poll /order-status by HASH while the pay screen is visible — see the header for the
  // privacy split. Skipped while the tab is hidden (a polite request pattern, and a backgrounded payer
  // can't read the answer anyway) and re-fired immediately when the tab returns.
  useEffect(() => {
    if (!quote) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() >= quote.expires_at) return;
      void checkNow();
    };
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checkNow closes over this order's stable props
  }, [quote]);

  async function checkNow() {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const st = await fetchOrderStatus(await hashToken(token));
      setStatus(st);
      // Only spend the raw token on /balance when the payment is plausibly done. `closed` means the
      // order row is gone (credited / reaped / never existed) — /balance is the authoritative tiebreak.
      if (st.state === "finalizing" || st.state === "closed") {
        const bal = await checkBalance(token);
        if (bal !== null && bal > baseline) {
          onFunded(bal);
          return;
        }
      }
    } catch {
      /* transient; let the user try again */
    } finally {
      // Always clear the spinner — including the funded `return` above. Today the parent unmounts this
      // component on onFunded so a stuck flag was invisible; finally makes it correct regardless of
      // whether the screen advances (a no-op setState on an unmounting component is safe in React 19).
      inFlight.current = false;
      setChecking(false);
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
            <div className="notice">{buyErrorMessage(errorCode)}</div>
            <button className="btn-primary" type="button" onClick={onRetry}>
              try again →
            </button>
          </>
        )}
      </div>
    );
  }

  if (expired) {
    return (
      <div className="section">
        <div className="notice">
          This quote expired. The amount and address are no longer valid. Get a fresh quote to pay.
        </div>
        {errorCode && <div className="notice">{buyErrorMessage(errorCode)}</div>}
        <button className="btn-primary" type="button" disabled={busy} onClick={onRetry}>
          {busy ? "requesting…" : "new quote →"}
        </button>
      </div>
    );
  }

  const expiry = new Date(quote.expires_at);

  // Status is secondary to actually paying from a wallet; the force-a-check button sits beside it.
  // Before the first poll lands (status null) we show watching copy — "watching", not "waiting",
  // because a payer who just sent money reads "waiting for your payment" as "we saw nothing". After,
  // we reflect the live order state — "confirming n/N" being the reassurance the payment is on its way.
  const statusText = checking
    ? "checking…"
    : !status
      ? baseline > 0
        ? "watching for your top-up"
        : "watching for your payment"
      : status.state === "confirming"
        ? `payment seen, confirming ${status.confirmations}/${status.required}`
        : status.state === "finalizing"
          ? "confirmed, verifying credit…"
          : // waiting, or closed with no credit landed yet
            baseline > 0
            ? "no top-up landed yet"
            : "not seen yet";

  return (
    <section className="section">
      {/* Pay-with-another-coin: a short link right under the key (above the payment details) so a holder of another coin
          spots the escape hatch immediately. Opened in a NEW TAB so the KeyFlow beforeunload guard never
          fires (leaving with a freshly-minted unfunded key loses it); noreferrer also strips
          the Referer. The URL carries no token/hash — only the address + amount + affiliate ref. The
          third-party + rate fine print is the (*) footnote at the bottom. */}
      <p className="swap-line">
        <a href={trocadorSwapUrl(quote)} {...EXT}>
          hold a different coin? swap to {quote.unit} ↗
        </a>
        <span className="fn-ref"> *</span>
      </p>

      <div className="pay">
        <Qr data={quote.pay_uri} />
        <div className="pay-main">
          {/* Relative, ticking countdown — "in 23h 58m" beats two timestamps the payer has to
              subtract in their head; the dateTime attr keeps the absolute moment machine-readable. */}
          <div className="pay-label">
            <span>
              <span className="hl">expires</span>{" "}
              <time dateTime={expiry.toISOString()}>in {fmtLeft(quote.expires_at - Date.now())}</time>
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
        </div>
      </div>

      {/* The line moves on its own (hash poll); the button forces an immediate cycle for the
          impatient. The fine-print line under it states the privacy split out loud — the design
          choice is a feature, so say it. */}
      <div className="status">
        <span className="watch">{statusText}</span>
        <button className="copy acid" type="button" disabled={checking} onClick={checkNow}>
          check
        </button>
      </div>
      <p className="pay-meta">progress is checked automatically using only the order&apos;s hash.</p>

      {/* The (*) footnote for the swap link above: names the third parties and the rate caveat, kept out
          of the link itself so the escape hatch stays one short line. Framed in retention terms ("outside
          our no-logs guarantee"), NOT "sees your IP" — every server on earth receives IPs, ours included;
          the differentiator is what gets KEPT, and theirs is governed by their policies, not ours. */}
      <p className="swap-note">
        <span className="fn-ref">*</span> swaps run through trocador and a partner exchange. these third
        parties keep data under their own policies, not ours. paying with {quote.unit} directly involves no
        third party. swapped credit can land slightly over or under the quote, depending on rate and fees.
      </p>
    </section>
  );
}
