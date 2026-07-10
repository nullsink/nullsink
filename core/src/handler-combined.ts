// The BOTH-WORLDS router: prompt-world routes (handler.ts) + payment-world routes (payments-handler.ts)
// behind one handler. NOTHING IN PRODUCTION RUNS THIS. It survives the split as a test fixture: the handler
// tests and scripts/e2e-capture.ts drive /v1/*, /balance AND /buy through a single router, which is far
// cheaper than standing up two servers per test. It also keeps one copy of the pre-split routing shape to
// diff the two world routers against.
//
// LOAD-BEARING: neither composition root (proxy.ts / payments.ts) may import this module. It is the only
// place the two worlds' code meets, so importing it from a root would drag the other world's code into that
// binary — and the proxy binary is the unit stage 4 attests, which must stay minimal and payments-free.
// test/world-isolation.test.ts asserts no root reaches it, and scripts/assert-worlds.ts asserts the compiled
// proxy carries no payments symbols.
import { buildProxyRoutes, type ProxyHandlerDeps } from "./handler";
import { buildPaymentsRoutes, type PaymentsHandlerDeps } from "./payments-handler";
import { deny } from "./http";
import { BUILD_VERSION } from "./version";

// Re-exported so the handler tests keep a single import site for the monolith surface.
export { isModelNotFound, maskedErrorDetail } from "./handler";
export type { RailView } from "./rails/types";
export type { ProxyHandlerDeps } from "./handler";
export type { PaymentsHandlerDeps } from "./payments-handler";

// The union of both worlds' deps. The two roots each pass only their half.
export type HandlerDeps = ProxyHandlerDeps & PaymentsHandlerDeps;

export function createHandler(d: HandlerDeps): (req: Request) => Promise<Response> {
  const proxyRoutes = buildProxyRoutes(d);
  const paymentsRoutes = buildPaymentsRoutes(d);
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Local-only liveness check; never forwarded upstream. Unauthenticated.
    if (url.pathname === "/healthz") return new Response(`ok ${BUILD_VERSION}`);
    // The two worlds' paths are disjoint, so dispatch order is immaterial; each returns undefined for a path
    // it doesn't own, and anything unclaimed hits the fail-closed 404.
    return (await proxyRoutes(req, url)) ?? (await paymentsRoutes(req, url)) ?? deny(404, "unsupported_endpoint");
  };
}
