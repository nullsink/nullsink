// The three read endpoints — /order-status, /rails, /balance — extracted from handler.ts. All cheap reads
// behind the global, identity-free read throttle (no money gate), each `(req) => Promise<Response>`.
import { deny, denyThrottled, readJsonBody } from "../http";
import { hashToken } from "../ledger/hash";
import { decimalsOf, type EndpointDeps } from "./types";
import type { TokenBucket } from "../ratelimit";
import * as metrics from "../metrics";

// The read-endpoint throttle in ONE place: the "this is a read throttle" classification + its metric live
// together at the decision site (like buy.ts records reject.* at its gates), leaving denyThrottled a pure
// envelope builder. Returns the 429 to return, or null to proceed.
function readThrottled(bucket: TokenBucket | undefined): Response | null {
  if (bucket && !bucket.tryConsume()) {
    metrics.recordReject("read");
    return denyThrottled(1);
  }
  return null;
}

// POST /order-status: live payment progress for an in-flight order, keyed by the token's HASH (never the raw
// token — that goes only to /balance). The hash already crossed the wire to /buy, so this leaks nothing new;
// it reveals only how far along a payment is, never the balance. Once an order settles the row is dropped
// (settle.ts), so a credited/reaped/never-existed order all read `closed` — the dropped-link privacy
// property. The client confirms the actual credit via /balance.
export function makeOrderStatus(d: EndpointDeps) {
  const { rails: RAILS, defaultRail: DEFAULT_RAIL, maxBuyBodyBytes: MAX_BUY_BODY_BYTES, orderTtlMs: ORDER_TTL_MS, latestOpenOrderByHash, orderStatus, readRateLimit } = d;
  return async (req: Request): Promise<Response> => {
    const throttled = readThrottled(readRateLimit);
    if (throttled) return throttled;
    const parsed = await readJsonBody(req, MAX_BUY_BODY_BYTES);
    if ("rejection" in parsed) return parsed.rejection;
    const body = parsed.body;
    const hash: string | null = typeof body?.hash === "string" ? body.hash : null;
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return deny(400, "invalid_hash");
    const order = latestOpenOrderByHash(hash);
    if (!order) return Response.json({ state: "closed" });
    // Format by the ORDER's rail (a BTC order shows BTC sats/unit even while Monero is also active).
    // Fallback fires only if a rail is dropped from PAY_RAILS with open orders still live — it would then
    // render in the WRONG coin's scale/unit, so drain a rail's open orders before removing it.
    const r = RAILS.get(order.rail) ?? RAILS.get(DEFAULT_RAIL)!;
    const progress = orderStatus?.(order.order_index, order.rail);
    const received = progress?.received_atomic ?? 0;
    const confirmations = progress?.confirmations ?? 0;
    // waiting: order open, nothing seen yet. confirming: seen, still gaining confirmations. finalizing:
    // confirmations met but the poller hasn't credited+closed it yet (e.g. the output is still locked) —
    // the client should now check /balance for the authoritative credit.
    const state = received <= 0 ? "waiting" : confirmations < r.confirmations ? "confirming" : "finalizing";
    return Response.json({
      state,
      confirmations,
      required: r.confirmations,
      received: (received / r.scale).toFixed(decimalsOf(r.scale)),
      expected: (order.expected_atomic / r.scale).toFixed(decimalsOf(r.scale)),
      unit: r.unit,
      expires_at: order.created_at + ORDER_TTL_MS,
    });
  };
}

// GET /rails: the active pay rails (name + display unit + confirmations) and which one /buy defaults to.
// Lets the client render a coin picker without hardcoding the set; privacy-neutral (reveals only which coins
// we accept, already public). A cheap read — the shared read limit applies.
export function makeRails(d: EndpointDeps) {
  const { rails: RAILS, defaultRail: DEFAULT_RAIL, readRateLimit } = d;
  return async (_req: Request): Promise<Response> => {
    const throttled = readThrottled(readRateLimit);
    if (throttled) return throttled;
    return Response.json({
      default: DEFAULT_RAIL,
      rails: [...RAILS.values()].map((rv) => ({ name: rv.name, unit: rv.unit, confirmations: rv.confirmations })),
    });
  };
}

// GET /v1/models: the OpenAI-compatible model catalog — every model THIS instance serves (its provider is
// configured AND owns the id), so `data[].id` is exactly the set that won't 400 unsupported_model. Lets an
// SDK or agent framework enumerate/validate models the standard way. Unauthenticated and a cheap read (the
// list is static and already public on /models): the shared read throttle applies, like /rails. Each entry
// carries its USD-per-Mtok pricing (nullsink bills upstream rates) — the one thing an upstream /v1/models
// can't give you, and the reason we build the list locally rather than proxy one. `created` is a constant 0
// (we don't track model dates) — present only to satisfy the OpenAI Model schema.
export function makeModels(d: EndpointDeps) {
  const { servedModels, readRateLimit } = d;
  return async (_req: Request): Promise<Response> => {
    const throttled = readThrottled(readRateLimit);
    if (throttled) return throttled;
    return Response.json({
      object: "list",
      pricing_unit: "usd_per_mtok", // documents every entry's `pricing` figures once, not per-model
      data: servedModels.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: m.provider,
        pricing: { input: m.input, output: m.output, cache_read: m.cache_read, cache_write: m.cache_write },
      })),
    });
  };
}

// GET /balance: a token holder checks their own remaining balance. Distinguishes a known token (200) from
// unknown (401) — a token-validity oracle — fine because tokens are 256-bit unguessable.
export function makeBalance(d: EndpointDeps) {
  const { getBalance, readRateLimit } = d;
  return async (req: Request): Promise<Response> => {
    const throttled = readThrottled(readRateLimit);
    if (throttled) return throttled;
    const token = req.headers.get("x-api-key");
    if (!token) return deny(401, "invalid_token");
    const micros = getBalance(hashToken(token));
    if (micros === null) return deny(401, "invalid_token");
    return Response.json({ balance_usd: micros / 1_000_000 });
  };
}
