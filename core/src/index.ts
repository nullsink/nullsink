// Bootstrap / composition root. All side effects live here — env validation, SQLite stores, port bind,
// settlement timer, signal handlers. Request logic is in handler.ts, settlement in settle.ts; both are
// pure/injectable and import-safe (importing them binds no port, starts no timer), which makes them
// testable and reusable.
import { openDb, DB_PATH } from "./ledger/db";
import { openOrderStore, PENDING_DB_PATH } from "./ledger/orders";
import { createHandler, type RailView } from "./handler";
import { makeOrderStatus } from "./ledger/orderstatus";
import { byteBoundHold, makeCountTokensHold, ANTHROPIC_COUNT_OMIT, OPENAI_COUNT_OMIT } from "./hold";
import { settle } from "./ledger/settle";
import { drainCreditOutbox } from "./ledger/drain";
import { selectRails, type PayRail } from "./rails";
import type { Incoming } from "./rails/types";
import { makeTokenBucket } from "./ratelimit";
import { drainInflight } from "./shutdown";
import { numEnv } from "./env";
import { classifyPollOutcome } from "./ledger/poll";
import * as log from "./log";
import * as metrics from "./metrics";
import { BUILD_VERSION } from "./version";
import { DEFAULT_MARGIN } from "./pricing-config";

const PORT = numEnv("PORT", 8080, 1, 65535);
// Bind address. Defaults to 127.0.0.1 (safe by default): the app must NEVER face the open net — Caddy
// fronts it and reverse-proxies to localhost. Override with HOST=0.0.0.0 only for local dev. A
// missing/typo'd env now fails private, not public.
const HOST = process.env.HOST ?? "127.0.0.1";
// Total wall-clock cap on the upstream call (reaps hung/stalled connections). Matches the Anthropic
// SDK's ~10min default; raise it if long generations get cut.
const UPSTREAM_TIMEOUT_MS = numEnv("UPSTREAM_TIMEOUT_MS", 600_000, 1000, 3_600_000);
// Force-settle deadline for a stream the client opens but never reads/closes — none of done/error/cancel
// fire, so settle() never runs and the hold leaks until restart (handler.ts). Min is UPSTREAM_TIMEOUT_MS + 1
// so it always sits above the upstream timeout: a legit stream finishes (or upstream aborts) first, so this
// only reaps a non-reading straggler.
const STREAM_SETTLE_DEADLINE_MS = numEnv("STREAM_SETTLE_DEADLINE_MS", UPSTREAM_TIMEOUT_MS + 60_000, UPSTREAM_TIMEOUT_MS + 1, 7_200_000);
// Pre-flight hold sizing. "count_tokens" (default) asks Anthropic for the exact input-token count so the
// hold isn't grossly over-reserved (byte bound is ~62× loose on base64 images, ~7× on ASCII), failing
// safe to the byte bound on any error. "byte" forces the deterministic no-extra-call bound (provider
// without count_tokens, or to avoid the round-trip). Either is sound.
const HOLD_ESTIMATOR = process.env.HOLD_ESTIMATOR ?? "count_tokens";
const COUNT_TOKENS_TIMEOUT_MS = numEnv("COUNT_TOKENS_TIMEOUT_MS", 10_000, 100, 600_000);

