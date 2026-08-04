// PROXY TRUST DOMAIN request handler: the metered money path (POST /v1/*) plus the two free reads it owns
// (GET /balance, GET /v1/models). A factory over an injected dependency bag, so tests supply in-memory stores
// and a stubbed upstream fetch — no port, no network. proxy.ts wires production deps; pure helpers (pricing,
// usage, hashing) are imported directly.
//
// This module must NOT import anything from the payments trust domain (rails, the order store, /buy). The proxy binary is the
// unit the sealed tier attests, so it must never bundle payments code — that's a structural guarantee, not a
// tree-shaking hope. The combined trust-domain router lives in test/support/handler-combined.ts, which only
// the tests import; neither composition root does.
import { hashToken } from "./ledger/hash";
import { priceUsage, pricedModels, type Metered, type UsageEvidence } from "./cost";
import { BUILD_VERSION } from "./version";
import * as log from "./log";
import * as metrics from "./metrics";
import { selectProviders, resolveProvider, type Provider } from "./providers";
import { makeProxyEndpoints } from "./endpoints/proxy";
import { deny, denyApi, apiErrorBody, NO_API_KEY, scrubRespHeaders, buildUpstreamHeaders } from "./http";
import type { HoldEstimator } from "./hold";
import type { BalanceStore } from "./ledger/db";
import type { TokenBucket } from "./ratelimit";

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

// A non-OK upstream response is either the USER's fault (a request they can fix) or OURS / the provider's.
// Relay the former verbatim; sanitize the latter into a stable native envelope. Safe transient categories
// retain their retry semantics, but our key/billing state and every raw upstream body remain private.
// The caller has already refunded the hold; `text` is the already-read upstream body.
function relayOrSanitizeUpstream(provider: { id: string }, upstream: Response, text: string): Response {
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
  // Sanitized: never send the upstream body. Log the real status + safe structured detail server-side.
  // Preserve safe transient semantics (genuine 429 and Anthropic 529 overload), while operator auth/billing
  // failures stay opaque behind 503. An out-of-funds 429 is billing, not retryable rate limiting.
  log.error("upstream", `masked ${s} (refunded, not relayed): ${maskedErrorDetail(text)}`);
  const throttled = s === 429 && !billing; // a GENUINE vendor rate limit (an out-of-funds 429 is billing → 503)
  const overloaded = s === 529 && !billing; // safe transient category; body is synthesized, never relayed raw
  // Classify the masked outcome for the [metrics] trend (aggregate, no identity). Order matters: billing
  // wins over a 429 (out-of-funds can wear a 429), then a genuine throttle, then our key (auth), then a
  // provider 5xx. A model 404 is handled above; everything else (a rare 405/409/…) → `other`, so EVERY masked
  // outcome is bucketed and the served↔req gap reconciles exactly.
  if (throttled) metrics.recordUpstream("throttle"); // ceiling tripwire: vendor rate limit
  else if (billing) metrics.recordUpstream("billing"); // out-of-funds — top up the account
  else if (s === 401 || s === 403) metrics.recordUpstream("auth"); // our key/permission is wrong
  else if (s >= 500) metrics.recordUpstream("server"); // provider degraded / overloaded
  else metrics.recordUpstream("other"); // rare masked status (405/409/…) — bucketed, never an unexplained residual
  const status = overloaded ? 529 : throttled ? 429 : 503;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) headers["retry-after"] = retryAfter;
  // We know the internal category even though the body stays sanitized: transient throttle/server/overload
  // retries; operator auth, billing, and unknown masked statuses do not. This avoids retry storms on permanent
  // operator failures without exposing which permanent condition occurred.
  const retryable = throttled || overloaded || (!billing && s >= 500);
  headers["x-should-retry"] = retryable ? "true" : "false";
  const code = overloaded ? "upstream_overloaded" : throttled ? "rate_limited" : "service_unavailable";
  const errorType = overloaded && provider.id === "anthropic" ? "overloaded_error" : undefined;
  return new Response(apiErrorBody(provider.id, status, code, undefined, errorType), { status, headers });
}

