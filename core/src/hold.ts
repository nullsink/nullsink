// Sizing the pre-flight balance hold: a SOUND upper bound on request cost. The handler's refund clamp
// (handler.ts billActual) caps the charge at the hold, so even an under-estimate can NEVER overdraft —
// it just bills the full hold. A sound bound keeps the clamp from biting so the user is billed exactly.
//
// Estimator SEAM. The default below is deterministic and provider-agnostic (no extra upstream call); a
// tighter per-provider path (Anthropic/Bedrock/Vertex `count_tokens`) can drop in as an alternative
// HoldEstimator closing over the upstream creds in proxy.ts, zero handler changes. Reach for it only if
// the over-reservation below causes real false-402s.
import { priceHoldBound } from "./cost";

export type HoldInput = {
  model: string; // gate-validated, priced model id (response model is not yet known)
  raw: string; // raw request body — the byte source for the deterministic bound
  body: any; // parsed body — read by the count_tokens estimator (the prod default); unused by the byte bound
  maxTokens: number; // request max_tokens — the exact output ceiling
  // Per-request headers to merge into the count_tokens call (the byte bound ignores them). The handler puts
  // the client's `anthropic-beta` here so the FREE counter accepts beta-gated body fields it would otherwise
  // 400 (e.g. context_management, prompt-caching-scope) — see makeCountTokensHold. Counting is unbilled, so
  // forwarding any beta here can NEVER enable premium pricing: that is gated only on the separate (filtered)
  // /v1/messages relay. Our injected auth always overrides these (they can't spoof x-api-key/version).
  countHeaders?: Record<string, string>;
  // True when the request opts into 1-hour cache writes; priceHoldBound then sizes the input ceiling at the
  // 2× tier (vs the standard tier when absent/false). See the cache_write_1h synthesis in cost/pricing.ts.
  oneHourCache?: boolean;
};

// The hold (micro-dollars) plus the input-token count it was sized from. `micros` is the hold (padded for
// headroom); `inputTokens` is the REAL estimate (the unpadded count, or the byte bound on fallback) — billed
// at the actual input rate, not the hold's max rate, and reused for the OpenAI streaming disconnect bill
// (see the scanners' fallback in cost/usage/openai.ts).
export type HoldResult = { micros: number; inputTokens: number };

// Sync today; typed async-capable so a count_tokens estimator (one upstream round-trip) drops in without
// touching the handler, which already awaits the result.
export type HoldEstimator = (input: HoldInput) => HoldResult | Promise<HoldResult>;

// Deterministic, no-upstream-call upper bound. Soundness:
//   input  — a prompt tokenizes to at most one token per UTF-8 byte (BPE byte-fallback is the worst
//            case), so prompt_tokens ≤ utf8_bytes; priceHoldBound charges those at the model's priciest
//            input rate, so the real input cost can only be lower.
//   output — exact: output_tokens (thinking included) ≤ max_tokens.
// So holdAmount ≥ actual always → refund always ≥ 0. Loose for ASCII (~5×) and very loose for base64
// images, but over-reservation only risks a false 402 on a near-empty balance, never a money loss. Use
// utf8 bytes, NOT raw.length (UTF-16 units): CJK is ~1 UTF-16 unit but ~1.5 tokens/char, so raw.length
// would NOT be sound.
export function byteBoundHold({ model, raw, maxTokens, oneHourCache }: HoldInput): HoldResult {
  const utf8Bytes = Buffer.byteLength(raw, "utf8");
  return { micros: priceHoldBound(model, utf8Bytes, maxTokens, { oneHourCache }), inputTokens: utf8Bytes };
}

// Tighter estimator: asks Anthropic's `/v1/messages/count_tokens` for the EXACT input-token count
// (images included — the byte bound is ~62× loose on base64 images, ~5× on ASCII), then sizes the hold
// at priceHoldBound(model, padded_input_tokens, max_tokens). count_tokens is free but a DOCUMENTED ESTIMATE
// that "may differ slightly from actual usage", so we add token headroom (HOLD_INPUT_MARGIN/PAD) against
// realistic count↔bill drift (cache bookkeeping, tokenizer diffs), then CAP at the byte bound (proven
// bytes-≥-tokens ceiling) so an absurd count can't inflate it. Output exact by max_tokens. One extra
// upstream round-trip per request.
//
// RESIDUAL: the bound still BETS padded_count ≥ actual input tokens — not a proof like the byte bound.
// The margin makes the bet safe against realistic drift, not adversarial pathology; for a hard guarantee
// set HOLD_ESTIMATOR=byte. Either way the handler's refund clamp caps the charge at the hold, so even a
// blown bet can't overdraft — it just bills the full hold. FAILS SAFE: any error (down, timeout,
// malformed, non-positive count) falls back to byteBoundHold. Built in proxy.ts so it closes over creds.

// Token headroom over the count_tokens result. Multiply by MARGIN and add PAD (covers small fixed
// per-request overhead like cache-breakpoint bookkeeping). 10%+64 tok is still dwarfed by the byte bound.
export const HOLD_INPUT_MARGIN = 1.1;
export const HOLD_INPUT_PAD = 64;

