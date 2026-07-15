// API surface for the nullsink purchase page. Same-origin endpoints; the
// authoritative contract lives in core's request handler.
//
//   POST /buy           contract header + { hash, credit_usd } -> a one-time quote
//   POST /order-status  { hash, address? }               -> live payment progress (no balance)
//   GET  /balance       header x-api-key: <raw token>    -> { balance_usd }
//
// Within this purchase-page module, the raw token is sent only to /balance on our own origin. Metered API
// clients also send it as their bearer credential. /buy and /order-status see only the SHA-256 hash.
import { DEFAULT_MARGIN } from "../../../core/src/pricing-config.ts";

// --- limits -----------------------------------------------------------------
// The UI clamps to a deliberately small band: nullsink is early and scaling up over
// time. Keep this the single source of truth; raising the cap is a one-line change.
// The backend's BUY_MIN_USD must match this min (core's default is 2 as well). The backend
// allows a much higher max; we stay well inside it on purpose.
export const BUY_MIN_USD = 2;
export const BUY_MAX_USD = 100;
export const AMOUNT_PRESETS = [10, 25, 50, 100] as const;

// The markup, from the SHARED default in core/src/pricing-config.ts that the server also uses as its
// numEnv("MARGIN") default — so the advertised markup and the charged markup can't drift. The ACTUAL
// per-order charge is still locked server-side at quote time and shown verbatim from /buy's amount; this
// only drives the up-front "≈" estimate and the "~N% markup" copy below.
export const MARGIN = DEFAULT_MARGIN;

// Percentage form of MARGIN for display ("~N% markup") — one source so the hero, the price
// line, and the prose can't disagree if the margin moves.
export const MARKUP_PCT = Math.round((MARGIN - 1) * 100);

// Format a USD amount for display: "$12.00" / "$1,234.50". Intl.NumberFormat with a FIXED en-US locale
// (not the runtime's) so prerender (Bun) and the browser produce identical strings — a locale-dependent
// result would desync hydration. Centralized so a future locale switch is one line, and so grouping +
// negatives are correct (the old $${n.toFixed(2)} gave "$1234.50" and "$-5.00").
const USD_FMT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const usd = (n: number): string => USD_FMT.format(n);

// Whole-dollar form ("$10", "$100") for the round figures — presets, the min/max band, the per-purchase
// range. Same fixed-locale reasoning; routes the symbol + its placement through Intl too.
const USD_WHOLE_FMT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const usdWhole = (n: number): string => USD_WHOLE_FMT.format(n);

export interface Quote {
  // Version 2 identifies the quote timing + tracking contract explicitly. Optional at the wire boundary so
  // a new bundle can fail closed when an older backend ignores the request header during rollback.
  contract?: number;
  pay_to: string;
  amount: string; // verbatim coin amount string (8dp for BTC) — display AS-IS, never reformat/round
  unit: string; // display ticker, e.g. "BTC"
  pay_uri: string; // wallet URI for the QR, built server-side (e.g. bitcoin:addr?amount=…)
  rate_usd: number;
  confirmations_required: number;
  // Quote creation time from the payment service. Optional only during a mixed-version deploy. New clients
  // combine it with the monotonic request-start anchor below, so a device's wall-clock skew cannot extend the
  // period in which a payment address is displayed.
  created_at?: number; // server epoch ms
  expires_at: number; // epoch ms
  // Server-authored unseen-order reap horizon (expires_at + configured grace). Optional only for a
  // mixed-version deploy or an older cached response; new servers always send it.
  tracking_until?: number; // epoch ms
  // Client-only, monotonic request-start anchor attached by requestQuote; never sent over the wire. Starting
  // the server-authored durations before the server creates the order can hide an address slightly early,
  // but can never keep it payable beyond the server's own deadline because of network latency.
  _request_started_at?: number; // performance.now() domain
  _request_started_wall_at?: number; // Date.now() domain; counts device sleep when performance.now pauses
  // An older payment service cannot supply a trustworthy relative quote clock. The new UI therefore hides
  // payment-initiation details for that response while continuing conservative status tracking.
  _initiation_clock_untrusted?: true;
}

