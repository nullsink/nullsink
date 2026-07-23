// LND REST payment rail. Unlike the on-chain rails, LND is NOT watch-only: it holds hot channel keys and
// money-critical channel/invoice state. Keep it disabled unless `lightning` is explicitly listed in
// PAY_RAILS, use an invoice-only macaroon, and cap funds exposed to the node.
//
// This first integration deliberately uses AddInvoice for creation and paginated ListInvoices for
// authoritative reconciliation. A later fast path may wake settlement from SubscribeInvoices, but must
// never replace reconciliation: stream cursors have bootstrap/crash boundaries and notifications can be
// missed. LND's monotonically increasing add_index fits Nullsink's existing integer order_index.
import { numEnv } from "../env";
import { btcUsd } from "./rate";
import { RAIL_META } from "./catalog";
import { SATS_PER_BTC } from "./units";
import type { CreatePaymentRequest, Incoming, NewPayment, PayRail } from "./types";

export class LightningError extends Error {}

export type LightningOptions = {
  restUrl: string;
  macaroonHex: string;
  timeoutMs: number;
  pageSize?: number;
  maxPages?: number;
  tlsCa?: string | Blob; // LND's self-signed tls.cert, trusted explicitly (never disable verification)
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const decimalUint = /^(0|[1-9]\d*)$/;

// Protobuf's REST gateway serializes uint64/int64 values as decimal strings. Parse only canonical,
// non-negative integers and reject values outside JS's exact integer range; rounding an add_index could
// associate a payment with the wrong pending order.
function safeUint(value: unknown, field: string, allowZero = true): number {
  if (typeof value !== "string" || !decimalUint.test(value)) {
    throw new LightningError(`${field}: expected a decimal integer string`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || (!allowZero && n === 0)) {
    throw new LightningError(`${field}: outside the supported integer range`);
  }
  return n;
}

// LND REST returns protobuf bytes as padded standard base64. The payment hash is exactly 32 bytes. Buffer's
// decoder is intentionally permissive, so verify the round-trip too instead of accepting truncated/garbage
// input that could weaken the exactly-once key.
function paymentHashHex(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LightningError("r_hash: expected base64");
  }
  const bytes = Buffer.from(value, "base64");
  const canonical = bytes.toString("base64");
  if (bytes.length !== 32 || canonical !== value) {
    throw new LightningError("r_hash: expected canonical base64 for 32 bytes");
  }
  return bytes.toString("hex");
}

export function makeLightning(opts: LightningOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 100;
  const baseUrl = opts.restUrl.replace(/\/+$/, "");
  const parsedBaseUrl = new URL(baseUrl);
  const loopback = parsedBaseUrl.hostname === "127.0.0.1" || parsedBaseUrl.hostname === "::1" || parsedBaseUrl.hostname === "localhost";
  if (parsedBaseUrl.protocol !== "https:" && !(parsedBaseUrl.protocol === "http:" && loopback)) {
    throw new LightningError("LND_REST_URL must use HTTPS except on loopback");
  }

  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new LightningError("pageSize must be an integer in [1, 1000]");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new LightningError("maxPages must be an integer in [1, 10000]");
  }

  function authHeaders(): Record<string, string> {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(opts.macaroonHex)) {
      throw new LightningError("LND_MACAROON_HEX is missing or malformed");
    }
    return {
      "content-type": "application/json",
      "Grpc-Metadata-macaroon": opts.macaroonHex,
    };
  }

  async function request(path: string, init: RequestInit): Promise<any> {
    const fetchOptions = {
      ...init,
      headers: { ...authHeaders(), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(opts.timeoutMs),
      ...(opts.tlsCa ? { tls: { ca: [opts.tlsCa] } } : {}),
    };
    const res = await fetchImpl(`${baseUrl}${path}`, fetchOptions);
    if (!res.ok) throw new LightningError(`LND HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new LightningError("LND returned invalid JSON");
    }
  }

  async function createPayment(requestInfo: CreatePaymentRequest): Promise<NewPayment> {
    const { amountAtomic, expiresAt } = requestInfo;
    if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) {
      throw new LightningError("invoice amount must be a positive safe integer number of satoshis");
    }
    // Floor so the LND invoice never outlives the deadline Nullsink advertised. One second is the minimum
    // meaningful REST value; an already-expired request fails rather than minting a default-24h invoice.
    const expirySeconds = Math.floor((expiresAt - now()) / 1000);
    if (!Number.isSafeInteger(expirySeconds) || expirySeconds < 1) {
      throw new LightningError("invoice deadline has already expired");
    }

    const body = await request("/v1/invoices", {
      method: "POST",
      body: JSON.stringify({
        value: String(amountAtomic),
        expiry: String(expirySeconds),
        memo: "", // fixed and non-identifying; never persist a token-derived label in LND
      }),
    });
    const payTo = body?.payment_request;
    if (typeof payTo !== "string" || payTo.length === 0 || payTo.length > 4096) {
      throw new LightningError("AddInvoice: invalid payment_request");
    }
    const orderIndex = safeUint(body?.add_index, "add_index", false);
    paymentHashHex(body?.r_hash); // validate now; reconciliation later uses this as its idempotency key
    return { payTo, orderIndex };
  }

  async function incomingTransfers(orderIndices?: number[]): Promise<Incoming[]> {
    if (!orderIndices || orderIndices.length === 0) return [];
    const watched = new Set<number>();
    for (const index of orderIndices) {
      if (!Number.isSafeInteger(index) || index <= 0) {
        throw new LightningError("open Lightning order has an invalid add_index");
      }
      watched.add(index);
    }
    const first = Math.min(...watched);
    const last = Math.max(...watched);
    let offset = first - 1; // ListInvoices returns invoices AFTER index_offset.
    const out: Incoming[] = [];

    for (let page = 0; page < maxPages && offset < last; page++) {
      const query = new URLSearchParams({
        index_offset: String(offset),
        num_max_invoices: String(pageSize),
        reversed: "false",
        pending_only: "false", // settled invoices are the authoritative records we need
      });
      const body = await request(`/v1/invoices?${query}`, { method: "GET" });
      if (!Array.isArray(body?.invoices)) throw new LightningError("ListInvoices: missing invoices array");
      if (body.invoices.length === 0) return out;

      let largestInvoiceIndex = offset;
      for (const invoice of body.invoices) {
        const orderIndex = safeUint(invoice?.add_index, "invoice.add_index", false);
        largestInvoiceIndex = Math.max(largestInvoiceIndex, orderIndex);
        if (!watched.has(orderIndex) || invoice?.state !== "SETTLED") continue;
        const amount = safeUint(invoice?.amt_paid_sat, "invoice.amt_paid_sat", false);
        out.push({
          orderIndex,
          idempotencyKey: `lightning:${paymentHashHex(invoice?.r_hash)}`,
          amount,
          confirmations: 0,
          final: true,
        });
      }

      const nextOffset = safeUint(body?.last_index_offset, "last_index_offset");
      // Fail loudly instead of either looping forever or reporting a successful empty reconciliation.
      if (nextOffset <= offset || nextOffset < largestInvoiceIndex) {
        throw new LightningError("ListInvoices: pagination did not advance");
      }
      offset = nextOffset;
    }

    if (offset < last) {
      throw new LightningError(`ListInvoices exceeded the ${maxPages}-page reconciliation cap`);
    }
    return out;
  }

  return { createPayment, incomingTransfers };
}

const REST_URL = process.env.LND_REST_URL ?? "https://127.0.0.1:8080";
const MACAROON_HEX = process.env.LND_MACAROON_HEX ?? "";
const TLS_CERT_PATH = process.env.LND_TLS_CERT_PATH;
const TIMEOUT_MS = numEnv("LND_TIMEOUT_MS", 30_000, 100, 600_000);
const PAGE_SIZE = Math.floor(numEnv("LND_INVOICE_PAGE_SIZE", 100, 1, 1000));
const MAX_PAGES = Math.floor(numEnv("LND_INVOICE_MAX_PAGES", 100, 1, 10_000));
const ORDER_TTL_MS = numEnv("LIGHTNING_ORDER_TTL_MS", 30 * 60 * 1000, 5 * 60 * 1000, 4 * 60 * 60 * 1000);

const lnd = makeLightning({
  restUrl: REST_URL,
  macaroonHex: MACAROON_HEX,
  timeoutMs: TIMEOUT_MS,
  pageSize: PAGE_SIZE,
  maxPages: MAX_PAGES,
  tlsCa: TLS_CERT_PATH ? Bun.file(TLS_CERT_PATH) : undefined,
});

export const lightningRail: PayRail = {
  name: "lightning",
  scale: SATS_PER_BTC,
  confirmations: 0,
  unit: RAIL_META.lightning.unit,
  orderTtlMs: ORDER_TTL_MS,
  createPayment: lnd.createPayment,
  incomingTransfers: lnd.incomingTransfers,
  rateUsd: btcUsd,
  paymentUri: (invoice) => `lightning:${invoice}`,
};
