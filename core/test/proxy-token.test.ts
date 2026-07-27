import { expect, test } from "bun:test";
import { readProxyToken } from "../src/http/proxy-token";

const req = (headers: Record<string, string>) =>
  new Request("https://proxy.local", { headers });

test("proxy token reader parses both conventions and preserves endpoint-specific precedence", () => {
  expect(readProxyToken(req({ "x-api-key": "api" }), "api-key")).toBe("api");
  expect(readProxyToken(req({ authorization: "bEaReR   bearer-token  " }), "api-key")).toBe("bearer-token");

  const both = req({ "x-api-key": "api", authorization: "Bearer bearer" });
  expect(readProxyToken(both, "api-key")).toBe("api");
  expect(readProxyToken(both, "bearer")).toBe("bearer");
});

test("proxy token reader falls back from malformed auth and rejects absent credentials", () => {
  expect(readProxyToken(req({ "x-api-key": "api", authorization: "Basic ignored" }), "bearer")).toBe("api");
  expect(readProxyToken(req({ authorization: "Basic ignored" }), "api-key")).toBeNull();
  expect(readProxyToken(req({}), "bearer")).toBeNull();
});