function hasRelativeQuoteClock(quote: Quote): quote is Quote & {
  created_at: number;
  _request_started_at: number;
  _request_started_wall_at: number;
} {
  return (
    Number.isFinite(quote.created_at) &&
    Number.isFinite(quote._request_started_at) &&
    Number.isFinite(quote._request_started_wall_at)
  );
}

function relativeDeadline(quote: Quote, serverDeadline: number | undefined): number | undefined {
  if (serverDeadline === undefined || !Number.isFinite(serverDeadline)) return undefined;
  if (quote._initiation_clock_untrusted) return Number.NEGATIVE_INFINITY;
  if (!hasRelativeQuoteClock(quote)) return serverDeadline;
  // Relative-clock quotes use an elapsed-time domain whose origin is the browser's request start.
  const deadline = serverDeadline - quote.created_at;
  return Number.isFinite(deadline) ? deadline : serverDeadline;
}

type RelativeClockState = {
  elapsed: number;
  wallSample: number;
  monotonicSample: number | undefined;
};

// Keep the accumulated clock private to this module instead of adding mutable bookkeeping to the quote
// value that the UI passes around. Each sample advances by the greater positive delta reported by the wall
// and monotonic clocks. Updating both sample anchors even when one moves backwards is important: after a
// wall-clock rollback, a later period of device sleep is still counted by Date.now even on browsers whose
// performance.now pauses while asleep.
const relativeClockState = new WeakMap<Quote, RelativeClockState>();

function monotonicNow(): number | undefined {
  if (typeof performance === "undefined") return undefined;
  const now = performance.now();
  return Number.isFinite(now) ? now : undefined;
}

/** Current time in the same clock domain as quoteExpiresAt/quoteTrackingUntil. */
export function quoteClockNow(quote: Quote): number {
  if (hasRelativeQuoteClock(quote)) {
    const wallNow = Date.now();
    const monoNow = monotonicNow();
    const prior = relativeClockState.get(quote);
    if (!prior) {
      // The first read may happen well after /buy returns. Anchor to the greatest observed duration so
      // network/render delay and an initial sleep are conservative, never validity-extending.
      const wallElapsed = wallNow - quote._request_started_wall_at;
      const monotonicElapsed = monoNow === undefined ? 0 : monoNow - quote._request_started_at;
      const elapsed = Math.max(
        0,
        Number.isFinite(wallElapsed) ? wallElapsed : 0,
        Number.isFinite(monotonicElapsed) ? monotonicElapsed : 0,
      );
      relativeClockState.set(quote, { elapsed, wallSample: wallNow, monotonicSample: monoNow });
      return elapsed;
    }

    const wallDelta = wallNow - prior.wallSample;
    const monotonicDelta =
      monoNow === undefined || prior.monotonicSample === undefined ? 0 : monoNow - prior.monotonicSample;
    prior.elapsed += Math.max(
      0,
      Number.isFinite(wallDelta) ? wallDelta : 0,
      Number.isFinite(monotonicDelta) ? monotonicDelta : 0,
    );
    // Deliberately retain a backwards sample as the new anchor without reducing elapsed. If Date.now then
    // advances while performance.now is suspended, that sleep interval is added on the next observation.
    prior.wallSample = wallNow;
    prior.monotonicSample = monoNow;
    return prior.elapsed;
  }
  return Date.now();
}

/** Record independent evidence that this quote's elapsed clock reached a server-relative boundary. */
export function advanceQuoteClockTo(quote: Quote, elapsedFloor: number): number {
  const now = quoteClockNow(quote);
  if (!hasRelativeQuoteClock(quote) || !Number.isFinite(elapsedFloor)) return now;
  const state = relativeClockState.get(quote)!;
  state.elapsed = Math.max(state.elapsed, elapsedFloor);
  return state.elapsed;
}

/** Local deadline immune to device wall-clock skew when the server supplied created_at. */
export function quoteExpiresAt(quote: Quote): number {
  return relativeDeadline(quote, quote.expires_at)!;
}

/** Local tracking horizon, or undefined for an older response. */
export function quoteTrackingUntil(quote: Quote): number | undefined {
  return relativeDeadline(quote, quote.tracking_until);
}

