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
const walletUnit = readFileSync(deploy("monero-wallet-rpc.service"), "utf8");
const setup = readFileSync(deploy("setup.sh"), "utf8");
const backup = readFileSync(deploy("backup.sh"), "utf8");
const restore = readFileSync(deploy("restore.sh"), "utf8");
const proxy = readFileSync(src("proxy.ts"), "utf8");
const payments = readFileSync(src("payments.ts"), "utf8");

function upstreamFor(path: string): string | null {
  // Caddy's exact-path `handle` blocks are the deploy contract. Stop at the next handle block so a
  // later reverse_proxy cannot make a missing route falsely pass.
  const block = caddy.match(new RegExp(`handle ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([\\s\\S]*?)(?=\\n\\thandle |\\n\\t# --- Everything else|$)`));
  return block?.[1].match(/reverse_proxy 127\.0\.0\.1:(\d+)/)?.[1] ?? null;
}

function namedMatcher(name: string): string {
  const startMarker = `\t\t@${name} {\n`;
  const start = caddy.indexOf(startMarker);
  if (start === -1) return "";
  const end = caddy.indexOf("\n\t\t}\n", start + startMarker.length);
  return end === -1 ? "" : caddy.slice(start, end + "\n\t\t}".length);
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

test("the Monero wallet keeps ring metadata outside its protected home", () => {
  expect(walletUnit).toContain("StateDirectory=nullsink-wallet");
  expect(walletUnit).toContain("ProtectHome=true");
  expect(walletUnit).toContain("--shared-ringdb-dir %S/nullsink-wallet/.shared-ringdb");
  expect(walletUnit).not.toMatch(/--shared-ringdb-dir (?:~|\/home)/);
});

test("edge body caps and outages are disjoint, status-aware contracts", () => {
  // Both request_body and reverse_proxy enter handle_errors. Path-only matchers turn a terminal 413 into a
  // retryable outage, so every native body-cap matcher is pinned to 413 and every outage matcher to 5xx.
  expect(caddy).toContain("# --- Edge error contract.");
  for (const name of ["anthropic_too_large", "openai_too_large", "payments_too_large"])
    expect(namedMatcher(name), name).toContain("expression {err.status_code} == 413");
  for (const name of ["anthropic_outage", "openai_outage", "balance_outage", "proxy_outage", "payments_outage"])
    expect(namedMatcher(name), name).toContain("expression {err.status_code} >= 500 && {err.status_code} <600");

  // These limits are one fixed contract, not independent operator knobs that can drift from Caddy.
  expect(caddy).toContain("max_size 32MiB");
  expect(caddy).toContain("max_size 4KiB");
  expect(proxy).toContain("const MAX_MESSAGES_BODY_BYTES = 32 * 1024 * 1024;");
  expect(payments).toContain("const MAX_BUY_BODY_BYTES = 4 * 1024;");
  expect(proxy).not.toContain('numEnv("MAX_MESSAGES_BODY_BYTES"');
  expect(payments).not.toContain('numEnv("MAX_BUY_BODY_BYTES"');

  expect(caddy).toMatch(/header x-should-retry "false"\n\t\t\trespond `\{"type":"error","error":\{"type":"request_too_large","message":"payload_too_large"\}\}` 413/);
  expect(caddy).toMatch(/header x-should-retry "false"\n\t\t\trespond `\{"error":\{"message":"payload_too_large","type":"invalid_request_error","code":"payload_too_large"\}\}` 413/);
  expect(caddy).toContain('respond `{"error":"payload_too_large"}` 413');
  expect(caddy).toMatch(/header x-should-retry "true"\n\t\t\trespond `\{"type":"error","error":\{"type":"api_error","message":"service_unavailable"\}\}` 503/);
  expect(caddy).toMatch(/header x-should-retry "true"\n\t\t\trespond `\{"error":\{"message":"service_unavailable","type":"server_error","code":"service_unavailable"\}\}` 503/);
  expect(caddy).toContain('respond `{"error":"proxy_error"}` 503');
  expect(caddy).toContain('respond `{"error":"payments_error"}` 503');
});

test("balance responses are never stored by an intermediary", () => {
  // /balance is a GET keyed by the bearer-like x-api-key header. Caddy's deferred set means an upstream
  // response cannot overwrite no-store while its headers are copied to the client. An error route is a new
  // handler chain, so its Caddy-generated proxy outage also sets no-store explicitly.
  expect(caddy).toMatch(/handle \/balance \{[\s\S]*?header >Cache-Control "no-store"[\s\S]*?reverse_proxy 127\.0\.0\.1:8080/);
  expect(caddy).toMatch(/handle @balance_outage \{\n\t\t\theader Cache-Control "no-store"/);
});

test("backup and restore preserve the scrubbed-outbox money invariant", () => {
  // The outbox snapshot must precede the ledger snapshot: any tombstone/ack captured in pending.db is then
  // guaranteed to have its applied_orders marker captured in the later balances.db snapshot.
  expect(backup.indexOf(".backup '$work/pending.db'")).toBeGreaterThan(-1);
  expect(backup.indexOf(".backup '$work/balances.db'")).toBeGreaterThan(backup.indexOf(".backup '$work/pending.db'"));

  // A tombstone has no payload to replay. Restore must verify its receiver marker, never re-arm it, and reject
  // a balances-only restore over a deployment that already has pending.db.
  expect(restore).toContain("scrubbed credit tombstone(s) have no matching ledger marker");
  expect(restore).toContain("WHERE acked_at IS NOT NULL\n          AND hash <> ''");
  expect(restore).toContain("UPDATE credit_outbox SET acked_at = NULL WHERE hash <> '';");
  expect(restore).toContain("unsafe partial restore refused");
  expect(restore).not.toMatch(/SET acked_at = NULL WHERE hash = ''/);
});
