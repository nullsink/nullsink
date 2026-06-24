// Shared usage types — the canonical metered shape the cost math prices, plus the streaming-scanner seam
// both providers' adapters conform to. Provider-agnostic, so the handler that drives scanners stays so too.
import type { Usage } from "../pricing";

export type Metered = { model: string; usage: Usage } | null;

// The streaming-meter seam: feed decoded chunks as they pass to the client, read result() at the end
// (clean close) or at a disconnect (partial). Both the Anthropic scanner (exact cumulative usage per
// delta) and the OpenAI scanners (final usage chunk + a content-token fallback for mid-stream
// disconnects) conform to this, so handleMetered in handler.ts stays provider-agnostic.
export type UsageScanner = { feed(chunk: string): void; result(): Metered; errored(): boolean };

// Cap the per-line buffer a streaming scanner accumulates before the next newline. A real SSE/usage frame is
// tiny; an upstream that streams a long run with NO newline (a giant frame, or a buggy/compromised/MITM
// upstream) would otherwise grow the scanner's buffer without bound — memory exhaustion, amplified across
// concurrent streams. Past this the partial line is dropped and the scanner resyncs at the next newline;
// billing is unaffected (a dropped frame bills from the last-seen usage / the hold, never over).
export const MAX_SSE_LINE = 1 << 20; // 1 MiB (chars)

// Per-request context handed to a scanner at construction, for the OpenAI scanners' disconnect fallback:
// `model` (the request id, when stream metadata never arrived), `inputTokens` (the input floor to bill),
// `maxTokens` (the cap), and `reasoning` (bill the cap, since thinking never streams). The Anthropic
// scanner ignores all of it (it reads everything off the stream).
export type ScannerCtx = { model: string; inputTokens: number; maxTokens?: number; reasoning?: boolean };
