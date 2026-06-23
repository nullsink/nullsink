// The pay-rail contract. A rail mints per-order receive addresses and detects confirmed deposits to them;
// it never holds spend authority — the box watches, custody stays cold (the "watch-only online, cold
// custody" invariant; see /docs/trust-model.md). Monero (rails/monero.ts) is the reference
// implementation; Bitcoin (rails/bitcoin.ts) is next, keyed on the same INTEGER per-order index (Monero's
// subaddress minor index / Bitcoin's HD derivation index). A string order key is only needed for Lightning
// (payment_hash) and is deferred until then.

// A fresh per-order receive address: the address to pay, plus the rail's integer index for it — the key of
// the pending order (Monero subaddress minor index, Bitcoin HD derivation index).
export type NewAddress = { address: string; orderIndex: number };

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
  createAddress(label?: string): Promise<NewAddress>;
  incomingTransfers(orderIndices?: number[]): Promise<Incoming[]>;
  rateUsd(): Promise<number>;
  paymentUri(address: string, amount: string): string; // the coin's wallet URI for the pay QR (e.g. bitcoin:addr?amount=…)
}

// The per-rail view the request-handling layer needs (a subset of PayRail): mint an address, quote the rate,
// and format amounts — but NOT incomingTransfers (the poller's concern). /buy resolves one by the request's
// rail; /order-status by the looked-up order's own rail, so a BTC order renders BTC sats/unit even while
// Monero is also active. PayRail satisfies RailView structurally, so the composition root passes the live
// rails as RailViews directly. Lives here (next to PayRail) so the handler + endpoints/ share it without a
// cycle.
export type RailView = {
  name: string;
  createAddress: (label?: string) => Promise<NewAddress>;
  rateUsd: () => Promise<number>;
  scale: number;
  unit: string;
  confirmations: number;
  paymentUri: (address: string, amount: string) => string;
};
