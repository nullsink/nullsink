// LND REST rail tests with an injected fetch — no node or network. These pin the money-relevant boundary:
// exact amount/expiry invoice creation, add_index order mapping, SETTLED-only reconciliation,
// payment-hash idempotency, uint64 precision guards, and bounded forward pagination.
import { expect, test } from "bun:test";
import { LightningError, makeLightning } from "../src/rails/lightning";

const NOW = 1_800_000_000_000;
const MACAROON = "ab".repeat(32);
const hash64 = (byte: number) => Buffer.alloc(32, byte).toString("base64");

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const asFetch = (fn: (...args: any[]) => Promise<Response>): typeof fetch => fn as unknown as typeof fetch;

test("AddInvoice receives the exact sat amount and a deadline-bounded expiry", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = asFetch(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return json({
      payment_request: "lnbcrt1000n1ptestinvoice",
      r_hash: hash64(1),
      add_index: "7",
    });
  });
  const lnd = makeLightning({
    restUrl: "https://lnd.test/",
    macaroonHex: MACAROON,
    timeoutMs: 1000,
    fetchImpl,
    now: () => NOW,
    tlsCa: "TEST LND CERT",
  });

  await expect(
    lnd.createPayment({
      amountAtomic: 1234,
      expiresAt: NOW + 120_999,
      label: "token-derived-label-must-not-cross",
    }),
  ).resolves.toEqual({ payTo: "lnbcrt1000n1ptestinvoice", orderIndex: 7 });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://lnd.test/v1/invoices");
  expect(calls[0]!.init.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
    value: "1234",
    expiry: "120", // floor: the LND invoice cannot outlive Nullsink's deadline
    memo: "", // never persists the request label/token relationship in LND
  });
  expect(new Headers(calls[0]!.init.headers).get("Grpc-Metadata-macaroon")).toBe(MACAROON);
  expect((calls[0]!.init as any).tls).toEqual({ ca: ["TEST LND CERT"] });
});

test("AddInvoice fails closed on invalid amount/deadline/auth and malformed identifiers", async () => {
  const goodResponse = { payment_request: "lnbc1invoice", r_hash: hash64(2), add_index: "1" };
  let calls = 0;
  const make = (macaroonHex = MACAROON, body: unknown = goodResponse) =>
    makeLightning({
      restUrl: "https://lnd.test",
      macaroonHex,
      timeoutMs: 1000,
      now: () => NOW,
      fetchImpl: asFetch(async () => {
        calls++;
        return json(body);
      }),
    });

  await expect(make().createPayment({ amountAtomic: 0, expiresAt: NOW + 1000 })).rejects.toBeInstanceOf(LightningError);
  await expect(make().createPayment({ amountAtomic: 1.5, expiresAt: NOW + 1000 })).rejects.toBeInstanceOf(LightningError);
  await expect(make().createPayment({ amountAtomic: 1, expiresAt: NOW })).rejects.toBeInstanceOf(LightningError);
  expect(calls).toBe(0); // local validation happens before touching LND

  await expect(make("").createPayment({ amountAtomic: 1, expiresAt: NOW + 1000 })).rejects.toThrow(/MACAROON/);
  await expect(
    make(MACAROON, { ...goodResponse, add_index: "9007199254740992" }).createPayment({
      amountAtomic: 1,
      expiresAt: NOW + 1000,
    }),
  ).rejects.toThrow(/add_index/);
  await expect(
    make(MACAROON, { ...goodResponse, r_hash: Buffer.alloc(31).toString("base64") }).createPayment({
      amountAtomic: 1,
      expiresAt: NOW + 1000,
    }),
  ).rejects.toThrow(/r_hash/);
});

test("remote LND REST is required to use TLS", () => {
  expect(() =>
    makeLightning({
      restUrl: "http://10.0.0.2:8080",
      macaroonHex: MACAROON,
      timeoutMs: 1000,
    }),
  ).toThrow(/must use HTTPS/);
  expect(() =>
    makeLightning({
      restUrl: "http://127.0.0.1:8080",
      macaroonHex: MACAROON,
      timeoutMs: 1000,
    }),
  ).not.toThrow();
});

