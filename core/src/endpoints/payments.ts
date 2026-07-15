// PAYMENTS TRUST DOMAIN endpoint assembly (/buy, /order-status, /rails). Imported by payments-handler.ts. The mirror
// of endpoints/proxy.ts: the payments trust domain imports this and only this — never the proxy trust domain's assembly.
import { makeBuy } from "./buy";
import { makeOrderStatus, makeRails } from "./payment-reads";
import type { PaymentsEndpointDeps } from "./types";

export function makePaymentsEndpoints(d: PaymentsEndpointDeps) {
  return {
    buy: makeBuy(d),
    orderStatus: makeOrderStatus(d),
    rails: makeRails(d),
  };
}