// --- pay with another coin (Trocador AnonPay swap fallback) -----------------
// Rung 1: a pre-filled REFERRAL REDIRECT, no server integration. A user without BTC opens Trocador in a
// NEW TAB (see QuotePay) to swap their coin -> BTC, paid straight to THIS order's address; the existing
// backend poller then credits the landed BTC exactly like a direct payment. The hand-off is a user-
// initiated top-level navigation, which the launch CSP `default-src 'self'` permits — it is NEVER a
// fetch/iframe/script (those would need a CSP relaxation). The URL carries only the address, the amount,
// and our affiliate ref: NO raw token, NO hash, nothing identity-bearing. The ref is a plain affiliate tag,
// safe to ship in client JS. Whatever BTC lands credits proportionally server-side (core/src/ledger/settle.ts:
// received/expected), so a floating swap rate just means slightly more/less credit — no client-side
// reconciliation.
export const TROCADOR_ANONPAY_URL = "https://trocador.app/anonpay/";
// Set to the nullsink Trocador affiliate code (single source of truth). Empty → no ref param is sent.
export const TROCADOR_REF = "";

// Build the pre-filled AnonPay URL for a live quote: destination = the quote's coin (unit) on Mainnet to
// the order's address, amount LOCKED to the quote's amount (verbatim — never reformat). The SOURCE coin is
// chosen by the user on Trocador's page. Pure + deterministic. `amount` is the destination amount in
// AnonPay "payment mode".
export function trocadorSwapUrl(quote: Quote): string {
  const params = new URLSearchParams({
    ticker_to: quote.unit.toLowerCase(),
    network_to: "Mainnet",
    address: quote.pay_to,
    amount: quote.amount,
    name: "nullsink",
    description: "api credit",
  });
  if (TROCADOR_REF) params.set("ref", TROCADOR_REF);
  return `${TROCADOR_ANONPAY_URL}?${params.toString()}`;
}

export interface BuyError {
  code: string;
  status: number;
}

// Failure shape for the browser's own non-metered reads. This is intentionally small: callers need to
// distinguish "try later", "check your connection", and "the service answered but is unavailable" — not
// duplicate server prose or infer token validity from a transport failure.
export type ReadFailure = {
  kind: "network" | "rate_limited" | "server" | "unknown";
  status: number;
  retryAfterSec?: number;
};

function retryAfterSec(res: Response): number | undefined {
  const value = Number(res.headers.get("retry-after"));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function readFailure(res: Response): ReadFailure {
  return {
    kind: res.status === 429 ? "rate_limited" : "server",
    status: res.status,
    retryAfterSec: retryAfterSec(res),
  };
}

export function balanceErrorMessage(error: ReadFailure): string {
  switch (error.kind) {
    case "rate_limited":
      return "Balance checks are busy right now. Try again in a moment.";
    case "network":
      return "Couldn't reach nullsink. Check your connection and try again.";
    case "server":
      return "The balance service is temporarily unavailable. Try again shortly.";
    case "unknown":
      return "Couldn't complete the balance check. Try again shortly.";
  }
}

// Turn an unknown caught value back into the small read-failure vocabulary. Fetch helpers above are the only
// expected producers, but UI boundaries must stay fail-safe if a future refactor throws something else.
export function toReadFailure(error: unknown): ReadFailure {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    ((error as ReadFailure).kind === "network" ||
      (error as ReadFailure).kind === "rate_limited" ||
      (error as ReadFailure).kind === "server" ||
      (error as ReadFailure).kind === "unknown")
  )
    return error as ReadFailure;
  // A programming/parsing exception is not evidence of a connectivity problem. Keep it actionable but
  // honest, and retain the money-safe instructions at the payment-specific call sites below.
  return { kind: "unknown", status: 0 };
}

// A payment status read never establishes that no payment landed. The instruction is deliberately stable
// across failure kinds: never pay a single-use address again; check the existing order later.
export function paymentStatusErrorMessage(error: ReadFailure): string {
  switch (error.kind) {
    case "rate_limited":
      return "Payment checks are busy right now. Don't resend; check again in a moment.";
    case "network":
      return "Couldn't reach nullsink to check payment status. Don't resend; check again shortly.";
    case "server":
      return "Payment status is temporarily unavailable. Don't resend; check again shortly.";
    case "unknown":
      return "Couldn't complete the payment status check. Don't resend; check again shortly.";
  }
}

