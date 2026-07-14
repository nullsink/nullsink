// Runtime contract test for the production Caddyfile. The static deploy-wiring test catches accidental
// route/port edits; this one starts the real adapter and proxy against body-consuming loopback upstreams,
// because handle_errors semantics (notably request_body 413 vs reverse_proxy 5xx) cannot be proved by regex.
// Invoked by scripts/lint.sh after Caddy validate/fmt, in the Caddy-equipped CI lint job.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CORE_ROOT = resolve(import.meta.dir, "..");
const EDGE_PORT = Number(process.env.NULLSINK_EDGE_TEST_PORT ?? 18_080);
if (!Number.isInteger(EDGE_PORT) || EDGE_PORT < 1 || EDGE_PORT > 65_535) {
  throw new Error(`invalid NULLSINK_EDGE_TEST_PORT: ${process.env.NULLSINK_EDGE_TEST_PORT}`);
}
if (!Bun.which("caddy")) throw new Error("test-caddy-edge: caddy is required on PATH");

const BASE = `http://127.0.0.1:${EDGE_PORT}`;
const work = mkdtempSync(join(tmpdir(), "nullsink-caddy-edge-"));
const webRoot = join(work, "web");
mkdirSync(webRoot);
writeFileSync(join(webRoot, "index.html"), "edge test ready\n");
writeFileSync(join(webRoot, "404.html"), "not found\n");

type Observed = { response: Response; body: string };

function fail(label: string, detail: string): never {
  throw new Error(`${label}: ${detail}`);
}

function expectResponse(got: Observed, status: number, body: string, label: string): void {
  if (got.response.status !== status) fail(label, `expected HTTP ${status}, got ${got.response.status}: ${got.body}`);
  if (got.body !== body) fail(label, `expected body ${body}, got ${got.body}`);
}

function expectHeader(got: Observed, name: string, value: string, label: string): void {
  const actual = got.response.headers.get(name);
  if (actual !== value) fail(label, `expected ${name}: ${value}, got ${actual ?? "<absent>"}`);
}

function expectJson(got: Observed, label: string): void {
  const actual = got.response.headers.get("content-type");
  if (!actual?.toLowerCase().startsWith("application/json")) {
    fail(label, `expected JSON content-type, got ${actual ?? "<absent>"}`);
  }
}

function expectHeaderAbsent(got: Observed, name: string, label: string): void {
  const actual = got.response.headers.get(name);
  if (actual !== null) fail(label, `expected no ${name} header, got ${actual}`);
}

async function request(path: string, init: RequestInit = {}): Promise<Observed> {
  const response = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  return { response, body: await response.text() };
}

function streamedBytes(length: number): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(1024, remaining)).fill(0x61);
      remaining -= chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

