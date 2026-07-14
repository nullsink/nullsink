// The proxy/payments split is enforced in code, but the production boundary also depends on three
// deploy artifacts that TypeScript cannot typecheck: Caddyfile, systemd units, and setup.sh's seeded
// environment. A mismatched port or CREDIT_SOCK still lets both binaries start, then leaves public paths
// 502ing or paid credits stuck in pending.db. Keep this deliberately static: it checks the committed
// production contract without needing Caddy or systemd installed in the test runner.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const deploy = (name: string) => fileURLToPath(new URL(`../deploy/${name}`, import.meta.url));
const src = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

const caddy = readFileSync(deploy("Caddyfile"), "utf8");
const proxyUnit = readFileSync(deploy("nullsink-proxy.service"), "utf8");
const paymentsUnit = readFileSync(deploy("nullsink-payments.service"), "utf8");
const setup = readFileSync(deploy("setup.sh"), "utf8");
const proxy = readFileSync(src("proxy.ts"), "utf8");
const payments = readFileSync(src("payments.ts"), "utf8");

function upstreamFor(path: string): string | null {
  // Caddy's exact-path `handle` blocks are the deploy contract. Stop at the next handle block so a
  // later reverse_proxy cannot make a missing route falsely pass.
  const block = caddy.match(new RegExp(`handle ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([\\s\\S]*?)(?=\\n\\thandle |\\n\\t# --- Everything else|$)`));
  return block?.[1].match(/reverse_proxy 127\.0\.0\.1:(\d+)/)?.[1] ?? null;
}

test("the two roots, setup defaults, Caddy routes, and service units agree on the split ports", () => {
  expect(proxy).toContain('numEnv("PORT", 8080');
  expect(payments).toContain('numEnv("PAYMENTS_PORT", 8081');
  expect(setup).toMatch(/\nPORT=8080\nPAYMENTS_PORT=8081\n/);

  for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1/models", "/balance"])
    expect(upstreamFor(path)).toBe("8080");
  for (const path of ["/buy", "/order-status", "/rails"]) expect(upstreamFor(path)).toBe("8081");
});

test("both systemd units and both roots use the one owner-authenticated credit socket", () => {
  const socket = "/run/nullsink/credit.sock";
  expect(proxy).toContain(`process.env.CREDIT_SOCK ?? "${socket}"`);
  expect(payments).toContain(`process.env.CREDIT_SOCK ?? "${socket}"`);
  expect(proxyUnit).toContain(`Environment=CREDIT_SOCK=${socket}`);
  expect(paymentsUnit).toContain(`Environment=CREDIT_SOCK=${socket}`);
});

test("edge outages preserve each public route's error envelope and retry contract", () => {
  // Caddy enters handle_errors only for its own failures (such as a refused loopback connection), not for
  // an upstream's ordinary 4xx/5xx response. Keep the app-down boundary as deliberate as the port split.
  expect(caddy).toContain("# --- Edge error contract.");
  expect(caddy).toMatch(/@anthropic_outage path \/v1\/messages[\s\S]*?header x-should-retry "true"[\s\S]*?respond `\{"type":"error","error":\{"type":"api_error","message":"service_unavailable"\}\}` 503/);
  expect(caddy).toMatch(/@openai_outage path \/v1\/chat\/completions \/v1\/responses[\s\S]*?header x-should-retry "true"[\s\S]*?respond `\{"error":\{"message":"service_unavailable","type":"server_error","code":"service_unavailable"\}\}` 503/);
  expect(caddy).toMatch(/@proxy_outage path \/v1\/models \/balance[\s\S]*?respond `\{"error":"proxy_error"\}` 503/);
  expect(caddy).toMatch(/@payments_outage path \/buy \/order-status \/rails[\s\S]*?respond `\{"error":"payments_error"\}` 503/);
});
