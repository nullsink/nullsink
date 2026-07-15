// Composition root for the PROXY service (prompt world). All side effects live here — env validation, the
// balance store, the HTTP port, the credit socket, timers, signal handlers. Request logic is in handler.ts,
// which is pure/injectable and import-safe (importing it binds no port, starts no timer).
//
// Owns balances.db (tokens + holds journal + applied_orders) and the upstream provider keys. Serves the metered
// /v1 paths + /balance + /v1/models on a loopback port behind Caddy, and runs the CREDIT SOCKET server — the one
// door the payment world may open into this one (payments → proxy, `credit`).
//
// It must never import payment-world code (no rails, no order store, no settle, no /buy). Enforced by
// test/world-isolation.test.ts at the module level and by scripts/assert-worlds.ts on the compiled binary.
import { openDb, DB_PATH } from "./ledger/db";
import { createProxyHandler } from "./handler";
import { deny } from "./http";
import { serveCreditSocket } from "./credit-server";
import { byteBoundHold, makeCountTokensHold, ANTHROPIC_COUNT_OMIT, OPENAI_COUNT_OMIT } from "./hold";
import { makeTokenBucket } from "./ratelimit";
import { drainInflight } from "./shutdown";
import { numEnv } from "./env";
import * as log from "./log";
import * as metrics from "./metrics";
import { BUILD_VERSION } from "./version";

const PORT = numEnv("PORT", 8080, 1, 65535);
// Bind address. Defaults to 127.0.0.1 (safe by default): the service must NEVER face the open net — Caddy
// fronts it and reverse-proxies to localhost. Override with HOST=0.0.0.0 only for local dev.
const HOST = process.env.HOST ?? "127.0.0.1";
// The credit crossing. THIS service binds the socket (owner-only; see credit-server.ts) and the payments
// service connects to the same path — its write permission on this file is the authentication.
const CREDIT_SOCK = process.env.CREDIT_SOCK ?? "/run/nullsink/credit.sock";
// Total wall-clock cap on the upstream call (reaps hung/stalled connections). Matches the Anthropic SDK's
// ~10min default; raise it if long generations get cut.
const UPSTREAM_TIMEOUT_MS = numEnv("UPSTREAM_TIMEOUT_MS", 600_000, 1000, 3_600_000);
// Force-settle deadline for a stream the client opens but never reads/closes — none of done/error/cancel fire,
// so settle() never runs and the hold leaks until restart (handler.ts). Min is UPSTREAM_TIMEOUT_MS + 1 so it
// always sits above the upstream timeout: a legit stream finishes (or upstream aborts) first.
const STREAM_SETTLE_DEADLINE_MS = numEnv("STREAM_SETTLE_DEADLINE_MS", UPSTREAM_TIMEOUT_MS + 60_000, UPSTREAM_TIMEOUT_MS + 1, 7_200_000);
// Pre-flight hold sizing. "count_tokens" (default) asks the provider for the exact input-token count so the hold
// isn't grossly over-reserved (byte bound is ~62× loose on base64 images), failing safe to the byte bound on any
// error. "byte" forces the deterministic no-extra-call bound. Either is sound.
const HOLD_ESTIMATOR = process.env.HOLD_ESTIMATOR ?? "count_tokens";
const COUNT_TOKENS_TIMEOUT_MS = numEnv("COUNT_TOKENS_TIMEOUT_MS", 10_000, 100, 600_000);
// Fixed public body contract: Caddy and this direct-service backstop both enforce exactly 32 MiB.
// Keeping this non-configurable prevents an env override from silently disagreeing with the edge.
const MAX_MESSAGES_BODY_BYTES = 32 * 1024 * 1024;
// Output cap applied (and injected into the forwarded request) when a client OMITS one — so stock OpenAI clients
// that omit a cap still work. The hold is sized against it. 0 = strict (require an explicit cap).
const DEFAULT_MAX_OUTPUT_TOKENS = numEnv("DEFAULT_MAX_OUTPUT_TOKENS", 0, 0, 1_000_000);

// Global, identity-free throttle for THIS world's free reads (/balance, /v1/models). The payments service
// runs its own bucket for /order-status + /rails and reads the SAME env names, so each default is sized at
// half the intended aggregate — raising the shared env raises BOTH worlds' caps at once.
const READ_RATE_CAPACITY = numEnv("READ_RATE_CAPACITY", 60, 1, 1_000_000);
const READ_RATE_REFILL_PER_MIN = numEnv("READ_RATE_REFILL_PER_MIN", 3000, 1, 60_000_000);
const readRateLimit = makeTokenBucket({ capacity: READ_RATE_CAPACITY, refillPerSec: READ_RATE_REFILL_PER_MIN / 60 });

// Anthropic provider — OPTIONAL and symmetric with the others: enabled iff ANTHROPIC_API_KEY is set, else its
// /v1/messages endpoint 404s. At least one provider must be set (the boot guard below exits if none is).
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

// OpenAI provider — OPTIONAL. Hold counts via /v1/responses/input_tokens with the byte bound as cap + fallback
// (that counter 400s a Chat-Completions body, so chat holds use the byte bound — sound, looser; see hold.ts).
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

// Tinfoil provider — OPTIONAL, OpenAI-compatible (open-weight models in attested TEEs). Shares
// /v1/chat/completions with OpenAI (the handler routes by model). No count_tokens endpoint → byte-bound hold.
const TINFOIL_API_KEY = process.env.TINFOIL_API_KEY;
const TINFOIL_BASE_URL = process.env.TINFOIL_BASE_URL ?? "https://inference.tinfoil.sh";
const tinfoilDeps = TINFOIL_API_KEY ? { apiKey: TINFOIL_API_KEY, baseUrl: TINFOIL_BASE_URL, estimateHold: byteBoundHold } : undefined;

