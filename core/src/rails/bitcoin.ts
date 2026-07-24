// Minimal bitcoind JSON-RPC client — the Bitcoin pay rail's watcher, against a WATCH-ONLY descriptor
// wallet (imported from an xpub; the spend key stays cold/offline). It mints receive addresses and lists
// confirmed deposits but holds NO spend authority — no spend method is exposed (the "watch-only online,
// cold custody" invariant). This module only talks to that watch-only descriptor wallet.
//
// bitcoind RPC needs auth (rpcuser/rpcpassword or the cookie) and is wallet-scoped, so BITCOIN_RPC_URL is
// the wallet endpoint, e.g. http://127.0.0.1:8332/wallet/nullsink.
import * as log from "../log";
import { numEnv } from "../env";
import { btcUsd } from "./rate";
import { SATS_PER_BTC } from "./units";
import { RAIL_META } from "./catalog";
import type { PayRail, NewPayment, CreatePaymentRequest, Incoming } from "./types";

export class BitcoinError extends Error {}

export type BitcoinOptions = {
  rpcUrl: string;
  rpcUser?: string;
  rpcPassword?: string;
  confirmations: number; // an output is `final` (creditable) at >= this many confirmations
  timeoutMs: number;
  fetchImpl?: typeof fetch; // injectable so tests don't hit a real bitcoind
};

