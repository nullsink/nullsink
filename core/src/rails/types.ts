// The pay-rail contract. A rail creates one payment request per order and detects funds received against
// it. On-chain rails return a fresh address; Lightning returns an amount-bound BOLT11 invoice. The
// settlement core deliberately sees the same shape for both.

// The information a rail needs to create a payment destination. Lightning consumes amountAtomic and
// expiresAt when encoding its invoice; address-based rails currently need only the non-identifying label.
export type CreatePaymentRequest = {
  amountAtomic: number;
  expiresAt: number; // unix ms
  label?: string;
};

// A fresh per-order payment destination plus the rail's integer key. `payTo` is an on-chain address or a
// BOLT11 invoice. Keeping the rail-owned key numeric lets the existing composite (rail, order_index)
// pending-order key support LND's monotonically increasing add_index without a schema migration.
export type NewPayment = { payTo: string; orderIndex: number };

// A confirmed-or-confirming incoming deposit, already normalised by the rail. The rail computes finality
// (`final`) by its own rule and supplies an opaque `idempotencyKey` unique per creditable unit, so the
// settlement core stays coin-agnostic — it never sees txids, a confirmations threshold, or Monero's
// locked / double-spend flags (all folded into `final` inside the rail).
export type Incoming = {
  orderIndex: number; // the open order this pays (the rail's per-order index)
  // The applied-orders key — unique per creditable unit AND globally unique ACROSS rails (they share one
  // applied_orders table). Monero is the legacy un-prefixed "txid:minor"; every OTHER rail prefixes its name
  // ("bitcoin:txid:idx") so two rails' keys can't alias even on a coincident txid. Monero stays un-prefixed
  // safely — it's the only un-prefixed rail and the keys are high-entropy on-chain hashes; never re-prefix a
  // rail that has live in-flight deposits (the format change would miss its old marker and double-credit).
  idempotencyKey: string;
  amount: number; // atomic units of the rail's coin (PayRail.scale atomic units per whole coin)
  confirmations: number; // depth, for the /order-status progress display (0 for an instant-final rail)
  final: boolean; // rail-computed: eligible to credit now
};

export interface PayRail {
  name: string;
  scale: number; // atomic units per whole coin (units.ts)
  confirmations: number; // finality depth this rail credits at — also shown to buyers as confirmations_required
  unit: string; // display ticker shown to buyers, e.g. "BTC"
  orderTtlMs?: number; // rail-specific quote lifetime; absent uses the service-wide on-chain default
  createPayment(request: CreatePaymentRequest): Promise<NewPayment>;
  incomingTransfers(orderIndices?: number[]): Promise<Incoming[]>;
  rateUsd(): Promise<number>;
  paymentUri(payTo: string, amount: string): string; // wallet URI for the QR; Lightning's payTo already embeds amount
}

// The per-rail view the request-handling layer needs (a subset of PayRail): mint an address, quote the rate,
// and format amounts — but NOT incomingTransfers (the poller's concern). /buy resolves one by the request's
// rail; /order-status by the looked-up order's own rail, so a BTC order renders BTC sats/unit even while
// Monero is also active. PayRail satisfies RailView structurally, so the composition root passes the live
// rails as RailViews directly. Lives here (next to PayRail) so the handler + endpoints/ share it without a
// cycle.
export type RailView = {
  name: string;
  createPayment: (request: CreatePaymentRequest) => Promise<NewPayment>;
  rateUsd: () => Promise<number>;
  scale: number;
  unit: string;
  confirmations: number;
  orderTtlMs?: number;
  paymentUri: (address: string, amount: string) => string;
};