function startStub(world: "proxy" | "payments") {
  const firstPort = 20_000 + (process.pid % 20_000);
  let lastError: unknown;
  for (let offset = 0; offset < 100; offset += 1) {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: firstPort + offset,
        maxRequestBodySize: 64 * 1024 * 1024,
        async fetch(req) {
          // Consume the complete forwarded body. A respond-only stub can answer before reverse_proxy reads the
          // final byte, which would make a just-over-limit request an invalid test of request_body max_size.
          await req.arrayBuffer();
          const forced = req.headers.get("x-stub-status");
          const status = forced === null ? 200 : Number(forced);
          if (!Number.isInteger(status) || status < 200 || status > 599) return new Response("bad stub status", { status: 500 });

          const path = new URL(req.url).pathname;
          const body = status === 200
            ? JSON.stringify({ ok: world })
            : JSON.stringify({ error: `upstream_${status}` });
          const headers = new Headers({ "content-type": "application/json" });
          if (path === "/balance") headers.set("cache-control", "public, max-age=3600");
          if (status === 429) headers.set("retry-after", "7");
          return new Response(body, { status, headers });
        },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("stub startup failed without an error");
}

function startEdge(proxyPort: number, paymentsPort: number) {
  // Production intentionally fixes both loopback ports. Substitute only those addresses in a temporary copy
  // so this test cannot collide with a developer's running services; the committed file itself was already
  // parsed/formatted immediately before this harness and its default port mapping has a static contract test.
  const source = readFileSync(join(CORE_ROOT, "deploy/Caddyfile"), "utf8");
  const proxyAddress = "127.0.0.1:8080";
  const paymentsAddress = "127.0.0.1:8081";
  const globalAnchor = "{\n\t# Slow-loris guard";
  if (!source.includes(proxyAddress) || !source.includes(paymentsAddress) || !source.includes(globalAnchor)) {
    fail("test config", "production loopback addresses or global block were not found");
  }
  const config = source
    .replace(globalAnchor, "{\n\tadmin off\n\t# Slow-loris guard")
    .replaceAll(proxyAddress, `127.0.0.1:${proxyPort}`)
    .replaceAll(paymentsAddress, `127.0.0.1:${paymentsPort}`);
  const configPath = join(work, "Caddyfile");
  writeFileSync(configPath, config);

  return Bun.spawn(["caddy", "run", "--adapter", "caddyfile", "--config", configPath], {
    cwd: CORE_ROOT,
    env: {
      ...process.env,
      HOME: work,
      XDG_CONFIG_HOME: join(work, "config"),
      XDG_DATA_HOME: join(work, "data"),
      NULLSINK_DOMAIN: BASE,
      NULLSINK_WEBROOT: webRoot,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function waitForEdge(edge: ReturnType<typeof startEdge>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (edge.exitCode !== null) fail("edge startup", `Caddy exited with status ${edge.exitCode}`);
    try {
      const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return;
    } catch {
      // The listener is not ready yet.
    }
    await Bun.sleep(50);
  }
  fail("edge startup", `timed out waiting for ${BASE}`);
}

async function exerciseHealthyEdge(): Promise<void> {
  const smallBody = "{}";

  let got = await request("/definitely-missing");
  expectResponse(got, 404, "not found\n", "static 404 page");

  // reverse_proxy treats an upstream HTTP response as a successful exchange regardless of status. Pin that
  // boundary so status-aware handle_errors matchers cannot accidentally mask application responses.
  got = await request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-stub-status": "418" },
    body: smallBody,
  });
  expectResponse(got, 418, '{"error":"upstream_418"}', "Anthropic upstream 4xx passthrough");
  expectHeaderAbsent(got, "x-should-retry", "Anthropic upstream 4xx passthrough");

  got = await request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-stub-status": "413" },
    body: smallBody,
  });
  expectResponse(got, 413, '{"error":"upstream_413"}', "Anthropic upstream 413 passthrough");
  expectHeaderAbsent(got, "x-should-retry", "Anthropic upstream 413 passthrough");

  got = await request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-stub-status": "500" },
    body: smallBody,
  });
  expectResponse(got, 500, '{"error":"upstream_500"}', "OpenAI upstream 5xx passthrough");
  expectHeaderAbsent(got, "x-should-retry", "OpenAI upstream 5xx passthrough");

  got = await request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-stub-status": "429" },
    body: smallBody,
  });
  expectResponse(got, 429, '{"error":"upstream_429"}', "OpenAI upstream 429 passthrough");
  expectHeader(got, "retry-after", "7", "OpenAI upstream 429 passthrough");
  expectHeaderAbsent(got, "x-should-retry", "OpenAI upstream 429 passthrough");

  got = await request("/buy", {
    method: "POST",
    headers: { "content-type": "application/json", "x-stub-status": "422" },
    body: smallBody,
  });
  expectResponse(got, 422, '{"error":"upstream_422"}', "payments upstream 4xx passthrough");

  // The deferred success-path header must override every upstream cache policy/status, including an ordinary
  // upstream 500 which must remain a 500 rather than being mistaken for an edge outage.
  for (const status of [200, 401, 429, 500]) {
    const headers = status === 200 ? undefined : { "x-stub-status": String(status) };
    got = await request("/balance", { headers });
    const body = status === 200 ? '{"ok":"proxy"}' : `{"error":"upstream_${status}"}`;
    expectResponse(got, status, body, `/balance upstream ${status}`);
    expectHeader(got, "cache-control", "no-store", `/balance upstream ${status}`);
    if (status === 429) expectHeader(got, "retry-after", "7", "/balance upstream 429");
  }

  const large = new Uint8Array(32 * 1024 * 1024 + 1).fill(0x61);
  got = await request("/v1/messages", { method: "POST", body: large });
  expectResponse(
    got,
    413,
    '{"type":"error","error":{"type":"request_too_large","message":"payload_too_large"}}',
    "Anthropic edge body cap",
  );
  expectHeader(got, "x-should-retry", "false", "Anthropic edge body cap");
  expectJson(got, "Anthropic edge body cap");

  for (const path of ["/v1/chat/completions", "/v1/responses"]) {
    got = await request(path, { method: "POST", body: large });
    expectResponse(
      got,
      413,
      '{"error":{"message":"payload_too_large","type":"invalid_request_error","code":"payload_too_large"}}',
      `${path} edge body cap`,
    );
    expectHeader(got, "x-should-retry", "false", `${path} edge body cap`);
    expectJson(got, `${path} edge body cap`);
  }

  const paymentAtLimit = new Uint8Array(4 * 1024).fill(0x61);
  got = await request("/buy", { method: "POST", body: paymentAtLimit });
  expectResponse(got, 200, '{"ok":"payments"}', "/buy exact 4 KiB body cap");

  const paymentBody = new Uint8Array(4 * 1024 + 1).fill(0x61);
  for (const path of ["/buy", "/order-status"]) {
    // Exercise both a fixed Content-Length body and an unknown-length stream. The latter pins the reason the
    // Caddy cap exists in addition to the app's header precheck: chunked requests have no declared length.
    const body = path === "/buy" ? paymentBody : streamedBytes(4 * 1024 + 1);
    got = await request(path, { method: "POST", body });
    expectResponse(got, 413, '{"error":"payload_too_large"}', `${path} edge body cap`);
    expectJson(got, `${path} edge body cap`);
  }
}

