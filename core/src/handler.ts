// Request handler factory over an injected dependency bag, so tests supply in-memory stores, a stubbed
// upstream fetch, and fake rate/wallet calls — no port, no network. index.ts wires production deps; pure
// helpers (pricing, usage, hashing) are imported directly.
import { hashToken } from "./ledger/db";
import { priceUsage, isReasoningModel } from "./cost";
import { BUILD_VERSION } from "./version";
import * as log from "./log";
import * as metrics from "./metrics";
import { selectProviders, type Provider } from "./providers";
import { makeEndpoints } from "./endpoints";
import { deny, denyApi, apiErrorBody, NO_API_KEY, scrubRespHeaders, buildUpstreamHeaders } from "./http";
import type { HoldEstimator } from "./hold";
import type { RailView } from "./rails/types";
import type { BalanceStore } from "./ledger/db";
import type { OrdersStore } from "./ledger/orders";
import type { OrderProgress } from "./ledger/orderstatus";
import type { TokenBucket } from "./ratelimit";

// RailView moved to rails/types.ts (shared by handler + endpoints/ without a cycle); re-export for
// back-compat — index.ts and the tests still import it from here.
export type { RailView } from "./rails/types";

// Does an upstream error body indicate a billing/credit/quota failure (OUR account, not the user's
// request)? Match the provider's STRUCTURED error fields (type/code, and a tight message phrase), not the
// whole body: a generic 400 often echoes the user's own prompt, which could contain "billing"/"quota" and
// be masked by mistake, hiding a fixable error. OpenAI signals via type/code = "insufficient_quota";
// Anthropic has no distinct type, so we anchor on its exact phrasing. Falls back to the raw text only when
// the body isn't JSON.
function isBillingError(text: string): boolean {
  const phrase = /credit balance is too low|purchase credits|insufficient[_ ]?quota/i;
  let err: any;
  try {
    err = JSON.parse(text)?.error;
  } catch {
    return phrase.test(text); // non-JSON body: best-effort on the raw text
  }
  if (!err || typeof err !== "object") return phrase.test(text);
  const tag = `${typeof err.type === "string" ? err.type : ""} ${typeof err.code === "string" ? err.code : ""}`;
  return /insufficient_quota|billing/i.test(tag) || phrase.test(typeof err.message === "string" ? err.message : "");
}

// Did the upstream reject the MODEL ITSELF (not the request shape)? Handled uniformly across providers +
// endpoints, whose status codes differ (verified live 2026-06-22): Anthropic /v1/messages → 404
// `not_found_error`; OpenAI /v1/chat/completions → 404 and /v1/responses → 400, both carrying
// `error.code: "model_not_found"`. Our metered paths are fixed + valid, so any 404 from them is a bad model;
// OpenAI also flags it on a 400 via the code — which a bare status check would miss (and would wrongly relay).
export function isModelNotFound(status: number, text: string): boolean {
  let err: any;
  try {
    err = JSON.parse(text)?.error;
  } catch {
    return status === 404; // non-JSON body: fall back to the status
  }
  if (err && typeof err === "object") {
    if (err.code === "model_not_found") return true; // OpenAI (chat 404 / responses 400)
    if (status === 404 && err.type === "not_found_error") return true; // Anthropic
  }
  return status === 404; // any other 404 on our fixed metered endpoints is a model-not-found
}

// Structured detail for the masked-error / model-not-found logs: the provider's stable error `type` (+ `code`
// when present — OpenAI) and a length-capped `message`, read from `error.*` ONLY. Reading just `error.*`
// structurally DROPS Anthropic's sibling `request_id` (an upstream correlation id we don't want in the
// journal) and replaces the old indiscriminate 300-char raw-body slice. Safe to log: the masked path is our/
// provider-side (key, billing, provider-down) or a model 404 — that message names OUR account state or the
// rejected model id, never a prompt (prompt-echoing 4xx are RELAYED, not masked). Non-JSON → a short bounded
// slice (no request_id possible); JSON without `error.*` → "" (don't slice the raw — it may hold request_id).
export function maskedErrorDetail(text: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.slice(0, 120);
  }
  const err = parsed?.error;
  if (!err || typeof err !== "object") return "";
  const head = [err.type, err.code].filter((x) => typeof x === "string").join("/");
  const msg = typeof err.message === "string" ? err.message.slice(0, 200) : "";
  return [head, msg].filter(Boolean).join(": ");
}

