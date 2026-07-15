// PROXY TRUST DOMAIN read endpoints — /balance and /v1/models — extracted from handler.ts. Cheap reads behind the
// global, identity-free read throttle (no money gate), each `(req) => Promise<Response>`. The payments trust domain
// reads (/order-status, /rails) live in payment-reads.ts so the attested proxy never imports their source.
import { deny } from "../http";
import { hashToken } from "../ledger/hash";
import type { ProxyEndpointDeps } from "./types";
import { readThrottled } from "./read-throttle";

// GET /v1/models: the OpenAI-compatible model catalog — every model THIS instance serves (its provider is
// configured AND owns the id), so `data[].id` is exactly the set that won't 400 unsupported_model. Lets an
// SDK or agent framework enumerate/validate models the standard way. Unauthenticated and a cheap read (the
// list is static and already public on /models): the shared read throttle applies, like /rails. Each entry
// carries its USD-per-Mtok pricing (nullsink bills upstream rates) — the one thing an upstream /v1/models
// can't give you, and the reason we build the list locally rather than proxy one. `created` is a constant 0
// (we don't track model dates) — present only to satisfy the OpenAI Model schema.
export function makeModels(d: ProxyEndpointDeps) {
  const { servedModels, readRateLimit } = d;
  return async (_req: Request): Promise<Response> => {
    const throttled = readThrottled(readRateLimit);
    if (throttled) return throttled;
    return Response.json({
      object: "list",
      pricing_unit: "usd_per_mtok", // documents every entry's `pricing` figures once, not per-model
      data: servedModels.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: m.provider,
        pricing: { input: m.input, output: m.output, cache_read: m.cache_read, cache_write: m.cache_write },
      })),
    });
  };
}

// GET /balance: a token holder checks their own remaining balance. Distinguishes a known token (200) from
// unknown (401) — a token-validity oracle — fine because tokens are 256-bit unguessable.
export function makeBalance(d: ProxyEndpointDeps) {
  const { getBalance, readRateLimit } = d;
  return async (req: Request): Promise<Response> => {
    const throttled = readThrottled(readRateLimit);
    if (throttled) return throttled;
    const token = req.headers.get("x-api-key");
    if (!token) return deny(401, "invalid_token");
    const micros = getBalance(hashToken(token));
    if (micros === null) return deny(401, "invalid_token");
    return Response.json({ balance_usd: micros / 1_000_000 });
  };
}
