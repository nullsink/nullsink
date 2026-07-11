// PAYMENT-world request handler: quote a payment (/buy), poll an order (/order-status), list rails (/rails).
// A factory over an injected dependency bag, so tests supply in-memory stores and fake rate/wallet calls —
// no port, no network. payments.ts wires production deps.
//
// This module must NOT import anything prompt-world (the balance store, providers, the metered path). The
// mirror of handler.ts's rule: each binary bundles only its own world. The combined both-worlds router lives
// in test/support/handler-combined.ts, which neither composition root imports.
import { makePaymentsEndpoints } from "./endpoints/payments";
import { deny } from "./http";
import { BUILD_VERSION } from "./version";
import type { RailView } from "./rails/types";
import type { OrdersStore } from "./ledger/orders";
import type { OrderProgress } from "./ledger/orderstatus";
import type { TokenBucket } from "./ratelimit";

// RailView lives in rails/types.ts (shared without a cycle); re-exported here as the payment world's public
// handler type.
export type { RailView } from "./rails/types";

export type PaymentsHandlerDeps = {
  orders: OrdersStore;
  // Pay-rail registry: every active rail keyed by name (PayRail satisfies RailView structurally, so the
  // composition root passes the live rails directly), plus which one /buy defaults to when a request omits
  // `rail`. /buy resolves by the request's rail; /order-status by the looked-up order's rail. Tests build a
  // one-entry map; payments.ts passes the multi-rail set.
  rails: Map<string, RailView>;
  defaultRail: string;
  margin: number; // our cut, applied to the quote at /buy time
  buyMinUsd: number;
  buyMaxUsd: number;
  orderTtlMs: number; // quoted expires_at window: how long the buyer is told the address stays valid
  maxOpenOrders: number;
  maxBuyBodyBytes: number;
  buyRateLimit?: TokenBucket; // global, identity-free /buy rate limit; omitted = no limit (e.g. tests)
  // Global, identity-free throttle for this world's unauthenticated READ endpoints (/order-status, /rails).
  // Fail-safe, no IP/token key (privacy thesis). Omitted = no limit (e.g. tests). Each process gets its OWN
  // bucket, so the two together must be retuned or aggregate read capacity doubles.
  readRateLimit?: TokenBucket;
  // Live per-order payment progress for /order-status (the poller's last-seen sighting). Omitted in tests
  // that don't exercise /order-status; absent → every open order reads as "waiting".
  orderStatus?: (orderIndex: number, rail?: string) => OrderProgress | undefined;
};

// Dispatch only the PAYMENT-world paths. undefined = "not mine" (the combined router already tried the
// prompt-world routes; createPaymentsHandler turns it into the fail-closed 404).
export function buildPaymentsRoutes(d: PaymentsHandlerDeps): (req: Request, url: URL) => Promise<Response> | undefined {
  const { tryAddOrder, openCount, latestOpenOrderByHash, openOrderByHashAddress } = d.orders;
  const endpoints = makePaymentsEndpoints({
    rails: d.rails,
    defaultRail: d.defaultRail,
    margin: d.margin,
    buyMinUsd: d.buyMinUsd,
    buyMaxUsd: d.buyMaxUsd,
    orderTtlMs: d.orderTtlMs,
    maxOpenOrders: d.maxOpenOrders,
    maxBuyBodyBytes: d.maxBuyBodyBytes,
    tryAddOrder,
    openCount,
    latestOpenOrderByHash,
    openOrderByHashAddress,
    buyRateLimit: d.buyRateLimit,
    readRateLimit: d.readRateLimit,
    orderStatus: d.orderStatus,
  });

  return function paymentsRoutes(req: Request, url: URL): Promise<Response> | undefined {
    if (req.method === "POST" && url.pathname === "/buy") return endpoints.buy(req);
    if (req.method === "POST" && url.pathname === "/order-status") return endpoints.orderStatus(req);
    if (req.method === "GET" && url.pathname === "/rails") return endpoints.rails(req);
    return undefined;
  };
}

// The payments service's HTTP handler: payment-world routes + /healthz, fail-closed 404 on anything else.
// payments.ts wires this to Bun.serve. (The credit crossing is a separate unix socket, not an HTTP route.)
export function createPaymentsHandler(d: PaymentsHandlerDeps): (req: Request) => Promise<Response> {
  const routes = buildPaymentsRoutes(d);
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Local-only liveness check; never forwarded upstream. Unauthenticated.
    if (url.pathname === "/healthz") return new Response(`ok ${BUILD_VERSION}`);
    return (await routes(req, url)) ?? deny(404, "unsupported_endpoint");
  };
}
