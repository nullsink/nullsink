// PROTOTYPE — pins the network contract in lib/api.ts, the one logic-bearing client module with no dedicated
// test (QuotePay.test mocks the whole module away). Each request's body/headers and each status/error branch
// is exercised against a stubbed global fetch. Privacy-critical: the raw token may appear ONLY in /balance.
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { requestQuote, checkBalance, getRails, fetchOrderStatus, balanceErrorMessage, buyErrorMessage, trocadorSwapUrl, TROCADOR_ANONPAY_URL } from "./api.ts";

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

// Install a fetch stub that returns whatever `responder` produces (a Response, or a thrown error to model a
// network failure). Records every call for body/header assertions.
function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyOf = (c: Call) => JSON.parse(c.init!.body as string);

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// --- requestQuote -----------------------------------------------------------
test("requestQuote omits `rail` when not given, includes it when given", async () => {
  stubFetch(() => json({ pay_to: "addr", amount: "1.0", unit: "XMR", pay_uri: "monero:addr", rate_usd: 150, confirmations_required: 10, expires_at: 1 }));
  await requestQuote("HASH", 25);
  expect(bodyOf(calls[0])).toEqual({ hash: "HASH", credit_usd: 25 }); // no rail key at all
  expect("rail" in bodyOf(calls[0])).toBe(false);

  calls = [];
  await requestQuote("HASH", 25, "bitcoin");
  expect(bodyOf(calls[0])).toEqual({ hash: "HASH", credit_usd: 25, rail: "bitcoin" });
  expect(calls[0].url).toBe("/buy");
  expect((calls[0].init!.method)).toBe("POST");
});

test("requestQuote returns the parsed quote on 200", async () => {
  const quote = { pay_to: "8addr", amount: "0.12345678", unit: "BTC", pay_uri: "bitcoin:8addr?amount=0.12345678", rate_usd: 60000, confirmations_required: 3, expires_at: 1234 };
  stubFetch(() => json(quote));
  expect(await requestQuote("H", 50)).toEqual(quote);
});

test("requestQuote throws {code:'network', status:0} when fetch itself rejects", async () => {
  stubFetch(() => { throw new TypeError("Failed to fetch"); });
  await expect(requestQuote("H", 10)).rejects.toEqual({ code: "network", status: 0 });
});

test("requestQuote throws {code, status} parsed from a non-OK JSON error body", async () => {
  stubFetch(() => json({ error: "rate_unavailable" }, 503));
  await expect(requestQuote("H", 10)).rejects.toEqual({ code: "rate_unavailable", status: 503 });
});

test("requestQuote throws {code:'unknown', status} when the non-OK body isn't JSON", async () => {
  stubFetch(() => new Response("upstream blew up", { status: 500 }));
  await expect(requestQuote("H", 10)).rejects.toEqual({ code: "unknown", status: 500 });
});

// --- checkBalance -----------------------------------------------------------
test("checkBalance sends the RAW token in x-api-key (only here) and returns the balance on 200", async () => {
  stubFetch(() => json({ balance_usd: 12.5 }));
  const bal = await checkBalance("pr_secret_raw");
  expect(bal).toBe(12.5);
  expect(calls[0].url).toBe("/balance");
  expect(new Headers(calls[0].init?.headers).get("x-api-key")).toBe("pr_secret_raw");
});

test("checkBalance maps 401 to null (ambiguous unknown/unconfirmed), not an error", async () => {
  stubFetch(() => new Response("{}", { status: 401 }));
  expect(await checkBalance("pr_x")).toBeNull();
});

test("checkBalance distinguishes rate limit, network, and server failures without treating them as an empty key", async () => {
  stubFetch(() => new Response("nope", { status: 429, headers: { "retry-after": "7" } }));
  await expect(checkBalance("pr_x")).rejects.toEqual({ kind: "rate_limited", status: 429, retryAfterSec: 7 });

  stubFetch(() => new Response("nope", { status: 500 }));
  await expect(checkBalance("pr_x")).rejects.toEqual({ kind: "server", status: 500, retryAfterSec: undefined });

  stubFetch(() => { throw new TypeError("offline"); });
  await expect(checkBalance("pr_x")).rejects.toEqual({ kind: "network", status: 0 });

  expect(balanceErrorMessage({ kind: "rate_limited", status: 429 })).toMatch(/busy/i);
  expect(balanceErrorMessage({ kind: "network", status: 0 })).toMatch(/connection/i);
  expect(balanceErrorMessage({ kind: "server", status: 500 })).toMatch(/temporarily unavailable/i);
});

