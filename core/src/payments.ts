// Composition root for the PAYMENTS service (payment world). All side effects live here — env validation, the
// order store, the HTTP port, the settlement poller, the credit sender, signal handlers.
//
// Owns pending.db (in-flight orders, the sales book, the credit outbox), the pay rails and their watch-only
// wallets. Serves /buy, /order-status, /rails on a loopback port behind Caddy. Credits reach the balance ledger
// only through the credit socket — the single, one-directional crossing (payments → proxy).
//
// It must never import prompt-world code (no balance store, no providers, no metered path). Enforced by
// test/world-isolation.test.ts at the module level and by scripts/assert-worlds.ts on the compiled binary.
import { openOrderStore, PENDING_DB_PATH } from "./ledger/orders";
import { createPaymentsHandler, type RailView } from "./payments-handler";
import { deny } from "./http";
import { makeOrderStatus } from "./ledger/orderstatus";
import { settle } from "./ledger/settle";
import { makeSocketSender, drainCreditOutboxOverSocket, oldestUnackedAgeMs } from "./credit-sender";
import { selectRails, type PayRail } from "./rails";
import type { Incoming } from "./rails/types";
import { makeTokenBucket } from "./ratelimit";
import { numEnv } from "./env";
import { classifyPollOutcome } from "./ledger/poll";
import * as log from "./log";
import * as metrics from "./metrics";
import { BUILD_VERSION } from "./version";
import { DEFAULT_MARGIN } from "./pricing-config";

const PORT = numEnv("PAYMENTS_PORT", 8081, 1, 65535);
const HOST = process.env.HOST ?? "127.0.0.1";
// The credit crossing. The proxy binds this socket; we connect. Our write permission on the socket file IS the
// authentication (Linux checks it at connect(2)), granted by the deploy — see credit-server.ts.
const CREDIT_SOCK = process.env.CREDIT_SOCK ?? "/run/nullsink/credit.sock";
const CREDIT_TIMEOUT_MS = numEnv("CREDIT_TIMEOUT_MS", 5_000, 100, 60_000);
// Alert when the oldest undelivered credit is older than this. /healthz cannot see a wedged credit socket or a
// stalled sender, but credits piling up in the outbox can — this is the "is money still crossing?" signal.
const OUTBOX_AGE_ALERT_MS = numEnv("OUTBOX_AGE_ALERT_MS", 10 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);