// A non-OK upstream response is either the USER's fault (a request they can fix) or OURS / the provider's
// (our key, our billing, the provider rate-limiting us, or the provider down). Relay the former verbatim so
// the developer can fix it; MASK the latter behind an opaque nullsink error, so we never leak the provider's
// identity, our billing state, or our key status (a funded user must never see "your credit balance is too
// low"). The caller has already refunded the hold; `text` is the already-read upstream body.
function relayOrMaskUpstream(provider: { id: string }, upstream: Response, text: string): Response {
  const s = upstream.status;
  // Model not found — handled uniformly despite the providers' differing status codes (Anthropic 404; OpenAI
  // 404 chat / 400 responses). The permissive prefix gate forwards dated snapshots we can't pre-confirm, so a
  // typo'd or retired model surfaces HERE rather than at the door. Return our own clear `unsupported_model`
  // (byte-for-byte the gate's own rejection — opaque about the provider) instead of a misleading masked 503
  // OR the raw provider body. WARN: refunded + client-visible + user/config-fixable; the logged model id is
  // what an operator adds to the sync scrub list if a bad id recurs. Counted as `upstream:notfound` (routine —
  // the client's bad model, not ours), so the served↔req gap stays fully itemized.
  if (isModelNotFound(s, text)) {
    metrics.recordUpstream("notfound");
    log.warn("upstream", `model not found upstream (refunded): ${maskedErrorDetail(text)}`);
    return denyApi(provider, 400, "unsupported_model");
  }
  const billing = isBillingError(text);
  // Relay ONLY clearly user-fixable request errors (bad request / unprocessable / payload too large), and
  // only when they aren't a billing failure wearing a 400 (Anthropic's low-credit error is a 400). Anything
  // else is our or the provider's side: our key (401/403), billing (402), routing (404), throttle (429),
  // provider down (5xx). Relayed bodies are the upstream's OWN native envelope, already correctly shaped.
  const relayable = ((s === 400 || s === 422) && !billing) || s === 413;
  if (relayable) {
    // Count the relayed user error so the served↔req gap is itemized in [metrics], not just inferable.
    // It's the CLIENT's fixable request error (not ours / not the provider's), so it rides the routine
    // INFO heartbeat rather than the WARN problem line, and we DON'T log the body per-event (a 4xx body
    // can echo the user's prompt — the same leak the mask branch below is built to avoid).
    metrics.recordUpstream("relayed4xx");
    return new Response(text, {
      status: s,
      statusText: upstream.statusText,
      headers: scrubRespHeaders(upstream),
    });
  }
  // Masked: never send the upstream body. Log the real status + a snippet server-side so the operator is
  // alerted (e.g. to top up the account). Keep a genuine throttle (429) as a 429 so clients back off, but
  // map an out-of-funds error to 503 even when the provider wore a 429 (OpenAI returns insufficient_quota
  // as a 429, which retrying will never clear). Preserve a numeric Retry-After for real throttles.
  log.error("upstream", `masked ${s} (refunded, not relayed): ${maskedErrorDetail(text)}`);
  const throttled = s === 429 && !billing; // a GENUINE vendor rate limit (an out-of-funds 429 is billing → 503)
  // Classify the masked outcome for the [metrics] trend (aggregate, no identity). Order matters: billing
  // wins over a 429 (out-of-funds can wear a 429), then a genuine throttle, then our key (auth), then a
  // provider 5xx. A model 404 is handled above; everything else (a rare 405/409/…) → `other`, so EVERY masked
  // outcome is bucketed and the served↔req gap reconciles exactly.
  if (throttled) metrics.recordUpstream("throttle"); // ceiling tripwire: vendor rate limit
  else if (billing) metrics.recordUpstream("billing"); // out-of-funds — top up the account
  else if (s === 401 || s === 403) metrics.recordUpstream("auth"); // our key/permission is wrong
  else if (s >= 500) metrics.recordUpstream("server"); // provider degraded / overloaded
  else metrics.recordUpstream("other"); // rare masked status (405/409/…) — bucketed, never an unexplained residual
  const status = throttled ? 429 : 503;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) headers["retry-after"] = retryAfter;
  // A genuine throttle (429) is safe to mark retryable (with the provider's Retry-After). The masked 503 is
  // deliberately AMBIGUOUS — provider-down (retryable) vs our key/billing (won't clear) — which we never
  // disclose, so we leave x-should-retry unset and let the client's default status heuristic decide. The
  // body wears the provider's native envelope (so a stock SDK parses it) but the message stays opaque.
  if (status === 429) headers["x-should-retry"] = "true";
  return new Response(apiErrorBody(provider.id, status, status === 429 ? "rate_limited" : "service_unavailable"), { status, headers });
}

