// The BOTH-WORLDS router: prompt-world routes (handler.ts) + payment-world routes (payments-handler.ts)
// behind one handler. This is the pre-split monolith's shape, kept for src/index.ts (until the two
// composition roots replace it) and for the handler tests that drive /v1/*, /balance AND /buy through a
// single router.
//
// LOAD-BEARING: neither composition root (proxy.ts / payments.ts) may import this module. It is the only
// place the two worlds' code meets, so importing it from a root would drag the other world's code into that
// binary — and the proxy binary is the unit stage 4 attests, which must stay minimal and payments-free. A
// build-time check asserts the compiled proxy carries no payments symbols.
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
