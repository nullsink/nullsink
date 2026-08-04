// Minimal monero-wallet-rpc (JSON-RPC 2.0) client — the Monero pay rail's wallet driver, and the
// reference PayRail implementation (rails/types.ts). The wallet on the box is VIEW-ONLY: it derives
// per-order subaddresses and lists incoming deposits but cannot spend (spend key stays cold/offline). No
// spend method is used or exposed here.
//
// Expects a localhost JSON-RPC endpoint; URL via MONERO_WALLET_RPC_URL.
import * as log from "../log";
import { numEnv } from "../env";
import { xmrUsd } from "./rate";
import { ATOMIC_PER_XMR } from "./units";
import { RAIL_META } from "./catalog";
import type { PayRail, NewPayment, CreatePaymentRequest, Incoming } from "./types";

export class MoneroError extends Error {}

export type MoneroOptions = {
  rpcUrl: string;
  accountIndex: number;
  confirmations: number; // finality depth — an output is `final` (creditable) at >= this many confirmations
  timeoutMs: number;
  fetchImpl?: typeof fetch; // injectable so tests don't hit a real wallet-rpc
};

// Build a wallet-rpc client bound to one endpoint. Prod uses the singleton below; tests inject a fetch
// returning canned JSON-RPC responses.
export function makeMonero(opts: MoneroOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const res = await fetchImpl(opts.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new MoneroError(`wallet-rpc HTTP ${res.status}`);
    const json: any = await res.json();
    if (json?.error) {
      throw new MoneroError(`wallet-rpc ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    return json?.result;
  }

  // Create a fresh per-order subaddress in the configured account. The subaddress minor index IS the
  // order's integer key (PayRail's orderIndex).
  async function createPayment(request?: CreatePaymentRequest): Promise<NewPayment> {
    const r = await rpc("create_address", { account_index: opts.accountIndex, label: request?.label });
    if (typeof r?.address !== "string" || typeof r?.address_index !== "number") {
      throw new MoneroError("create_address: unexpected response");
    }
    return { payTo: r.address, orderIndex: r.address_index };
  }

  // Confirmed incoming transfers in the configured account, normalised to the rail-neutral Incoming shape.
  // get_transfers returns ONE entry PER OUTPUT, so several may share a txid (multiple outputs, or paying
  // two of our subaddresses). We fetch only `in` (confirmed, confs ≥ 1), NOT the pool/unconfirmed set: an
  // on-chain confirmed transfer is monotonic, not flickering like a pool entry. But the wallet's REPORTING
  // is NOT monotonic: a rescan/node resync can transiently return an empty `in` (coerced to [] below),
  // indistinguishable here from "nobody paid yet" — which is why settle() keeps cross-tick `seen` state.
  // Pass `orderIndices` (subaddress minor indices) to scope get_transfers to just those subaddresses;
  // without it the account's full lifetime of outputs is returned every call, growing unbounded and
  // eventually tripping the timeout. An empty/omitted list means NO filter — wallet-rpc treats
  // subaddr_indices:[] as "all" — so a caller with nothing to watch must SKIP this call, not pass [].
  //
  // We OWN finality here: each output is marked `final` (confs ≥ our threshold AND not time-locked), and a
  // double-spend-flagged output is DROPPED entirely (it can never credit, so it must neither mark its order
  // "being paid" in settle's seen-set nor animate /order-status progress). The idempotency key is
  // `txid:minor` — NOT per-output — so several outputs of one tx to the SAME subaddress aggregate into one
  // credit, while one tx paying TWO subaddresses stays two distinct keys (the money-loss guard). Amounts
  // beyond JS-safe integer precision (~9000 XMR in one output) are dropped rather than
  // mis-credited from a lossy double-parse.
  async function incomingTransfers(orderIndices?: number[]): Promise<Incoming[]> {
    const params: Record<string, unknown> = { in: true, account_index: opts.accountIndex };
    if (orderIndices && orderIndices.length > 0) params.subaddr_indices = orderIndices;
    const r = await rpc("get_transfers", params);
    const list: any[] = Array.isArray(r?.in) ? r.in : [];
    const out: Incoming[] = [];
    for (const t of list) {
      const amount = Number(t?.amount ?? 0);
      if (!Number.isSafeInteger(amount)) {
        log.warn("wallet", `skipping transfer with unsafe amount ${t?.amount} (txid ${String(t?.txid).slice(0, 8)})`);
        continue;
      }
      if (t?.double_spend_seen === true) continue; // never credits → never surface it
      const orderIndex = Number(t?.subaddr_index?.minor ?? 0);
      const confirmations = Number(t?.confirmations ?? 0);
      const locked = t?.locked === true;
      out.push({
        orderIndex,
        idempotencyKey: `${String(t?.txid ?? "")}:${orderIndex}`,
        amount,
        confirmations,
        final: confirmations >= opts.confirmations && !locked,
      });
    }
    return out;
  }

  return { createPayment, incomingTransfers };
}

const RPC_URL = process.env.MONERO_WALLET_RPC_URL ?? "http://127.0.0.1:18083/json_rpc";
const ACCOUNT_INDEX = numEnv("MONERO_ACCOUNT_INDEX", 0, 0, 1_000_000);
const TIMEOUT_MS = numEnv("MONERO_TIMEOUT_MS", 30_000, 100, 600_000);
// Finality depth (also shown to buyers as confirmations_required). 10 = XMR finality. Per-rail env
// (MONERO_CONFIRMATIONS) with NO shared fallback — a generic CONFIRMATIONS both rails read would let one
// value govern both (dropping XMR's 10 to e.g. BTC's 3, a shallow reorg-exposed gate), the exact hazard the
// per-rail split exists to kill. Routed through numEnv (range [0,720]) so a typo fails fast at boot
// rather than silently reverting to the default and quietly weakening the gate.
const CONFIRMATIONS = Math.floor(numEnv("MONERO_CONFIRMATIONS", 10, 0, 720));

// The Monero rail: view-only wallet detection + the XMR/USD quote source (rate.ts) + the piconero scale
// (units.ts) + the confirmation depth. rails/index.ts registers it; the composition root selects active
// rails via PAY_RAILS (legacy PAY_RAIL = a single name); monero is the fallback default and, listed first,
// the /buy default.
const wallet = makeMonero({ rpcUrl: RPC_URL, accountIndex: ACCOUNT_INDEX, confirmations: CONFIRMATIONS, timeoutMs: TIMEOUT_MS });
export const moneroRail: PayRail = {
  name: "monero",
  scale: ATOMIC_PER_XMR,
  confirmations: CONFIRMATIONS,
  unit: RAIL_META.monero.unit,
  createPayment: wallet.createPayment,
  incomingTransfers: wallet.incomingTransfers,
  rateUsd: xmrUsd,
  paymentUri: (address, amount) => `monero:${address}?tx_amount=${amount}`,
};