// This is reached only after /order-status says finalizing or closed, when the UI spends the raw token on
// /balance to settle the outcome. It must name THAT failed step rather than claim status itself failed.
export function creditVerificationErrorMessage(error: ReadFailure): string {
  switch (error.kind) {
    case "rate_limited":
      return "Couldn't verify your credit yet: balance checks are busy. Don't resend; check again in a moment.";
    case "network":
      return "Couldn't verify your credit yet: couldn't reach nullsink. Don't resend; check again shortly.";
    case "server":
      return "Couldn't verify your credit yet: the balance service is temporarily unavailable. Don't resend; check again shortly.";
    case "unknown":
      return "Couldn't complete credit verification yet. Don't resend; check again shortly.";
  }
}

// Map a /buy error code to calm, user-facing copy.
export function buyErrorMessage(code: string): string {
  switch (code) {
    case "rate_unavailable":
      return "Couldn't get a price right now. Try again shortly.";
    case "busy_try_later":
      return "The system is busy. Try again soon.";
    case "order_in_progress":
      return "This key already has a payment in progress. Don't send again; check its status or balance first.";
    case "client_upgrade_required":
      return "This payment page is out of date. Refresh the page before requesting another quote.";
    case "rate_limited":
      // 429 from the global, identity-free rate limit — a single honest user can hit it because
      // OTHERS are flooding, so don't blame them ("too many requests"); just "busy, retry".
      return "Busy right now. Try again in a moment.";
    case "wallet_unavailable":
      return "Temporarily unavailable. Try again shortly.";
    case "payments_error":
      // Caddy could not reach the isolated payments service. The request did not create an order, so this
      // is safe to retry; name the temporary service failure rather than collapsing it into a generic error.
      return "Payments are temporarily unavailable. Try again shortly.";
    case "unknown_rail":
      // The chosen coin isn't in the active rail set (e.g. it was paused between loading /rails and buying).
      return "That coin isn't available right now — pick another.";
    case "network":
      // requestQuote threw before any HTTP response (status 0): offline, server unreachable, or a
      // DNS/TLS/connection failure. Distinct from a 5xx (which DID respond) — point at the connection.
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      // The validation codes (invalid_json / invalid_hash / invalid_amount / payload_too_large) are
      // unreachable if the client validates; a proxy_error or any unexpected body lands here too.
      // Generic retry copy fits all of them — a server hiccup, nothing the user can act on but retry.
      return "Something went wrong. Try again.";
  }
}

// --- pay rails (GET /rails) -------------------------------------------------
// The active pay rails the server accepts, so the coin picker renders the REAL set instead of hardcoding it.
// The `default` (first-listed) is what /buy quotes when no `rail` is sent. Read-only + privacy-neutral (it
// reveals only which coins we take, already public).
export interface Rail {
  name: string; // server rail id, e.g. "monero" — echoed back to /buy as `rail`
  unit: string; // display ticker, e.g. "XMR"
  confirmations: number; // finality depth for this rail, as reported by the server
}
export interface Rails {
  default: string;
  rails: Rail[];
}

// The picker's OPTIMISTIC first-paint set — seeded into KeyFlow's initial state so the coin picker is present
// in the prerendered HTML (and at first client paint) instead of popping in after getRails() resolves. This is
// only the opening guess: getRails() reconciles it against the server's authoritative set (the same map /buy
// validates against), so a deployment whose rails differ self-corrects on the /rails response. The JS-off page
// is the one place this set stays final, so seed it to match PRODUCTION (Monero + Bitcoin). If the refresh
// fails, KeyFlow deliberately keeps this set stable and lets the authoritative /buy request reject a paused
// coin with an actionable error; changing the picker would be a misleading, visible failure mode.
export const RAILS_OPTIMISTIC: Rails = {
  default: "monero",
  rails: [
    { name: "monero", unit: "XMR", confirmations: 10 },
    { name: "bitcoin", unit: "BTC", confirmations: 3 },
  ],
};

// `null` means the read could not establish an authoritative set. It is deliberately not converted into a
// guessed single-rail configuration: the optimistic picker remains usable, and /buy is the authority when
// the visitor actually asks for a quote.
export async function getRails(): Promise<Rails | null> {
  try {
    const res = await fetch("/rails");
    if (!res.ok) return null;
    const body = (await res.json()) as Rails;
    return body?.rails?.length ? body : null;
  } catch {
    return null;
  }
}

