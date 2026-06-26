// The provider seam: everything that differs between upstream API shapes (Anthropic Messages today;
// OpenAI Chat Completions / Responses added behind the same record). The money skeleton — hold → forward
// → clamp-refund, in handleMetered (handler.ts) — is shared and provider-agnostic; only these edges are
// parameterized. Built by the per-provider factories (providers/anthropic.ts, providers/openai.ts), each
// closing over its own creds/estimator; selectProviders (providers/index.ts) assembles the active set.
import type { HoldEstimator } from "../hold";
import type { Metered, UsageScanner, ScannerCtx } from "../cost";

export type Provider = {
  id: string;
  baseUrl: string;
  upstreamPath: string; // path appended to baseUrl; mirrors the inbound path (exact-routed)
  estimateHold: HoldEstimator; // sizes the pre-flight hold (count_tokens-style per provider; byte fallback)
  // --- gate (runs before any spend) ---
  readToken: (req: Request) => string | null; // Anthropic: x-api-key, falling back to Authorization: Bearer. OpenAI: Bearer, falling back to x-api-key.
  // Reject anything the flat rate card can't bill (premium tiers / fee-bearing tools), before forwarding.
  premiumReject: (body: any) => { status: number; error: string } | null;
  outputCap: (body: any) => number | null; // the request's output ceiling (max_tokens / max_*); null → max_tokens_required
  ownsModel: (model: string) => boolean; // model is priced AND belongs to this provider (cross-provider gate)
  // --- forward ---
  extraStrip?: Set<string>; // headers to strip beyond the shared STRIP set (e.g. openai-organization)
  // Given the client's raw `anthropic-beta` value (stripped by default), return the flat-rate-safe subset to
  // forward, or null to drop it. Only the Anthropic provider sets this (see safeAnthropicBeta).
  forwardBeta?: (clientBeta: string) => string | null;
  injectAuth: (headers: Headers) => void; // inject our upstream key (+ version) after stripping the client's
  // mutate the forwarded body (OpenAI: store:false + include_usage; Anthropic = identity). injectCap, when
  // set, is the effective output cap to write into the body (its provider-specific field) — used when the
  // client omitted one and the global default applied, so the forwarded request is bounded to what we held.
  prepareBody: (raw: string, body: any, streaming: boolean, injectCap?: number) => string;
  // --- settle ---
  extractUsage: (text: string) => Metered; // buffered response → {model, usage}
  makeScanner: (ctx: ScannerCtx) => UsageScanner; // streaming meter (provider-shaped SSE); ctx feeds the disconnect bill
  // When true, the streaming-disconnect bill treats EVERY model on this provider as a reasoning model (bills
  // the output cap, not the visible-text char estimate). Open-weight hosts (Tinfoil) serve reasoning models
  // whose thinking tokens never stream as visible text — and vLLM may emit them in a separate reasoning_content
  // field the estimate can't see — so the cap is the only sound disconnect bound. Absent = false.
  forceReasoning?: boolean;
};
