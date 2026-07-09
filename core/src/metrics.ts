// Aggregate, identity-free operational counters — the "are we serving, and are we nearing a ceiling?"
// signal. Like log.ts, this is a process-global, in-memory module (NO per-request record, no identity, reset
// on restart, nothing persisted). It holds only aggregate COUNTS + high-water marks, flushed to one [metrics]
// journald line on a coarse cadence and on shutdown (each composition root), then the window resets. Families:
//
//   bill.*     — money-safety anomalies on the metered path (handler.ts). Each is ALSO logged per-event at
//     ERROR there (and paged by deploy/status-check.sh); these are the trend behind that page.
//       refundedInFull  a 2xx / stream carried NO parseable usage, so real usage was served and billed
//                       NOTHING — the one event log.ts says to alert on. A spike = a metering break.
//       holdExceeded    actual cost priced ABOVE the up-front hold; the refund was clamped to 0 (no
//                       overdraft). Sound by construction, but a spike means the hold is mis-sized.
//   upstream.* — every reason a forwarded request came back non-2xx (i.e. the served↔req gap), BY CAUSE,
//     classified in handler.ts relayOrMaskUpstream + the transport catch. Level is per-member, not a
//     family-wide rule: the our/provider-side causes below pair with a per-event log → WARN; relayed4xx is
//     the CLIENT's own request error → routine INFO (no per-event log — a 4xx body can echo the prompt).
//       throttle    a GENUINE HTTP 429 rate limit — the ceiling tripwire (NOT an out-of-funds 429)
//       server      5xx / overloaded — provider degraded
//       auth        401/403 — OUR key/permission is wrong (operator must fix)
//       billing     out-of-funds (the upstream wore 400/402/429; we mask to 503) — top up the account
//       timeout     the upstream call hit our wall-clock cap (504) — often a long generation, not an outage
//       unreachable a transport failure reaching the upstream (502) — DNS/connection/TLS down
//       relayed4xx  a user-fixable 400/422/413 passed back verbatim — the CLIENT's request error (not
//                   ours, not the provider's). Routine INFO, not a problem: no operator action, it just
//                   itemizes the gap. (Emitted as `upstream:4xx`, keeping the family's label prefix.)
//       notfound    the provider rejected the MODEL (Anthropic 404 / OpenAI 404|400) — the CLIENT's bad or
//                   unsupported model, returned as our `unsupported_model`. Routine INFO, like relayed4xx.
//                   Emitted as `upstream:notfound`.
//       other       a masked non-2xx that is none of the buckets above (a rare 405/409/…) — our/provider
//                   side, masked to 503. WARN. Emitted as `upstream:other`. With notfound + other, EVERY
//                   forwarded non-2xx is now bucketed, so served + Σ upstream.* = req (the gap reconciles).
//   reject.*   — LOCAL shedding WE did, before/without an upstream call (our own limits, not the vendor):
//       buy       /buy global rate-limit 429
//       read      /balance + /order-status + /rails read-throttle 429
//       orders    MAX_OPEN_ORDERS "busy_try_later" 503
//   gate.*     — metered requests REJECTED before we forwarded upstream (so NOT in `requests`/`served`). All
//     client-caused + expected, so counter-only (no per-event log) and routine INFO — but a spike is visible
//     (e.g. `gate:auth=5000` = an unauthenticated/bad-token flood the door shed cheaply). Emitted as `gate:*`.
//       auth      401 — no token, or a token we don't recognise (incl. the openHold race-loss)
//       request   400/413 — the residual malformed-request kinds: invalid_json / max_tokens_required / payload_too_large
//       model     400 — unsupported_model: client asked for a model we don't serve (demand/config signal; cf. upstream:notfound)
//       premium   400 — a premium feature we don't price (inference_geo / server tools / web_search / service_tier / n>1) —
//                       carved out of `request` because the demand for unsupported features is an operator/product signal
//       funds     402 — insufficient_balance (pre-check or openHold race-loss)
//   requests / served — metered traffic volume: `requests` = requests we FORWARDED upstream (post-gates);
//     `served` = those we forwarded AND billed cleanly (a 2xx we metered actual usage on). served ≤ requests
//     always; the gap is the forwarded requests that did NOT bill clean — upstream.* failures, relayed 4xx,
//     and the streaming-success outcomes below (servedPartial + streamAborted + the bill.refundedInFull leak).
//     Every forwarded request lands in exactly one of these, so they reconcile:
//       requests = served + servedPartial + streamAborted + bill.refundedInFull + Σ upstream.*
//     The per-window `served=N req=M` heartbeat makes "successful serving silently stopped" (served → 0 while
//     the box is still up) VISIBLE — the one drop /healthz can't.
//   servedPartial / streamAborted — the streamed-request outcomes that aren't a clean bill (so NOT in served):
//       servedPartial   the client disconnected after we'd forwarded the prompt → billed an INPUT-FLOOR only
//                       (the upstream already ingested + charged us for the prompt; no output yet). ROUTINE —
//                       real, bounded billing. Emitted `stream:partial`. NOTE: Anthropic-granularity — the
//                       OpenAI scanner folds a mid-stream disconnect into its normal usage result, so an OpenAI
//                       partial bills via the clean path and counts as `served`, not here (cost/usage/openai.ts).
//       streamAborted   a 2xx SSE that never reached a clean bill: the upstream errored mid-flight, or we
//                       drained the stream at shutdown → refunded in full. ROUTINE (the client got an error or
//                       nothing, not billable content) — NOT the money leak (that's bill.refundedInFull, which
//                       pages). Emitted `stream:aborted`.
//   peakStreams / peakOpenOrders — high-water marks for concurrent live streams and open payment orders, so
//     saturation toward the in-flight ceilings is visible before it bites.
//   recoveredHolds — how many stranded holds boot recoverHolds() refunded at startup (a crash/SIGKILL between
//     debit and settle leaves them; db.ts). A boot-point money-movement gauge: non-zero only in the first
//     window after an UNgraceful restart, behind the existing [boot] WARN. ROUTINE. Emitted `recovered:holds`.
//
// All aggregate, no identity. More counters extend this the same way.

