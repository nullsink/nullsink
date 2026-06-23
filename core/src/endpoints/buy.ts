// POST /buy: quote a crypto payment for a token. The client generates its token locally and sends only the
// hash; the poller credits it once the deposit confirms. Self-serve and public: the billing hold is a sound
// upper bound (hold.ts), so /buy yields no free usage. Extracted from handler.ts.
import { deny, readJsonBody } from "../http";
import * as log from "../log";
import * as metrics from "../metrics";
import { decimalsOf, type EndpointDeps } from "./types";

export function makeBuy(d: EndpointDeps) {
  const {
    rails: RAILS,
    defaultRail: DEFAULT_RAIL,
    margin: MARGIN,
    buyMinUsd: BUY_MIN_USD,
    buyMaxUsd: BUY_MAX_USD,
    orderTtlMs: ORDER_TTL_MS,
    maxOpenOrders: MAX_OPEN_ORDERS,
    maxBuyBodyBytes: MAX_BUY_BODY_BYTES,
    openCount,
    tryAddOrder,
    buyRateLimit,
  } = d;
  // In-flight createAddress reservations (this process). Gated at the slot check below so a burst never
  // starts more creates than free slots; per-handler state, resets between tests. See the reservation.
  let pendingCreates = 0;

  return async function buy(req: Request): Promise<Response> {
    // Global, identity-free burst guard — cheapest shed under a flood (no body/parse/wallet/rate I/O).
    // Fail-safe: throttles everyone, fine because /buy yields no free value. Bounds order-creation RATE
    // (cap bounds concurrent total, reaper bounds duration); none alone stops a determined attacker.
    if (buyRateLimit && !buyRateLimit.tryConsume()) {
      metrics.recordReject("buy"); // /buy local rate-limit shed
      return deny(429, "rate_limited");
    }
    const parsed = await readJsonBody(req, MAX_BUY_BODY_BYTES);
    if ("rejection" in parsed) return parsed.rejection;
    const body = parsed.body;
    const hash: string | null = typeof body?.hash === "string" ? body.hash : null;
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return deny(400, "invalid_hash");
    const creditUsd = body?.credit_usd;
    if (
      typeof creditUsd !== "number" ||
      !Number.isFinite(creditUsd) ||
      creditUsd < BUY_MIN_USD ||
      creditUsd > BUY_MAX_USD
    )
      return deny(400, "invalid_amount");
    // Resolve the pay rail: the request may name one (multi-rail); default to DEFAULT_RAIL. An unknown or
    // inactive rail is a 400 — never silently fall back, which would quote the wrong coin.
    const railName: string = typeof body?.rail === "string" ? body.rail : DEFAULT_RAIL;
    const r = RAILS.get(railName);
    if (!r) return deny(400, "unknown_rail");

    // Cheap pre-check: counts pendingCreates so the bulk of an over-cap flood sheds before the rate
    // round-trip; the load-bearing gate is the reservation below.
    if (openCount() + pendingCreates >= MAX_OPEN_ORDERS) {
      metrics.recordReject("orders"); // at the open-order cap
      return deny(503, "busy_try_later");
    }

    let rate: number;
    try {
      rate = await r.rateUsd();
    } catch (err) {
      log.warn("buy", `rate unavailable: ${log.errMsg(err)}`);
      return deny(503, "rate_unavailable");
    }
    // A resolved rate must be finite and positive. A degenerate value (0, negative, NaN, Infinity — a
    // broken/empty price source that RETURNS rather than throws) poisons the quote: expectedAtomic below
    // goes to 0 / non-finite, producing an order that can NEVER credit (settle skips it on the
    // `expected_atomic <= 0` guard) or credits nothing. Treat it exactly like an unavailable rate: a
    // retryable 503, never a stuck order. Same reason string so the health-check journal grep pages on it.
    if (!Number.isFinite(rate) || rate <= 0) {
      log.warn("buy", `rate invalid (${rate}); treating as unavailable`);
      return deny(503, "rate_unavailable");
    }
    // Expected amount = credit_usd × MARGIN dollars in atomic units, rounded UP so the margin is never
    // eroded. Credit is locked here (credit_micros); settlement credits proportional to the amount received
    // vs. this expectation, so no rate is re-fetched at payment time.
    const expectedAtomic = Math.ceil(((creditUsd * MARGIN) / rate) * r.scale);
    // One timestamp for stored created_at and quoted expires_at = created_at + ORDER_TTL_MS. The reaper
    // waits LONGER internally (see index.ts) so a deadline payment still gains its first confirmation.
    const createdAt = Date.now();

    // Reserve a create slot BEFORE the irreversible createAddress, gating on committed orders + creates
    // already in flight. The check and the ++ run with no await between them, so in this single-threaded
    // event loop they're atomic: at most (MAX_OPEN_ORDERS − openCount()) creates are ever in flight, so a
    // loser is shed HERE and never mints an address — closing the orphan-on-race the post-create claim
    // used to merely reject after the fact. Held until the row commits or the attempt fails, then released
    // in `finally` (a committed order is then counted by openCount() instead, keeping the sum stable).
    if (openCount() + pendingCreates >= MAX_OPEN_ORDERS) {
      metrics.recordReject("orders"); // at the open-order cap, reservation gate
      return deny(503, "busy_try_later");
    }
    pendingCreates++;
    try {
      let addr;
      try {
        // Label is a FIXED, non-identifying tag — never token-derived. The rail's wallet persists labels
        // in its own file, OUTSIDE this app's two-DB privacy boundary and not dropped at settle; a
        // hash-derived label would be a durable address→token link surviving the very deletion (settle.ts)
        // the design relies on. The real link lives only in pending.db while needed.
        addr = await r.createAddress("ns");
      } catch (err) {
        log.warn("buy", `createAddress failed: ${log.errMsg(err)}`);
        return deny(502, "wallet_unavailable");
      }
      // Hard cap backstop: the reservation already bounds in-process creates to the free-slot count, but
      // this count-gated insert is the authoritative, race-free ceiling that ALSO holds across processes
      // (two app instances sharing pending.db, where the in-memory counter can't see the other). In
      // single-process it never fails; if it ever does, log a COUNT-only line (no hash) and reject.
      const claimed = tryAddOrder(
        {
          rail: railName, // the buyer's chosen pay rail (defaults to DEFAULT_RAIL when the request omits it)
          order_index: addr.orderIndex,
          address: addr.address,
          hash,
          expected_atomic: expectedAtomic,
          credit_micros: Math.round(creditUsd * 1_000_000),
          received_atomic: 0,
          created_at: createdAt,
          rate_usd: rate, // lock the quote rate so settle books gross independent of any later MARGIN change
        },
        MAX_OPEN_ORDERS,
      );
      if (!claimed) {
        log.warn("buy", `slot race lost at cap; orphaned order index ${addr.orderIndex}`);
        metrics.recordReject("orders"); // cross-process claim lost at the cap
        return deny(503, "busy_try_later");
      }
      metrics.observeOpenOrders(openCount()); // high-water open orders — the count only RISES here, so observing at creation catches every peak (vs. a sampling tick)
      const amount = (expectedAtomic / r.scale).toFixed(decimalsOf(r.scale));
      return Response.json({
        pay_to: addr.address,
        pay_uri: r.paymentUri(addr.address, amount),
        amount,
        unit: r.unit,
        rate_usd: rate,
        confirmations_required: r.confirmations,
        expires_at: createdAt + ORDER_TTL_MS,
      });
    } finally {
      pendingCreates--;
    }
  };
}
