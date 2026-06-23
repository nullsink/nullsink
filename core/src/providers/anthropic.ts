// Provider #1: the Anthropic Messages API. Transparent passthrough — the body is forwarded unchanged
// (prepareBody = identity), usage is read off the native response shape. makeAnthropicProvider closes over
// the upstream creds + estimator (was built inline in createHandler before the providers/ seam).
import { providerOf, extractUsage, streamUsageScanner } from "../cost";
import type { HoldEstimator } from "../hold";
import type { Provider } from "./types";

// Anthropic betas that bill at standard per-token rates (no premium tier / per-call fee) and are therefore
// safe to forward under the flat rate card. The handler strips `anthropic-beta` wholesale (blocking premium
// betas — fast mode, 1M context `context-1m-*`) and re-adds only these. Currently just CONTEXT EDITING
// (`context-management-*`): a server-side prune that REDUCES tokens over long sessions (its only cost is
// normal prompt-cache churn, which we already meter). Claude Code and other agents send it; without the beta
// their `context_management` body field is rejected `400 Extra inputs are not permitted`. Prefix-matched for
// version dates. Add a marker ONLY after confirming no surcharge (`context-1m-` must never be added).
const ANTHROPIC_SAFE_BETA = ["context-management-"];

// Filter a client `anthropic-beta` header down to the flat-rate-safe subset (or null if none survive),
// preserving the markers' comma-joined form so the upstream still parses them.
function safeAnthropicBeta(clientBeta: string): string | null {
  const kept = clientBeta
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && ANTHROPIC_SAFE_BETA.some((p) => m.startsWith(p)));
  return kept.length ? kept.join(", ") : null;
}

// Server-side tools (web search, code execution) carry usage-based fees our flat per-token rates don't
// cover — reject them. Client-side (custom) tools are just tokens, so they're fine. NOTE: this is a
// 2-prefix denylist, not a general server-tool gate — a future fee-bearing tool (e.g. web_fetch) with a
// new prefix would slip through and under-bill (a known gap: fail closed + meter server_tool_use).
function hasServerTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((t) => {
    const type = typeof (t as any)?.type === "string" ? (t as any).type : "";
    return type.startsWith("web_search") || type.startsWith("code_execution");
  });
}

// Does the request opt into 1-HOUR cache writes (a cache_control breakpoint with ttl:"1h") anywhere? Those
// tokens bill 2× input (vs 1.25× for the default 5-min tier), so the pre-flight hold must reserve the dearer
// tier — but ONLY for requests that use it, else every Anthropic hold over-reserves. A DEEP scan (not a
// fixed list of breakpoint locations — system / messages / tools / top-level) so a new placement can't slip
// a 1h write past the hold and re-open the under-bill. Conservative by construction: any ttl:"1h" → true.
export function hasOneHourCacheControl(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasOneHourCacheControl);
  if (v !== null && typeof v === "object") {
    const cc = (v as { cache_control?: unknown }).cache_control;
    if (cc !== null && typeof cc === "object" && (cc as { ttl?: unknown }).ttl === "1h") return true;
    return Object.values(v as Record<string, unknown>).some(hasOneHourCacheControl);
  }
  return false;
}

// Anthropic's native auth header is x-api-key; ALSO accept Authorization: Bearer so clients that default to
// Bearer authenticate instead of silently 401ing — notably Claude Code under ANTHROPIC_AUTH_TOKEN, and other
// agents/SDKs that only know the Bearer convention. x-api-key wins when both are present (it's the native
// one). Both are in STRIP, so whichever carried the proxy token is dropped before forwarding and our real
// key injected — accepting Bearer changes only what we READ, never what we forward.
function anthropicToken(req: Request): string | null {
  const k = req.headers.get("x-api-key");
  if (k) return k;
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

export function makeAnthropicProvider(cfg: {
  apiKey: string;
  baseUrl: string;
  version: string;
  estimateHold: HoldEstimator;
}): Provider {
  return {
    id: "anthropic",
    baseUrl: cfg.baseUrl,
    upstreamPath: "/v1/messages",
    // Annotate the hold input with whether this request opts into 1-hour cache writes, so the (provider-
    // agnostic) estimator + priceHoldBound reserve the dearer 2× input tier only when 1h is actually used.
    estimateHold: (input) => cfg.estimateHold({ ...input, oneHourCache: hasOneHourCacheControl(input.body) }),
    readToken: anthropicToken,
    premiumReject: (body) => {
      // Premium-priced features the flat rate card doesn't cover. inference_geo (regional premium) and
      // server-side tools (web search / code exec) carry usage-based fees beyond per-token rates.
      if (body?.inference_geo != null) return { status: 400, error: "unsupported_option" };
      if (hasServerTool(body?.tools)) return { status: 400, error: "unsupported_tool" };
      return null;
    },
    outputCap: (body) => {
      const m = body?.max_tokens;
      return typeof m === "number" && m > 0 ? m : null;
    },
    // Priced AND tagged anthropic — a gpt-* model (priced, but provider openai) is rejected here with
    // unsupported_model, not forwarded to Anthropic for a 404.
    ownsModel: (model) => providerOf(model) === "anthropic",
    // STRIP covers authorization/x-api-key/anthropic-beta/anthropic-organization-id; forwardBeta re-adds the
    // flat-rate-safe beta subset (context editing) that STRIP dropped — premium betas stay stripped.
    forwardBeta: safeAnthropicBeta,
    injectAuth: (headers) => {
      headers.set("x-api-key", cfg.apiKey); // we hold the key; the client never sees it
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", cfg.version);
    },
    // Forward the exact bytes — no mutation — UNLESS the global default had to supply a missing max_tokens
    // (rare: Anthropic's API requires it, so real clients always send one), in which case inject it.
    prepareBody: (raw, body, _streaming, injectCap) => (injectCap != null ? JSON.stringify({ ...body, max_tokens: injectCap }) : raw),
    extractUsage,
    makeScanner: streamUsageScanner,
  };
}
