// nullsink's own (non-metered) endpoints, assembled over one EndpointDeps bag. createHandler (handler.ts)
// calls makeEndpoints once and the router dispatches by method + path; the money/forward path (handleMetered)
// stays in the handler. Each handler is `(req) => Promise<Response>`.
import { makeBuy } from "./buy";
import { makeOrderStatus, makeRails, makeBalance } from "./reads";
import type { EndpointDeps } from "./types";

export type { EndpointDeps } from "./types";

export function makeEndpoints(d: EndpointDeps) {
  return {
    buy: makeBuy(d),
    orderStatus: makeOrderStatus(d),
    rails: makeRails(d),
    balance: makeBalance(d),
  };
}
