// Provider #2: OpenAI. Built only when OPENAI_API_KEY is configured (selectProviders only calls this when
// its config is given); otherwise its endpoints 404. Chat Completions and Responses share everything except
// their request/response shape (gate, body mutation, usage extraction), so a small factory (makeBase) supplies
// the common edges (auth, model ownership, org strip, the count-endpoint hold) and each endpoint passes its
// shape-specific parts. Was built inline in createHandler before the providers/ seam.
import { providerOf, isOffCardModel, extractOpenAIChatUsage, openaiChatScanner, extractOpenAIResponsesUsage, openaiResponsesScanner } from "../cost";
import type { HoldEstimator } from "../hold";
import type { Provider } from "./types";

// OpenAI clients put the proxy token in `Authorization: Bearer …`; also accept x-api-key for the long
// tail of OpenAI-compatible tools. Either way it's stripped before forwarding (STRIP) and our key injected.
function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  return req.headers.get("x-api-key");
}

// --- OpenAI Chat Completions provider pieces (the shape passed to makeBase below) ---

// Declarative reject list: request features the flat per-token rate card can't bill. Readable at a glance
// and testable by iteration; each rule → a gate error returned BEFORE forwarding, so a reject never spends.
// (Off-card MODELS — search-preview / deep-research / audio / realtime — are rejected separately, by
// ownsModel via isOffCardModel, since they're a model-id concern not a body feature. The audio rules below
// are the body-level backstop for that id gate.)
const OPENAI_CHAT_REJECTS: Array<{ reason: string; when: (body: any) => boolean; error: string }> = [
  {
    reason: "service_tier flex/priority bill at non-standard rates; only default/auto match the card",
    when: (b) => b?.service_tier != null && b.service_tier !== "auto" && b.service_tier !== "default",
    error: "unsupported_option",
  },
  {
    reason: "built-in web search carries per-call fees outside the per-token rates",
    when: (b) => b?.web_search_options != null,
    error: "unsupported_tool",
  },
  {
    // Any present n other than exactly 1 multiplies output cost beyond a single-completion hold. Reject
    // non-numbers too (e.g. "2") — if upstream coerced one we'd under-size the hold. (rejected in v1)
    reason: "n other than 1 multiplies output cost beyond a single-completion hold (rejected in v1)",
    when: (b) => b?.n != null && b.n !== 1,
    error: "unsupported_option",
  },
  {
    // Audio output tokens bill ~8× the text output rate and our usage mapping doesn't split them out, so
    // any non-text modality under-bills. Fail closed: anything other than absent or exactly ["text"] is
    // rejected — this also backstops the isOffCardModel id gate for a future audio-capable id without an
    // "audio" marker in it (audio output can't be requested without this field).
    reason: "non-text output modalities bill at audio rates the flat per-token card doesn't cover",
    when: (b) => b?.modalities != null && !(Array.isArray(b.modalities) && b.modalities.length === 1 && b.modalities[0] === "text"),
    error: "unsupported_option",
  },
  {
    reason: "the audio output config only exists to request audio output, which bills at off-card rates",
    when: (b) => b?.audio != null,
    error: "unsupported_option",
  },
  {
    // Audio INPUT (input_audio content parts) bills at audio input rates (~16× text). On a text-only
    // model the upstream would 400 this anyway (full refund); rejecting here keeps it free.
    reason: "input_audio content parts bill at audio input rates the flat per-token card doesn't cover",
    when: (b) =>
      Array.isArray(b?.messages) &&
      b.messages.some(
        (m: any) => Array.isArray(m?.content) && m.content.some((p: any) => p?.type === "input_audio"),
      ),
    error: "unsupported_option",
  },
];

function openaiChatPremiumReject(body: any): { status: number; error: string } | null {
  for (const r of OPENAI_CHAT_REJECTS) if (r.when(body)) return { status: 400, error: r.error };
  return null;
}

// OpenAI's output ceiling: max_completion_tokens (current) or the legacy max_tokens. REQUIRED here — the
// API lets you omit it (run to context), but the hold needs a sound output bound. null → max_tokens_required.
function openaiChatOutputCap(body: any): number | null {
  const m = body?.max_completion_tokens ?? body?.max_tokens;
  return typeof m === "number" && m > 0 ? m : null;
}

// The only non-passthrough mutation, both privacy- and billing-driven:
//   • store:false — disables OpenAI application-state storage/server-side chaining. It does NOT by itself
//     disable default abuse-monitoring retention; that requires an approved organization-level data control.
//     Clients replace server-side chaining by resending context.
//   • stream_options.include_usage (streaming only) — OpenAI omits usage from streams unless asked, and
//     without it a streamed response carries NO usage → we'd refund in full (free usage). This makes the
//     final chunk carry exact usage; the scanner's content fallback covers a mid-stream disconnect.
function openaiChatPrepareBody(_raw: string, body: any, streaming: boolean, injectCap?: number): string {
  const out: Record<string, unknown> = { ...(body ?? {}), store: false };
  if (injectCap != null) out.max_completion_tokens = injectCap; // client omitted a cap → bound the output to what we held
  if (streaming) out.stream_options = { ...(body?.stream_options ?? {}), include_usage: true };
  return JSON.stringify(out);
}

