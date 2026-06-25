// Provider registry + selection — the upstream LLM seam, mirror of rails/index.ts. The composition root
// (src/handler.ts createHandler) builds the active set from its deps and routes metered requests by EXACT
// upstreamPath. Each provider is registered iff its config is given (its key set in index.ts): Anthropic's
// /v1/messages, OpenAI's pair (/v1/chat/completions, /v1/responses). A disabled provider's endpoints 404.
// At least one must be configured — selectProviders throws on an all-absent set, mirroring selectRails'
// non-empty PAY_RAILS guard.
import { makeAnthropicProvider } from "./anthropic";
import { makeOpenAIProviders } from "./openai";
import type { Provider } from "./types";
import type { HoldEstimator } from "../hold";

export type { Provider } from "./types";

export type ProvidersConfig = {
  // Each present iff its key is configured (index.ts); absent → that provider's endpoints are not registered
  // (404). At least one is required — selectProviders throws on an all-absent config.
  anthropic?: { apiKey: string; baseUrl: string; version: string; estimateHold: HoldEstimator };
  openai?: { apiKey: string; baseUrl: string; estimateHold: HoldEstimator };
};

// Resolve the active providers into an EXACT-path → Provider map. Map.get is exact (no prefix readmit),
// preserving the old providerForPath invariant: a prefix would readmit subpaths (e.g. /v1/messages/batches).
// Unknown paths (or a disabled provider) miss the map → the handler's fail-closed 404.
export function selectProviders(cfg: ProvidersConfig): Map<string, Provider> {
  const m = new Map<string, Provider>();
  if (cfg.anthropic) {
    const anthropic = makeAnthropicProvider(cfg.anthropic);
    m.set(anthropic.upstreamPath, anthropic); // /v1/messages
  }
  if (cfg.openai) {
    const { chat, responses } = makeOpenAIProviders(cfg.openai);
    m.set(chat.upstreamPath, chat); // /v1/chat/completions
    m.set(responses.upstreamPath, responses); // /v1/responses
  }
  // At least one provider must be configured — an empty set would 404 every metered path, serving no LLM at
  // all. Mirrors selectRails' empty-PAY_RAILS guard; the composition root (index.ts) fails fast on it at boot.
  if (m.size === 0) throw new Error("no providers configured (set ANTHROPIC_API_KEY and/or OPENAI_API_KEY)");
  return m;
}
