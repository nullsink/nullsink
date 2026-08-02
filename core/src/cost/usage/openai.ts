// OpenAI usage adapter: maps OpenAI's two response shapes (Chat Completions + the newer Responses API)
// into the canonical Usage.
import { sanitizeCount, type Usage } from "../pricing";
import type { Metered, UsageScanner, ScannerCtx } from "./types";

// --- OpenAI Chat Completions shape ---------------------------------------------------------------
// Different from Anthropic in two ways that matter for billing:
//   1. Usage field names: prompt_tokens / completion_tokens (vs input_tokens / output_tokens), and
//      crucially prompt_tokens is INCLUSIVE of its cache slices (Anthropic's input_tokens is exclusive).
//      So we split prompt_tokens across the input / cache_read / cache_write rates (see splitOpenAIInput),
//      or the sliced tokens would be double-counted. reasoning_tokens is already a SUBSET of
//      completion_tokens, so output_tokens = completion_tokens covers it — never add it separately.
//   2. Streaming carries usage ONLY in a final chunk (and only because we inject stream_options.
//      include_usage). There is NO incremental usage, so a mid-stream disconnect has none — see the
//      scanner's content-token fallback.

// OpenAI reports a single input total INCLUSIVE of its detail slices (both Chat and Responses), unlike
// Anthropic's exclusive input_tokens: cached_tokens (read from cache) and — billable since gpt-5.6, at
// 1.25× input — cache_write_tokens (written to cache; absent or 0 on older models). Split the total into
// non-cached (input rate) + cached (cache_read rate) + written (cache_write rate). Each slice is CLAMPED
// to what remains of the total: a buggy/hostile report whose slices exceed the total must neither drive
// input_tokens negative nor bill more cache-write tokens (the dearest input tier) than the prompt had —
// either direction would mis-bill.
function splitOpenAIInput(totalInput: number, cached: number, written: number): Usage {
  const read = Math.min(cached, totalInput);
  const write = Math.min(written, totalInput - read);
  return {
    input_tokens: totalInput - read - write,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  };
}

// Chat Completions usage: prompt_tokens / completion_tokens, detail slices under prompt_tokens_details.
// completion_tokens already includes reasoning_tokens.
function mapOpenAIChatUsage(u: any): Usage {
  const d = u?.prompt_tokens_details;
  return { ...splitOpenAIInput(sanitizeCount(u?.prompt_tokens), sanitizeCount(d?.cached_tokens), sanitizeCount(d?.cache_write_tokens)), output_tokens: sanitizeCount(u?.completion_tokens) };
}

// Responses usage: input_tokens / output_tokens, detail slices under input_tokens_details. output_tokens
// already includes output_tokens_details.reasoning_tokens.
function mapOpenAIResponsesUsage(u: any): Usage {
  const d = u?.input_tokens_details;
  return { ...splitOpenAIInput(sanitizeCount(u?.input_tokens), sanitizeCount(d?.cached_tokens), sanitizeCount(d?.cache_write_tokens)), output_tokens: sanitizeCount(u?.output_tokens) };
}

// Non-streaming path: one chat.completion JSON with top-level model + usage.
export function extractOpenAIChatUsage(text: string): Metered {
  try {
    const obj = JSON.parse(text);
    if (obj?.model && obj?.usage) return { model: obj.model, usage: mapOpenAIChatUsage(obj.usage), evidence: "reported" };
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
// fallback is billed at the full input rate (the cache split isn't known mid-stream): that overstates a
// cache-read-heavy prompt in our favour, and since gpt-5.6 (cache writes 1.25× input) can understate a
// write-heavy one by ≤25% of its input cost — accepted, disconnect-only, bounded by the clamp; billing
// the floor at max(input, cache_write) instead would overcharge every cache-read-heavy disconnect.
export function openaiChatScanner(ctx: ScannerCtx): UsageScanner {
  let buf = "";
  let model: string | null = null;
  let finalUsage: Usage | null = null; // exact, from the include_usage final chunk
  let contentChars = 0; // accumulated streamed output text (content + reasoning/reasoning_content), for the disconnect estimate
  let sawAny = false; // any parseable event → generation started (bill the partial, not a full refund)
  let failed = false; // upstream signalled an error mid-stream (not a client disconnect)

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
            const d = ch?.delta;
            const c = d?.content;
            if (typeof c === "string") contentChars += c.length;
            // Reasoning streams in a side field on OpenAI-compatible hosts and bills as output — count it too,
            // or a disconnect estimate would be blind to it. Tinfoil/vLLM uses `reasoning` (verified live);
            // DeepSeek-style hosts use `reasoning_content`. Genuine OpenAI emits NEITHER on chat; its hidden
            // reasoning is unavailable before terminal usage. We do not speculate about it:
            // a reservation maximum is not evidence and must never become the disconnect charge.
            const r = d?.reasoning ?? d?.reasoning_content;
            if (typeof r === "string") contentChars += r.length;
          }
        }
      }
    },

    result(mode?: "evidenced_only"): Metered {
      if (finalUsage) return { model: model ?? ctx.model, usage: finalUsage, evidence: "reported" }; // clean close → exact
      if (!sawAny) return null;
      // OpenAI reports usage only in the terminal chunk. If the upstream fails after visible text, bill a
      // conservative estimate of work the caller actually received: counted/discounted input plus visible output.
      // Never apply the output reservation here: charging speculative invisible work would be unfair. An
      // operator/provider-caused termination before visible output still fully refunds.
      if (mode === "evidenced_only") {
        if (contentChars === 0) return null;
        return {
          model: model ?? ctx.model,
          evidence: "estimated",
          usage: {
            input_tokens: ctx.inputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: Math.ceil(contentChars / CHARS_PER_TOKEN),
          },
        };
      }
      // An in-band upstream failure with no requested failure estimate is not a caller disconnect.
      if (failed) return null;
      return {
        model: model ?? ctx.model,
        evidence: "estimated",
        usage: {
          input_tokens: ctx.inputTokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: Math.ceil(contentChars / CHARS_PER_TOKEN),
        },
      };
    },
    errored: () => failed,
  };
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
    if (obj?.model && obj?.usage) return { model: obj.model, usage: mapOpenAIResponsesUsage(obj.usage), evidence: "reported" };
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
  let failed = false; // a response.failed / error event (no usage) → upstream failure

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
    },

    result(mode?: "evidenced_only"): Metered {
      if (finalUsage) return { model: model ?? ctx.model, usage: finalUsage, evidence: "reported" }; // clean close → exact
      if (!sawAny) return null;
      if (mode === "evidenced_only") {
        if (contentChars === 0) return null;
        return {
          model: model ?? ctx.model,
          evidence: "estimated",
          usage: {
            input_tokens: ctx.inputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: Math.ceil(contentChars / CHARS_PER_TOKEN),
          },
        };
      }
      if (failed) return null;
      return {
        model: model ?? ctx.model,
        evidence: "estimated",
        usage: {
          input_tokens: ctx.inputTokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: Math.ceil(contentChars / CHARS_PER_TOKEN),
        },
      };
    },
    errored: () => failed,
  };
}