test("ListInvoices paginates the open add-index range and returns SETTLED invoices only", async () => {
  const queryOffsets: string[] = [];
  const pages = [
    {
      invoices: [
        { add_index: "5", state: "SETTLED", amt_paid_sat: "125", r_hash: hash64(5) },
        { add_index: "6", state: "ACCEPTED", amt_paid_sat: "200", r_hash: hash64(6) },
      ],
      last_index_offset: "6",
    },
    {
      invoices: [
        { add_index: "7", state: "CANCELED", amt_paid_sat: "300", r_hash: hash64(7) },
        { add_index: "8", state: "SETTLED", amt_paid_sat: "999", r_hash: hash64(8) },
      ],
      last_index_offset: "8",
    },
  ];
  const fetchImpl = asFetch(async (url: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    const parsed = new URL(url);
    queryOffsets.push(parsed.searchParams.get("index_offset")!);
    expect(parsed.searchParams.get("pending_only")).toBe("false");
    expect(parsed.searchParams.get("reversed")).toBe("false");
    return json(pages.shift());
  });
  const lnd = makeLightning({
    restUrl: "https://lnd.test",
    macaroonHex: MACAROON,
    timeoutMs: 1000,
    pageSize: 2,
    fetchImpl,
  });

  const transfers = await lnd.incomingTransfers([5, 8]);
  expect(queryOffsets).toEqual(["4", "6"]);
  expect(transfers).toEqual([
    {
      orderIndex: 5,
      idempotencyKey: `lightning:${Buffer.alloc(32, 5).toString("hex")}`,
      amount: 125,
      confirmations: 0,
      final: true,
    },
    {
      orderIndex: 8,
      idempotencyKey: `lightning:${Buffer.alloc(32, 8).toString("hex")}`,
      amount: 999, // amt_paid_sat is authoritative, including overpayment
      confirmations: 0,
      final: true,
    },
  ]);
});

test("reconciliation replay returns the same payment-hash idempotency key", async () => {
  const page = {
    invoices: [{ add_index: "3", state: "SETTLED", amt_paid_sat: "42", r_hash: hash64(9) }],
    last_index_offset: "3",
  };
  const lnd = makeLightning({
    restUrl: "https://lnd.test",
    macaroonHex: MACAROON,
    timeoutMs: 1000,
    fetchImpl: asFetch(async () => json(page)),
  });
  expect(await lnd.incomingTransfers([3])).toEqual(await lnd.incomingTransfers([3]));
});

test("reconciliation skips I/O with no open orders and fails closed on malformed or stuck pages", async () => {
  let calls = 0;
  const noCall = makeLightning({
    restUrl: "https://lnd.test",
    macaroonHex: MACAROON,
    timeoutMs: 1000,
    fetchImpl: asFetch(async () => {
      calls++;
      return json({});
    }),
  });
  expect(await noCall.incomingTransfers([])).toEqual([]);
  expect(calls).toBe(0);

  const malformed = makeLightning({
    restUrl: "https://lnd.test",
    macaroonHex: MACAROON,
    timeoutMs: 1000,
    fetchImpl: asFetch(async () =>
      json({
        invoices: [{ add_index: "2", state: "SETTLED", amt_paid_sat: "1.5", r_hash: hash64(2) }],
        last_index_offset: "2",
      })),
  });
  await expect(malformed.incomingTransfers([2])).rejects.toThrow(/amt_paid_sat/);

  const stuck = makeLightning({
    restUrl: "https://lnd.test",
    macaroonHex: MACAROON,
    timeoutMs: 1000,
    fetchImpl: asFetch(async () =>
      json({
        invoices: [{ add_index: "2", state: "OPEN", amt_paid_sat: "0", r_hash: hash64(2) }],
        last_index_offset: "1",
      })),
  });
  await expect(stuck.incomingTransfers([2])).rejects.toThrow(/pagination did not advance/);

  const capped = makeLightning({
    restUrl: "https://lnd.test",
    macaroonHex: MACAROON,
    timeoutMs: 1000,
    maxPages: 1,
    fetchImpl: asFetch(async () =>
      json({
        invoices: [{ add_index: "1", state: "CANCELED", amt_paid_sat: "0", r_hash: hash64(1) }],
        last_index_offset: "1",
      })),
  });
  await expect(capped.incomingTransfers([1, 2])).rejects.toThrow(/page reconciliation cap/);
});

test("LND HTTP and JSON failures are surfaced as LightningError", async () => {
  const make = (fetchImpl: typeof fetch) =>
    makeLightning({
      restUrl: "https://lnd.test",
      macaroonHex: MACAROON,
      timeoutMs: 1000,
      fetchImpl,
      now: () => NOW,
    });
  await expect(
    make(asFetch(async () => new Response("down", { status: 503 }))).createPayment({
      amountAtomic: 1,
      expiresAt: NOW + 1000,
    }),
  ).rejects.toThrow("LND HTTP 503");
  await expect(
    make(asFetch(async () => new Response("not json"))).createPayment({
      amountAtomic: 1,
      expiresAt: NOW + 1000,
    }),
  ).rejects.toThrow("invalid JSON");
});
