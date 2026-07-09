// PAYMENT-world read endpoints — /order-status and /rails. Split out of reads.ts so the attested proxy binary,
// which imports only the prompt reads (/balance, /v1/models), never carries this payment-endpoint source. Both
// are cheap reads behind the shared, identity-free read throttle (no money gate), each `(req) => Promise<Response>`.
import { deny, readJsonBody } from "../http";
import { decimalsOf, type PaymentsEndpointDeps } from "./types";
import { readThrottled } from "./read-throttle";

// POST /order-status: live payment progress for an in-flight order, keyed by the token's HASH (never the raw
// token — that goes only to /balance). The hash already crossed the wire to /buy, so this leaks nothing new;
// it reveals only how far along a payment is, never the balance. Once an order settles the row is dropped
// (settle.ts), so a credited/reaped/never-existed order all read `closed` — the dropped-link privacy
// property. The client confirms the actual credit via /balance.
export function makeOrderStatus(d: PaymentsEndpointDeps) {
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
    // waiting:    order open, no inbound EVER observed.
    // detected:   an inbound WAS observed — durably, via pending_orders.seen_at — but we have no live
    //             progress for it right now. That means the process restarted (deploy, restore, crash) and
    //             the wallet has not caught up yet. `orderStatus` is process-local and comes back empty, so
    //             without seen_at this order would report "waiting" and the client would render "not seen
    //             yet" OVER a payment we have already seen. A buyer who reads that may pay a SECOND time —
    //             and pay-once has already closed the order on the first deposit, so settle() drops the
    //             second one (no open order for that index) and it can never be credited. seen_at outlives
    //             the process, so this state can never regress back to "waiting".
    // confirming: seen, still gaining confirmations.
    // finalizing: confirmations met but the poller hasn't credited+closed it yet (e.g. the output is still
    //             locked) — the client should now check /balance for the authoritative credit.
    const state =
      received > 0
        ? confirmations < r.confirmations
          ? "confirming"
          : "finalizing"
        : order.seen_at != null
          ? "detected"
          : "waiting";
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
export function makeRails(d: PaymentsEndpointDeps) {
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
