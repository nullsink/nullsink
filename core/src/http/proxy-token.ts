// Read the customer's proxy token without coupling callers to one SDK's auth convention.
// Anthropic-native and nullsink-owned endpoints prefer x-api-key; OpenAI-compatible
// endpoints prefer Authorization: Bearer. A malformed preferred header falls back to the
// other convention, preserving compatibility for clients that happen to send both.
export function readProxyToken(req: Request, prefer: "api-key" | "bearer"): string | null {
  const apiKey = req.headers.get("x-api-key");
  const authorization = req.headers.get("authorization");
  const bearer = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]?.trim() ?? null : null;

  return prefer === "api-key" ? apiKey || bearer : bearer || apiKey;
}
