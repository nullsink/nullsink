// Error + rejection responses for the proxy edge, extracted from handler.ts. Two envelope styles:
// deny() serves nullsink's OWN endpoints (/buy, /balance, 404) with a bare {error} body; denyApi() +
// apiErrorBody() build each upstream PROVIDER's NATIVE error envelope so a stock SDK classifies a gate
// reject correctly. The upstream relay/mask POLICY (relayOrMaskUpstream / isBillingError) stays with the
// metering engine in handler.ts and imports apiErrorBody from here — it's billing policy, not plumbing.

// The public, nullsink-owned endpoint codes. Keep this list small and stable: browser/UI copy belongs in
// the client, while API callers can safely branch on these codes. Provider-native errors deliberately do
// NOT use this type — their wire formats are part of the upstream SDK contracts below.
export const OWN_API_ERROR_CODES = [
  "unsupported_endpoint",
  "rate_limited",
  "payload_too_large",
  "invalid_json",
  "invalid_hash",
  "invalid_address",
  "invalid_amount",
  "unknown_rail",
  "client_upgrade_required",
  "order_in_progress",
  "busy_try_later",
  "rate_unavailable",
  "wallet_unavailable",
  "invalid_token",
  "proxy_error",
  "payments_error",
] as const;
export type OwnApiErrorCode = (typeof OWN_API_ERROR_CODES)[number];

export const deny = (status: number, error: OwnApiErrorCode) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });

// 429 with a Retry-After hint so a well-behaved client backs off instead of hot-looping (which would only
// tighten a flood). Used by the global, identity-free read throttle on /balance + /order-status. The hint
// is coarse (these buckets refill fast by default), and Retry-After is advisory regardless.
export const denyThrottled = (retryAfterSec: number) =>
  new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(retryAfterSec) },
  });

// Map an HTTP status to Anthropic's native error `type`. A stock Anthropic SDK (e.g. Claude Code) classifies
// a failure by this envelope, so a gate 401 must read as a terminal `authentication_error` it won't retry —
// not our old opaque `{"error":"..."}`, which a client can mis-handle into a retry storm. Strings match
// Anthropic's own error types (incl. `billing_error` for 402, as the upstream itself returns).
function anthropicErrorType(status: number): string {
  switch (status) {
    case 400: return "invalid_request_error";
    case 401: return "authentication_error";
    case 402: return "billing_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 413: return "request_too_large";
    case 429: return "rate_limit_error";
    default: return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

// Map an HTTP status to OpenAI's native error `type` (coarse, by status — OpenAI uses invalid_request_error
// for auth too). SDKs key retry on status + x-should-retry, not this string; the native `type`+`code` is
// what openai-python/node read off `err.error.*` for a clean message.
function openaiErrorType(status: number): string {
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

// Build the provider-native error BODY (string, no Response) so a stock SDK classifies it natively. Both
// providers wear an OBJECT `error` (a bare {error:"code"} string surfaces a blank message in their SDKs):
// Anthropic → {type:"error",error:{type,message}}; OpenAI → {error:{message,type,code}} (code keeps our
// machine-readable reason). `message` stays opaque on masked paths (a generic code, never the upstream's
// text) so the envelope is native without leaking the provider's identity, our billing state, or key status.
// Shared by denyApi (the gate) and relayOrMaskUpstream / the transient catch (the forward path).
export function apiErrorBody(providerId: string, status: number, code: string, message?: string): string {
  return providerId === "anthropic"
    ? JSON.stringify({ type: "error", error: { type: anthropicErrorType(status), message: message ?? code } })
    : JSON.stringify({ error: { message: message ?? code, type: openaiErrorType(status), code } });
}

// Provider-native GATE rejection (pre-forward), as opposed to deny() which serves nullsink's OWN endpoints
// (/balance, /buy, 404). Every gate reject is TERMINAL (bad token, unpriced model, no funds — retrying never
// clears it), so we send `x-should-retry: false` to stop conforming SDKs from spinning. Transient upstream
// errors take the retryable path in relayOrMaskUpstream / the catch below instead.
export function denyApi(provider: { id: string }, status: number, code: string, message?: string): Response {
  return new Response(apiErrorBody(provider.id, status, code, message), {
    status,
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });
}

// The two distinct 401s on the metered gate were both the opaque "invalid_token", indistinguishable to a
// caller. This one means NO usable auth header was presented at all (vs a present-but-unrecognized token) —
// a client-config error, so the message names the fix. Kept separate from the token-validity 401 so the
// developer can tell "I sent no key" from "my key is wrong" without a validity oracle on specific tokens.
export const NO_API_KEY = {
  code: "missing_api_key",
  message: "no API key provided — send the proxy token as the x-api-key header (or Authorization: Bearer)",
};
