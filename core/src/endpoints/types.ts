// Shared dependency bag for nullsink's own (non-metered) endpoints — /buy, /order-status, /rails, /balance.
// createHandler builds this once (from HandlerDeps) and passes it to makeEndpoints (endpoints/index.ts).
// Each endpoint factory destructures only what it needs. Kept narrow on purpose (ISP): the endpoints see
// the rail registry + the order/balance store methods + the limits, never the full handler internals.
import type { RailView } from "../rails/types";
import type { BalanceStore } from "../ledger/db";
import type { OrdersStore } from "../ledger/orders";
import type { OrderProgress } from "../ledger/orderstatus";
import type { TokenBucket } from "../ratelimit";

export type EndpointDeps = {
  rails: Map<string, RailView>; // active pay rails keyed by name; /buy + /order-status resolve by it
  defaultRail: string; // the rail /buy quotes when a request omits one
  margin: number; // our cut, applied to the quote at /buy time
  buyMinUsd: number;
  buyMaxUsd: number;
  orderTtlMs: number; // quoted expires_at window
  maxOpenOrders: number; // global in-flight order ceiling (the only order cap)
  maxBuyBodyBytes: number; // body-size guard for /buy + /order-status
  getBalance: BalanceStore["getBalance"]; // /balance
  tryAddOrder: OrdersStore["tryAddOrder"]; // /buy: atomic slot-claiming insert
  openCount: OrdersStore["openCount"]; // /buy: in-flight ceiling pre-check
  latestOpenOrderByHash: OrdersStore["latestOpenOrderByHash"]; // /order-status
  buyRateLimit?: TokenBucket; // global /buy burst guard; omitted = no limit (tests)
  readRateLimit?: TokenBucket; // global read throttle for /order-status + /rails + /balance; omitted = no limit
  orderStatus?: (orderIndex: number, rail?: string) => OrderProgress | undefined; // live payment progress
};

// Render an atomic coin amount at its scale (a power of ten → decimals = digits of the scale minus 1).
// Each rail carries its own precision (e.g. 12 or 8 decimals). Shared by /buy + /order-status.
export const decimalsOf = (scale: number) => String(scale).length - 1;