export type UpstreamKind = "throttle" | "server" | "auth" | "billing" | "timeout" | "unreachable" | "relayed4xx" | "notfound" | "other";
export type RejectKind = "buy" | "read" | "orders";
export type BillKind = "refundedInFull" | "holdExceeded";
export type GateKind = "auth" | "request" | "model" | "premium" | "funds";

const upstream = { throttle: 0, server: 0, auth: 0, billing: 0, timeout: 0, unreachable: 0, relayed4xx: 0, notfound: 0, other: 0 };
const reject = { buy: 0, read: 0, orders: 0 };
const bill = { refundedInFull: 0, holdExceeded: 0 };
const gate = { auth: 0, request: 0, model: 0, premium: 0, funds: 0 }; // metered requests shed at a pre-forward gate (NOT in requests/served)
let requests = 0; // metered requests forwarded upstream (post-gates)
let served = 0; // of those, the ones we billed cleanly (a 2xx we metered actual usage on)
let servedPartial = 0; // streamed, client disconnected post-forward → billed input-floor only (Anthropic-granularity)
let streamAborted = 0; // streamed 2xx that never cleanly billed — mid-flight upstream error, or shutdown drain → refunded
let peakStreams = 0;
let peakOpenOrders = 0;
let recoveredHolds = 0; // stranded holds boot recoverHolds() refunded (ungraceful restart) — boot-point money gauge
let windowStart = 0;

// One non-clean upstream outcome, already classified by the caller (handler.ts relayOrMaskUpstream / catch).
export function recordUpstream(kind: UpstreamKind): void {
  upstream[kind] += 1;
}

// One LOCAL rejection we issued (our own rate limit / capacity cap — handler.ts).
export function recordReject(kind: RejectKind): void {
  reject[kind] += 1;
}

// One money-safety anomaly on the metered path (handler.ts billActual / reconcile). The per-event ERROR log
// stays the immediate pager; this is the trend.
export function recordBill(kind: BillKind): void {
  bill[kind] += 1;
}