export type HandlerDeps = {
  apiKey: string;
  baseUrl: string;
  version: string;
  upstreamTimeoutMs: number;
  margin: number;
  buyMinUsd: number;
  buyMaxUsd: number;
  orderTtlMs: number; // quoted expires_at window: how long the buyer is told the address stays valid
  maxOpenOrders: number;
  maxBuyBodyBytes: number;
  maxMessagesBodyBytes: number;
  balances: BalanceStore;
  orders: OrdersStore;
  estimateHold: HoldEstimator; // sizes the pre-flight hold; prod default is count_tokens (index.ts), byte bound as fallback
  // OpenAI provider config — present iff OPENAI_API_KEY is set (index.ts). Absent → /v1/chat/completions
  // 404s like any unsupported endpoint, so the proxy runs Anthropic-only by default (enable by adding a key).
  openai?: {
    apiKey: string;
    baseUrl: string;
    estimateHold: HoldEstimator; // OpenAI's own hold estimator (count via /v1/responses/input_tokens, byte fallback)
  };
  // Output cap applied (and injected into the forwarded body) when a request OMITS one. 0/undefined =
  // require an explicit cap (max_tokens_required). Set it (index.ts, DEFAULT_MAX_OUTPUT_TOKENS) so stock
  // OpenAI clients that don't send a cap work. Provider-agnostic.
  defaultMaxOutputTokens?: number;
  upstreamFetch: typeof fetch; // injectable so tests stub the upstream without a network
  // Pay-rail registry: every active rail keyed by name (PayRail satisfies RailView structurally, so the
  // composition root passes the live rails directly), plus which one /buy defaults to when a request omits
  // `rail`. /buy resolves by the request's rail; /order-status by the looked-up order's rail. Tests build a
  // one-entry map; index.ts passes the multi-rail set.
  rails: Map<string, RailView>;
  defaultRail: string;
  buyRateLimit?: TokenBucket; // global, identity-free /buy rate limit; omitted = no limit (e.g. tests)
  // Global, identity-free throttle for the unauthenticated READ endpoints (/balance, /order-status): they
  // have no money gate and do a parse+DB read per call, so a flood is pure free work — cap the aggregate
  // rate. Fail-safe, no IP/token key (privacy thesis). Omitted = no limit (e.g. tests). The metered
  // endpoints deliberately get NO such bucket: the atomic hold already makes unfunded requests cost nothing,
  // and a blunt global limit would throttle legitimate high-throughput agent clients.
  readRateLimit?: TokenBucket;
  // Live per-order payment progress for /order-status (the poller's last-seen sighting). Omitted in
  // tests that don't exercise /order-status; absent → every open order reads as "waiting".
  orderStatus?: (orderIndex: number, rail?: string) => OrderProgress | undefined;
  // Registry of live streaming settle() callbacks — each stream adds itself for its lifetime and removes
  // itself the moment its billing finalizes (done/error/cancel). The shutdown handler (index.ts) drains
  // this on SIGTERM so a request still streaming at restart is reconciled instead of force-closed with its
  // hold un-reconciled (see settle() for the partial-billed / rest-refunded outcome). Idempotent, so a
  // drain racing a natural settle is safe. Omitted in tests → a throwaway local set.
  inflight?: Set<(reason?: "drain") => void>;
  // Force-settle deadline (ms) for a streaming request whose client opens it but then neither reads nor
  // disconnects — none of done/error/cancel fire, so settle() would never run and the hold would leak until
  // restart. MUST be > upstreamTimeoutMs so a legit stream always finishes naturally first (index.ts enforces
  // this). Omitted in tests → defaults to upstreamTimeoutMs + 60s.
  streamSettleDeadlineMs?: number;
  // Injectable timer for the deadline above (so tests fire it deterministically, like shutdown.ts's clock).
  // Returns a canceller. Omitted → setTimeout/clearTimeout (unref'd so a pending deadline never blocks exit).
  scheduleStreamDeadline?: (onDeadline: () => void, ms: number) => () => void;
};

