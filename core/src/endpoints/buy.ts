// POST /buy: quote a crypto payment for a token. The client generates its token locally and sends only the
// hash; the poller credits it once the deposit confirms. Self-serve and public: the billing hold is a sound
// upper bound (hold.ts), so /buy yields no free usage. Extracted from handler.ts.
import { deny, denyThrottled, readJsonBody } from "../http";
import * as log from "../log";
import * as metrics from "../metrics";
import { decimalsOf, type PaymentsEndpointDeps } from "./types";

export function makeBuy(d: PaymentsEndpointDeps) {
  const {
    rails: RAILS,
    defaultRail: DEFAULT_RAIL,
    margin: MARGIN,
    buyMinUsd: BUY_MIN_USD,
    buyMaxUsd: BUY_MAX_USD,
    orderTtlMs: ORDER_TTL_MS,
    orderTrackingMs: ORDER_TRACKING_MS,
    maxOpenOrders: MAX_OPEN_ORDERS,
    maxBuyBodyBytes: MAX_BUY_BODY_BYTES,
    openCount,
    tryAddOrder,
    latestOpenOrderByHash,
    hasUnackedCreditForHash,
    buyRateLimit,
  } = d;
  // In-flight createAddress reservations (this process). Gated at the slot check below so a burst never
  // starts more creates than free slots; per-handler state, resets between tests. See the reservation.
  let pendingCreates = 0;
  // Per-process single-flight reservation. The store insert below repeats the hash predicate atomically for
  // a second process sharing pending.db; this set avoids minting an orphan address in the common case.
  const creatingHashes = new Set<string>();

  return async function buy(req: Request): Promise<Response> {
    // Global, identity-free burst guard — cheapest shed under a flood (no body/parse/wallet/rate I/O).
    // Fail-safe: throttles everyone, fine because /buy yields no free value. Bounds order-creation RATE
    // (cap bounds concurrent total, reaper bounds duration); none alone stops a determined attacker.
    if (buyRateLimit && !buyRateLimit.tryConsume()) {
      metrics.recordReject("buy"); // /buy local rate-limit shed
      // Match the free-read throttle: a real 429 carries a concrete backoff hint, not just a code.
      return denyThrottled(1);
    }
    // Version the payment-state contract at the request boundary. Old already-loaded bundles stop tracking
    // at expires_at and can offer a replacement after an earlier payment has fully delivered (when no live
    // hash remains to guard). Reject them after backend activation; they remain blocked until a refresh loads
    // the new UI (an older bundle does not know the new error code's refresh-specific copy). Unknown
    // headers are ignored by the old backend, so the new UI is also safe during the opposite deploy half.
    if (req.headers.get("x-nullsink-quote-contract") !== "2")
      return deny(409, "client_upgrade_required");
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

    // A pay-once address cannot safely overlap another order for the same bearer balance. This is also the
    // backward-compatibility guard for an old loaded UI: even if it stops polling at expires_at and offers a
    // replacement, the original order (or its queued credit) owns the hash until settle/reap/definite ack.
    if (creatingHashes.has(hash) || latestOpenOrderByHash(hash) || hasUnackedCreditForHash(hash))
      return deny(409, "order_in_progress");
    creatingHashes.add(hash);
    try {

    // Cheap pre-check: counts pendingCreates so the bulk of an over-cap flood sheds before the rate
    // round-trip; the load-bearing gate is the reservation below.
    if (openCount() + pendingCreates >= MAX_OPEN_ORDERS) {
      metrics.recordReject("orders"); // at the open-order cap
      return deny(503, "busy_try_later");
    }

    let rate: number;
    try {
      rate = await r.rateUsd();
    } catch {
      // Source exceptions can contain URLs/response fragments. Keep the journal event categorical.
      log.warn("buy", "rate unavailable");
      return deny(503, "rate_unavailable");
    }
    // A resolved rate must be finite and positive. A degenerate value (0, negative, NaN, Infinity — a
    // broken/empty price source that RETURNS rather than throws) poisons the quote: expectedAtomic below
    // goes to 0 / non-finite, producing an order that can NEVER credit (settle skips it on the
    // `expected_atomic <= 0` guard) or credits nothing. Treat it exactly like an unavailable rate: a
    // retryable 503, never a stuck order. Same reason string so the health-check journal grep pages on it.
    if (!Number.isFinite(rate) || rate <= 0) {
      log.warn("buy", "rate invalid; treating as unavailable");
      return deny(503, "rate_unavailable");
    }
    // Expected amount = credit_usd × MARGIN dollars in atomic units, rounded UP so the margin is never
    // eroded. Credit is locked here (credit_micros); settlement credits proportional to the amount received
    // vs. this expectation, so no rate is re-fetched at payment time.
    const expectedAtomic = Math.ceil(((creditUsd * MARGIN) / rate) * r.scale);
    // One timestamp for stored created_at and quoted expires_at = created_at + ORDER_TTL_MS. The reaper
    // waits LONGER internally (see payments.ts) so a deadline payment still gains its first confirmation.
    const createdAt = Date.now();

    // Reserve a create slot BEFORE the irreversible createAddress, gating on committed orders + creates
    // already in flight. The check and the ++ run with no await between them, so in this single-threaded
    // event loop they're atomic: at most (MAX_OPEN_ORDERS − openCount()) creates are ever in flight, so a
    // loser is shed HERE and never mints an address — a claim made only after the create would reject the
    // race but orphan the minted address. Held until the row commits or the attempt fails, then released
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
      } catch {
        // Wallet RPC exceptions are not a safe logging boundary; they may echo response or request fields.
        log.warn("buy", "createAddress failed");
        return deny(502, "wallet_unavailable");
      }
      // Hard cross-process backstop: the statement atomically claims global capacity and proves this hash
      // has neither another live order nor an undelivered credit.
      // In one process both reservations above prevent this path; another process can still win while the
      // wallet call is in flight, leaving an orphaned but never-displayed address here.
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
        log.warn("buy", "slot/hash race lost after address creation");
        if (latestOpenOrderByHash(hash) || hasUnackedCreditForHash(hash))
          return deny(409, "order_in_progress");
        metrics.recordReject("orders"); // cross-process claim lost at the global cap
        return deny(503, "busy_try_later");
      }
      metrics.observeOpenOrders(openCount()); // high-water open orders — the count only RISES here, so observing at creation catches every peak (vs. a sampling tick)
      const amount = (expectedAtomic / r.scale).toFixed(decimalsOf(r.scale));
      return Response.json({
        contract: 2,
        pay_to: addr.address,
        pay_uri: r.paymentUri(addr.address, amount),
        amount,
        unit: r.unit,
        rate_usd: rate,
        confirmations_required: r.confirmations,
        // Additive anchor for clock-skew-safe clients. They apply the durations below to the monotonic time
        // at which /buy was requested, so a fast/slow device clock cannot extend payment validity.
        created_at: createdAt,
        expires_at: createdAt + ORDER_TTL_MS,
        // Additive contract: cached older clients ignore this field. New clients hide the now-invalid
        // payment details at expires_at but keep polling by HASH until this exact server reap horizon, so
        // a payment sent near the deadline is not abandoned before its first wallet sighting.
        tracking_until: createdAt + ORDER_TRACKING_MS,
      });
    } finally {
      pendingCreates--;
    }
    } finally {
      creatingHashes.delete(hash);
    }
  };
}