export type ProxyHandlerDeps = {
  // Provider configs — each present iff its key is set (proxy.ts). At least one is required: selectProviders
  // throws on an all-absent set and the root fails fast at boot. Absent → that provider's endpoints 404, so
  // the proxy runs any subset of the configured providers.
  anthropic?: {
    apiKey: string;
    baseUrl: string;
    version: string;
    estimateHold: HoldEstimator; // sizes the pre-flight hold; prod default is count_tokens, byte bound as fallback
  };
  openai?: {
    apiKey: string;
    baseUrl: string;
    estimateHold: HoldEstimator; // OpenAI's own hold estimator (count via /v1/responses/input_tokens, byte fallback)
  };
  // Tinfoil config — present iff TINFOIL_API_KEY is set. OpenAI-compatible; shares /v1/chat/completions with
  // OpenAI (the handler routes by model). No count_tokens endpoint → byte-bound hold.
  tinfoil?: {
    apiKey: string;
    baseUrl: string;
    estimateHold: HoldEstimator;
  };
  upstreamTimeoutMs: number;
  maxMessagesBodyBytes: number;
  balances: BalanceStore;
  // Output cap applied (and injected into the forwarded body) when a request OMITS one. 0/undefined =
  // require an explicit cap (max_tokens_required). Set it (DEFAULT_MAX_OUTPUT_TOKENS) so stock OpenAI clients
  // that don't send a cap work. Provider-agnostic.
  defaultMaxOutputTokens?: number;
  upstreamFetch: typeof fetch; // injectable so tests stub the upstream without a network
  // Global, identity-free throttle for this trust domain's unauthenticated READ endpoints (/balance, /v1/models):
  // no money gate + a DB read per call, so a flood is pure free work — cap the aggregate rate. Fail-safe, no
  // IP/token key (privacy thesis). Omitted = no limit (e.g. tests). Each process gets its OWN bucket, so the
  // two together must be retuned or aggregate read capacity doubles. The metered endpoints deliberately get
  // NO such bucket: the atomic hold already makes unfunded requests cost nothing.
  readRateLimit?: TokenBucket;
  // Registry of live streaming settle() callbacks — each stream adds itself for its lifetime and removes
  // itself the moment its billing finalizes (done/error/cancel). The root's shutdown handler drains this on
  // SIGTERM so a request still streaming at restart is reconciled instead of force-closed with its hold
  // un-reconciled. Idempotent, so a drain racing a natural settle is safe. Omitted in tests → throwaway set.
  inflight?: Set<(reason?: "drain") => void>;
  // Force-settle deadline (ms) for a streaming request whose client opens it but then neither reads nor
  // disconnects — none of done/error/cancel fire, so settle() would never run and the hold would leak until
  // restart. MUST be > upstreamTimeoutMs so a legit stream always finishes naturally first (the root enforces
  // this). Omitted in tests → defaults to upstreamTimeoutMs + 60s.
  streamSettleDeadlineMs?: number;
  // Injectable timer for the deadline above (so tests fire it deterministically, like shutdown.ts's clock).
  // Returns a canceller. Omitted → setTimeout/clearTimeout (unref'd so a pending deadline never blocks exit).
  scheduleStreamDeadline?: (onDeadline: () => void, ms: number) => () => void;
};

type StreamTerminalCause = "complete" | "upstream_error" | "client_cancel" | "deadline" | "shutdown_drain";
type StreamSettlementDecision =
  | { outcome: "served"; cost: number }
  | { outcome: "partial"; cost: number }
  | { outcome: "upstream_partial"; cost: number; evidence: UsageEvidence }
  | { outcome: "upstream_aborted"; cost: 0 }
  | { outcome: "shutdown_aborted"; cost: 0 }
  | { outcome: "unmetered_complete"; cost: 0 };

