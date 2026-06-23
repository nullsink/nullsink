// Header policy at the proxy edge (http/headers.ts). The forward path must drop the client's auth/org AND its
// SDK fingerprint (user-agent + the x-stainless-* cluster) so nothing identifying about the caller reaches the
// upstream, inject our own key, and present a normalized user-agent. The relay path must scrub our own
// org/project headers off the response. Both Anthropic and OpenAI SDKs are Stainless-generated, so the
// fingerprint stripping in the shared builder covers both providers.
import { test, expect } from "bun:test";
import { buildUpstreamHeaders, scrubRespHeaders } from "../src/http/headers";
import type { Provider } from "../src/providers";

// buildUpstreamHeaders only reads extraStrip, forwardBeta, and injectAuth off the provider — stub the rest.
function fakeProvider(over: Partial<Provider> = {}): Provider {
  return { injectAuth: (h: Headers) => h.set("x-api-key", "OUR_KEY"), ...over } as unknown as Provider;
}

// A standalone Headers object (guard "none") lets us set otherwise-forbidden request headers (host,
// content-length, user-agent, …); wrap it as the minimal Request shape buildUpstreamHeaders reads.
function reqWith(h: Record<string, string>): Request {
  return { headers: new Headers(h) } as unknown as Request;
}

test("forward path strips the client SDK fingerprint and normalizes user-agent", () => {
  const out = buildUpstreamHeaders(
    fakeProvider(),
    reqWith({
      "user-agent": "Anthropic/Python 0.39.0",
      "x-stainless-os": "MacOS",
      "x-stainless-arch": "arm64",
      "x-stainless-lang": "python",
      "x-stainless-runtime": "CPython",
      "x-stainless-runtime-version": "3.12.1",
      "x-stainless-package-version": "0.39.0",
      "x-stainless-retry-count": "0",
      "x-request-id": "client-trace-abc",
      "content-type": "application/json",
    }),
  );
  // user-agent replaced with the neutral value — never the client's SDK string
  expect(out.get("user-agent")).toBe("nullsink");
  // every x-stainless-* header is gone
  for (const [k] of out) expect(k.startsWith("x-stainless-")).toBe(false);
  expect(out.has("x-request-id")).toBe(false);
  // a genuine functional header still passes through untouched
  expect(out.get("content-type")).toBe("application/json");
});

test("forward path strips client auth/org/framing and injects our key", () => {
  const out = buildUpstreamHeaders(
    fakeProvider(),
    reqWith({
      authorization: "Bearer CLIENT_TOKEN",
      "x-api-key": "CLIENT_KEY",
      "anthropic-organization-id": "client-org",
      host: "nullsink.example",
      connection: "keep-alive",
      "content-length": "123",
      accept: "text/event-stream",
    }),
  );
  expect(out.has("authorization")).toBe(false);
  expect(out.get("x-api-key")).toBe("OUR_KEY"); // client's stripped, ours injected
  expect(out.has("anthropic-organization-id")).toBe(false);
  expect(out.has("host")).toBe(false);
  expect(out.has("connection")).toBe(false);
  expect(out.has("content-length")).toBe(false);
  expect(out.get("accept")).toBe("text/event-stream"); // genuine client header preserved
});

test("forward path honors provider.extraStrip (e.g. OpenAI org/project)", () => {
  const out = buildUpstreamHeaders(
    fakeProvider({ extraStrip: new Set(["openai-organization", "openai-project"]) }),
    reqWith({
      "openai-organization": "client-org",
      "openai-project": "client-proj",
      "content-type": "application/json",
    }),
  );
  expect(out.has("openai-organization")).toBe(false);
  expect(out.has("openai-project")).toBe(false);
  expect(out.get("content-type")).toBe("application/json");
});

test("anthropic-beta: premium stripped, flat-rate-safe subset re-added via forwardBeta", () => {
  // provider keeps only "context-editing", drops everything else
  const provider = fakeProvider({
    forwardBeta: (clientBeta: string) =>
      clientBeta
        .split(",")
        .map((s) => s.trim())
        .includes("context-editing")
        ? "context-editing"
        : null,
  });
  const kept = buildUpstreamHeaders(provider, reqWith({ "anthropic-beta": "context-editing,fast-mode" }));
  expect(kept.get("anthropic-beta")).toBe("context-editing");

  // no safe markers → the header is dropped entirely
  const dropped = buildUpstreamHeaders(provider, reqWith({ "anthropic-beta": "fast-mode" }));
  expect(dropped.has("anthropic-beta")).toBe(false);

  // a provider with no forwardBeta → anthropic-beta is always stripped
  const noForward = buildUpstreamHeaders(fakeProvider(), reqWith({ "anthropic-beta": "context-editing" }));
  expect(noForward.has("anthropic-beta")).toBe(false);
});

test("relay path scrubs our org/project + content framing off the response", () => {
  const resp = new Response("body", {
    headers: {
      "anthropic-organization-id": "our-org",
      "openai-organization": "our-org",
      "openai-project": "our-proj",
      "content-encoding": "gzip",
      "content-type": "application/json",
    },
  });
  const h = scrubRespHeaders(resp);
  expect(h.has("anthropic-organization-id")).toBe(false);
  expect(h.has("openai-organization")).toBe(false);
  expect(h.has("openai-project")).toBe(false);
  expect(h.has("content-encoding")).toBe(false);
  expect(h.get("content-type")).toBe("application/json"); // genuine response header preserved
});
