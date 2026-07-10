// Provider #3: Tinfoil (tinfoil.sh) — an OpenAI-compatible host of open-weight models running in attested
// TEEs. The provider forwards plaintext (enclave attestation is the external tinfoil-proxy's job): the OpenAI Chat Completions shape, so it REUSES the
// OpenAI chat scanner + usage extractor (cost/usage/openai.ts) and shares /v1/chat/completions with the
// OpenAI provider — the handler routes between them by model (bare id → owner, or a `provider/model` prefix).
// Built only when TINFOIL_API_KEY is configured (selectProviders); otherwise its endpoint 404s.
import { providerOf, isOffCardModel, extractOpenAIChatUsage, openaiChatScanner } from "../cost";
import type { HoldEstimator } from "../hold";
import type { Provider } from "./types";

// Tinfoil clients put the proxy token in `Authorization: Bearer …` (OpenAI convention); also accept x-api-key
// for the OpenAI-compatible tool tail. Either way it's stripped before forwarding (STRIP) and our key injected.
function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  return req.headers.get("x-api-key");
}

// Output ceiling: max_completion_tokens (current) or the legacy max_tokens. REQUIRED — the hold needs a sound
// output bound. null → max_tokens_required.
function tinfoilOutputCap(body: any): number | null {
  const m = body?.max_completion_tokens ?? body?.max_tokens;
  return typeof m === "number" && m > 0 ? m : null;
}

// The minimum SOUND reject set for the flat per-token card:
//   • n != 1        — multiplies output beyond a single-completion hold (clamp would eat the gap).
//   • best_of != 1  — vLLM-family backends generate best_of candidates internally; if Tinfoil bills generated
//     (not returned) tokens, best_of>1 under-bills past the hold. Reject conservatively until the live backend
//     is confirmed (see the step-6 verification). OpenAI removed best_of, so this is Tinfoil-specific.
// Audio/modality backstops aren't needed: the curated price list is text-chat only, so any audio/embedding id
// is unpriced and ownsModel rejects it before this runs.
function tinfoilPremiumReject(body: any): { status: number; error: string } | null {
  if (body?.n != null && body.n !== 1) return { status: 400, error: "unsupported_option" };
  if (body?.best_of != null && body.best_of !== 1) return { status: 400, error: "unsupported_option" };
  return null;
}

// Body mutation, streaming-billing-driven only:
//   • stream_options.include_usage (streaming) — FORCED on (overriding a client `false`): OpenAI-compatible
//     streams omit usage unless asked, and without it a streamed response carries NO usage → we'd refund in
//     full (free usage). The final chunk then carries exact usage; the scanner's content fallback covers a
//     mid-stream disconnect.
//   • output cap — NORMALIZED to a single max_completion_tokens (== the value outputCap sized the hold from)
//     with the legacy max_tokens dropped, so the forwarded ceiling can't diverge from the hold no matter how
//     the backend prioritizes the two fields. (vLLM honors max_completion_tokens and, with both present,
//     ignores max_tokens — verified live — but normalizing removes the dependency on that behavior.) When the
//     client omitted a cap, injectCap supplies the held default.
// Unlike OpenAI we do NOT send store:false — it's an OpenAI-specific retention flag; Tinfoil's no-retention
// rests on enclave ephemerality, and sending an unknown field risks a strict-server 400.
function tinfoilPrepareBody(_raw: string, body: any, streaming: boolean, injectCap?: number): string {
  const out: Record<string, unknown> = { ...(body ?? {}) };
  const cap = injectCap ?? body?.max_completion_tokens ?? body?.max_tokens; // mirrors tinfoilOutputCap (the hold)
  if (cap != null) out.max_completion_tokens = cap;
  delete out.max_tokens; // forward one unambiguous ceiling; the legacy field can't out-rank the hold
  if (streaming) out.stream_options = { ...(body?.stream_options ?? {}), include_usage: true };
  return JSON.stringify(out);
}

export type TinfoilConfig = { apiKey: string; baseUrl: string; estimateHold: HoldEstimator };

export function makeTinfoilProvider(cfg: TinfoilConfig): Provider {
  return {
    id: "tinfoil",
    baseUrl: cfg.baseUrl,
    upstreamPath: "/v1/chat/completions",
    estimateHold: cfg.estimateHold, // always the byte bound — Tinfoil has no count_tokens endpoint (proxy.ts)
    readToken: bearerToken,
    premiumReject: tinfoilPremiumReject,
    outputCap: tinfoilOutputCap,
    // Priced AND tagged tinfoil AND not off-card. The off-card check backstops a future priced id that
    // prefix-extends a base (the curated list is text-chat only today); a claude-*/gpt-* model is rejected
    // here as unsupported_model rather than forwarded to Tinfoil for a 404.
    ownsModel: (model) => providerOf(model) === "tinfoil" && !isOffCardModel(model),
    injectAuth: (headers) => headers.set("authorization", `Bearer ${cfg.apiKey}`),
    prepareBody: tinfoilPrepareBody,
    extractUsage: extractOpenAIChatUsage,
    // The shared chat scanner sums delta.content + delta.reasoning (+ reasoning_content) for its disconnect
    // estimate, so an open-weight model that streams its reasoning is metered like any other — no cap needed.
    // VERIFIED live (step 6): every curated model streams reasoning visibly — in `content` (deepseek, gemma)
    // or `delta.reasoning` (gpt-oss, glm, kimi); none silently. Re-probe reasoning streaming before adding a
    // model — a silently-thinking one would under-bill on a mid-stream disconnect and need a cap.
    makeScanner: (ctx) => openaiChatScanner(ctx),
  };
}
