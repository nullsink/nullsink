// Provider #4: Anthropic via its OpenAI-compatibility endpoint. Anthropic serves an OpenAI Chat Completions
// -shaped API at <base>/v1/chat/completions for claude-* models, so nullsink can offer Claude on the SAME
// path as OpenAI + Tinfoil — one endpoint reaches every model — by FORWARDING, not translating. Request and
// response are OpenAI-shaped, so it REUSES the OpenAI chat scanner + usage extractor (cost/usage/openai.ts)
// and shares /v1/chat/completions with OpenAI + Tinfoil; the handler routes claude-* here by model.
//
// OPT-IN (ANTHROPIC_OPENAI_COMPAT, index.ts), not enabled by the Anthropic key alone: Anthropic documents
// this endpoint as a test/compare layer, not production-grade — it silently drops prompt caching, structured
// outputs, and extended-thinking visibility. Gating keeps the native /v1/messages path (the full-fidelity
// Claude route) the default and lets the operator validate the compat endpoint before enabling it.
//
// Billing is safe by construction: the compat endpoint returns OpenAI-shaped usage (prompt/completion_tokens,
// with *_details always empty), so extractOpenAIChatUsage meters it and priceUsage resolves the returned
// claude-* id to the Anthropic rate card. Caching cannot occur here, so the empty cache fields correctly bill
// all input at the input rate — exactly what Anthropic charges us. prepareBody strips the `thinking` trigger
// so no hidden (unstreamed) output tokens exist for a mid-stream disconnect to under-count.
import { providerOf, extractOpenAIChatUsage, openaiChatScanner } from "../cost";
import type { HoldEstimator } from "../hold";
import type { Provider } from "./types";

// claude-* clients built for Anthropic send x-api-key; OpenAI-compat clients send Authorization: Bearer.
// Accept both; either is stripped before forwarding (STRIP) and our key injected.
function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  return req.headers.get("x-api-key");
}

// Output ceiling: max_completion_tokens (OpenAI) or the legacy max_tokens. REQUIRED — the hold needs a sound
// output bound. null → max_tokens_required.
function compatOutputCap(body: any): number | null {
  const m = body?.max_completion_tokens ?? body?.max_tokens;
  return typeof m === "number" && m > 0 ? m : null;
}

// n != 1 multiplies output beyond a single-completion hold — reject (Anthropic's compat requires n=1 anyway).
// Audio/modality options need no gate here: claude models are priced text-only, so an audio request is a
// text-only-model rejection upstream (full refund), never a silent under-bill.
function compatPremiumReject(body: any): { status: number; error: string } | null {
  if (body?.n != null && body.n !== 1) return { status: 400, error: "unsupported_option" };
  return null;
}

// Normalize the cap to a single max_completion_tokens (== what the hold was sized from), drop the legacy
// max_tokens so the forwarded ceiling can't diverge from the hold, and force stream_options.include_usage so
// a streamed response carries final usage (else we'd refund in full = free usage). Mirrors the Tinfoil body
// prep; no store:false (an OpenAI-specific retention flag Anthropic ignores).
function compatPrepareBody(_raw: string, body: any, streaming: boolean, injectCap?: number): string {
  const out: Record<string, unknown> = { ...(body ?? {}) };
  const cap = injectCap ?? body?.max_completion_tokens ?? body?.max_tokens; // mirrors compatOutputCap (the hold)
  if (cap != null) out.max_completion_tokens = cap;
  delete out.max_tokens; // forward one unambiguous ceiling; the legacy field can't out-rank the hold
  // Strip the Anthropic-native `thinking` trigger. On this endpoint it bills as output but the thought tokens
  // are NOT streamed (verified live: `thinking` inflates completion_tokens with zero streamed reasoning; the
  // standard OpenAI `reasoning_effort` is ignored), so a mid-stream disconnect would char-estimate visible
  // text only and under-bill the hidden thinking. No OpenAI-compat client sends this field; thinking belongs
  // on the full-fidelity native /v1/messages path. Stripping it keeps the disconnect estimate sound.
  delete out.thinking;
  if (streaming) out.stream_options = { ...(body?.stream_options ?? {}), include_usage: true };
  return JSON.stringify(out);
}

export type AnthropicCompatConfig = { apiKey: string; baseUrl: string; estimateHold: HoldEstimator };

export function makeAnthropicCompatProvider(cfg: AnthropicCompatConfig): Provider {
  return {
    // Same id as the native Messages provider — the two never share a path, so there's no ambiguity, and it
    // keeps the `anthropic/claude-...` namespace prefix routing on both endpoints.
    id: "anthropic",
    baseUrl: cfg.baseUrl,
    upstreamPath: "/v1/chat/completions",
    estimateHold: cfg.estimateHold, // byte bound — the OpenAI-shaped body can't use Anthropic's count_tokens
    readToken: bearerToken,
    premiumReject: compatPremiumReject,
    outputCap: compatOutputCap,
    // Priced AND tagged anthropic. On /v1/chat/completions only THIS provider owns claude-* (OpenAI/Tinfoil
    // own their own ids), so resolution is unambiguous; a gpt-*/open-weight id is rejected here as unsupported.
    ownsModel: (model) => providerOf(model) === "anthropic",
    injectAuth: (headers) => headers.set("authorization", `Bearer ${cfg.apiKey}`),
    prepareBody: compatPrepareBody,
    extractUsage: extractOpenAIChatUsage,
    makeScanner: (ctx) => openaiChatScanner(ctx),
  };
}
