// GET /v1/models — the OpenAI-compatible served-model catalog. The invariant under test: the list is
// exactly the priced models an ACTIVE provider owns, so a listed id is one that won't 400 unsupported_model
// (and a disabled provider's models, or an off-card variant, never appear). Plus the OpenAI list shape,
// the per-model USD/Mtok pricing, no-auth access, and that a POST to the path is not admitted.
import { test, expect } from "bun:test";
import { createHandler, type HandlerDeps, type RailView } from "./support/handler-combined";
import { pricedModels, isOffCardModel } from "../src/cost";
import { openDb } from "../src/ledger/db";
import { openOrderStore } from "../src/ledger/orders";
import { byteBoundHold } from "../src/hold";

// A handler with an arbitrary subset of providers configured. /v1/models never forwards, so the
// upstreamFetch throws — reaching it would be the bug.
function makeHandler(cfg: Pick<HandlerDeps, "anthropic" | "openai" | "tinfoil">) {
  const deps: HandlerDeps = {
    ...cfg,
    upstreamTimeoutMs: 1000,
    margin: 1.15, buyMinUsd: 5, buyMaxUsd: 2000, orderTtlMs: 4 * 60 * 60 * 1000, maxOpenOrders: 1000,
    maxBuyBodyBytes: 4096, maxMessagesBodyBytes: 33_554_432, balances: openDb(":memory:"), orders: openOrderStore(":memory:"),
    upstreamFetch: (async () => { throw new Error("/v1/models must not forward upstream"); }) as unknown as typeof fetch,
    rails: new Map<string, RailView>([["monero", { name: "monero", createAddress: async () => ({ address: "8a", orderIndex: 0 }), rateUsd: async () => 150, scale: 1e12, unit: "XMR", confirmations: 10, paymentUri: (a, amt) => `monero:${a}?tx_amount=${amt}` }]]),
    defaultRail: "monero",
  };
  return createHandler(deps);
}

const ANTHROPIC = { apiKey: "k", baseUrl: "https://up.example", version: "2023-06-01", estimateHold: byteBoundHold };
const OPENAI = { apiKey: "k", baseUrl: "https://up.example", estimateHold: byteBoundHold };
const TINFOIL = { apiKey: "k", baseUrl: "https://up.example", estimateHold: byteBoundHold };

const getModels = (h: (req: Request) => Promise<Response>) => h(new Request("https://proxy.local/v1/models"));
const idsFor = (provider: string) => pricedModels().filter((m) => m.provider === provider).map((m) => m.id).sort();
const json = async (res: Response): Promise<any> => JSON.parse(await res.text());

test("GET /v1/models: OpenAI list shape with per-model USD/Mtok pricing", async () => {
  const res = await getModels(makeHandler({ anthropic: ANTHROPIC }));
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.object).toBe("list");
  expect(body.pricing_unit).toBe("usd_per_mtok");
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeGreaterThan(0);
  for (const m of body.data) {
    expect(m.object).toBe("model");
    expect(typeof m.id).toBe("string");
    expect(m.created).toBe(0); // we don't track model dates — a constant to satisfy the schema
    expect(typeof m.owned_by).toBe("string");
    for (const k of ["input", "output", "cache_read", "cache_write"]) expect(typeof m.pricing[k]).toBe("number");
  }
});

test("GET /v1/models: lists exactly the active providers' models — a disabled provider's are absent", async () => {
  const anthropicOnly = await json(await getModels(makeHandler({ anthropic: ANTHROPIC })));
  const ids = anthropicOnly.data.map((m: any) => m.id).sort();
  expect(ids).toEqual(idsFor("anthropic")); // exactly the anthropic subset of the price book
  expect(new Set(anthropicOnly.data.map((m: any) => m.owned_by))).toEqual(new Set(["anthropic"]));
  expect(ids).toContain("claude-fable-5"); // a concrete served id
  expect(ids.some((id: string) => id.startsWith("gpt-"))).toBe(false); // no OpenAI models on an OpenAI-less instance
});

test("GET /v1/models: a multi-provider instance unions its providers and still excludes the disabled one", async () => {
  const body = await json(await getModels(makeHandler({ anthropic: ANTHROPIC, tinfoil: TINFOIL })));
  const owners = new Set(body.data.map((m: any) => m.owned_by));
  expect(owners).toEqual(new Set(["anthropic", "tinfoil"])); // both configured providers, and only them
  const ids = body.data.map((m: any) => m.id).sort();
  expect(ids).toEqual([...idsFor("anthropic"), ...idsFor("tinfoil")].sort());
});

test("GET /v1/models: never lists an off-card (fee-bearing / non-text) variant", async () => {
  const body = await json(await getModels(makeHandler({ openai: OPENAI })));
  for (const m of body.data) expect(isOffCardModel(m.id)).toBe(false);
});

test("GET /v1/models: served with no auth header (the list is public)", async () => {
  const res = await makeHandler({ anthropic: ANTHROPIC })(new Request("https://proxy.local/v1/models")); // no x-api-key
  expect(res.status).toBe(200);
});

test("POST /v1/models is not admitted — only the metered POST paths are", async () => {
  const res = await makeHandler({ anthropic: ANTHROPIC })(new Request("https://proxy.local/v1/models", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  expect(res.status).toBe(404);
});
