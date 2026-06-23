// Provider registry + selection — the upstream LLM seam, mirror of rails/index.ts. The composition root
// (src/handler.ts createHandler) builds the active set from its deps and routes metered requests by EXACT
// upstreamPath. Anthropic is always present; OpenAI's two endpoints are added iff its config is given
// (OPENAI_API_KEY set in index.ts), so they 404 when disabled.
import { makeAnthropicProvider } from "./anthropic";
import { makeOpenAIProviders } from "./openai";
import type { Provider } from "./types";
import type { HoldEstimator } from "../hold";

export type { Provider } from "./types";

export type ProvidersConfig = {
  anthropic: { apiKey: string; baseUrl: string; version: string; estimateHold: HoldEstimator };
  // Present iff OPENAI_API_KEY is configured; absent → the OpenAI endpoints are not registered (404).
  openai?: { apiKey: string; baseUrl: string; estimateHold: HoldEstimator };
};

// Resolve the active providers into an EXACT-path → Provider map. Map.get is exact (no prefix readmit),
// preserving the old providerForPath invariant: a prefix would readmit subpaths (e.g. /v1/messages/batches).
// Unknown paths (or a disabled provider) miss the map → the handler's fail-closed 404.
export function selectProviders(cfg: ProvidersConfig): Map<string, Provider> {
  const m = new Map<string, Provider>();
  const anthropic = makeAnthropicProvider(cfg.anthropic);
  m.set(anthropic.upstreamPath, anthropic); // /v1/messages
  if (cfg.openai) {
    const { chat, responses } = makeOpenAIProviders(cfg.openai);
    m.set(chat.upstreamPath, chat); // /v1/chat/completions
    m.set(responses.upstreamPath, responses); // /v1/responses
  }
  return m;
}
