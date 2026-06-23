// The proxy's HTTP transport toolkit — header policy (headers.ts) + error/rejection responses (errors.ts).
// A toolkit of helpers the handler calls, deliberately NOT a framework: routing + the money/forward logic
// stay explicit in handler.ts so the privacy/billing invariants read top-to-bottom. See /docs/architecture.md.
export { STRIP, buildUpstreamHeaders, scrubRespHeaders } from "./headers";
export { deny, denyThrottled, apiErrorBody, denyApi, NO_API_KEY } from "./errors";
export { readJsonBody, type JsonBody } from "./body";