// --- getRails ---------------------------------------------------------------
test("getRails passes a valid multi-rail body through", async () => {
  const rails = { default: "bitcoin", rails: [{ name: "bitcoin", unit: "BTC", confirmations: 3 }, { name: "monero", unit: "XMR", confirmations: 10 }] };
  stubFetch(() => json(rails));
  expect(await getRails()).toEqual(rails);
});

test("getRails reports an unestablished set on !ok, on a thrown fetch, and on an empty rails[]", async () => {
  stubFetch(() => new Response("{}", { status: 502 }));
  expect(await getRails()).toBeNull();

  stubFetch(() => { throw new Error("offline"); });
  expect(await getRails()).toBeNull();

  stubFetch(() => json({ default: "monero", rails: [] }));
  expect(await getRails()).toBeNull();
});

// --- fetchOrderStatus (hash-only; never the raw token) -----------------------
test("fetchOrderStatus POSTs the hash and returns parsed status; preserves typed transient failures", async () => {
  stubFetch(() => json({ state: "confirming", confirmations: 2, required: 10 }));
  const st = await fetchOrderStatus("HASH");
  expect(st.state).toBe("confirming");
  expect(bodyOf(calls[0])).toEqual({ hash: "HASH" }); // no address key when the caller omits it
  expect(JSON.stringify(calls[0].init)).not.toContain("x-api-key"); // hash-only; no raw token on this path

  // With the tracked order's address, it rides in the body so the server scopes to THAT order (still no token).
  calls = [];
  stubFetch(() => json({ state: "confirming", confirmations: 2, required: 10 }));
  await fetchOrderStatus("HASH", "PAY_TO_ADDR");
  expect(bodyOf(calls[0])).toEqual({ hash: "HASH", address: "PAY_TO_ADDR" });
  expect(JSON.stringify(calls[0].init)).not.toContain("x-api-key");

  stubFetch(() => new Response("x", { status: 404 }));
  await expect(fetchOrderStatus("HASH")).rejects.toEqual({ kind: "server", status: 404, retryAfterSec: undefined });
});

// --- trocadorSwapUrl (pure URL builder; no fetch) ---------------------------
test("trocadorSwapUrl prefills AnonPay: lowercased ticker, verbatim amount, no ref while the code is empty", () => {
  const quote = { pay_to: "8AbCdEf", amount: "0.12345678", unit: "XMR", pay_uri: "monero:8AbCdEf", rate_usd: 150, confirmations_required: 10, expires_at: 1 };
  const url = new URL(trocadorSwapUrl(quote));
  expect(url.href.startsWith(TROCADOR_ANONPAY_URL)).toBe(true);
  const p = url.searchParams;
  expect(p.get("ticker_to")).toBe("xmr"); // destination coin lowercased for Trocador
  expect(p.get("network_to")).toBe("Mainnet");
  expect(p.get("address")).toBe("8AbCdEf"); // destination = the order's address
  expect(p.get("amount")).toBe("0.12345678"); // verbatim — a money string is never reformatted
  expect(p.get("name")).toBe("nullsink");
  expect(p.get("description")).toBe("api credit");
  expect(p.has("ref")).toBe(false); // TROCADOR_REF === "" → the param is omitted entirely
});

// --- buyErrorMessage (pure code → copy) -------------------------------------
test("buyErrorMessage maps known codes to calm copy and falls back for the rest", () => {
  expect(buyErrorMessage("rate_unavailable")).toMatch(/price/i);
  expect(buyErrorMessage("unknown_rail")).toMatch(/coin/i);
  expect(buyErrorMessage("network")).toMatch(/connection/i);
  // the busy/limit/wallet codes (429s + transient wallet outage) each get their own calm, distinct copy
  expect(buyErrorMessage("busy_try_later")).toMatch(/system is busy/i);
  expect(buyErrorMessage("rate_limited")).toMatch(/busy right now/i);
  expect(buyErrorMessage("wallet_unavailable")).toMatch(/temporarily unavailable/i);
  // an unmapped code (a 500/proxy_error, or a validation code the client should never emit) → generic retry
  const fallback = buyErrorMessage("proxy_error");
  expect(fallback).toBe("Something went wrong. Try again.");
  expect(buyErrorMessage("invalid_hash")).toBe(fallback);
});