async function exerciseRefusedUpstreams(): Promise<void> {
  const smallBody = "{}";
  let got = await request("/v1/messages", { method: "POST", body: smallBody });
  expectResponse(
    got,
    503,
    '{"type":"error","error":{"type":"api_error","message":"service_unavailable"}}',
    "Anthropic edge outage",
  );
  expectHeader(got, "x-should-retry", "true", "Anthropic edge outage");
  expectJson(got, "Anthropic edge outage");

  for (const path of ["/v1/chat/completions", "/v1/responses"]) {
    got = await request(path, { method: "POST", body: smallBody });
    expectResponse(
      got,
      503,
      '{"error":{"message":"service_unavailable","type":"server_error","code":"service_unavailable"}}',
      `${path} edge outage`,
    );
    expectHeader(got, "x-should-retry", "true", `${path} edge outage`);
    expectJson(got, `${path} edge outage`);
  }

  got = await request("/v1/models");
  expectResponse(got, 503, '{"error":"proxy_error"}', "/v1/models edge outage");
  expectJson(got, "/v1/models edge outage");

  got = await request("/balance");
  expectResponse(got, 503, '{"error":"proxy_error"}', "/balance edge outage");
  expectHeader(got, "cache-control", "no-store", "/balance edge outage");
  expectJson(got, "/balance edge outage");

  for (const path of ["/buy", "/order-status"]) {
    got = await request(path, { method: "POST", body: smallBody });
    expectResponse(got, 503, '{"error":"payments_error"}', `${path} edge outage`);
    expectJson(got, `${path} edge outage`);
  }
  got = await request("/rails");
  expectResponse(got, 503, '{"error":"payments_error"}', "/rails edge outage");
  expectJson(got, "/rails edge outage");
}

let proxyStub: ReturnType<typeof startStub> | undefined;
let paymentsStub: ReturnType<typeof startStub> | undefined;
let edge: ReturnType<typeof startEdge> | undefined;
try {
  proxyStub = startStub("proxy");
  paymentsStub = startStub("payments");
  const proxyPort = proxyStub.port;
  const paymentsPort = paymentsStub.port;
  if (proxyPort === undefined || paymentsPort === undefined) fail("stub startup", "Bun did not assign loopback ports");
  edge = startEdge(proxyPort, paymentsPort);
  await waitForEdge(edge);
  await exerciseHealthyEdge();

  await proxyStub.stop(true);
  proxyStub = undefined;
  await paymentsStub.stop(true);
  paymentsStub = undefined;
  await exerciseRefusedUpstreams();
  console.log("caddy edge contract: OK");
} finally {
  if (proxyStub) await proxyStub.stop(true);
  if (paymentsStub) await paymentsStub.stop(true);
  if (edge) {
    if (edge.exitCode === null) edge.kill();
    await edge.exited;
  }
  rmSync(work, { recursive: true, force: true });
}