// One metered request REJECTED at a pre-forward gate (handler.ts denyApi sites). Client-caused + counter-only.
export function recordGate(kind: GateKind): void {
  gate[kind] += 1;
}

// One metered request forwarded upstream (handler.ts, just before the upstream fetch).
export function recordRequest(): void {
  requests += 1;
}

// One forwarded request we billed cleanly: a 2xx we metered actual usage on (handler.ts, buffered + streaming).
export function recordServed(): void {
  served += 1;
}

// One streamed request the client disconnected on after we'd forwarded the prompt → billed an input-floor only
// (handler.ts settle, the clientDisconnected branch). Real bounded billing, so NOT a clean `served`, NOT a leak.
export function recordServedPartial(): void {
  servedPartial += 1;
}

// One streamed 2xx that never reached a clean bill — upstream errored mid-flight, or we drained it at shutdown →
// refunded in full (handler.ts settle, the drain/aborted branches). Routine; NOT the bill.refundedInFull leak.
export function recordStreamAborted(): void {
  streamAborted += 1;
}

// High-water observers: keep the max seen this window. Cheap; called at the moment the level changes (a new
// live stream registers; a new payment order is created — the open count only rises there).
export function observeStreams(n: number): void {
  if (n > peakStreams) peakStreams = n;
}
export function observeOpenOrders(n: number): void {
  if (n > peakOpenOrders) peakOpenOrders = n;
}

// Boot-time: the count of stranded holds recoverHolds() refunded at startup (proxy.ts, once per start). Adds (not
// sets) so the boot event survives into whatever window is open; a clean restart records nothing.
export function recordRecoveredHolds(n: number): void {
  recoveredHolds += n;
}

// One window's aggregate counts + peaks, as returned by snapshot() and consumed by formatMetricsLine.
export type MetricsSnapshot = {
  upstream: { throttle: number; server: number; auth: number; billing: number; timeout: number; unreachable: number; relayed4xx: number; notfound: number; other: number };
  reject: { buy: number; read: number; orders: number };
  bill: { refundedInFull: number; holdExceeded: number };
  gate: { auth: number; request: number; model: number; premium: number; funds: number };
  requests: number;
  served: number;
  servedPartial: number;
  streamAborted: number;
  peakStreams: number;
  peakOpenOrders: number;
  recoveredHolds: number;
  windowStart: number;
};

// Point-in-time read for the periodic / shutdown flush. Pure (no reset); returns copies so a caller can't
// mutate the live counters.
export function snapshot(): MetricsSnapshot {
  return { upstream: { ...upstream }, reject: { ...reject }, bill: { ...bill }, gate: { ...gate }, requests, served, servedPartial, streamAborted, peakStreams, peakOpenOrders, recoveredHolds, windowStart };
}