export function makeBitcoin(opts: BitcoinOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const authHeader =
    opts.rpcUser != null ? "Basic " + Buffer.from(`${opts.rpcUser}:${opts.rpcPassword ?? ""}`).toString("base64") : undefined;

  async function rpc(method: string, params: unknown[] = []): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authHeader) headers.authorization = authHeader;
    // Force a fresh TCP connection per RPC instead of reusing Bun's fetch keep-alive pool. bitcoind closes
    // idle HTTP connections after rpcservertimeout (default 30s); the settlement poller ticks less often than
    // that, so the pooled socket is already dead by the next tick — Bun reuses it and the request fails with
    // "The socket connection was closed unexpectedly", silently blinding deposit detection (an on-chain,
    // confirmed payment never credits) while createPayment's burst of back-to-back calls stays inside the
    // window and works, masking the outage. A new connection per call is negligible against local RPC.
    headers.connection = "close";
    const res = await fetchImpl(opts.rpcUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: "0", method, params }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new BitcoinError(`bitcoind HTTP ${res.status}`);
    const json: any = await res.json();
    if (json?.error) throw new BitcoinError(`bitcoind ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
    return json?.result;
  }

  // The address index from an hdkeypath like "m/84h/0h/0h/0/5" → 5 (the last path element). Returns NaN for
  // an empty / missing / non-numeric path so the createPayment guard throws — WITHOUT the regex, Number("")
  // === 0 would silently key every order to index 0 (and the 2nd order would collide on the integer PK).
  function pathIndex(hdkeypath: string): number {
    const last = String(hdkeypath).split("/").pop() ?? "";
    if (!/^\d+[h']?$/.test(last)) return NaN;
    return Number(last.replace(/[h']/g, ""));
  }

  // Mint a fresh receive address. bitcoind's getnewaddress advances and PERSISTS the wallet's next-index,
  // so indices never repeat (no address reuse); we read that index back (getaddressinfo) and use it as the
  // order's integer key, then LABEL the address with it so the poller can map a deposit → order without
  // re-deriving. (The label arg the handler passes is ignored — we set our own, the index.)
  async function createPayment(_request?: CreatePaymentRequest): Promise<NewPayment> {
    const address = await rpc("getnewaddress");
    if (typeof address !== "string" || address.length === 0) throw new BitcoinError("getnewaddress: unexpected response");
    const info = await rpc("getaddressinfo", [address]);
    const orderIndex = pathIndex(info?.hdkeypath ?? "");
    if (!Number.isSafeInteger(orderIndex) || orderIndex < 0) throw new BitcoinError("getaddressinfo: could not read derivation index");
    await rpc("setlabel", [address, String(orderIndex)]);
    return { payTo: address, orderIndex };
  }

  // Confirmed-or-confirming deposits to the watched orders' addresses, normalised to Incoming. listunspent
  // returns one entry per UTXO (txid:vout); we never spend on the box, so deposits stay unspent until the
  // cold sweep — well after they've credited. minconf=0 + include_unsafe surface still-confirming outputs
  // (final=false) so /order-status can animate and settle's seen-set spares the order. Each UTXO's label
  // (set at createPayment) is its order index; we keep only the watched ones.
  //
  // The idempotency key is `bitcoin:txid:orderIndex` — NOT txid:vout — so multiple outputs of ONE tx to the
  // SAME order aggregate into one credit (pay-once), while one tx paying TWO of our addresses stays two keys.
  // The `bitcoin:` prefix namespaces it from Monero's legacy un-prefixed key in the shared applied_orders
  // table (see rails/types.ts), so coincident txids across rails can't alias. (Scaling note: listunspent returns the whole wallet's unspent
  // set; bounded by un-swept deposits. An address-scoped scan is the optimisation if volume grows.)
  async function incomingTransfers(orderIndices?: number[]): Promise<Incoming[]> {
    if (!orderIndices || orderIndices.length === 0) return [];
    const watched = new Set(orderIndices);
    const utxos = await rpc("listunspent", [0, 9_999_999, [], true]);
    const out: Incoming[] = [];
    for (const u of Array.isArray(utxos) ? utxos : []) {
      const labelStr = String(u?.label ?? "");
      if (!/^\d+$/.test(labelStr)) continue; // our addresses are labelled with the integer order index
      const orderIndex = Number(labelStr);
      if (!Number.isSafeInteger(orderIndex) || !watched.has(orderIndex)) continue; // not one of our open orders
      const sats = Math.round(Number(u?.amount ?? 0) * SATS_PER_BTC); // amount is BTC (float); round to sats
      if (!Number.isSafeInteger(sats)) {
        log.warn("wallet", `skipping utxo with unsafe amount ${u?.amount} (txid ${String(u?.txid).slice(0, 8)})`);
        continue;
      }
      if (sats <= 0) continue; // dust/zero — nothing to credit
      const confirmations = Number(u?.confirmations ?? 0);
      out.push({
        orderIndex,
        idempotencyKey: `bitcoin:${String(u?.txid ?? "")}:${orderIndex}`,
        amount: sats,
        confirmations,
        final: confirmations >= opts.confirmations,
      });
    }
    return out;
  }

  return { createPayment, incomingTransfers };
}

const RPC_URL = process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:8332/wallet/nullsink";
const RPC_USER = process.env.BITCOIN_RPC_USER;
const RPC_PASSWORD = process.env.BITCOIN_RPC_PASSWORD;
const TIMEOUT_MS = numEnv("BITCOIN_TIMEOUT_MS", 30_000, 100, 600_000);
// Finality depth (also shown to buyers as confirmations_required). 3 suits small buys; revisit toward the
// top of the band (BUY_MAX_USD defaults to $2000) if large BTC orders become common. A deeper
// reorg is vanishingly rare. Per-rail env (BITCOIN_CONFIRMATIONS) with NO shared fallback — a generic
// CONFIRMATIONS both rails read would let one value govern both at once. Routed through numEnv (range
// [0,720]) so a typo fails fast at boot rather than silently reverting to the default.
const CONFIRMATIONS = Math.floor(numEnv("BITCOIN_CONFIRMATIONS", 3, 0, 720));

const wallet = makeBitcoin({ rpcUrl: RPC_URL, rpcUser: RPC_USER, rpcPassword: RPC_PASSWORD, confirmations: CONFIRMATIONS, timeoutMs: TIMEOUT_MS });
export const bitcoinRail: PayRail = {
  name: "bitcoin",
  scale: SATS_PER_BTC,
  confirmations: CONFIRMATIONS,
  unit: RAIL_META.bitcoin.unit,
  createPayment: wallet.createPayment,
  incomingTransfers: wallet.incomingTransfers,
  rateUsd: btcUsd,
  paymentUri: (address, amount) => `bitcoin:${address}?amount=${amount}`,
};