// The token counters take INPUT-shaped bodies; output/sampling/control fields are NOT in their schema and
// would 400 the count ("Extra inputs are not permitted") or just be ignored. So we strip a per-provider
// denylist of those fields. Not about cost: none change the input count, and OUTPUT cost is reserved
// separately (output cap × output rate), so stripping is always sound.
//
// We forward the WHOLE body MINUS the denylist (not an allowlist) so it fails SAFE both ways: a future
// BILLABLE input field we don't know is still forwarded → counted → hold stays sound; a future
// incompatible CONTROL field we miss just 400s the count → byte-bound fallback (sound, loose). An
// allowlist would do the opposite — silently drop and under-count any new input field.
//
// Anthropic → POST /v1/messages/count_tokens. Schema: messages/model/system/tools/tool_choice/thinking/
// cache_control/output_config. This is the BELT to the suspenders: control/sampling fields below are
// stripped because they aren't in the count schema and don't affect the input count. (Beta-gated body
// fields are generally handled by forwarding the client's anthropic-beta — see HoldInput.countHeaders.)
// We KEEP context_management in the omit set anyway: a client may send it WITHOUT its beta header, and
// stripping avoids the 400 then — sound, since context editing only PRUNES (un-pruned over-counts → hold
// stays an upper bound).
export const ANTHROPIC_COUNT_OMIT = new Set([
  "max_tokens",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "service_tier",
  "context_management",
]);

// OpenAI → POST /v1/responses/input_tokens. EMPIRICAL (verified live via scripts/e2e-hold.ts): this endpoint
// counts a RESPONSES-shaped body (`input`) cleanly, but 400s a Chat-Completions `{messages}` body even when
// stripped to the minimum — so /v1/responses holds are tight (count-based) while /v1/chat/completions holds
// fall back to the (sound, looser ~5–18× — and ~60× on base64 images) byte bound. Either way the byte-bound
// cap/fallback keeps the hold a sound upper bound, so billing never overdrafts. This omit set is what makes
// the RESPONSES count succeed (strips the output/sampling/control fields it would reject). Tightening chat
// holds (translate messages→responses `input` for the count, or local tiktoken) is a TODO.
export const OPENAI_COUNT_OMIT = new Set([
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "stream",
  "stream_options",
  "n",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "seed",
  "response_format",
  "service_tier",
  "store",
  "metadata",
  "user",
  "parallel_tool_calls",
  "prediction",
  "reasoning_effort",
  "modalities",
  "audio",
]);

export type CountTokensHoldOptions = {
  countUrl: string; // full URL of the provider's token-count endpoint
  authHeaders: Record<string, string>; // provider auth (x-api-key+version, or Authorization: Bearer), merged with content-type
  omit: Set<string>; // body fields to strip before counting (ANTHROPIC_COUNT_OMIT / OPENAI_COUNT_OMIT)
  timeoutMs: number;
  fetchImpl?: typeof fetch; // injectable so tests don't hit the network
};

// Both providers' counters return `{ input_tokens }`, so the parse + headroom + byte-cap logic is shared;
// only the URL, auth headers, and omit-set differ (closed over per provider in proxy.ts).
export function makeCountTokensHold(opts: CountTokensHoldOptions): HoldEstimator {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async function countTokensHold(input: HoldInput): Promise<HoldResult> {
    const { model, body, maxTokens, countHeaders } = input;
    try {
      const countBody: Record<string, unknown> = { ...(body ?? {}) };
      for (const k of opts.omit) delete countBody[k];
      countBody.model = model; // the gate-validated model id
      const res = await fetchImpl(opts.countUrl, {
        method: "POST",
        // countHeaders (client anthropic-beta) BEFORE authHeaders: can ADD beta markers, never override our
        // injected auth. Free count call → can't enable premium pricing. See HoldInput.countHeaders.
        headers: { "content-type": "application/json", ...(countHeaders ?? {}), ...opts.authHeaders },
        body: JSON.stringify(countBody),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}`);
      const data: any = await res.json();
      const inputTokens = data?.input_tokens;
      // A gate-passing request always has ≥1 input token, so a 0/negative/NaN count is a bug not a tiny
      // prompt → fall back to the sound byte bound rather than trust a too-small hold.
      if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 1)
        throw new Error(`count_tokens: bad input_tokens ${JSON.stringify(inputTokens)}`);
      const padded = Math.ceil(inputTokens * HOLD_INPUT_MARGIN) + HOLD_INPUT_PAD;
      // Cap at the byte bound (proven ceiling) so an absurd count can't inflate the hold beyond it. Return
      // the UNPADDED count as inputTokens — the real input estimate for the disconnect bill (padding is
      // hold headroom, not usage).
      return {
        micros: Math.min(byteBoundHold(input).micros, priceHoldBound(model, padded, maxTokens, { oneHourCache: input.oneHourCache })),
        inputTokens,
      };
    } catch {
      // PURE + SILENT: any failure (down/timeout/malformed/non-positive count) falls back to the SOUND byte
      // bound. The byte bound is a proven upper bound and billActual reconciles to actual usage, so a fallback
      // costs nothing — no log, no metric. Its only possible harm is a false-402 on a near-empty balance, never
      // observed in prod; instrument that here (at the handler's openHold rejection) if it ever bites.
      return byteBoundHold(input);
    }
  };
}
