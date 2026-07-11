// Shared dependency bags for nullsink's own (non-metered) endpoints — /buy, /order-status, /rails, /balance.
// handler.ts and payments-handler.ts each build their world's bag and pass it to that world's endpoint
// factories (endpoints/proxy.ts, endpoints/payments.ts). Each endpoint factory destructures only what it needs. Kept narrow on purpose (ISP): the endpoints see
// the rail registry + the order/balance store methods + the limits, never the full handler internals.
import type { RailView } from "../rails/types";
import type { BalanceStore } from "../ledger/db";
import type { OrdersStore } from "../ledger/orders";
import type { OrderProgress } from "../ledger/orderstatus";
import type { TokenBucket } from "../ratelimit";
import type { ModelListing } from "../cost";

// Deps for the PROMPT-world endpoints (GET /balance, GET /v1/models) — built by the proxy composition root.
// Reads only the balance store + the served-model catalog; never the rails or order store.
export type ProxyEndpointDeps = {
  servedModels: ModelListing[]; // GET /v1/models: the priced models an active provider owns (computed once at boot)
  getBalance: BalanceStore["getBalance"]; // /balance
  readRateLimit?: TokenBucket; // global read throttle for /balance; omitted = no limit (tests). Its own bucket per world.
};

// Deps for the PAYMENT-world endpoints (POST /buy, POST /order-status, GET /rails) — built by the payments
// composition root. Reads only the rail registry + the order store; never the balance store.
export type PaymentsEndpointDeps = {
  rails: Map<string, RailView>; // active pay rails keyed by name; /buy + /order-status resolve by it
  defaultRail: string; // the rail /buy quotes when a request omits one
  margin: number; // our cut, applied to the quote at /buy time
  buyMinUsd: number;
  buyMaxUsd: number;
  orderTtlMs: number; // quoted expires_at window
  maxOpenOrders: number; // global in-flight order ceiling (the only order cap)
  maxBuyBodyBytes: number; // body-size guard for /buy + /order-status
  tryAddOrder: OrdersStore["tryAddOrder"]; // /buy: atomic slot-claiming insert
  openCount: OrdersStore["openCount"]; // /buy: in-flight ceiling pre-check
  latestOpenOrderByHash: OrdersStore["latestOpenOrderByHash"]; // /order-status unscoped fallback (no address)
  openOrderByHashAddress: OrdersStore["openOrderByHashAddress"]; // /order-status scoped to the client's tracked order
  buyRateLimit?: TokenBucket; // global /buy burst guard; omitted = no limit (tests)
  readRateLimit?: TokenBucket; // global read throttle for /order-status + /rails; omitted = no limit. Its own bucket per world.
  orderStatus?: (orderIndex: number, rail?: string) => OrderProgress | undefined; // live payment progress
};

// Render an atomic coin amount at its scale (a power of ten → decimals = digits of the scale minus 1).
// Each rail carries its own precision (e.g. 12 or 8 decimals). Shared by /buy + /order-status.
export const decimalsOf = (scale: number) => String(scale).length - 1;
