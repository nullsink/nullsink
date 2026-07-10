// Barrel for nullsink's own (non-metered) endpoints. ONLY the combined test router
// (test/support/handler-combined.ts) and tests import this — it joins both worlds, so pulling it from a composition root would drag the other world's code
// into that binary. The prompt world imports ./endpoints/proxy; the payment world imports ./endpoints/payments.
import { makeProxyEndpoints } from "./proxy";
import { makePaymentsEndpoints } from "./payments";
import type { EndpointDeps } from "./types";

export { makeProxyEndpoints } from "./proxy";
export { makePaymentsEndpoints } from "./payments";
export type { EndpointDeps, ProxyEndpointDeps, PaymentsEndpointDeps } from "./types";

// Both worlds — EndpointDeps satisfies each half. The two halves have disjoint keys, so the spread can't
// collide: {balance, models} + {buy, orderStatus, rails}.
export function makeEndpoints(d: EndpointDeps) {
  return { ...makeProxyEndpoints(d), ...makePaymentsEndpoints(d) };
}
