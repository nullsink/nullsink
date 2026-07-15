// TEST-ONLY combined trust-domain router: proxy trust domain routes (src/handler.ts) + payments trust domain routes
// (src/payments-handler.ts) behind one handler. The handler tests and scripts/e2e-capture.ts drive /v1/*,
// /balance AND /buy through a single router, which is far cheaper than standing up two servers per test.
//
// LOAD-BEARING: neither composition root (proxy.ts / payments.ts) may import this module. It is the only
// place code from the two trust domains meets, so importing it from a root would drag the other trust domain's
// code into that binary — and the proxy binary is the unit the sealed tier attests, which must stay minimal and
// payments-free. test/trust-domain-isolation.test.ts asserts no root reaches outside src, and
// scripts/assert-trust-domains.ts cross-checks Bun's inputs plus the compiled binaries.
import { buildProxyRoutes, type ProxyHandlerDeps } from "../../src/handler";
import { buildPaymentsRoutes, type PaymentsHandlerDeps } from "../../src/payments-handler";
import { deny } from "../../src/http";
import { BUILD_VERSION } from "../../src/version";

// Re-exported so the handler tests keep a single import site for the combined surface.
export { isModelNotFound, maskedErrorDetail } from "../../src/handler";
export type { RailView } from "../../src/rails/types";
export type { ProxyHandlerDeps } from "../../src/handler";
export type { PaymentsHandlerDeps } from "../../src/payments-handler";

// The union of both trust domains' deps. The two roots each pass only their half.
export type HandlerDeps = ProxyHandlerDeps & PaymentsHandlerDeps;

export function createHandler(d: HandlerDeps): (req: Request) => Promise<Response> {
  const proxyRoutes = buildProxyRoutes(d);
  const paymentsRoutes = buildPaymentsRoutes(d);
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Local-only liveness check; never forwarded upstream. Unauthenticated.
    if (url.pathname === "/healthz") return new Response(`ok ${BUILD_VERSION}`);
    // The two trust domains' paths are disjoint, so dispatch order is immaterial; each returns undefined for a path
    // it doesn't own, and anything unclaimed hits the fail-closed 404.
    return (await proxyRoutes(req, url)) ?? (await paymentsRoutes(req, url)) ?? deny(404, "unsupported_endpoint");
  };
}
