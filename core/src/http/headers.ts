// HTTP header policy for the proxy edge — the transport seam, extracted from handler.ts. Two directions:
// which CLIENT headers never reach the upstream (STRIP + buildUpstreamHeaders, the forward path), and which
// UPSTREAM headers never reach the client (scrubRespHeaders, the relay path). The money/forward logic stays
// in the handler; only the header plumbing lives here.
import type { Provider } from "../providers";

// Never forward upstream: the client's auth (we inject our own), `anthropic-beta` (premium betas; a
// flat-rate-safe subset is re-added by buildUpstreamHeaders — see ANTHROPIC_SAFE_BETA), the client's org id
// (we use our account), host/connection/content-length (connection framing — let fetch set its own), the
// client SDK fingerprint: `user-agent` and the `x-stainless-*` family (the prefix is handled below), and the
// caller-page fingerprint `origin`/`referer` — no LLM API gates on them, and the Tinfoil verifying proxy's
// loopback guard rejects any forwarded `origin`. NOTE: not a full RFC hop-by-hop strip
// (transfer-encoding/te/trailer/upgrade/keep-alive aren't listed); add if needed.
const STRIP = new Set([
  "host",
  "connection",
  "content-length",
  "authorization",
  "x-api-key",
  "anthropic-beta",
  "anthropic-organization-id",
  "user-agent", // client SDK fingerprint — normalized to a neutral value below, never forwarded
  "x-request-id", // client-supplied trace id; the upstream issues its own request-id on the response
  "origin", // caller-page fingerprint; no upstream gates on it, and the Tinfoil verifying proxy 403s it
  "referer",
]);

// The Stainless-generated Anthropic AND OpenAI SDKs attach an `x-stainless-*` header cluster (os, arch, lang,
// runtime, runtime-version, package-version, retry-count, …) — the caller's OS, CPU, language, and SDK
// version. None of it is functional: Anthropic gates on anthropic-version + anthropic-beta, OpenAI on the path
// + Authorization, and rate limits key on the account, never the UA. So we drop the whole prefix to keep that
// fingerprint off the upstream. `user-agent` is NORMALIZED rather than just dropped — a missing UA can trip an
// upstream abuse/rate-limit heuristic, so we forward a fixed neutral value in its place.
const STAINLESS_PREFIX = "x-stainless-";
const NORMALIZED_USER_AGENT = "nullsink";

// Build the upstream request headers: copy the client's, drop the shared STRIP set, the `x-stainless-*`
// fingerprint prefix, and any provider extras (auth, beta, org — never forwarded), then inject our key/version
// and a normalized user-agent. Shared by buffered + streaming.
export function buildUpstreamHeaders(provider: Provider, req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of req.headers) {
    const lk = key.toLowerCase();
    if (STRIP.has(lk) || lk.startsWith(STAINLESS_PREFIX) || provider.extraStrip?.has(lk)) continue;
    headers.set(key, value);
  }
  // `anthropic-beta` was dropped by STRIP; re-add only the flat-rate-safe markers (context editing), so a
  // request carrying both a safe and a premium beta forwards the safe one and still strips the premium.
  const clientBeta = req.headers.get("anthropic-beta");
  if (clientBeta && provider.forwardBeta) {
    const kept = provider.forwardBeta(clientBeta);
    if (kept) headers.set("anthropic-beta", kept);
  }
  provider.injectAuth(headers);
  headers.set("user-agent", NORMALIZED_USER_AGENT); // a fixed UA in place of the client's SDK fingerprint
  return headers;
}

// Never relay back to the client: content-encoding (fetch already decoded the body), content-length
// (length changed, or body is now a live stream — let Bun set it), and our org id (never leak our
// identity). Shared by buffered and streaming paths.
export function scrubRespHeaders(upstream: Response): Headers {
  const h = new Headers(upstream.headers);
  h.delete("content-encoding");
  h.delete("content-length");
  h.delete("anthropic-organization-id");
  h.delete("openai-organization"); // never leak our OpenAI org id back to the client
  h.delete("openai-project");
  return h;
}
