// OpenAI usage adapter: maps OpenAI's two response shapes (Chat Completions + the newer Responses API)
// into the canonical Usage.
import { sanitizeCount, type Usage } from "../pricing";
import { MAX_SSE_LINE, type Metered, type UsageScanner, type ScannerCtx } from "./types";

// --- OpenAI Chat Completions shape ---------------------------------------------------------------
// Different from Anthropic in two ways that matter for billing:
//   1. Usage field names: prompt_tokens / completion_tokens (vs input_tokens / output_tokens), and
//      crucially prompt_tokens is INCLUSIVE of cached tokens (Anthropic's input_tokens is exclusive). So
//      we split prompt_tokens into (prompt − cached) charged at the input rate + cached at the cache-read
//      rate, or cached tokens would be double-counted. reasoning_tokens is already a SUBSET of
//      completion_tokens, so output_tokens = completion_tokens covers it — never add it separately.
//   2. Streaming carries usage ONLY in a final chunk (and only because we inject stream_options.
//      include_usage). There is NO incremental usage, so a mid-stream disconnect has none — see the
//      scanner's content-token fallback.

// OpenAI reports a single input total INCLUSIVE of cached tokens (both Chat and Responses), unlike
// Anthropic's exclusive input_tokens. Split it into the non-cached portion (input rate) + cached
// (cache_read rate); cache_creation is always 0 (OpenAI has no cache-WRITE token fee).
function splitOpenAIInput(totalInput: number, cached: number): Usage {
  return {
    input_tokens: Math.max(0, totalInput - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

// Chat Completions usage: prompt_tokens / completion_tokens, cached under prompt_tokens_details.
// completion_tokens already includes reasoning_tokens.
function mapOpenAIChatUsage(u: any): Usage {
  return { ...splitOpenAIInput(sanitizeCount(u?.prompt_tokens), sanitizeCount(u?.prompt_tokens_details?.cached_tokens)), output_tokens: sanitizeCount(u?.completion_tokens) };
}

// Responses usage: input_tokens / output_tokens, cached under input_tokens_details. output_tokens already
// includes output_tokens_details.reasoning_tokens.
function mapOpenAIResponsesUsage(u: any): Usage {
  return { ...splitOpenAIInput(sanitizeCount(u?.input_tokens), sanitizeCount(u?.input_tokens_details?.cached_tokens)), output_tokens: sanitizeCount(u?.output_tokens) };
}

// Non-streaming path: one chat.completion JSON with top-level model + usage.
export function extractOpenAIChatUsage(text: string): Metered {
  try {
    const obj = JSON.parse(text);
    if (obj?.model && obj?.usage) return { model: obj.model, usage: mapOpenAIChatUsage(obj.usage) };
  } catch {}
  return null;
}

// Chars-per-token rule of thumb for the disconnect fallback ONLY (~4 for English).
// A deliberate approximation: the clean-completion path bills EXACT usage from the final chunk, so this is
// reached only on a mid-stream disconnect, where it closes the free-output exploit. The clamp keeps it ≤
// the hold. Tighten later with a real tokenizer if it proves too loose.
const CHARS_PER_TOKEN = 4;

// Streaming path. Each SSE `data:` is a chat.completion.chunk: `choices[].delta.content` carries text, and
// with stream_options.include_usage a FINAL chunk arrives with `choices:[]` + a `usage` object. A clean
// close bills that exact usage; a disconnect before it bills the prompt the upstream already ingested
// (ctx.inputTokens — image-aware, from the hold) plus a char-estimated partial output. Input on the
// fallback is billed at the full input rate (the cache split isn't known mid-stream) — a conservative
// choice that never under-bills us, bounded by the clamp.
export function openaiChatScanner(ctx: ScannerCtx): UsageScanner {
  let buf = "";
  let model: string | null = null;
  let finalUsage: Usage | null = null; // exact, from the include_usage final chunk
  let contentChars = 0; // accumulated streamed output text length, for the disconnect estimate
  let sawAny = false; // any parseable event → generation started (bill the partial, not a full refund)
  let failed = false; // upstream signalled an error mid-stream (not a client disconnect) → full refund

  return {
    feed(chunk: string): void {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd(); // strip a trailing \r from CRLF framing
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // skip blank separators / comments
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: any;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // ignore an unparseable frame rather than abort billing
        }
        sawAny = true;
        if (evt.error || evt.type === "error") failed = true; // upstream error frame (e.g. quota/content) mid-stream
        if (typeof evt.model === "string") model = evt.model;
        if (evt.usage) finalUsage = mapOpenAIChatUsage(evt.usage); // the include_usage final chunk
        const choices = evt.choices;
        if (Array.isArray(choices)) {
          for (const ch of choices) {
            const c = ch?.delta?.content;
            if (typeof c === "string") contentChars += c.length;
          }
        }
      }
      if (buf.length > MAX_SSE_LINE) buf = ""; // drop a newline-less run so buf can't grow unbounded
    },

    result(): Metered {
      if (finalUsage) return { model: model ?? ctx.model, usage: finalUsage }; // clean close → exact
      // No usage. Distinguish an UPSTREAM failure (error frame, or nothing arrived) — nothing billable
      // happened, full refund, like a non-2xx — from a CLIENT disconnect (generation started, the client
      // got partial output), which bills the partial below.
      if (failed || !sawAny) return null;
      return {
        model: model ?? ctx.model,
        usage: {
          input_tokens: ctx.inputTokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: disconnectOutput(contentChars, ctx),
        },
      };
    },
    errored: () => failed, // an upstream error frame → caller full-refunds (never the input floor) even on a client abort
  };
}

// Output-token estimate for a mid-stream disconnect (no final usage chunk). Normally the char heuristic;
// but for a REASONING model the billed thinking tokens never appear as streamed text, so the char count is
// blind to them and would massively under-bill — bill the output CAP instead (a sound upper bound, since
// reasoning can fill it). This can OVER-bill an honest early disconnect of a reasoning stream up to the cap
// (≤ the hold already reserved) — the accepted price of closing the under-bill exploit, since reasoning is
// unmeasurable mid-stream. maxTokens absent (e.g. tests) → falls back to the char estimate.
function disconnectOutput(contentChars: number, ctx: ScannerCtx): number {
  const est = Math.ceil(contentChars / CHARS_PER_TOKEN);
  return ctx.reasoning ? Math.max(est, ctx.maxTokens ?? 0) : est;
}

// --- OpenAI Responses shape ----------------------------------------------------------------------
// The Responses API (POST /v1/responses) is OpenAI's own newer endpoint — a THIRD shape, distinct from
// Chat Completions: the buffered body is `{ model, usage, output: [...] }`, and its stream emits typed
// events (response.output_text.delta for text, response.completed carrying the full response incl. usage).
// Usage streams BY DEFAULT (no include_usage opt-in needed), but only in the final event — so a mid-stream
// disconnect still has none and uses the same content-token fallback as the chat scanner.

// Non-streaming path: top-level model + usage on the response object.
export function extractOpenAIResponsesUsage(text: string): Metered {
  try {
    const obj = JSON.parse(text);
    if (obj?.model && obj?.usage) return { model: obj.model, usage: mapOpenAIResponsesUsage(obj.usage) };
  } catch {}
  return null;
}

// Streaming path. Dispatch on each event's `.type`: response.output_text.delta carries a `.delta` text
// chunk (accumulated for the disconnect estimate); the terminal response.completed / .failed / .incomplete
// events carry the full `.response` object, whose `.usage` is the exact final usage and `.model` the
// resolved id. Clean close → exact; disconnect before the terminal event → input (from the hold) + a
// char-estimated partial output, identical policy to the chat scanner.
export function openaiResponsesScanner(ctx: ScannerCtx): UsageScanner {
  let buf = "";
  let model: string | null = null;
  let finalUsage: Usage | null = null;
  let contentChars = 0;
  let sawAny = false;
  let failed = false; // a response.failed / error event (no usage) → upstream failure → full refund

  return {
    feed(chunk: string): void {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // ignore the SSE `event:` line; the payload self-identifies via .type
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: any;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        sawAny = true;
        // response.failed / a top-level error = upstream failure (no usable completion); response.incomplete
        // (hit the output cap) is NOT a failure — it carries usage and is handled by finalUsage below.
        if (evt.type === "response.failed" || evt.type === "error" || evt.error) failed = true;
        if (typeof evt.response?.model === "string") model = evt.response.model;
        if (evt.response?.usage) finalUsage = mapOpenAIResponsesUsage(evt.response.usage);
        if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") contentChars += evt.delta.length;
      }
      if (buf.length > MAX_SSE_LINE) buf = ""; // drop a newline-less run so buf can't grow unbounded
    },

    result(): Metered {
      if (finalUsage) return { model: model ?? ctx.model, usage: finalUsage }; // clean close → exact
      if (failed || !sawAny) return null; // upstream failure / nothing arrived → full refund
      return {
        model: model ?? ctx.model,
        usage: {
          input_tokens: ctx.inputTokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: disconnectOutput(contentChars, ctx),
        },
      };
    },
    errored: () => failed, // an upstream error frame → caller full-refunds (never the input floor) even on a client abort
  };
}