// Pure policy table for the terminal state of a 2xx stream. Charge an upstream-failed stream only when the
// scanner has evidence of delivered work: provider-reported incremental usage, or OpenAI's conservative
// input + visible-text estimate. With no such evidence the failure fully refunds. Caller-initiated/forced
// termination remains billable (the upstream already did the work); only a clean completion counts as served.
function decideStreamSettlement(input: {
  cause: StreamTerminalCause;
  metered: Metered;
  upstreamErrored: boolean;
  inputTokens: number;
  requestModel: string;
}): StreamSettlementDecision {
  const { cause, metered, upstreamErrored, inputTokens, requestModel } = input;
  const upstreamFailed = cause === "upstream_error" || upstreamErrored;
  if (metered) {
    const cost = priceUsage(metered.model, metered.usage, requestModel);
    if (upstreamFailed) return { outcome: "upstream_partial", cost, evidence: metered.evidence };
    return { outcome: cause === "complete" ? "served" : "partial", cost };
  }
  if (upstreamFailed) return { outcome: "upstream_aborted", cost: 0 };
  if (cause === "client_cancel" || cause === "deadline") {
    const cost = priceUsage(requestModel, {
      input_tokens: inputTokens,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }, requestModel);
    return { outcome: "partial", cost };
  }
  if (cause === "shutdown_drain") return { outcome: "shutdown_aborted", cost: 0 };
  return { outcome: "unmetered_complete", cost: 0 };
}