// At least one upstream provider must be configured — an all-absent set would 404 every metered path. Fail fast.
if (!anthropicDeps && !openaiDeps && !tinfoilDeps) {
  log.error("boot", "no providers configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or TINFOIL_API_KEY");
  process.exit(1);
}

// The one on-disk store this service owns. The payments service opens pending.db; neither touches the other's.
const balances = openDb(DB_PATH);

// Live streaming settlements. handler.ts registers each stream's settle() here for its lifetime and removes it
// the moment billing finalizes. The shutdown handler drains this so a request still streaming at restart is
// billed its metered partial (rest refunded) rather than left with the full hold debited.
const inflight = new Set<(reason?: "drain") => void>();

const handler = createProxyHandler({
  anthropic: anthropicDeps,
  openai: openaiDeps,
  tinfoil: tinfoilDeps,
  upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
  streamSettleDeadlineMs: STREAM_SETTLE_DEADLINE_MS,
  maxMessagesBodyBytes: MAX_MESSAGES_BODY_BYTES,
  balances,
  defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  upstreamFetch: fetch,
  readRateLimit,
  inflight,
});

// Crash recovery: refund any holds journaled by a request whose process died (SIGKILL / OOM / power loss)
// between the up-front debit and its settle. On a fresh boot there are no live requests, so every surviving
// holds row is stranded and refunded in full BEFORE we serve. Aggregate-only log, no identity.
const recovered = balances.recoverHolds();
if (recovered.count > 0)
  log.warn("boot", `recovered ${recovered.count} stranded hold(s), refunded ${recovered.micros} µ$ (ungraceful prior shutdown)`);

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // a long generation must not be cut while we await upstream
  // Hard ceiling on request body size — a backstop for any request reaching the service directly (bypassing
  // Caddy's edge cap). Bun enforces it on bytes actually read, so it also bounds chunked uploads.
  maxRequestBodySize: MAX_MESSAGES_BODY_BYTES,
  fetch: handler,
  error() {
    // This is Bun's last-resort handler: request logic normally catches and classifies every expected
    // failure itself. Keep the journal event content-free (an unexpected Error may include request data),
    // but never return a 500 with no operator-visible signal.
    log.error("http", "unhandled proxy request error");
    return deny(500, "proxy_error");
  },
});

// The credit crossing. Bound AFTER the balance store exists (it applies credits) and after recoverHolds, so the
// first credit can never race boot recovery. Payments may already be retrying against a missing socket — that is
// ambiguous to it, never a failure: its outbox is durable and it retries next tick.
const creditSocket = serveCreditSocket({ path: CREDIT_SOCK, balances });

const providerSummary = [anthropicDeps && `anthropic ${anthropicDeps.baseUrl}`, openaiDeps && `openai ${openaiDeps.baseUrl}`, tinfoilDeps && `tinfoil ${tinfoilDeps.baseUrl}`].filter(Boolean).join(" + ");
log.info("boot", `nullsink-proxy ${BUILD_VERSION} → ${providerSummary} listening on ${HOST}:${server.port} (credit socket ${CREDIT_SOCK})`);

// --- Metrics flush. Aggregate, identity-free counters emitted to one [metrics] journald line on a coarse
// cadence, then the window resets. Only logged when something happened. Default hourly. ---
const METRICS_FLUSH_MS = numEnv("METRICS_FLUSH_MS", 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
metrics.reset(Date.now());
if (recovered.count > 0) metrics.recordRecoveredHolds(recovered.count);
function flushMetrics(): void {
  const out = metrics.formatMetricsLine(metrics.snapshot(), Date.now());
  if (out) log[out.level]("metrics", out.line);
  metrics.reset(Date.now());
}
const metricsTimer = setInterval(flushMetrics, METRICS_FLUSH_MS);

// Graceful shutdown (deploy / restart / reboot — SIGTERM). Stop accepting connections and let in-flight requests
// finish NATURALLY for a short grace. Any STREAM still live at the deadline is force-settled (metered partial
// billed, rest refunded) before the hard close. SHUTDOWN_GRACE_MS MUST stay below the unit's TimeoutStopSec so we
// always finish on our own terms, never by SIGKILL.
const SHUTDOWN_GRACE_MS = numEnv("SHUTDOWN_GRACE_MS", 25_000, 0, 50_000);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; // a second signal must not re-enter the drain
  shuttingDown = true;
  clearInterval(metricsTimer);
  const handlersReturned = server.stop(); // stop new connections; resolves when handlers return
  const { forceSettled } = await drainInflight({
    inflight,
    handlersReturned,
    graceMs: SHUTDOWN_GRACE_MS,
    now: Date.now,
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    onSettleError: () => log.error("shutdown", "force-settle of an in-flight stream failed (others unaffected)"),
  });
  if (forceSettled > 0)
    log.warn("shutdown", `force-settled ${forceSettled} in-flight stream(s) at the drain deadline (metered partial billed, rest refunded)`);
  flushMetrics();
  // Close the credit socket LAST — payments may still be mid-drain, and a credit that lands during our stream
  // drain is one fewer retry. Anything it can't deliver stays durable in its outbox.
  creditSocket.stop();
  await server.stop(true); // hard-close anything still open
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
