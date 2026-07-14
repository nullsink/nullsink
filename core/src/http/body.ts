// Request-body reader for nullsink's OWN endpoints — the parse preamble /buy and /order-status each repeated:
// enforce the body-size cap, parse JSON, and normalise the result to a string-keyed bag. Returns the parsed
// body, or a ready rejection Response (413 too-large / 400 invalid_json) for the caller to return as-is.
//
// Scope note: this serves the own-endpoint paths that answer with deny()'s bare {error} envelope. The metered
// path (handleMetered) keeps its OWN inline parse on purpose — it needs the RAW text for the hold estimator,
// and answers with the provider-NATIVE error envelope (denyApi), not deny() — so it isn't a caller here.
import { deny } from "./errors";

// A parsed JSON request body as a string-keyed bag. Fields read off it are `unknown` until the endpoint
// narrows them (typeof guards) — safer than the `any` these handlers used before, with no behaviour change.
export type JsonBody = Record<string, unknown>;

export async function readJsonBody(req: Request, maxBytes: number): Promise<{ body: JsonBody } | { rejection: Response }> {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return { rejection: deny(413, "payload_too_large") };
  const bytes = await req.arrayBuffer();
  // Content-Length is only an early shed: it can be absent (chunked) or dishonest. The buffered byte count
  // is authoritative, while the server's larger hard backstop prevents this read from growing without bound.
  if (bytes.byteLength > maxBytes) return { rejection: deny(413, "payload_too_large") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { rejection: deny(400, "invalid_json") };
  }
  // A non-object body (array / string / number / null) carries none of the fields the endpoints read, so
  // normalise to an empty bag — each endpoint's field validation then rejects it (invalid_hash /
  // invalid_amount), as before.
  const body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonBody) : {};
  return { body };
}
