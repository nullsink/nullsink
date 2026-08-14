// Shared usage types — the canonical metered shape the cost math prices, plus the streaming-scanner seam
// both providers' adapters conform to. Provider-agnostic, so the handler that drives scanners stays so too.
import type { Usage } from "../pricing";

export type UsageEvidence = "reported" | "estimated";
export type Metered = { model: string; usage: Usage; evidence: UsageEvidence } | null;

// The streaming-meter seam: feed decoded chunks as they pass to the client, read result() at termination,
// and require the provider's native success marker before transport EOF may count as a clean completion.
// `evidenced_only` is used for provider failures and shutdown: exact provider usage is always returned, but
// an OpenAI fallback exists only after visible output. This prevents a metadata-only frame from becoming a
// charge when nullsink/provider caused termination. Anthropic ignores the mode because every snapshot is
// provider-reported.
export type UsageScanner = {
  feed(chunk: string): void;
  result(mode?: "evidenced_only"): Metered;
  errored(): boolean;
  completed(): boolean;
};

// Per-request context for OpenAI's pre-terminal fallback. `inputTokens` is already a billable count/estimate,
// never the byte-based reservation bound; output reservations deliberately do not cross this seam.
export type ScannerCtx = {
  model: string;
  inputTokens: number;
};