export function createHandler(d: HandlerDeps): (req: Request) => Promise<Response> {
  const {
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    version: VERSION,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    maxMessagesBodyBytes: MAX_MESSAGES_BODY_BYTES,
    balances,
    orders,
    estimateHold,
    upstreamFetch,
    orderStatus,
    inflight = new Set<(reason?: "drain") => void>(),
    streamSettleDeadlineMs = UPSTREAM_TIMEOUT_MS + 60_000, // default sits above the upstream timeout
    scheduleStreamDeadline = (onDeadline, ms) => {
      const t = setTimeout(onDeadline, ms);
      t.unref?.(); // a pending deadline must never keep the process alive at shutdown
      return () => clearTimeout(t);
    },
  } = d;
  const { getBalance, openHold, settleHold } = balances;
  const { tryAddOrder, openCount, latestOpenOrderByHash } = orders;
  const defaultMaxOutput = d.defaultMaxOutputTokens ?? 0; // 0 = require an explicit output cap (strict)
  // Rail registry (required deps): every active rail keyed by name + which one /buy defaults to. /buy selects
  // by the request's rail (default DEFAULT_RAIL); /order-status by the looked-up order's rail.
  const DEFAULT_RAIL = d.defaultRail;
  const RAILS = d.rails;

  // nullsink's own (non-metered) endpoints — /buy, /order-status, /rails, /balance — built over the rail
  // registry + the order/balance store methods + the limits (endpoints/). Each is `(req) => Promise<Response>`;
  // the router below dispatches to them. The metered money path (handleMetered) stays here in the handler.
  const endpoints = makeEndpoints({
    rails: RAILS,
    defaultRail: DEFAULT_RAIL,
    margin: d.margin,
    buyMinUsd: d.buyMinUsd,
    buyMaxUsd: d.buyMaxUsd,
    orderTtlMs: d.orderTtlMs,
    maxOpenOrders: d.maxOpenOrders,
    maxBuyBodyBytes: d.maxBuyBodyBytes,
    getBalance,
    tryAddOrder,
    openCount,
    latestOpenOrderByHash,
    buyRateLimit: d.buyRateLimit,
    readRateLimit: d.readRateLimit,
    orderStatus,
  });

  // Active upstream providers, resolved into an exact-path → Provider registry (providers/index.ts). The
  // Anthropic provider is always present; the OpenAI pair is registered iff OPENAI_API_KEY was configured
  // (d.openai), so its endpoints 404 when disabled. Built here so each closes over THIS handler's creds.
  const PROVIDERS = selectProviders({
    anthropic: { apiKey: API_KEY, baseUrl: BASE_URL, version: VERSION, estimateHold },
    openai: d.openai ? { apiKey: d.openai.apiKey, baseUrl: d.openai.baseUrl, estimateHold: d.openai.estimateHold } : undefined,
  });
  // Exact-path lookup (Map.get is exact — no prefix readmit of subpaths like /v1/messages/batches); an
  // unknown path or a disabled provider misses → the fail-closed 404 in handle().
  const providerForPath = (pathname: string): Provider | undefined => PROVIDERS.get(pathname);

  // --- Shared money skeleton. Gate (reject before any spend) → size + atomically debit the hold →
  // forward with our injected key → reconcile to the real metered cost (clamped at the hold so a refund
  // is never negative, enforcing the no-overdraft invariant). Provider-agnostic: every per-API-shape
  // difference is read off `provider`. ---
  async function handleMetered(provider: Provider, req: Request, url: URL): Promise<Response> {
    // Bound the body before buffering (DoS): the content-length header check rejects bodies that DECLARE
    // an oversized length before the balance check. Chunked uploads (no content-length) bypass this and
    // are bounded instead by Bun's maxRequestBodySize backstop (index.ts). Cap matches the upstream ceiling.
    if (Number(req.headers.get("content-length") ?? 0) > MAX_MESSAGES_BODY_BYTES) {
      metrics.recordGate("request");
      return denyApi(provider, 413, "payload_too_large");
    }

    // Two header-only sheds run BEFORE we buffer/parse the (up to 32 MiB) body, so neither an unauthenticated
    // nor an unknown-token flood ever reaches the buffer:
    //   1. NO token at all → 401 (the token is a header, so this needs no body).
    //   2. a PRESENT but unknown token → 401: every made-up/junk string is "not in the DB", so hashing it and
    //      checking getBalance here sheds the whole free, unfunded flood class before a single byte is buffered.
    // A present, FUNDED token buffers and bills exactly as before; a real-but-broke token (balance <= 0) is
    // still gated AFTER the body checks below — it is a paid token, not the free abuse vector. We authenticate
    // against this token, never forward it, and inject the real key below.
    const token = provider.readToken(req);
    if (!token) { metrics.recordGate("auth"); return denyApi(provider, 401, NO_API_KEY.code, NO_API_KEY.message); }
    const hash = hashToken(token);
    if (getBalance(hash) === null) { metrics.recordGate("auth"); return denyApi(provider, 401, "invalid_token"); }

    // Buffer and parse — the source of truth for billing. Reject anything we can't price at our flat
    // rates, constraining the request to the standard pricing regime before a cent is spent.
    const raw = await req.text();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      metrics.recordGate("request");
      return denyApi(provider, 400, "invalid_json");
    }
    // Streaming: pass SSE bytes through untouched, metering usage off the same stream (below). The
    // up-front hold gates admission either way, so this only affects how the response is reconciled.
    const streaming = body?.stream === true;
    const rej = provider.premiumReject(body);
    if (rej) { metrics.recordGate("premium"); return denyApi(provider, rej.status, rej.error); }
    const model: string | null = typeof body?.model === "string" ? body.model : null;
    if (!model || !provider.ownsModel(model)) { metrics.recordGate("model"); return denyApi(provider, 400, "unsupported_model"); }
    // The request's output cap, or the global default if it omitted one (then injected into the forward
    // below so the bound is real). defaultMaxOutput=0 keeps the strict requirement (max_tokens_required).
    const clientCap = provider.outputCap(body);
    const maxTokens = clientCap ?? (defaultMaxOutput > 0 ? defaultMaxOutput : null);
    if (maxTokens == null) { metrics.recordGate("request"); return denyApi(provider, 400, "max_tokens_required"); }

    // Pre-estimator balance gate: estimateHold may make an unmetered upstream count_tokens call, so reject a
    // broke token here — else a valid-but-broke token could force a free count_tokens round-trip. (An unknown
    // token was already shed before the buffer above; this re-read also catches a token deleted mid-flight,
    // which must read as 401 not 402.) The atomic openHold debit below remains the authoritative gate.
    const preBalance = getBalance(hash);
    if (preBalance === null) { metrics.recordGate("auth"); return denyApi(provider, 401, "invalid_token"); }
    if (preBalance <= 0) { metrics.recordGate("funds"); return denyApi(provider, 402, "insufficient_balance"); }

    // Hold the maximum this request could cost (upper bound). The atomic openHold debit gates admission AND
    // reserves funds, so concurrent requests can't overdraft; billActual (below) reconciles to actual cost.
    // Forward client anthropic-beta to the FREE count call so it accepts beta-gated body fields instead of
    // 400ing to the byte bound; count-only, so it can't enable premium pricing (the billed relay keeps its
    // strict beta filter). Absent for OpenAI.
    const clientBeta = req.headers.get("anthropic-beta");
    const { micros: holdAmount, inputTokens } = await provider.estimateHold({
      model,
      raw,
      body,
      maxTokens,
      countHeaders: clientBeta ? { "anthropic-beta": clientBeta } : undefined,
    });
    // One hold_id per request: openHold debits the upper bound AND journals it in one transaction, so a crash
    // before settle leaves a durable row that boot recovery refunds in full (db.ts recoverHolds). settleHold
    // closes that row on every exit path below; the journal makes the debit crash-safe, not just in-memory.
    const holdId = crypto.randomUUID();
    if (!openHold(hash, holdAmount, holdId)) {
      const gone = getBalance(hash) === null; // token deleted mid-flight → auth; else the balance lost the race → funds
      metrics.recordGate(gone ? "auth" : "funds");
      return gone ? denyApi(provider, 401, "invalid_token") : denyApi(provider, 402, "insufficient_balance");
    }

    // Charge the real cost, refund the rest. CLAMP the charge at the hold so a response pricing ABOVE it
    // (over-reported usage, or a response model resolving to a pricier rate than the request model) can never
    // make the refund negative and overdraft — enforcing the sound-upper-bound invariant in OUR code, not
    // trusting upstream. settleHold closes the journal row and refunds the unused part atomically, and is
    // idempotent (the row delete guards it), so a shutdown-drain settle racing the natural one can't
    // double-refund. Defined before the try so the catch can refund through it too.
    const billActual = (actual: number) => {
      if (actual > holdAmount) {
        log.error("bill", `actual cost ${actual} exceeded hold ${holdAmount} — refund clamped to 0 (no overdraft)`);
        metrics.recordBill("holdExceeded"); // trend behind the per-event ERROR (hold mis-sized if it spikes)
      }
      // Floor at 0 before refunding: a NEGATIVE cost (only reachable from a malformed/negative usage report —
      // never under honest upstreams) must not credit back MORE than was held (balance inflation). With this
      // floor the refund is always within [0, holdAmount].
      const cost = Math.max(0, actual);
      settleHold(holdId, hash, holdAmount - Math.min(cost, holdAmount));
    };

    // Past this point the hold is debited — every synchronous exit path refunds via billActual; the streaming
    // path defers refund to settle() on the response stream's done/error/cancel callback (see below).
    try {
      const headers = buildUpstreamHeaders(provider, req);
      // Inject the cap only when the client omitted one (clientCap == null) — i.e. the default supplied it.
      const sendBody = provider.prepareBody(raw, body, streaming, clientCap == null ? maxTokens : undefined);

      metrics.recordRequest(); // a metered request we're forwarding upstream (post-gates); served counts the 2xx below
      const upstream = await upstreamFetch(provider.baseUrl + provider.upstreamPath + url.search, {
        method: "POST",
        headers,
        body: sendBody,
        redirect: "manual",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      // Billing rides THIS response's stream lifecycle — settle() runs on clean end, upstream error, or
      // client disconnect — so it's not a detached task.
      if (streaming) {
        // A non-2xx, even for a stream request, comes back as a buffered JSON error with no SSE body to
        // meter → refund in full, exactly like the buffered non-ok path below.
        if (!upstream.ok || !upstream.body) {
          billActual(0); // no SSE body to meter → refund in full (and close the journal row)
          return relayOrMaskUpstream(provider, upstream, await upstream.text());
        }
        // `served` is NOT counted here — a 2xx SSE envelope is not yet a clean bill. settle() (below) counts the
        // streamed outcome exactly once: served (clean usage), servedPartial (disconnect floor), or streamAborted.
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const scan = provider.makeScanner({ model, inputTokens, maxTokens, reasoning: isReasoningModel(model) });
        let settled = false;
        // Set true the instant the client cuts the connection (the cancel callback), BEFORE we cancel the
        // upstream — cancelling upstream resolves any in-flight read as `done`, which would otherwise reach
        // settle() via the clean-end path and RACE (and beat) the cancel callback. Reading a closure flag
        // here, not a settle() argument, means whichever path wins the race still sees the disconnect.
        let clientDisconnected = false;
        // Set true by the pull catch when the upstream read errors mid-stream, so settle() bills it as an
        // aborted stream (WARN, routine — the client got an error, not content) rather than the money-leak
        // refunded-in-full page.
        let aborted = false;
        // Captured in the stream's start() so the force-settle deadline below can terminate the client's
        // stream even when the client is the one stalling (a backpressured pull won't observe a close itself).
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let cancelDeadline: (() => void) | undefined; // clears the force-settle timer; assigned after inflight.add
        const settle = (reason?: "drain") => {
          if (settled) return; // at-most-once (idempotent); exactly-once in the normal done/error/cancel flows
          settled = true;
          inflight.delete(settle); // billing finalized (naturally, or drained on shutdown) — stop tracking
          cancelDeadline?.(); // every natural exit (done/error/cancel/drain) clears the force-settle timer here
          const metered = scan.result();
          if (metered) {
            metrics.recordServed(); // streamed clean-end with parseable usage — billed actual (the success outcome)
            billActual(priceUsage(metered.model, metered.usage, model));
          } else if (clientDisconnected && !scan.errored() && inputTokens > 0) {
            // No usage metered yet, but the CLIENT cleanly disconnected after we began forwarding — the
            // upstream has already ingested (and bills us for) the prompt, so bill an input-only floor (no
            // output yet), clamped to the hold by billActual. Closes the early-abort free-prompt-ingestion
            // gap. scan.errored() EXCLUDES a 200-then-error stream the client aborts on (upstream failed →
            // the client got nothing usable → full refund, below). Provider-agnostic: the OpenAI scanners
            // already bill a floor once content has streamed; this covers the no-usage-frame-yet window for
            // both (the Anthropic scanner has no input floor of its own).
            metrics.recordServedPartial(); // client disconnected post-forward → input-floor bill (Anthropic-granularity)
            billActual(priceUsage(model, { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, model));
          } else if (reason === "drain") {
            // Shutdown drain cut a still-live stream before any usage frame — the client gets nothing more.
            // Routine (expected at restart), NOT a metering break: full refund, no log, no page.
            metrics.recordStreamAborted(); // shutdown drain of a live stream — refunded, routine (grouped with mid-flight aborts)
            billActual(0);
          } else if (aborted || scan.errored()) {
            // Mid-stream upstream failure (a transport read error, or an in-band error frame) — the client got
            // an error, not billable content. Provider friction worth a WARN, but NOT the money-leak page.
            log.warn("upstream", `stream aborted mid-flight (${provider.upstreamPath}) — refunded`);
            metrics.recordStreamAborted(); // mid-flight upstream error/abort — refunded, routine (client got an error)
            billActual(0);
          } else {
            // Clean end, NO parseable usage: we delivered a 2xx stream and metered nothing — the genuine
            // served-but-unbilled money leak, and the ONLY streaming case that should page (log.ts alerts on it).
            log.error("bill", `streamed ${provider.upstreamPath} without parseable usage — refunded in full`);
            metrics.recordBill("refundedInFull");
            billActual(0);
          }
        };
        // Track this live stream so a SIGTERM can finalize its billing before force-close (index.ts shutdown).
        inflight.add(settle);
        metrics.observeStreams(inflight.size); // high-water concurrent live streams

        // Force-settle deadline. settle() above fires only on the stream's done, a read error, or a client
        // cancel — all of which need the client to be READING or to disconnect. A client that opens the
        // stream and then holds the socket open without reading triggers none of them, so the hold would leak
        // (balance debited, never reconciled, provider already paid for what generated) until the process
        // restarts. This timer closes that: stop upstream spend, bill the metered partial (treated as a
        // disconnect → a no-usage-yet stream pays the input floor, not a full refund), and end the client
        // stream. Set strictly ABOVE upstreamTimeoutMs (index.ts), so a legit stream always reaches
        // done/error first and this never fires for it; settle() clears it on every natural exit.
        cancelDeadline = scheduleStreamDeadline(() => {
          clientDisconnected = true; // a force-cut is a disconnect for billing: partial / input floor, not full refund
          reader.cancel("stream_settle_deadline").catch(() => {}); // stop generation → stop paying the provider
          settle();
          try {
            streamController?.error(new Error("stream_settle_deadline"));
          } catch {
            /* stream already closed/errored — nothing to terminate */
          }
        }, streamSettleDeadlineMs);

        const out = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller; // so the deadline can terminate a stalled (non-reading) stream
          },
          // pull runs only when the client wants more, so backpressure to the client is preserved.
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                settle(); // clean end → bill the exact final total
                controller.close();
                return;
              }
              scan.feed(decoder.decode(value, { stream: true }));
              controller.enqueue(value);
            } catch (err) {
              aborted = true; // mid-stream upstream read error → settle() treats it as an aborted stream, not a leak
              settle(); // upstream errored / timed out mid-stream → bill what we metered
              controller.error(err);
            }
          },
          async cancel(reason) {
            // Client disconnected: flag it FIRST (so a racing done-pull, woken by the upstream cancel below,
            // bills the metered partial / input floor instead of full-refunding), then cancel upstream
            // (stops generation → stops our spend) and settle. The self-undercharge is bounded by the
            // metered partial / input floor, which the billActual clamp keeps ≤ the up-front hold.
            clientDisconnected = true;
            await reader.cancel(reason).catch(() => {});
            settle();
          },
        });

        return new Response(out, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: scrubRespHeaders(upstream),
        });
      }

      const text = await upstream.text();

      // Reconcile. A 2xx with parseable usage is billed (refunding hold − actual); a 2xx without usage
      // refunds in full and relays as-is. A non-OK upstream refunds in full, then relayOrMaskUpstream
      // decides whether to relay it (user-fixable) or mask it (our or the provider's side); see its note.
      if (upstream.ok) {
        const metered = provider.extractUsage(text);
        if (metered) {
          metrics.recordServed(); // a 2xx we metered actual usage on — billed clean (the success outcome)
          billActual(priceUsage(metered.model, metered.usage, model));
        } else {
          log.error("bill", `2xx ${provider.upstreamPath} without parseable usage — refunded in full`);
          metrics.recordBill("refundedInFull"); // 2xx but metered NOTHING — the served-but-unbilled leak (NOT served)
          billActual(0);
        }
        return new Response(text, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: scrubRespHeaders(upstream),
        });
      }

      billActual(0); // non-OK: nothing billable happened, refund in full
      return relayOrMaskUpstream(provider, upstream, text);
    } catch (err) {
      billActual(0); // refund in full — the request never billably completed (settleHold closes the row)
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      metrics.recordUpstream(timedOut ? "timeout" : "unreachable"); // transport-failure trend (distinct from a returned non-2xx)
      // Client-visible + already refunded → WARN, not ERROR. Greppable for an upstream/Anthropic outage.
      log.warn("upstream", timedOut ? "request timed out" : `unreachable: ${log.errMsg(err)}`);
      // Transient (network timeout / connection failure) → genuinely retryable, so native envelope +
      // x-should-retry:true; the opaque code never names the upstream.
      const status = timedOut ? 504 : 502;
      const code = timedOut ? "upstream_timeout" : "upstream_unreachable";
      return new Response(apiErrorBody(provider.id, status, code), {
        status,
        headers: { "content-type": "application/json", "x-should-retry": "true" },
      });
    }
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Local-only liveness check; never forwarded upstream. Unauthenticated.
    if (url.pathname === "/healthz") return new Response(`ok ${BUILD_VERSION}`);

    // nullsink's own endpoints (non-metered) — quote a payment, poll an order, list rails, check a balance.
    // The logic lives in endpoints/ (built in createHandler above); the router just dispatches by method +
    // path. Each returns a Response; none spends upstream. Anything unmatched falls through to the metered
    // routing (and then the fail-closed 404) below.
    if (req.method === "POST" && url.pathname === "/buy") return endpoints.buy(req);
    if (req.method === "POST" && url.pathname === "/order-status") return endpoints.orderStatus(req);
    if (req.method === "GET" && url.pathname === "/rails") return endpoints.rails(req);
    if (req.method === "GET" && url.pathname === "/balance") return endpoints.balance(req);

    // Metered endpoints: route by EXACT path to the provider that owns that API shape (Anthropic Messages
    // today; OpenAI added behind the same seam). Only these paths spend upstream — the up-front hold makes
    // each yield no free usage. Anything unmatched (other methods, batches/files, any endpoint Anthropic or
    // OpenAI add later) falls through to the fail-closed 404 below; a prefix match would readmit subpaths.
    const provider = req.method === "POST" ? providerForPath(url.pathname) : undefined;
    if (provider) return handleMetered(provider, req, url);

    return deny(404, "unsupported_endpoint");
  };
}
