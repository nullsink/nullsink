// The one test that boots all THREE composition roots as REAL processes and drives both financial crossings
// end-to-end: payments credits the ledger, then the proxy opens and settles a metered request. The roots are
// side-effectful wiring, no unit test imports them, and mutation testing skips them for that reason. A swapped port, a mismatched
// CREDIT_SOCK default, or a store wired to the wrong side would pass every unit test, trust-domain-isolation, and
// assert-trust-domains, and only surface at runtime. This catches exactly that class.
//
// Flow: seed one credit into pending.db's outbox; boot ledger (owns balances.db + both sockets), payments
// (owns pending.db + sends credit), stateless proxy, and a deterministic fake provider; assert the credit crosses
// exactly once and one proxy request settles to its exact usage. The rails never run: the credit is injected into
// the outbox, so a dummy MONERO_WALLET_RPC (whose poll harmlessly fails) is all payments needs to boot.
import { test, expect, afterEach } from "bun:test";
import { openOrderStore } from "../src/ledger/orders";
import { hashToken } from "../src/ledger/hash";
import { priceUsage } from "../src/cost";
import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import type { Subprocess } from "bun";

const PROXY = fileURLToPath(new URL("../src/proxy.ts", import.meta.url));
const LEDGER = fileURLToPath(new URL("../src/ledger-service.ts", import.meta.url));
const PAYMENTS = fileURLToPath(new URL("../src/payments.ts", import.meta.url));

// Two DISTINCT free localhost ports. Each :0 bind is held open until both are captured, then both released, so
// the two can never resolve to the same number (a plain "bind/read/release" twice can hand back one port twice,
// and the two HTTP services would then collide on bind). Small TOCTOU window remains — standard practice, and far
// safer than hardcoded ports that would collide when bun runs test files in parallel.
function freePortPair(): [number, number] {
  const a = Bun.serve({ port: 0, fetch: () => new Response("") });
  const b = Bun.serve({ port: 0, fetch: () => new Response("") });
  const pa = a.port;
  const pb = b.port;
  a.stop(true);
  b.stop(true);
  if (pa == null || pb == null || pa === pb) throw new Error(`bad port pair: ${pa}, ${pb}`);
  return [pa, pb];
}

const procs: Subprocess[] = [];
const servers: Array<{ stop(force?: boolean): void | Promise<void> }> = [];
let dir = "";
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
  for (const server of servers.splice(0)) server.stop(true);
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    dir = "";
  }
});