// --- OpenAI Responses provider pieces (POST /v1/responses — OpenAI's newer endpoint) ---

// Responses built-in tools that carry per-call fees outside the per-token rate card. Function tools
// (type "function") are just tokens, so they're allowed; these are rejected.
function hasResponsesBuiltinTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((t) => {
    const type = typeof (t as any)?.type === "string" ? (t as any).type : "";
    return (
      type.startsWith("web_search") ||
      type.startsWith("file_search") ||
      type.startsWith("code_interpreter") ||
      type.startsWith("computer_use") ||
      type.startsWith("image_generation")
    );
  });
}

function openaiResponsesPremiumReject(body: any): { status: number; error: string } | null {
  if (body?.service_tier != null && body.service_tier !== "auto" && body.service_tier !== "default")
    return { status: 400, error: "unsupported_option" };
  if (hasResponsesBuiltinTool(body?.tools)) return { status: 400, error: "unsupported_tool" };
  // Audio INPUT parts bill at off-card rates — same body-level backstop as the chat audio rules (id gate
  // is primary).
  if (
    Array.isArray(body?.input) &&
    body.input.some(
      (item: any) => Array.isArray(item?.content) && item.content.some((p: any) => p?.type === "input_audio"),
    )
  )
    return { status: 400, error: "unsupported_option" };
  return null; // no n param on Responses (removed by OpenAI)
}

// Responses output ceiling: max_output_tokens. REQUIRED (the API allows omitting it) so the hold has a bound.
function openaiResponsesOutputCap(body: any): number | null {
  const m = body?.max_output_tokens;
  return typeof m === "number" && m > 0 ? m : null;
}

// store:false for privacy (as with chat). NO include_usage needed — Responses streams usage by default in
// its terminal event.
function openaiResponsesPrepareBody(_raw: string, body: any, _streaming: boolean, injectCap?: number): string {
  const out: Record<string, unknown> = { ...(body ?? {}), store: false };
  if (injectCap != null) out.max_output_tokens = injectCap; // client omitted a cap → bound the output to what we held
  return JSON.stringify(out);
}

export type OpenAIConfig = { apiKey: string; baseUrl: string; estimateHold: HoldEstimator };

// The common edges shared by both OpenAI endpoints; each passes its shape-specific parts via `shape`.
function makeBase(
  cfg: OpenAIConfig,
  shape: Pick<Provider, "upstreamPath" | "premiumReject" | "outputCap" | "prepareBody" | "extractUsage" | "makeScanner">,
): Provider {
  return {
    id: "openai",
    baseUrl: cfg.baseUrl,
    estimateHold: cfg.estimateHold,
    readToken: bearerToken,
    // Priced AND tagged openai AND not off-card. The off-card check is load-bearing, not redundant with
    // the price-table curation: findModel matches by prefix, so an excluded id (o3-deep-research,
    // gpt-4o-audio-preview) would re-admit as its priced base (`o3`/`gpt-4o`) and under-bill. So claude-*
    // (wrong provider), *-search-preview (fee-bearing) and *-audio-preview (audio rates) all →
    // unsupported_model before forwarding.
    ownsModel: (model) => providerOf(model) === "openai" && !isOffCardModel(model),
    extraStrip: new Set(["openai-organization", "openai-project"]), // don't let the client pin/leak our org
    injectAuth: (headers) => headers.set("authorization", `Bearer ${cfg.apiKey}`),
    ...shape,
  };
}

// Build both OpenAI providers from one config. selectProviders (providers/index.ts) calls this only when
// OPENAI_API_KEY is set, so the two endpoints 404 when OpenAI is disabled — unchanged behavior.
export function makeOpenAIProviders(cfg: OpenAIConfig): { chat: Provider; responses: Provider } {
  const chat = makeBase(cfg, {
    upstreamPath: "/v1/chat/completions",
    premiumReject: openaiChatPremiumReject,
    outputCap: openaiChatOutputCap,
    prepareBody: openaiChatPrepareBody,
    extractUsage: extractOpenAIChatUsage,
    makeScanner: (ctx) => openaiChatScanner(ctx),
  });
  const responses = makeBase(cfg, {
    upstreamPath: "/v1/responses",
    premiumReject: openaiResponsesPremiumReject,
    outputCap: openaiResponsesOutputCap,
    prepareBody: openaiResponsesPrepareBody,
    extractUsage: extractOpenAIResponsesUsage,
    makeScanner: (ctx) => openaiResponsesScanner(ctx),
  });
  return { chat, responses };
}