// Proxy trust-domain route dispatch. Returns undefined when the path isn't ours, so the combined test router
// (test/support/handler-combined.ts) can fall through to the payments trust domain routes. createProxyHandler wraps
// this with /healthz + the fail-closed 404.
export function buildProxyRoutes(d: ProxyHandlerDeps): (req: Request, url: URL) => Promise<Response> | undefined {
  const {
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    maxMessagesBodyBytes: MAX_MESSAGES_BODY_BYTES,
    balances,
    upstreamFetch,
    inflight = new Set<(reason?: "drain") => void>(),
    streamSettleDeadlineMs = UPSTREAM_TIMEOUT_MS + 60_000, // default sits above the upstream timeout
    scheduleStreamDeadline = (onDeadline, ms) => {
      const t = setTimeout(onDeadline, ms);
      t.unref?.(); // a pending deadline must never keep the process alive at shutdown
      return () => clearTimeout(t);
    },
  } = d;
  const { getBalance, openHold, settleHold } = balances;
  const defaultMaxOutput = d.defaultMaxOutputTokens ?? 0; // 0 = require an explicit output cap (strict)

  // Active upstream providers, resolved into an exact-path → Provider[] registry (providers/index.ts). Each is
  // registered iff its config was given (d.anthropic / d.openai / d.tinfoil), so a disabled provider's endpoints 404;
  // selectProviders requires at least one. Passed straight through — each provider closes over its own creds.
  const PROVIDERS = selectProviders({ anthropic: d.anthropic, openai: d.openai, tinfoil: d.tinfoil });
  // Every active provider, flattened across paths — the source of both the provider-id set and the served-
  // model catalog below.
  const ACTIVE_PROVIDERS = [...PROVIDERS.values()].flat();
  // Every registered provider id (anthropic / openai / …) — used to tell a `provider/model` namespace prefix
  // from a bare model id (which may itself contain a slash, e.g. an org/model open-weight id).
  const KNOWN_PROVIDER_IDS = new Set<string>(ACTIVE_PROVIDERS.map((p) => p.id));
  // The GET /v1/models catalog: every priced model an ACTIVE provider owns — the SAME ownsModel gate the
  // metered path applies, so a listed id is exactly one that won't 400 unsupported_model (a claude-* on an
  // Anthropic-less instance, or an off-card variant, is absent). Computed once: price book + provider set are
  // both fixed from boot.
  const SERVED_MODELS = pricedModels().filter((m) => ACTIVE_PROVIDERS.some((p) => p.ownsModel(m.id)));
  // Exact-path lookup (Map.get is exact — no prefix readmit of subpaths like /v1/messages/batches); an
  // unknown path or a disabled provider misses → the fail-closed 404 in handle(). A path may carry more than
  // one provider (OpenAI + Tinfoil on /v1/chat/completions); handleMetered resolves the one a request means.
  const providersForPath = (pathname: string): Provider[] | undefined => PROVIDERS.get(pathname);

  // This trust domain's own (non-metered) endpoints — /balance + /v1/models — built over the balance store + the
  // served-model catalog. Each is `(req) => Promise<Response>`; the dispatcher below routes to them. The
  // metered money path (handleMetered) stays here in the handler.
  const endpoints = makeProxyEndpoints({
    servedModels: SERVED_MODELS,
    getBalance,
    readRateLimit: d.readRateLimit,
  });

  // --- Shared money skeleton. Gate (reject before any spend) → size + atomically debit the hold →
  // forward with our injected key → reconcile to the real metered cost (clamped at the hold so a refund
  // is never negative, enforcing the no-overdraft invariant). Provider-agnostic: every per-API-shape
  // difference is read off `provider`. ---
  async function handleMetered(candidates: Provider[], req: Request, url: URL): Promise<Response> {
    // Pre-resolution errors (size / auth / parse) use a representative provider's error envelope: every
    // provider sharing a path speaks the same wire shape and reads the proxy token the same way, so any of
    // them shapes these identically. The request-specific provider is resolved from the model below.
    const representative = candidates[0]!;
    // Bound the body before buffering (DoS): the content-length header check rejects bodies that DECLARE
    // an oversized length before the balance check. Chunked uploads (no content-length) bypass this and
    // are bounded instead by Bun's maxRequestBodySize backstop (proxy.ts). Cap matches the upstream ceiling.
    if (Number(req.headers.get("content-length") ?? 0) > MAX_MESSAGES_BODY_BYTES) {
      metrics.recordGate("request");
      return denyApi(representative, 413, "payload_too_large");
    }

    // Two header-only sheds run BEFORE we buffer/parse the (up to 32 MiB) body, so neither an unauthenticated
    // nor an unknown-token flood ever reaches the buffer:
    //   1. NO token at all → 401 (the token is a header, so this needs no body).
    //   2. a PRESENT but unknown token → 401: every made-up/junk string is "not in the DB", so hashing it and
    //      checking getBalance here sheds the whole free, unfunded flood class before a single byte is buffered.
    // A present, FUNDED token buffers and bills exactly as before; a real-but-broke token (balance <= 0) is
    // still gated AFTER the body checks below — it is a paid token, not the free abuse vector. We authenticate
    // against this token, never forward it, and inject the real key below.
    const token = representative.readToken(req);
    if (!token) { metrics.recordGate("auth"); return denyApi(representative, 401, NO_API_KEY.code, NO_API_KEY.message); }
    const hash = hashToken(token);
    if (getBalance(hash) === null) { metrics.recordGate("auth"); return denyApi(representative, 401, "invalid_token"); }

    // Buffer and parse — the source of truth for billing. Reject anything we can't price at our flat
    // rates, constraining the request to the standard pricing regime before a cent is spent.
    const raw = await req.text();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      metrics.recordGate("request");
      return denyApi(representative, 400, "invalid_json");
    }
    // Streaming: pass SSE bytes through untouched, metering usage off the same stream (below). The
    // up-front hold gates admission either way, so this only affects how the response is reconciled.
    const streaming = body?.stream === true;

    // Resolve which provider on this path serves the request, by model. A model may be namespaced
    // `provider/model` for explicit selection; a bare id resolves to its unique owner among the path's
    // providers (an overlap of the same id needs the prefix, else it's ambiguous). The prefix is stripped
    // before forwarding so the upstream sees its native id.
    const rawModel: string | null = typeof body?.model === "string" ? body.model : null;
    if (!rawModel) { metrics.recordGate("model"); return denyApi(representative, 400, "unsupported_model"); }
    // Resolve which provider on this path serves the request, by model — native id first, then a
    // `provider/model` namespace prefix (see providers/resolveProvider). The error envelope rides the
    // representative (every provider on a path shares the wire shape).
    const resolved = resolveProvider(candidates, rawModel, KNOWN_PROVIDER_IDS);
    if (!resolved.ok) { metrics.recordGate("model"); return denyApi(representative, 400, resolved.error); }
    const provider = resolved.provider;
    const model = resolved.model;
    // Forward with the prefix stripped — body is rebuilt ONLY when a prefix was present, so the common
    // (bare/native) path still forwards the exact original bytes. body.model is normalized so the hold
    // estimator/count call and prepareBody all see the native id.
    if (resolved.prefixed) body.model = model;
    const effectiveRaw = resolved.prefixed ? JSON.stringify(body) : raw;

    // premiumReject runs AFTER resolution by necessity — the gate is provider-specific, so it needs the
    // resolved provider. A request both unsupported-model and premium-violating is rejected as
    // unsupported_model first; both are terminal pre-spend 400s, so the order is immaterial to the caller.
    const rej = provider.premiumReject(body);
    if (rej) { metrics.recordGate("premium"); return denyApi(provider, rej.status, rej.error); }
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
    const { micros: holdAmount, inputTokens, inputTokensSource } = await provider.estimateHold({
      model,
      raw: effectiveRaw,
      body,
      maxTokens,
      countHeaders: clientBeta ? { "anthropic-beta": clientBeta } : undefined,
    });
    // Admission and settlement deliberately use different quantities. The hold keeps the estimator's sound
    // byte upper bound; every fallback charge uses a count result or bytes/4 estimate. A reservation ceiling
    // is never allowed to cross into usage accounting.
    const billableInputTokens = inputTokensSource === "counted" ? inputTokens : Math.ceil(inputTokens / 4);
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
      const effectiveDebit = Math.min(cost, holdAmount);
      settleHold(holdId, hash, holdAmount - effectiveDebit);
      return effectiveDebit;
    };

    // A provider-count result is suitable for an accepted-request input floor. The byte-bound fallback is
    // intentionally a worst-case reservation ceiling, not usage, so discount it to the conventional bytes/4
    // estimate when an upstream-caused buffered read failure leaves no terminal usage object.
    const acceptedInputFloor = () => priceUsage(model, {
      input_tokens: billableInputTokens,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }, model);

    // Past this point the hold is debited — every synchronous exit path refunds via billActual; the streaming
    // path defers refund to settle() on the response stream's done/error/cancel callback (see below).
    let bufferedReadFailedAfterOk = false;
    try {
      const headers = buildUpstreamHeaders(provider, req);
      // Inject the cap only when the client omitted one (clientCap == null) — i.e. the default supplied it.
      const sendBody = provider.prepareBody(effectiveRaw, body, streaming, clientCap == null ? maxTokens : undefined);

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
          return relayOrSanitizeUpstream(provider, upstream, await upstream.text());
        }
        // `served` is NOT counted here — a 2xx SSE envelope is not yet a clean bill. settle() (below) counts the
        // terminal outcome exactly once: completed, billable partial, aborted/refunded, or metering anomaly.
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const scan = provider.makeScanner({ model, inputTokens: billableInputTokens });
        let settled = false;
        // Mark caller/timeout termination BEFORE cancelling upstream. reader.cancel() can wake an in-flight
        // read as `done`; the done path consults this marker so that race cannot masquerade as a clean end.
        let requestedCause: "client_cancel" | "deadline" | "shutdown_drain" | null = null;
        // Captured in the stream's start() so the force-settle deadline below can terminate the client's
        // stream even when the client is the one stalling (a backpressured pull won't observe a close itself).
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let cancelDeadline: (() => void) | undefined; // clears the force-settle timer; assigned after inflight.add
        const settle = (reason: StreamTerminalCause | "drain" = "complete") => {
          if (settled) return; // at-most-once (idempotent); exactly-once in the normal done/error/cancel flows
          settled = true;
          inflight.delete(settle); // billing finalized (naturally, or drained on shutdown) — stop tracking
          cancelDeadline?.(); // every natural exit (done/error/cancel/drain) clears the force-settle timer here
          const cause = reason === "drain" ? "shutdown_drain" : reason;
          if (reason === "drain") {
            // Billing settlement alone does not stop the fetch body's blocked read. During a service restart,
            // that previously left server.stop(true) waiting for UPSTREAM_TIMEOUT_MS (normally 10 minutes)
            // until systemd killed the process at TimeoutStopSec. Cancel generation and end the downstream
            // body as part of the same idempotent drain action so shutdown finishes on our 25-second schedule.
            requestedCause = "shutdown_drain"; // mark before cancel wakes a racing reader.read()
            reader.cancel("shutdown_drain").catch(() => {});
            try {
              // Supplying an Error here makes Bun print an application stack trace for this expected
              // shutdown path. An omitted reason still aborts the body immediately, without the false alarm.
              streamController?.error();
            } catch {
              /* stream already closed/errored — nothing to terminate */
            }
          }
          const upstreamFailed = cause === "upstream_error" || scan.errored();
          const metered = scan.result(upstreamFailed || cause === "shutdown_drain" ? "evidenced_only" : undefined);
          const decision = decideStreamSettlement({
            cause,
            metered,
            upstreamErrored: scan.errored(),
            inputTokens: billableInputTokens,
            requestModel: model,
          });
          switch (decision.outcome) {
            case "served":
              metrics.recordServed();
              billActual(decision.cost);
              break;
            case "partial":
              metrics.recordServedPartial();
              billActual(decision.cost);
              break;
            case "upstream_partial":
              log.warn("upstream", `stream aborted mid-flight (${provider.upstreamPath}) — billed metered partial`);
              metrics.recordServedPartial();
              metrics.recordFailure(
                decision.evidence === "reported" ? "streamReported" : "streamEstimated",
                billActual(decision.cost),
              );
              break;
            case "shutdown_aborted":
              // Expected at restart before any usage frame: routine, silent, fully refunded.
              metrics.recordStreamAborted();
              billActual(0);
              break;
            case "upstream_aborted":
              log.warn("upstream", `stream aborted mid-flight (${provider.upstreamPath}) — no usage evidence, refunded`);
              metrics.recordFailure("streamRefunded");
              metrics.recordStreamAborted();
              billActual(0);
              break;
            case "unmetered_complete":
              // Clean end, NO parseable usage: delivered a 2xx stream and metered nothing — genuine
              // served-but-unbilled money leak, and the only streaming case that should page.
              log.error("bill", `streamed ${provider.upstreamPath} without parseable usage — refunded in full`);
              metrics.recordBill("refundedInFull");
              billActual(0);
              break;
          }
        };
        // Track this live stream so a SIGTERM can finalize its billing before force-close (proxy.ts shutdown).
        inflight.add(settle);
        metrics.observeStreams(inflight.size); // high-water concurrent live streams

        // Force-settle deadline. settle() above fires only on the stream's done, a read error, or a client
        // cancel — all of which need the client to be READING or to disconnect. A client that opens the
        // stream and then holds the socket open without reading triggers none of them, so the hold would leak
        // (balance debited, never reconciled, provider already paid for what generated) until the process
        // restarts. This timer closes that: stop upstream spend, bill the metered partial (treated as a
        // disconnect → a no-usage-yet stream pays the billable input estimate, never the reservation), and
        // end the client stream. Set strictly ABOVE upstreamTimeoutMs (proxy.ts), so a legit stream always reaches
        // done/error first and this never fires for it; settle() clears it on every natural exit.
        cancelDeadline = scheduleStreamDeadline(() => {
          requestedCause = "deadline"; // set before cancel so a racing done-pull cannot settle as complete
          reader.cancel("stream_settle_deadline").catch(() => {}); // stop generation → stop paying the provider
          settle("deadline");
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
                settle(requestedCause ?? "complete");
                controller.close();
                return;
              }
              scan.feed(decoder.decode(value, { stream: true }));
              controller.enqueue(value);
            } catch (err) {
              // reader.cancel() may reject a pending read; when we initiated that cancel, preserve its already-
              // marked client/deadline cause. With no local termination pending, this is a genuine transport error.
              settle(requestedCause ?? "upstream_error");
              controller.error(err);
            }
          },
          async cancel(reason) {
            // Mark FIRST so a racing done-pull woken by reader.cancel() bills a partial, never a clean serve.
            requestedCause = "client_cancel";
            await reader.cancel(reason).catch(() => {});
            settle("client_cancel");
          },
        });

        return new Response(out, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: scrubRespHeaders(upstream),
        });
      }

      let text: string;
      try {
        text = await upstream.text();
      } catch (err) {
        // Headers committed a 2xx, so the provider accepted and began the request. The caller receives no
        // partial buffered body, but charging a conservative input-only floor avoids making nullsink absorb
        // all accepted prompt work. A non-2xx read failure remains fully refunded.
        bufferedReadFailedAfterOk = upstream.ok;
        throw err;
      }

      // Reconcile. A 2xx with parseable usage is billed (refunding hold − actual); a 2xx without usage
      // refunds in full and relays as-is. A non-OK upstream refunds in full, then relayOrSanitizeUpstream
      // decides whether to relay it (user-fixable) or synthesize a safe error; see its note.
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
      return relayOrSanitizeUpstream(provider, upstream, text);
    } catch (err) {
      if (bufferedReadFailedAfterOk) {
        const inputFloor = acceptedInputFloor();
        metrics.recordFailure("bufferedInputFloor", billActual(inputFloor));
      } else {
        billActual(0); // no accepted buffered work to substantiate — refund in full
      }
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      metrics.recordUpstream(timedOut ? "timeout" : "unreachable"); // transport-failure trend (distinct from a returned non-2xx)
      // Client-visible and either refunded or input-floor billed → WARN, not ERROR.
      log.warn(
        "upstream",
        bufferedReadFailedAfterOk
          ? `response body interrupted after 2xx — billed input floor: ${log.errMsg(err)}`
          : timedOut ? "request timed out" : `unreachable: ${log.errMsg(err)}`,
      );
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

  // Dispatch only the PROXY TRUST DOMAIN paths. undefined = "not mine" (the combined router then tries the
  // payments trust domain routes; createProxyHandler turns it into the fail-closed 404).
  return function proxyRoutes(req: Request, url: URL): Promise<Response> | undefined {
    // This trust domain's free read: a token holder checks their own balance.
    if (req.method === "GET" && url.pathname === "/balance") return endpoints.balance(req);
    // The one /v1 path that's a free read, not a metered forward: the served-model catalog. Matched here (a
    // GET) before the POST-only metered routing below, so it never reaches handleMetered.
    if (req.method === "GET" && url.pathname === "/v1/models") return endpoints.models(req);

    // Metered endpoints: route by EXACT path to the provider that owns that API shape (Anthropic Messages
    // today; OpenAI added behind the same seam). Only these paths spend upstream — the up-front hold makes
    // each yield no free usage. Anything unmatched (other methods, batches/files, any endpoint Anthropic or
    // OpenAI add later) falls through to the fail-closed 404; a prefix match would readmit subpaths.
    const candidates = req.method === "POST" ? providersForPath(url.pathname) : undefined;
    if (candidates) return handleMetered(candidates, req, url);

    return undefined;
  };
}

// The proxy service's HTTP handler: proxy trust domain routes + /healthz, fail-closed 404 on anything else.
// proxy.ts wires this to Bun.serve.
export function createProxyHandler(d: ProxyHandlerDeps): (req: Request) => Promise<Response> {
  const routes = buildProxyRoutes(d);
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Local-only liveness check; never forwarded upstream. Unauthenticated.
    if (url.pathname === "/healthz") return new Response(`ok ${BUILD_VERSION}`);
    return (await routes(req, url)) ?? deny(404, "unsupported_endpoint");
  };
}
