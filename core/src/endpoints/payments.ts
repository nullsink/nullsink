// PAYMENT-world endpoint assembly (/buy, /order-status, /rails). Imported by payments-handler.ts. The mirror
// of endpoints/proxy.ts: import this module, never the barrel, from the payment world.
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