// Format a snapshot into the single [metrics] journald line + its level, or null when nothing happened (so
// the flush never spams). PURE — extracted from the pre-split root's flushMetrics so the WARN-vs-INFO precedence is
// unit-testable without a logger or timers. Problem signals (money anomalies + upstream errors + local
// rejects) are notable → WARN, so `journalctl -p warning` stays problem-only; the served/req heartbeat +
// peaks (and relayed user 4xx — a client error, not ours) are routine → INFO, and ride along on the WARN
// line for context when a problem IS present. bill.* sorts first — it's the money-safety signal. `nowMs`
// is injected (clock-free).
export function formatMetricsLine(m: MetricsSnapshot, nowMs: number): { level: "warn" | "info"; line: string } | null {
  const problems: string[] = [];
  if (m.bill.refundedInFull) problems.push(`bill:refunded=${m.bill.refundedInFull}`);
  if (m.bill.holdExceeded) problems.push(`bill:holdexceeded=${m.bill.holdExceeded}`);
  if (m.upstream.throttle) problems.push(`upstream:throttle=${m.upstream.throttle}`);
  if (m.upstream.server) problems.push(`upstream:5xx=${m.upstream.server}`);
  if (m.upstream.auth) problems.push(`upstream:auth=${m.upstream.auth}`);
  if (m.upstream.billing) problems.push(`upstream:billing=${m.upstream.billing}`);
  if (m.upstream.timeout) problems.push(`upstream:timeout=${m.upstream.timeout}`);
  if (m.upstream.unreachable) problems.push(`upstream:unreachable=${m.upstream.unreachable}`);
  if (m.upstream.other) problems.push(`upstream:other=${m.upstream.other}`); // a rare masked 405/409/… — our/provider side
  if (m.reject.buy) problems.push(`reject:buy=${m.reject.buy}`);
  if (m.reject.read) problems.push(`reject:read=${m.reject.read}`);
  if (m.reject.orders) problems.push(`reject:orders=${m.reject.orders}`);
  // Routine heartbeat: any window that forwarded metered traffic emits `served=N req=M`, so a drop to
  // served=0 (the box up but serving nothing) is visible in the journal, not just inferable from silence.
  const routine: string[] = [];
  if (m.requests) routine.push(`served=${m.served}`, `req=${m.requests}`);
  // The streamed-success outcomes that aren't a clean bill, itemizing their slice of the served↔req gap. Both
  // are routine: a partial is real bounded billing, an abort is a refund — neither is an operator problem (the
  // streamed money LEAK is bill:refunded, in the problem segment above).
  if (m.servedPartial) routine.push(`stream:partial=${m.servedPartial}`);
  if (m.streamAborted) routine.push(`stream:aborted=${m.streamAborted}`);
  // Relayed user 4xx rides here (right after served/req), itemizing the gap — a client error, not an
  // operator-actionable problem, so it never flips the line to WARN on its own.
  if (m.upstream.relayed4xx) routine.push(`upstream:4xx=${m.upstream.relayed4xx}`);
  // Model-not-found rides here too — the client's bad model, returned as unsupported_model; not our problem.
  if (m.upstream.notfound) routine.push(`upstream:notfound=${m.upstream.notfound}`);
  // Pre-forward gate rejections (client-caused, never forwarded) — counter-only, routine; a spike (e.g. an
  // unauthenticated flood) stays visible without per-event spam.
  if (m.gate.auth) routine.push(`gate:auth=${m.gate.auth}`);
  if (m.gate.request) routine.push(`gate:request=${m.gate.request}`);
  if (m.gate.model) routine.push(`gate:model=${m.gate.model}`); // client asked for a model we don't serve
  if (m.gate.premium) routine.push(`gate:premium=${m.gate.premium}`); // demand for a premium feature we don't price
  if (m.gate.funds) routine.push(`gate:funds=${m.gate.funds}`);
  if (m.peakStreams) routine.push(`peak:streams=${m.peakStreams}`);
  if (m.peakOpenOrders) routine.push(`peak:orders=${m.peakOpenOrders}`);
  // Boot-point gauge: stranded holds the last (ungraceful) restart refunded. Non-zero only in the first window
  // after a rough restart; the actionable signal is the [boot] WARN, this is the cross-restart trend.
  if (m.recoveredHolds) routine.push(`recovered:holds=${m.recoveredHolds}`);
  const mins = Math.max(1, Math.round((nowMs - m.windowStart) / 60_000));
  if (problems.length > 0) return { level: "warn", line: `${[...problems, ...routine].join(" ")} (last ${mins}m)` };
  if (routine.length > 0) return { level: "info", line: `${routine.join(" ")} (last ${mins}m)` };
  return null;
}

// Start a fresh window: zero every counter / peak and stamp the start. `nowMs` is injected (each composition root passes
// Date.now()) so this module stays clock-free and unit-testable.
export function reset(nowMs: number): void {
  upstream.throttle = upstream.server = upstream.auth = upstream.billing = upstream.timeout = upstream.unreachable = upstream.relayed4xx = upstream.notfound = upstream.other = 0;
  reject.buy = reject.read = reject.orders = 0;
  bill.refundedInFull = bill.holdExceeded = 0;
  gate.auth = gate.request = gate.model = gate.premium = gate.funds = 0;
  requests = 0;
  served = 0;
  servedPartial = 0;
  streamAborted = 0;
  peakStreams = 0;
  peakOpenOrders = 0;
  recoveredHolds = 0;
  windowStart = nowMs;
}