// Buy-rail margin: our cut, applied at credit time (credit < paid), like cli/issue.ts.
const MARGIN = numEnv("MARGIN", DEFAULT_MARGIN, 1, 100);
const BUY_MIN_USD = numEnv("BUY_MIN_USD", 2, 0.01, 1_000_000);
const BUY_MAX_USD = numEnv("BUY_MAX_USD", 2000, BUY_MIN_USD, 1_000_000);
const POLL_INTERVAL_MS = numEnv("POLL_INTERVAL_MS", 30_000, 1000, 3_600_000);
// Consecutive FAILED poll ticks for one rail before we escalate from a per-tick warn to an alertable ERROR
// marker ("POLL BLIND"). A single miss is a normal transient (Tor/node flake, retried next tick); a streak
// means that rail's deposit detection is DOWN. At ~POLL_INTERVAL_MS apart, 5 ≈ minutes — fast to page, slow
// to false-alarm. deploy/status-check.sh greps the marker.
const POLL_FAIL_ALERT = numEnv("POLL_FAIL_ALERT", 5, 1, 1000);
// Global in-flight ceiling (no IP tracking — privacy). Bounds total open orders, hence addresses
// created and rows watched. The only order cap; a per-token cap was removed
// (a flood mints fresh hashes for free, so it protected nothing).
const MAX_OPEN_ORDERS = numEnv("MAX_OPEN_ORDERS", 1000, 1, 10_000_000);
// Body-size caps (DoS): /buy is tiny; /v1/messages matches the upstreams' own request ceiling. Anthropic's
// 32 MB limit is binary MiB, so default = 32 MiB = 33_554_432 (not decimal 32_000_000, ~1.5 MB
// tighter) — matching their ceiling avoids 413-ing a body upstream would accept; a larger cap only buffers
// bytes upstream rejects anyway.
const MAX_BUY_BODY_BYTES = numEnv("MAX_BUY_BODY_BYTES", 4096, 64, 1_048_576);
const MAX_MESSAGES_BODY_BYTES = numEnv("MAX_MESSAGES_BODY_BYTES", 33_554_432, 1024, 1_000_000_000);
// Output cap applied (and injected into the forwarded request) when a client OMITS one — so stock OpenAI
// clients that omit a cap still work (Anthropic requires max_tokens, moot there). The hold is sized against
// it; injecting it bounds output to what we held. 0 = strict (require an explicit cap). Keep it <= the
// smallest max-output you serve — a higher cap makes upstream 4xx (fully refunded; just a failed call).
const DEFAULT_MAX_OUTPUT_TOKENS = numEnv("DEFAULT_MAX_OUTPUT_TOKENS", 0, 0, 1_000_000);
// Order horizons. ORDER_TTL_MS is the quoted expires_at — the buyer's "pay by" deadline. Default 4h:
// generous for an honest buyer, junk orders still self-clear in hours. Only the QUOTED window — the reaper
// waits ORDER_TTL_MS + REAP_GRACE_MS before dropping an unfunded order.
const ORDER_TTL_MS = numEnv("ORDER_TTL_MS", 4 * 60 * 60 * 1000, 5 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
// REAP_GRACE_MS is the slack between the quoted deadline and the internal reap. A buyer paying at the
// deadline still needs time for the tx's FIRST sighting, which spares it from the unfunded reap (settle.ts
// tracks sightings cross-tick in `seen`). 30m covers block time + congestion.
const REAP_GRACE_MS = numEnv("REAP_GRACE_MS", 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
// ORDER_BACKSTOP_MS is the absolute safety net: reap ANY order older than this — including one
// paid-but-never-confirmed (broadcast, seen, then dropped before confirming) — so nothing lingers
// forever. Internal only, never advertised. Keep well above ORDER_TTL_MS + REAP_GRACE_MS.
const ORDER_BACKSTOP_MS = numEnv("ORDER_BACKSTOP_MS", 24 * 60 * 60 * 1000, 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
// Backstop must outlast the unfunded-reap horizon — else it fires first, silently disabling the fast reap
// AND maybe dropping an order still confirming. numEnv only validates vars independently, so guard this
// cross-field relation here and fail fast.
if (ORDER_BACKSTOP_MS <= ORDER_TTL_MS + REAP_GRACE_MS) {
  log.error("boot", `ORDER_BACKSTOP_MS (${ORDER_BACKSTOP_MS}) must exceed ORDER_TTL_MS + REAP_GRACE_MS (${ORDER_TTL_MS + REAP_GRACE_MS})`);
  process.exit(1);
}
// Global, identity-free /buy bucket: capacity = burst, refill/min = sustained. Generous vs. organic /buy,
// devastating to a flood. (Bounds RATE; cap bounds concurrent TOTAL, reaper bounds DURATION — see
// ratelimit.ts.)
const BUY_RATE_CAPACITY = numEnv("BUY_RATE_CAPACITY", 20, 1, 1_000_000);
const BUY_RATE_REFILL_PER_MIN = numEnv("BUY_RATE_REFILL_PER_MIN", 60, 1, 60_000_000);
const buyRateLimit = makeTokenBucket({
  capacity: BUY_RATE_CAPACITY,
  refillPerSec: BUY_RATE_REFILL_PER_MIN / 60,
});

// Global /balance + /order-status read throttle (identity-free — one shared bucket, no IP, no token).
// No money gate + a JSON-parse + DB read per call, so a flood is pure free work — this caps the aggregate
// read rate. Sized far above organic reads, devastating to a flood; fail-safe (throttles everyone under
// load). The metered
// endpoints get NO such bucket on purpose — the hold already makes unfunded requests cost nothing, and a
// blunt global limit would punish legitimate high-throughput agent clients. Default 6000/min = 100/s
// sustained, burst 120.
const READ_RATE_CAPACITY = numEnv("READ_RATE_CAPACITY", 120, 1, 1_000_000);
const READ_RATE_REFILL_PER_MIN = numEnv("READ_RATE_REFILL_PER_MIN", 6000, 1, 60_000_000);
const readRateLimit = makeTokenBucket({
  capacity: READ_RATE_CAPACITY,
  refillPerSec: READ_RATE_REFILL_PER_MIN / 60,
});

// Anthropic provider — OPTIONAL and symmetric with OpenAI below: enabled iff ANTHROPIC_API_KEY is set, else
// its /v1/messages endpoint 404s and the proxy runs OpenAI-only. At least one provider must be set (the boot
// guard below exits if neither is). Tighter-by-default hold (count_tokens via /v1/messages/count_tokens),
// with the byte bound as both the "byte" mode and the fallback. The same key gates the count call + forward.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION ?? "2023-06-01";
const anthropicDeps = ANTHROPIC_API_KEY
  ? {
      apiKey: ANTHROPIC_API_KEY,
      baseUrl: ANTHROPIC_BASE_URL,
      version: ANTHROPIC_VERSION,
      estimateHold:
        HOLD_ESTIMATOR === "byte"
          ? byteBoundHold
          : makeCountTokensHold({
              countUrl: ANTHROPIC_BASE_URL + "/v1/messages/count_tokens",
              authHeaders: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION },
              omit: ANTHROPIC_COUNT_OMIT,
              timeoutMs: COUNT_TOKENS_TIMEOUT_MS,
            }),
    }
  : undefined;

// OpenAI provider — OPTIONAL and symmetric with Anthropic above: enabled iff OPENAI_API_KEY is set, else its
// endpoints 404 and the proxy serves whatever other provider is configured. Hold counts via
// /v1/responses/input_tokens with the byte bound as cap +
// fallback. NOTE (verified live): that counter accepts a RESPONSES-shaped body but 400s a Chat-Completions
// {messages} body, so /v1/responses holds are tight while /v1/chat/completions holds use the byte bound
// (sound, looser) — see hold.ts. Same key gates the count call and the forward, so a missing/typo'd key
// just disables the provider rather than 500ing requests.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
const openaiDeps = OPENAI_API_KEY
  ? {
      apiKey: OPENAI_API_KEY,
      baseUrl: OPENAI_BASE_URL,
      estimateHold:
        HOLD_ESTIMATOR === "byte"
          ? byteBoundHold
          : makeCountTokensHold({
              countUrl: OPENAI_BASE_URL + "/v1/responses/input_tokens",
              authHeaders: { authorization: `Bearer ${OPENAI_API_KEY}` },
              omit: OPENAI_COUNT_OMIT,
              timeoutMs: COUNT_TOKENS_TIMEOUT_MS,
            }),
    }
  : undefined;

// Tinfoil provider — OPTIONAL, OpenAI-compatible (open-weight models in attested TEEs). Enabled iff
// TINFOIL_API_KEY is set; shares /v1/chat/completions with OpenAI (the handler routes by model). Tinfoil has
// no count_tokens endpoint, so the hold ALWAYS uses the byte bound regardless of HOLD_ESTIMATOR (sound, just
// looser). Same key gates the forward, so a missing/typo'd key disables the provider rather than 500ing.
const TINFOIL_API_KEY = process.env.TINFOIL_API_KEY;
const TINFOIL_BASE_URL = process.env.TINFOIL_BASE_URL ?? "https://inference.tinfoil.sh";
const tinfoilDeps = TINFOIL_API_KEY ? { apiKey: TINFOIL_API_KEY, baseUrl: TINFOIL_BASE_URL, estimateHold: byteBoundHold } : undefined;

// At least one upstream provider must be configured — an all-absent set would 404 every metered path, so the
// proxy would serve no LLM at all. Fail fast at boot like the other guards (selectProviders also throws as the
// library-level backstop). Any one provider alone is valid; the buy rails are independent of this.
if (!anthropicDeps && !openaiDeps && !tinfoilDeps) {
  log.error("boot", "no providers configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or TINFOIL_API_KEY");
  process.exit(1);
}

// Open the two on-disk stores this process owns (a composition-root side effect — see the header). balances.db:
// tokens + holds journal + applied_orders (the money ledger). pending.db: in-flight payment↔token orders. The
// stores are import-safe (openDb/openOrderStore open nothing until called), so they're constructed HERE and
// injected into the handler + poller below — the stage-2 split then gives each service only the store it owns.
const balances = openDb(DB_PATH);
const orders = openOrderStore(PENDING_DB_PATH);

// Ephemeral live payment progress for /order-status, fed by the poller each tick (orderstatus.ts). Held
// here, not the DB — it's a display aid, not money, and is re-derived on the next poll after a restart.
const orderStatus = makeOrderStatus();

// Live streaming settlements. handler.ts registers each stream's settle() here for its lifetime and
// removes it the moment billing finalizes. The shutdown handler drains this so a request still streaming
// at restart is billed its metered partial (rest refunded) rather than left with the full hold debited.
const inflight = new Set<(reason?: "drain") => void>();

// Pay rail — the payment backend (per-order deposit detection + the quote source), selected by env
// (default monero; see /docs/architecture.md). PAY_RAILS is a comma list of active rails (legacy PAY_RAIL =
// a single name); the FIRST is the /buy default. Fail fast on an unknown name like the other boot checks.
const rails: Map<string, PayRail> = (() => {
  try {
    return selectRails(process.env.PAY_RAILS ?? process.env.PAY_RAIL ?? "monero");
  } catch (e) {
    log.error("boot", log.errMsg(e));
    process.exit(1);
  }
})();
const DEFAULT_RAIL = [...rails.keys()][0]!; // first listed = the rail /buy quotes when a request omits one
log.info("boot", `pay rails: ${[...rails.keys()].join(", ")} (default ${DEFAULT_RAIL})`);

const handler = createHandler({
  anthropic: anthropicDeps,
  openai: openaiDeps,
  tinfoil: tinfoilDeps,
  upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
  streamSettleDeadlineMs: STREAM_SETTLE_DEADLINE_MS,
  margin: MARGIN,
  buyMinUsd: BUY_MIN_USD,
  buyMaxUsd: BUY_MAX_USD,
  orderTtlMs: ORDER_TTL_MS,
  maxOpenOrders: MAX_OPEN_ORDERS,
  maxBuyBodyBytes: MAX_BUY_BODY_BYTES,
  maxMessagesBodyBytes: MAX_MESSAGES_BODY_BYTES,
  balances,
  orders,
  defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  upstreamFetch: fetch,
  rails: new Map<string, RailView>(rails), // every active rail's view (PayRail satisfies RailView structurally)
  defaultRail: DEFAULT_RAIL,
  buyRateLimit,
  readRateLimit,
  orderStatus: orderStatus.get,
  inflight,
});

// Crash recovery: refund any holds journaled by a request whose process died (SIGKILL / OOM / power loss)
// between the up-front debit and its settle. On a fresh boot there are no live requests, so every surviving
// holds row is stranded and refunded in full BEFORE we serve, so a recovered token is whole by its next
// request. Graceful shutdown drains streams normally (SIGTERM handler); this backstops the ungraceful path.
// Aggregate-only log, no identity.
const recovered = balances.recoverHolds();
if (recovered.count > 0)
  log.warn("boot", `recovered ${recovered.count} stranded hold(s), refunded ${recovered.micros} µ$ (ungraceful prior shutdown)`);

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // a long generation must not be cut while we await upstream
  // Hard ceiling on request body size — a backstop for any request reaching the app directly (bypassing
  // Caddy's edge cap). Bun enforces it on the bytes actually read, so it also bounds chunked uploads the
  // handler's content-length-header check can't see. Set to the largest legitimate body (the /v1/messages
  // multimodal cap); /buy is far smaller and capped in the handler.
  maxRequestBodySize: MAX_MESSAGES_BODY_BYTES,
  fetch: handler,
  error() {
    return new Response(JSON.stringify({ error: "proxy_error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  },
});

// Active providers, listed like the "pay rails:" line — exactly those configured, in a stable order.
const providerSummary = [anthropicDeps && `anthropic ${anthropicDeps.baseUrl}`, openaiDeps && `openai ${openaiDeps.baseUrl}`, tinfoilDeps && `tinfoil ${tinfoilDeps.baseUrl}`].filter(Boolean).join(" + ");
log.info("boot", `nullsink ${BUILD_VERSION} → ${providerSummary} listening on ${HOST}:${server.port}`);

// --- Settlement poller. Pure outbound: fetches confirmed deposits via each rail's watch-only wallet and
// hands them to settle(), which credits the matching token once a deposit has CONFIRMATIONS. ---
// Per-rail CONSECUTIVE poll-failure streak. UNLIKE the health-check's direct node/wallet probes
// (deploy/status-check.sh §4/§4b), which open a FRESH connection and so cannot see a CLIENT-SIDE fault like a
// stale keep-alive socket, this counts the app's OWN poll outcomes — the only signal that catches "the app
// itself can't reach its node." Past POLL_FAIL_ALERT the tick emits a greppable ERROR marker so the monitor
// pages; reset (with a one-line recovery log) on the first poll that succeeds. In-memory: a restart that
// doesn't fix the cause simply rebuilds the streak and re-pages.
const pollFailsByRail = new Map<string, number>();

// Poll ONE rail: scope the wallet query + settle + status to THIS rail's own open orders. Errors are
// isolated (logged, retried next tick) so one rail's wallet/node outage can't stall the others.
async function pollRail(rail: PayRail): Promise<void> {
  // Scope the query to this rail's currently-open orders — otherwise incomingTransfers returns the wallet's
  // ENTIRE lifetime of outputs every tick, growing unbounded and tripping the timeout (settle credits only
  // open-order indices anyway). With nothing to watch we SKIP the call and still run settle so its purges fire.
  const watch = orders.openOrders(rail.name).map((o) => o.order_index);
  let transfers: Incoming[] = [];
  if (watch.length > 0) {
    try {
      transfers = await rail.incomingTransfers(watch);
    } catch (err) {
      const o = classifyPollOutcome(pollFailsByRail.get(rail.name) ?? 0, false, POLL_FAIL_ALERT);
      pollFailsByRail.set(rail.name, o.fails);
      // Transient wallet/node error — retry next tick. A SUSTAINED streak is a real outage: escalate to a
      // stable, greppable ERROR marker (deploy/status-check.sh pages on "POLL BLIND") and keep emitting it
      // each blind tick so the monitor's lookback window always sees an open incident.
      if (o.event === "blind")
        log.error("poll", `[${rail.name}] POLL BLIND: ${o.fails} consecutive incomingTransfers failures — deposit detection is DOWN: ${log.errMsg(err)}`);
      else log.warn("poll", `[${rail.name}] incomingTransfers failed: ${log.errMsg(err)}`);
      return;
    }
  }
  // The poll succeeded (or there was nothing to watch) — the rail can see deposits. Clear the streak,
  // announcing recovery ONCE if we'd crossed the alert threshold (so the journal records the incident closing).
  const prevFails = pollFailsByRail.get(rail.name) ?? 0;
  const recovered = classifyPollOutcome(prevFails, true, POLL_FAIL_ALERT);
  if (recovered.event === "recovered")
    log.info("poll", `[${rail.name}] poll recovered after ${prevFails} consecutive failures — deposit detection restored`);
  pollFailsByRail.set(rail.name, recovered.fails);
  settle(transfers, orders, Date.now(), {
    scale: rail.scale,
    asset: rail.name,
    rail: rail.name, // scope settle's pending_orders reads/reaps to THIS rail
    backstopMs: ORDER_BACKSTOP_MS,
    unfundedReapMs: ORDER_TTL_MS + REAP_GRACE_MS,
  });
  // Refresh the live /order-status view from this tick's sightings (scoped to this rail), AFTER settle has
  // removed credited/reaped orders so closed ones drop out. Merge semantics (orderstatus.ts) keep a
  // mid-confirming order from flickering on a transient-empty tick — the display-side echo of the durable
  // seen_at guard settle uses. NOTE: unlike seen_at, this map is process-local and empty after a restart.
  orderStatus.update(transfers, orders.openOrders(rail.name).map((o) => o.order_index), rail.name);
}

// Each tick polls every active rail independently — allSettled so one rail's failure can't block another.
async function pollOnce(): Promise<void> {
  await Promise.allSettled([...rails.values()].map((r) => pollRail(r)));
  // Deliver any credits settle() enqueued this tick into the balance ledger (the in-process sender; PR-C moves
  // this hop over the credit socket to the proxy). Rail-agnostic — one drain covers every rail. Idempotent, so
  // a crash before ack re-delivers next tick, and the startup tick clears any outbox rows a prior crash left.
  const { delivered } = drainCreditOutbox(orders, balances, Date.now());
  if (delivered > 0) log.info("credit", `delivered ${delivered} credit(s) from the outbox`);
}

let polling = false;
function tick(): void {
  if (polling) return; // don't let a slow tick overlap the next
  polling = true;
  pollOnce()
    .catch((e) => log.error("poll", `tick error: ${log.errMsg(e)}`))
    .finally(() => {
      polling = false;
    });
}
const poller = setInterval(tick, POLL_INTERVAL_MS);
tick(); // immediate poll on startup — recover deposits that landed while we were down

// --- Metrics flush. Aggregate, identity-free counters (metrics.ts) emitted to one [metrics] journald line
// on a coarse cadence, then the window resets — the operator's "are we nearing a vendor rate limit?" signal.
// Only logged when something happened, so it never spams; it's a trend, not a per-event log. Default hourly.
const METRICS_FLUSH_MS = numEnv("METRICS_FLUSH_MS", 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
metrics.reset(Date.now());
// Seed the boot-recovery gauge AFTER the first reset (recoverHolds ran above, before this window opened), so the
// first flush carries `recovered:holds=N` — the cross-restart trend behind the [boot] WARN already logged.
if (recovered.count > 0) metrics.recordRecoveredHolds(recovered.count);
function flushMetrics(): void {
  // The pure formatting + WARN/INFO decision lives in metrics.formatMetricsLine (testable); here we just
  // emit it (when non-null) and reset the window.
  const out = metrics.formatMetricsLine(metrics.snapshot(), Date.now());
  if (out) log[out.level]("metrics", out.line);
  metrics.reset(Date.now());
}
const metricsTimer = setInterval(flushMetrics, METRICS_FLUSH_MS);

// Graceful shutdown (deploy / restart / reboot — i.e. SIGTERM). Stop new polls, stop accepting connections,
// and let in-flight requests finish NATURALLY for a short grace — they bill exactly via their normal path.
// Any STREAM still live at the deadline is force-settled (metered partial billed, rest refunded) before the
// hard close, so the SIGKILL systemd sends at TimeoutStopSec can't strand its hold. The drain logic lives in
// drainInflight (shutdown.ts) so it's unit-testable; CRUCIALLY it waits on the `inflight` set emptying, NOT
// on server.stop()'s promise (which resolves when handlers return — a streaming handler returns immediately
// while its body pumps; see shutdown.ts for the race this fixes). A BUFFERED request (not in `inflight`;
// no partial until its response lands) finishes
// naturally if it returns within the grace, else is hard-closed and FULL-refunded by boot recovery on the
// next start (correct: nothing was delivered). recoverHolds (above) stays the backstop for an UNgraceful
// death (SIGKILL / OOM / power loss). Keep the grace comfortably above normal request latency.
//
// SHUTDOWN_GRACE_MS MUST stay below the unit's TimeoutStopSec (deploy/nullsink.service, default 60s) so
// we always finish on our own terms (settle, then exit), never by SIGKILL. The max here enforces that against
// the shipped unit; raising it past TimeoutStopSec is a deliberate paired edit (here AND the unit file).
const SHUTDOWN_GRACE_MS = numEnv("SHUTDOWN_GRACE_MS", 25_000, 0, 50_000);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; // a second signal (SIGTERM then SIGINT, or a repeat) must not re-enter the drain
  shuttingDown = true;
  clearInterval(poller); // stop new polls; an in-flight tick is safe to abandon (idempotent)
  clearInterval(metricsTimer);
  const handlersReturned = server.stop(); // stop new connections; resolves when handlers return (buffered done)
  const { forceSettled } = await drainInflight({
    inflight,
    handlersReturned,
    graceMs: SHUTDOWN_GRACE_MS,
    now: Date.now,
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    onSettleError: (err) => log.error("shutdown", `force-settle of an in-flight stream threw (others unaffected): ${log.errMsg(err)}`),
  });
  if (forceSettled > 0)
    log.warn("shutdown", `force-settled ${forceSettled} in-flight stream(s) at the drain deadline (metered partial billed, rest refunded)`);
  // Final flush AFTER the drain, so everything that settled during the grace — natural finishes (served)
  // and force-settles (stream:aborted / stream:partial) — makes the last window and it still reconciles.
  flushMetrics();
  await server.stop(true); // hard-close anything still open (force-settled streams, buffered stragglers)
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
