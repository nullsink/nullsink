// API surface for the nullsink purchase page. Same-origin endpoints; the
// authoritative contract lives in core's request handler.
//
//   POST /buy           { hash, credit_usd }            -> a one-time quote (pay_to + amount + unit + pay_uri)
//   POST /order-status  { hash }                         -> live payment progress (no balance)
//   GET  /balance       header x-api-key: <raw token>    -> { balance_usd }
//
// The raw token is sent over the wire exactly once, to /balance, on our own origin.
// /buy and /order-status only ever see the SHA-256 hash. See lib/token.ts for the invariant.
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

// Format a USD amount for display: "$12.00". Centralized so the dollar/2-decimal decision
// lives in one place (and can later become Intl.NumberFormat).
export const usd = (n: number): string => `$${n.toFixed(2)}`;

export interface Quote {
  pay_to: string;
  amount: string; // verbatim coin amount string (8dp for BTC) — display AS-IS, never reformat/round
  unit: string; // display ticker, e.g. "BTC"
  pay_uri: string; // wallet URI for the QR, built server-side (e.g. bitcoin:addr?amount=…)
  rate_usd: number;
  confirmations_required: number;
  expires_at: number; // epoch ms
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

// Map a /buy error code to calm, user-facing copy.
export function buyErrorMessage(code: string): string {
  switch (code) {
    case "rate_unavailable":
      return "Couldn't get a price right now. Try again shortly.";
    case "busy_try_later":
      return "The system is busy. Try again soon.";
    case "rate_limited":
      // 429 from the global, identity-free rate limit — a single honest user can hit it because
      // OTHERS are flooding, so don't blame them ("too many requests"); just "busy, retry".
      return "Busy right now. Try again in a moment.";
    case "wallet_unavailable":
      return "Temporarily unavailable. Try again shortly.";
    case "unknown_rail":
      // The chosen coin isn't in the active rail set (e.g. it was paused between loading /rails and buying).
      return "That coin isn't available right now — pick another.";
    case "network":
      // requestQuote threw before any HTTP response (status 0): offline, server unreachable, or a
      // DNS/TLS/connection failure. Distinct from a 5xx (which DID respond) — point at the connection.
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      // The validation codes (invalid_json / invalid_hash / invalid_amount / payload_too_large) are
      // unreachable if the client validates; a 500 (proxy_error) or any unexpected body lands here too.
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

// Last-resort fallback if /rails can't be reached, so the buy flow NEVER blocks on it. One rail → the picker
// hides and the flow is single-coin, exactly as before multi-rail.
const RAILS_FALLBACK: Rails = { default: "monero", rails: [{ name: "monero", unit: "XMR", confirmations: 10 }] };

// The picker's OPTIMISTIC first-paint set — seeded into KeyFlow's initial state so the coin picker is present
// in the prerendered HTML (and at first client paint) instead of popping in after getRails() resolves. This is
// only the opening guess: getRails() reconciles it against the server's authoritative set (the same map /buy
// validates against), so a deployment whose rails differ self-corrects on the /rails response. The JS-off page
// is the one place this set stays final, so seed it to match PRODUCTION (Monero + Bitcoin). Distinct from
// RAILS_FALLBACK, the conservative single-rail value shown only when /rails never answers.
export const RAILS_OPTIMISTIC: Rails = {
  default: "monero",
  rails: [
    { name: "monero", unit: "XMR", confirmations: 10 },
    { name: "bitcoin", unit: "BTC", confirmations: 1 },
  ],
};

export async function getRails(): Promise<Rails> {
  try {
    const res = await fetch("/rails");
    if (!res.ok) return RAILS_FALLBACK;
    const body = (await res.json()) as Rails;
    return body?.rails?.length ? body : RAILS_FALLBACK;
  } catch {
    return RAILS_FALLBACK;
  }
}

// POST /buy — quote a payment in `rail` (omit → the server's default rail). Throws BuyError on a non-200.
export async function requestQuote(hash: string, creditUsd: number, rail?: string): Promise<Quote> {
  let res: Response;
  try {
    res = await fetch("/buy", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  return (await res.json()) as Quote;
}

// GET /balance — returns the balance in USD, or null for 401 (unknown / never-funded).
// We hold no list of tokens, so a 401 is genuinely ambiguous: wrong token, or right
// token whose deposit hasn't confirmed yet.
export async function checkBalance(rawToken: string): Promise<number | null> {
  const res = await fetch("/balance", { headers: { "x-api-key": rawToken } });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`balance_${res.status}`);
  const body = (await res.json()) as { balance_usd: number };
  return body.balance_usd;
}

// Live payment progress for an in-flight order, keyed by the token's HASH (never the raw token — so a
// re-check during the wait never puts the spendable secret on the wire; that's reserved for /balance).
// `closed` means there's no open order for this hash: it may have credited, been reaped, or never
// existed — the server can't tell (the link is dropped at settle), so the caller falls back to /balance
// for the authoritative outcome.
export interface OrderStatus {
  state: "waiting" | "confirming" | "finalizing" | "closed";
  confirmations?: number;
  required?: number;
  received?: string; // verbatim coin amount string
  expected?: string; // verbatim coin amount string
  unit?: string; // display ticker, e.g. "BTC"
  expires_at?: number; // epoch ms
}

export async function fetchOrderStatus(hash: string): Promise<OrderStatus> {
  const res = await fetch("/order-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash }),
  });
  if (!res.ok) throw new Error(`order_status_${res.status}`);
  return (await res.json()) as OrderStatus;
}
