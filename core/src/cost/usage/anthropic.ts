// Anthropic usage adapter: extracts {model, usage} from an Anthropic response so we can price it. Two
// shapes — a buffered JSON body (extractUsage) and an incremental SSE stream (streamUsageScanner). Both
// read ONLY these meta fields — never the completion content — and store none of it.
import type { Usage } from "../pricing";
import type { Metered, UsageScanner } from "./types";

// Non-streaming path: the body is one JSON object carrying top-level model + usage.
export function extractUsage(text: string): Metered {
  try {
    const obj = JSON.parse(text);
    if (obj?.model && obj?.usage) {
      const u = obj.usage;
      // Normalize Anthropic's nested 1-hour cache-write slice (usage.cache_creation.ephemeral_1h_input_tokens)
      // to the flat field priceUsage prices at 2× — the SAME shape the streaming scanner below produces, so
      // both paths agree. Absent → 0 (no 1h writes, or a non-Anthropic shape). The flat total
      // (cache_creation_input_tokens) is already top-level on the usage object and passes through verbatim.
      return { model: obj.model, usage: { ...u, cache_creation_1h_input_tokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0 } };
    }
  } catch {}
  return null;
}

// Streaming path: usage is split across SSE events. `message_start` carries the model and input/cache
// tokens (plus an initial output_tokens); each `message_delta` restates the running cumulative
// output_tokens, final value in the last delta before `message_stop`. Feed raw decoded chunks as they
// pass to the client, then read result() at the end (clean close → exact) or at a client disconnect
// (partial — bills the last total seen; the up-front hold covers the rest). Every event's `data:`
// payload self-identifies via `.type`, so we dispatch on that and ignore SSE `event:` lines entirely.
export function streamUsageScanner(): UsageScanner {
  let buf = "";
  let model: string | null = null;
  let usage: Usage | null = null;
  // saw an `error` event → upstream failed (no usable completion); the caller full-refunds, never the input floor
  let errored = false;

  return {
    // Feed a decoded chunk. Buffers a partial trailing line across chunk boundaries.
    feed(chunk: string): void {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd(); // strip a trailing \r from CRLF framing
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // skip `event:`, blank separators, comments
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: any;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // ignore an unparseable frame rather than abort billing
        }
        if (evt?.type === "error") errored = true; // upstream error event (e.g. overloaded) → not billable
        if (evt?.type === "message_start" && evt.message?.usage) {
          if (typeof evt.message.model === "string") model = evt.message.model;
          const u = evt.message.usage;
          usage = {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
            // 1-hour cache-write slice (nested under cache_creation) → flat field, billed at 2×. The buffered
            // extractor lifts the same nested path so both shapes agree. Absent → 0.
            cache_creation_1h_input_tokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          };
        } else if (evt?.type === "message_delta" && evt.usage && usage) {
          // Deltas carry cumulative output_tokens; newer APIs sometimes restate input/cache too.
          const u = evt.usage;
          if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
          if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
          if (typeof u.cache_creation_input_tokens === "number")
            usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
          // Restate the 1-hour slice too, in lockstep with the flat total above, so a delta that re-reports
          // the cache totals can't leave the 1h sub-count stale against an updated total.
          if (typeof u.cache_creation?.ephemeral_1h_input_tokens === "number")
            usage.cache_creation_1h_input_tokens = u.cache_creation.ephemeral_1h_input_tokens;
          if (typeof u.cache_read_input_tokens === "number")
            usage.cache_read_input_tokens = u.cache_read_input_tokens;
        }
      }
    },

    // Snapshot for billing. null until a message_start with usage is seen → caller full-refunds,
    // mirroring extractUsage's "2xx without parseable usage" path.
    result(): Metered {
      return model && usage ? { model, usage } : null;
    },
    errored: () => errored,
  };
}
