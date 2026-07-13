// Provider registry + selection — the upstream LLM seam, mirror of rails/index.ts. The composition root
// (src/handler.ts createHandler) builds the active set from its deps and routes metered requests by EXACT
// upstreamPath, then by model where providers share a path. Each provider is registered iff its config is
// given (its key set in proxy.ts): Anthropic's /v1/messages, OpenAI's pair (/v1/chat/completions,
// /v1/responses), and Tinfoil on /v1/chat/completions (shared with OpenAI, routed by model). A disabled
// provider's endpoints 404.
// At least one must be configured — selectProviders throws on an all-absent set, mirroring selectRails'
// non-empty PAY_RAILS guard.
import { makeAnthropicProvider } from "./anthropic";
import { makeOpenAIProviders } from "./openai";
import { makeTinfoilProvider } from "./tinfoil";
import type { Provider } from "./types";
import type { HoldEstimator } from "../hold";

export type { Provider } from "./types";

export type ProvidersConfig = {
  // Each present iff its key is configured (proxy.ts); absent → that provider's endpoints are not registered
  // (404). At least one is required — selectProviders throws on an all-absent config.
  anthropic?: { apiKey: string; baseUrl: string; version: string; estimateHold: HoldEstimator };
  openai?: { apiKey: string; baseUrl: string; estimateHold: HoldEstimator };
  // Tinfoil (OpenAI-compatible) — shares /v1/chat/completions with OpenAI; the handler routes by model.
  tinfoil?: { apiKey: string; baseUrl: string; estimateHold: HoldEstimator };
};

// Resolve the active providers into an EXACT-path → Provider[] map. Map.get is exact (no prefix readmit),
// preserving the old routing invariant: a prefix would readmit subpaths (e.g. /v1/messages/batches).
// Unknown paths (or a disabled provider) miss the map → the handler's fail-closed 404. A path may carry more
// than one provider (OpenAI + Tinfoil both speak /v1/chat/completions); the handler disambiguates per request
// by model (bare id → unique owner, or an explicit `provider/model` prefix).
export function selectProviders(cfg: ProvidersConfig): Map<string, Provider[]> {
  const m = new Map<string, Provider[]>();
  const register = (p: Provider) => {
    const list = m.get(p.upstreamPath);
    if (list) list.push(p);
    else m.set(p.upstreamPath, [p]);
  };
  if (cfg.anthropic) register(makeAnthropicProvider(cfg.anthropic)); // /v1/messages
  if (cfg.openai) {
    const { chat, responses } = makeOpenAIProviders(cfg.openai);
    register(chat); // /v1/chat/completions
    register(responses); // /v1/responses
  }
  if (cfg.tinfoil) register(makeTinfoilProvider(cfg.tinfoil)); // /v1/chat/completions (shared with OpenAI — routed by model)
  // At least one provider must be configured — an empty set would 404 every metered path, serving no LLM at
  // all. Mirrors selectRails' empty-PAY_RAILS guard; the composition root (proxy.ts) fails fast on it at boot.
  if (m.size === 0) throw new Error("no providers configured (set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or TINFOIL_API_KEY)");
  return m;
}

// Resolve which provider on a path serves a request, by model. Native id FIRST: a provider owning the
// VERBATIM id wins (so an org/model open-weight id whose org segment equals a provider name isn't wrongly
// stripped), then a `provider/model` namespace prefix (validated against the path's providers; the caller
// strips it before forwarding). Pure + exported so the branchy routing is unit-testable apart from the handler.
export type Resolution =
  | { ok: true; provider: Provider; model: string; prefixed: boolean }
  | { ok: false; error: "unsupported_model" | "ambiguous_model" };

export function resolveProvider(candidates: Provider[], rawModel: string, knownProviderIds: Set<string>): Resolution {
  // Native id first: one verbatim owner routes there; two would be ambiguous (unreachable while one provider
  // owns each id, but the guard stands for when pricing moves to (provider, id) keys).
  const nativeOwners = candidates.filter((c) => c.ownsModel(rawModel));
  if (nativeOwners.length > 1) return { ok: false, error: "ambiguous_model" };
  if (nativeOwners.length === 1) return { ok: true, provider: nativeOwners[0]!, model: rawModel, prefixed: false };
  // No verbatim owner — try a `provider/model` prefix. A leading segment that doesn't name a registered
  // provider stays part of the model (so an org/model id falls through to unsupported_model, not mis-split).
  const slash = rawModel.indexOf("/");
  const hint = slash > 0 ? rawModel.slice(0, slash) : "";
  if (!hint || !knownProviderIds.has(hint)) return { ok: false, error: "unsupported_model" };
  const bareModel = rawModel.slice(slash + 1);
  const hinted = candidates.find((c) => c.id === hint);
  // The prefix must name a provider serving THIS path AND that provider must own the bare model.
  if (!hinted || !hinted.ownsModel(bareModel)) return { ok: false, error: "unsupported_model" };
  return { ok: true, provider: hinted, model: bareModel, prefixed: true };
}
