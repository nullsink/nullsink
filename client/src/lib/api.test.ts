// PROTOTYPE — pins the network contract in lib/api.ts, the one logic-bearing client module with no dedicated
// test (QuotePay.test mocks the whole module away). Each request's body/headers and each status/error branch
// is exercised against a stubbed global fetch. Privacy-critical: the raw token may appear ONLY in /balance.
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { requestQuote, checkBalance, getRails, fetchOrderStatus } from "./api.ts";

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

test("checkBalance throws balance_<status> on a non-401 non-OK", async () => {
  stubFetch(() => new Response("nope", { status: 500 }));
  await expect(checkBalance("pr_x")).rejects.toThrow("balance_500");
});

// --- getRails ---------------------------------------------------------------
test("getRails passes a valid multi-rail body through", async () => {
  const rails = { default: "bitcoin", rails: [{ name: "bitcoin", unit: "BTC", confirmations: 3 }, { name: "monero", unit: "XMR", confirmations: 10 }] };
  stubFetch(() => json(rails));
  expect(await getRails()).toEqual(rails);
});

test("getRails falls back on !ok, on a thrown fetch, and on an empty rails[]", async () => {
  const FALLBACK = { default: "monero", rails: [{ name: "monero", unit: "XMR", confirmations: 10 }] };
  stubFetch(() => new Response("{}", { status: 502 }));
  expect(await getRails()).toEqual(FALLBACK);

  stubFetch(() => { throw new Error("offline"); });
  expect(await getRails()).toEqual(FALLBACK);

  stubFetch(() => json({ default: "monero", rails: [] }));
  expect(await getRails()).toEqual(FALLBACK); // empty set → never let the buy form block on /rails
});

// --- fetchOrderStatus (hash-only; never the raw token) -----------------------
test("fetchOrderStatus POSTs the hash and returns parsed status; throws order_status_<status> on non-OK", async () => {
  stubFetch(() => json({ state: "confirming", confirmations: 2, required: 10 }));
  const st = await fetchOrderStatus("HASH");
  expect(st.state).toBe("confirming");
  expect(bodyOf(calls[0])).toEqual({ hash: "HASH" });
  expect(JSON.stringify(calls[0].init)).not.toContain("x-api-key"); // hash-only; no raw token on this path

  stubFetch(() => new Response("x", { status: 404 }));
  await expect(fetchOrderStatus("HASH")).rejects.toThrow("order_status_404");
});