// Buy-rail margin: our cut, applied at credit time (credit < paid), like cli/issue.ts.
const MARGIN = numEnv("MARGIN", DEFAULT_MARGIN, 1, 100);
const BUY_MIN_USD = numEnv("BUY_MIN_USD", 2, 0.01, 1_000_000);
const BUY_MAX_USD = numEnv("BUY_MAX_USD", 2000, BUY_MIN_USD, 1_000_000);
const POLL_INTERVAL_MS = numEnv("POLL_INTERVAL_MS", 30_000, 1000, 3_600_000);
// Consecutive FAILED poll ticks for one rail before escalating to an alertable ERROR marker ("POLL BLIND"). A
// single miss is a normal transient; a streak means that rail's deposit detection is DOWN.
const POLL_FAIL_ALERT = numEnv("POLL_FAIL_ALERT", 5, 1, 1000);
// Global in-flight ceiling (no IP tracking — privacy). Bounds total open orders, hence addresses created.
const MAX_OPEN_ORDERS = numEnv("MAX_OPEN_ORDERS", 1000, 1, 10_000_000);
// Fixed public body contract: Caddy and the handler both enforce exactly 4 KiB. This is intentionally not
// an env knob; a different local value would make one layer's advertised limit ineffective.
const MAX_BUY_BODY_BYTES = 4 * 1024;
// Order horizons. ORDER_TTL_MS is the quoted expires_at — the buyer's "pay by" deadline. REAP_GRACE_MS is the
// slack before the internal reap. ORDER_BACKSTOP_MS is the absolute safety net (internal only).
const ORDER_TTL_MS = numEnv("ORDER_TTL_MS", 4 * 60 * 60 * 1000, 5 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
const REAP_GRACE_MS = numEnv("REAP_GRACE_MS", 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
const ORDER_BACKSTOP_MS = numEnv("ORDER_BACKSTOP_MS", 24 * 60 * 60 * 1000, 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
// Backstop must outlast the unfunded-reap horizon — else it fires first, silently disabling the fast reap AND
// maybe dropping an order still confirming. numEnv validates vars independently, so guard this relation here.
if (ORDER_BACKSTOP_MS <= ORDER_TTL_MS + REAP_GRACE_MS) {
  log.error("boot", `ORDER_BACKSTOP_MS (${ORDER_BACKSTOP_MS}) must exceed ORDER_TTL_MS + REAP_GRACE_MS (${ORDER_TTL_MS + REAP_GRACE_MS})`);
  process.exit(1);
}
// Global, identity-free /buy bucket: capacity = burst, refill/min = sustained.
const BUY_RATE_CAPACITY = numEnv("BUY_RATE_CAPACITY", 20, 1, 1_000_000);
const BUY_RATE_REFILL_PER_MIN = numEnv("BUY_RATE_REFILL_PER_MIN", 60, 1, 60_000_000);
const buyRateLimit = makeTokenBucket({ capacity: BUY_RATE_CAPACITY, refillPerSec: BUY_RATE_REFILL_PER_MIN / 60 });

// Global, identity-free throttle for THIS world's free reads (/order-status, /rails). The proxy runs its
// own bucket for /balance + /v1/models and reads the SAME env names, so each default is sized at half the
// intended aggregate — raising the shared env raises BOTH worlds' caps at once.
const READ_RATE_CAPACITY = numEnv("READ_RATE_CAPACITY", 60, 1, 1_000_000);
const READ_RATE_REFILL_PER_MIN = numEnv("READ_RATE_REFILL_PER_MIN", 3000, 1, 60_000_000);
const readRateLimit = makeTokenBucket({ capacity: READ_RATE_CAPACITY, refillPerSec: READ_RATE_REFILL_PER_MIN / 60 });

// The one on-disk store this service owns. The proxy opens balances.db; neither touches the other's.
const orders = openOrderStore(PENDING_DB_PATH);

// Ephemeral live payment progress for /order-status, fed by the poller each tick. Held here, not the DB — it's a
// display aid, not money, and is re-derived on the next poll after a restart.
const orderStatus = makeOrderStatus();

// Pay rail — the payment backend (per-order deposit detection + the quote source), selected by env. PAY_RAILS is
// a comma list of active rails; the FIRST is the /buy default. Fail fast on an unknown name.
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

const handler = createPaymentsHandler({
  orders,
  rails: new Map<string, RailView>(rails), // PayRail satisfies RailView structurally
  defaultRail: DEFAULT_RAIL,
  margin: MARGIN,
  buyMinUsd: BUY_MIN_USD,
  buyMaxUsd: BUY_MAX_USD,
  orderTtlMs: ORDER_TTL_MS,
  maxOpenOrders: MAX_OPEN_ORDERS,
  maxBuyBodyBytes: MAX_BUY_BODY_BYTES,
  buyRateLimit,
  readRateLimit,
  orderStatus: orderStatus.get,
});

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // Leave enough room for the handler to return nullsink's JSON 413 for a modest direct/chunked overage;
  // readJsonBody enforces the exact 4 KiB actual-byte contract, while this is the hard allocation backstop.
  maxRequestBodySize: MAX_BUY_BODY_BYTES * 16,
  fetch: handler,
  error() {
    // Last-resort only; see proxy.ts. The error object itself may contain request data, so the alertable
    // journal line intentionally carries no interpolated detail.
    log.error("http", "unhandled payments request error");
    return deny(500, "payments_error");
  },
});
log.info("boot", `nullsink-payments ${BUILD_VERSION} listening on ${HOST}:${server.port} (credit socket ${CREDIT_SOCK})`);

// --- Settlement poller. Pure outbound: fetch confirmed deposits via each rail's watch-only wallet, hand them to
// settle() (which ENQUEUES credits into the durable outbox), then deliver the outbox over the credit socket. ---
const sendCredit = makeSocketSender(CREDIT_SOCK, CREDIT_TIMEOUT_MS);

// Per-rail CONSECUTIVE poll-failure streak — the only signal that catches "the app itself can't reach its node".
// Past POLL_FAIL_ALERT the tick emits a greppable ERROR marker so the monitor pages.
const pollFailsByRail = new Map<string, number>();

// Poll ONE rail: scope the wallet query + settle + status to THIS rail's own open orders. Errors are isolated
// (logged, retried next tick) so one rail's wallet/node outage can't stall the others.
async function pollRail(rail: PayRail): Promise<void> {
  const watch = orders.openOrders(rail.name).map((o) => o.order_index);
  let transfers: Incoming[] = [];
  if (watch.length > 0) {
    try {
      transfers = await rail.incomingTransfers(watch);
    } catch (err) {
      const o = classifyPollOutcome(pollFailsByRail.get(rail.name) ?? 0, false, POLL_FAIL_ALERT);
      pollFailsByRail.set(rail.name, o.fails);
      if (o.event === "blind")
        log.error("poll", `[${rail.name}] POLL BLIND: ${o.fails} consecutive incomingTransfers failures — deposit detection is DOWN: ${log.errMsg(err)}`);
      else log.warn("poll", `[${rail.name}] incomingTransfers failed: ${log.errMsg(err)}`);
      return;
    }
  }
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
  // Refresh the live /order-status view AFTER settle has removed credited/reaped orders, so closed ones drop out.
  // Unlike settle's reap guard (durable pending_orders.seen_at), this map is process-local and empty after a
  // restart — /order-status reports `detected` from seen_at until the wallet repopulates it.
  orderStatus.update(transfers, orders.openOrders(rail.name).map((o) => o.order_index), rail.name);
}

// Each tick polls every active rail independently — allSettled so one rail's failure can't block another — then
// delivers whatever settle() enqueued. The drain runs at the TAIL of the tick, INSIDE the `polling` single-flight
// guard below: delivery is async now (a socket round-trip per row), so a standalone interval could overlap itself
// and re-send unacked rows. Keeping it here means it can never run concurrently with itself.
async function pollOnce(): Promise<void> {
  await Promise.allSettled([...rails.values()].map((r) => pollRail(r)));
  const now = Date.now();
  const { delivered, blocked } = await drainCreditOutboxOverSocket(orders, sendCredit, now);
  if (delivered > 0) log.info("credit", `delivered ${delivered} credit(s) over the socket`);
  // Ambiguous delivery (proxy restarting, socket not yet bound, timeout): the rows stay durable and we retry.
  // Say what it MEANS ourselves — the raw reason can be Bun's generic "Was there a typo in the url or port?",
  // which reads like a config error when it is just the proxy being down.
  if (blocked) log.warn("credit", `proxy unreachable or not acking over the credit socket — credits stay queued, retrying next tick (${blocked})`);
  // The "is money still crossing?" alarm. Greppable marker for deploy/status-check.sh.
  const age = oldestUnackedAgeMs(orders, now);
  if (age > OUTBOX_AGE_ALERT_MS)
    log.error("credit", `CREDIT OUTBOX STALLED: oldest undelivered credit is ${Math.round(age / 1000)}s old (> ${Math.round(OUTBOX_AGE_ALERT_MS / 1000)}s) — credits are not reaching the ledger`);
}

let polling = false;
function tick(): void {
  if (polling) return; // don't let a slow tick overlap the next — this is also the sender's re-entrancy guard
  polling = true;
  pollOnce()
    .catch((e) => log.error("poll", `tick error: ${log.errMsg(e)}`))
    .finally(() => {
      polling = false;
    });
}
const poller = setInterval(tick, POLL_INTERVAL_MS);
tick(); // immediate poll on startup — recover deposits that landed while we were down, and drain any outbox rows
// a prior crash left unacked (the proxy may not be up yet; that's ambiguous, not fatal — we retry next tick).

// --- Metrics flush (aggregate, identity-free). ---
const METRICS_FLUSH_MS = numEnv("METRICS_FLUSH_MS", 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
metrics.reset(Date.now());
function flushMetrics(): void {
  const out = metrics.formatMetricsLine(metrics.snapshot(), Date.now());
  if (out) log[out.level]("metrics", out.line);
  metrics.reset(Date.now());
}
const metricsTimer = setInterval(flushMetrics, METRICS_FLUSH_MS);

// Graceful shutdown (SIGTERM). Stop new polls and stop accepting connections; there are no long-lived streams
// here. An in-flight tick is safe to abandon: settle's writes are transactional and undelivered credits stay
// durable in the outbox for the next start.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(poller);
  clearInterval(metricsTimer);
  await server.stop();
  flushMetrics();
  await server.stop(true);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