const spawn = (path: string, env: Record<string, string>) => {
  const p = Bun.spawn({ cmd: [process.execPath, path], env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  procs.push(p);
  return p;
};

test("a credited token completes one metered request across all three processes", async () => {
  dir = `/tmp/nullsink-3proc-${process.pid}`; // short path — a unix socket path has a ~104-char ceiling
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const balancesDb = `${dir}/balances.db`;
  const pendingDb = `${dir}/pending.db`;
  const creditSock = `${dir}/credit.sock`;
  const ledgerSock = `${dir}/ledger.sock`;
  const token = "smoke-token-three-process";
  const model = "claude-opus-4-8";
  const usage = { input_tokens: 10, output_tokens: 2 };
  const upstreamRequests: Array<{ path: string; apiKey: string | null; model?: string }> = [];

  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { model?: string };
      upstreamRequests.push({
        path: new URL(req.url).pathname,
        apiKey: req.headers.get("x-api-key"),
        model: body.model,
      });
      return Response.json({
        id: "msg_three_process",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage,
      });
    },
  });
  servers.push(upstream);

  // Seed one $5 credit into the outbox (5_000_000 micro-USD), then release the handle so the payments process
  // opens the DB cleanly. openOrderStore creates the schema, so this also initialises pending.db.
  const seed = openOrderStore(pendingDb);
  expect(seed.enqueueCredit("smoke-tx-1", hashToken(token), 5_000_000, Date.now())).toBe(true);
  seed.db.close();

  const [proxyPort, paymentsPort] = freePortPair();

  // Ledger starts first and publishes both capabilities. This mirrors systemd's Before= readiness contract;
  // the proxy's startSession is deliberately fail-closed and must not race an absent socket in this harness.
  spawn(LEDGER, { DB_PATH: balancesDb, LEDGER_SOCK: ledgerSock, CREDIT_SOCK: creditSock });
  for (let i = 0; i < 50; i++) {
    if (existsSync(ledgerSock) && existsSync(creditSock)
      && statSync(ledgerSock).isSocket() && statSync(creditSock).isSocket()) break;
    await Bun.sleep(100);
  }
  expect(existsSync(ledgerSock) && existsSync(creditSock)).toBe(true);

  // Proxy has no DB and no credit capability. Its upstream is deterministic, local, and records the forwarded
  // path/auth/model so this test proves the public metering path as well as the ledger socket round-trips.
  spawn(PROXY, {
    PORT: String(proxyPort), HOST: "127.0.0.1", ANTHROPIC_API_KEY: "upstream-secret",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`, HOLD_ESTIMATOR: "byte", LEDGER_SOCK: ledgerSock,
  });
  // payments: owns pending.db, runs the sender. Dummy monero rail (its poll fails, harmlessly); a fast poll so
  // the drain runs promptly. The sender delivers the outbox row over the socket on the first tick.
  spawn(PAYMENTS, {
    PAYMENTS_PORT: String(paymentsPort), HOST: "127.0.0.1", PAY_RAILS: "monero",
    MONERO_WALLET_RPC: "http://127.0.0.1:1/json_rpc", PENDING_DB_PATH: pendingDb, CREDIT_SOCK: creditSock, POLL_INTERVAL_MS: "1000",
  });

  // Poll /balance on the proxy until the credit has crossed (or time out). Connection-refused early just retries.
  const balUrl = `http://127.0.0.1:${proxyPort}/balance`;
  let crossed = false;
  for (let i = 0; i < 40 && !crossed; i++) {
    await Bun.sleep(500);
    try {
      const r = await fetch(balUrl, { headers: { "x-api-key": token } });
      if (r.ok) {
        const body = (await r.json()) as { balance_usd?: number };
        if (body.balance_usd === 5) crossed = true;
      }
    } catch {
      /* proxy not up yet — retry */
    }
  }
  expect(crossed).toBe(true); // the credit crossed the socket and is visible through the metered read path

  const metered = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token },
    body: JSON.stringify({
      model,
      max_tokens: 2,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(metered.status).toBe(200);
  expect((await metered.json()) as object).toMatchObject({ model, usage });
  expect(upstreamRequests).toEqual([
    { path: "/v1/messages", apiKey: "upstream-secret", model },
  ]);

  const expectedBalance = 5_000_000 - priceUsage(model, usage);
  const ledger = new Database(balancesDb, { readonly: true });
  try {
    expect(
      ledger.query<{ balance: number }, [string]>("SELECT balance FROM tokens WHERE hash = ?").get(hashToken(token)),
    ).toEqual({ balance: expectedBalance });
    expect(ledger.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM holds").get()).toEqual({ n: 0 });
  } finally {
    ledger.close();
  }

  // Exactly once + no loss: the outbox row acks, scrubs, and drains right after the credit lands. The ack is a WRITE in the
  // PAYMENTS process, so across our separate reader connection it can lag the /balance visibility by a WAL tick
  // (more so under load) — poll briefly for the drained state instead of reading once and racing it. The balance
  // being exactly 5 (not 10) across the poll ticks that ran already proves creditOnce's idempotency held.
  let drained = false;
  for (let i = 0; i < 25 && !drained; i++) {
    const check = openOrderStore(pendingDb);
    drained = check.listUnackedCredits().length === 0;
    check.db.close();
    if (!drained) await Bun.sleep(200);
  }
  expect(drained).toBe(true); // no credit stuck unacked — delivery completed exactly once
}, 45_000);
