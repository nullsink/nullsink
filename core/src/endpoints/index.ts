// nullsink's own (non-metered) endpoints, split by world for the stage-2 process split. The proxy composition
// root builds the PROMPT-world half (/balance, /v1/models); the payments root builds the PAYMENT-world half
// (/buy, /order-status, /rails). createHandler builds BOTH (makeEndpoints) for tests + the pre-split monolith.
// Each handler is `(req) => Promise<Response>`; the money/forward path (handleMetered) stays in the handler.
import { makeBuy } from "./buy";
import { makeOrderStatus, makeRails, makeBalance, makeModels } from "./reads";
import type { EndpointDeps, ProxyEndpointDeps, PaymentsEndpointDeps } from "./types";

export type { EndpointDeps, ProxyEndpointDeps, PaymentsEndpointDeps } from "./types";

// PROMPT world (proxy): reads only the balance store + served-model catalog.
export function makeProxyEndpoints(d: ProxyEndpointDeps) {
  return {
    balance: makeBalance(d),
    models: makeModels(d),
  };
}

// PAYMENT world (payments): reads only the rail registry + the order store.
export function makePaymentsEndpoints(d: PaymentsEndpointDeps) {
  return {
    buy: makeBuy(d),
    orderStatus: makeOrderStatus(d),
    rails: makeRails(d),
  };
}

// Both worlds — createHandler wires all five (EndpointDeps satisfies both halves).
export function makeEndpoints(d: EndpointDeps) {
  return { ...makeProxyEndpoints(d), ...makePaymentsEndpoints(d) };
}