// POST /buy — quote a payment in `rail` (omit → the server's default rail). Throws BuyError on a non-200.
export async function requestQuote(hash: string, creditUsd: number, rail?: string): Promise<Quote> {
  const requestStartedAt = typeof performance !== "undefined" ? performance.now() : 0;
  const requestStartedWallAt = Date.now();
  let res: Response;
  try {
    res = await fetch("/buy", {
      method: "POST",
      // New payment-state contract. A post-upgrade server rejects old loaded bundles that omit this header,
      // preventing them from opening a replacement after their old expiry-only UI abandoned tracking.
      headers: { "content-type": "application/json", "x-nullsink-quote-contract": "2" },
      body: JSON.stringify(rail ? { hash, credit_usd: creditUsd, rail } : { hash, credit_usd: creditUsd }),
    });
  } catch {
    throw { code: "network", status: 0 } as BuyError;
  }
  if (!res.ok) {
    let code = "unknown";
    try {
      code = (await res.json())?.error ?? "unknown";
    } catch {
      /* non-JSON body */
    }
    throw { code, status: res.status } as BuyError;
  }
  const quote = (await res.json()) as Quote;
  return quote.contract === 2 && Number.isFinite(quote.created_at)
    ? { ...quote, _request_started_at: requestStartedAt, _request_started_wall_at: requestStartedWallAt }
    : { ...quote, _initiation_clock_untrusted: true };
}

// GET /balance — returns the balance in USD, or null for 401 (unknown / never-funded).
// We hold no list of tokens, so a 401 is genuinely ambiguous: wrong token, or right
// token whose deposit hasn't confirmed yet.
export async function checkBalance(rawToken: string): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch("/balance", { headers: { "x-api-key": rawToken } });
  } catch {
    throw { kind: "network", status: 0 } as ReadFailure;
  }
  if (res.status === 401) return null;
  if (!res.ok) throw readFailure(res);
  const body = (await res.json()) as { balance_usd: number };
  return body.balance_usd;
}

// Live payment progress for an in-flight order, keyed by the token's HASH (never the raw token — so a
// re-check during the wait never puts the spendable secret on the wire; that's reserved for /balance).
// `closed` means there's no open order or undelivered outbox credit for this hash: it may have credited,
// been reaped, or never existed. After definite delivery the link is scrubbed, so the server deliberately
// collapses those cases and the caller falls back to /balance for the authoritative outcome.
export interface OrderStatus {
  // Version 2 guarantees that `finalizing` covers an undelivered credit and that `closed` follows its
  // definite acknowledgement. Optional at the type boundary because a new UI can meet an older backend
  // during rollback; the tracking reducer treats missing/unknown versions as fail-closed recovery mode.
  contract?: number;
  // Server wall time at response creation. V2 clients compare it with the quote's server-authored created_at
  // before exposing an address, closing the request-suspended-before-first-clock-sample hole. Optional only at
  // the wire boundary so an older/rolled-back payment service fails closed.
  server_now?: number; // server epoch ms
  // `detected` = the server has durably seen an inbound for this order (pending_orders.seen_at) but has no
  // live confirmation count right now — its progress map is process-local and empty after a restart, and the
  // wallet may still be resyncing. It exists so a payer is never told "not seen yet" about a payment we HAVE
  // seen: believing that, they may pay twice, and the second deposit lands on a closed order and is lost.
  state: "waiting" | "detected" | "confirming" | "finalizing" | "closed";
  confirmations?: number;
  required?: number;
  received?: string; // verbatim coin amount string
  expected?: string; // verbatim coin amount string
  unit?: string; // display ticker, e.g. "BTC"
  expires_at?: number; // epoch ms
}

// `address` is the /buy pay_to the caller is tracking. Sent when known so the server scopes the status to
// THIS order — a hash can have several open at once, and the newest empty one must not shadow a paid older
// one. Omitted callers (an older cached bundle) still get the server's seen-preferring fallback.
export async function fetchOrderStatus(hash: string, address?: string): Promise<OrderStatus> {
  let res: Response;
  try {
    res = await fetch("/order-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(address ? { hash, address } : { hash }),
    });
  } catch {
    throw { kind: "network", status: 0 } as ReadFailure;
  }
  if (!res.ok) throw readFailure(res);
  return (await res.json()) as OrderStatus;
}
