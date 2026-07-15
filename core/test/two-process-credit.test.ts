// The one test that boots BOTH composition roots as REAL processes and drives a credit across the socket
// end-to-end. proxy.ts and payments.ts are the split's wiring — ports, the credit-socket path, which store
// feeds the credit server vs the sender — and nothing else covers them: no test imports them (they are pure
// side-effect roots), and mutation testing skips them for that reason. A swapped port, a mismatched
// CREDIT_SOCK default, or a store wired to the wrong side would pass every unit test, trust-domain-isolation, and
// assert-trust-domains, and only surface at runtime. This catches exactly that class.
//
// Flow: seed one credit into pending.db's outbox, boot payments (owns pending.db, runs the sender) and proxy
// (owns balances.db, binds the socket + serves /balance), and assert the credit crosses and is readable via
// the metered read path — exactly once. The rails never run: the credit is injected straight into the outbox,
// so a dummy MONERO_WALLET_RPC (whose poll harmlessly fails) is all payments needs to boot.
import { test, expect, afterEach } from "bun:test";
import { openOrderStore } from "../src/ledger/orders";
import { hashToken } from "../src/ledger/hash";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import type { Subprocess } from "bun";

const PROXY = fileURLToPath(new URL("../src/proxy.ts", import.meta.url));
const PAYMENTS = fileURLToPath(new URL("../src/payments.ts", import.meta.url));

// Two DISTINCT free localhost ports. Each :0 bind is held open until BOTH are captured, then both released, so
// the two can never resolve to the same number (a plain "bind/read/release" twice can hand back one port twice,
// and proxy + payments would then collide on bind). Small TOCTOU window remains — standard practice, and far
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
let dir = "";
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
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

test("a seeded credit crosses the socket from payments to proxy and reads back through /balance exactly once", async () => {
  dir = `/tmp/nullsink-2proc-${process.pid}`; // short path — a unix socket path has a ~104-char ceiling
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const balancesDb = `${dir}/balances.db`;
  const pendingDb = `${dir}/pending.db`;
  const sock = `${dir}/credit.sock`;
  const token = "smoke-token-two-process";

  // Seed one $5 credit into the outbox (5_000_000 micro-USD), then release the handle so the payments process
  // opens the DB cleanly. openOrderStore creates the schema, so this also initialises pending.db.
  const seed = openOrderStore(pendingDb);
  expect(seed.enqueueCredit("smoke-tx-1", hashToken(token), 5_000_000, Date.now())).toBe(true);
  seed.db.close();

  const [proxyPort, paymentsPort] = freePortPair();

  // proxy: owns balances.db, binds the credit socket, serves /balance. Needs ≥1 provider to boot (dummy key —
  // it is never called; the test only hits /balance).
  spawn(PROXY, { PORT: String(proxyPort), HOST: "127.0.0.1", ANTHROPIC_API_KEY: "dummy", DB_PATH: balancesDb, CREDIT_SOCK: sock });
  // payments: owns pending.db, runs the sender. Dummy monero rail (its poll fails, harmlessly); a fast poll so
  // the drain runs promptly. The sender delivers the outbox row over the socket on the first tick.
  spawn(PAYMENTS, {
    PAYMENTS_PORT: String(paymentsPort), HOST: "127.0.0.1", PAY_RAILS: "monero",
    MONERO_WALLET_RPC: "http://127.0.0.1:1/json_rpc", PENDING_DB_PATH: pendingDb, CREDIT_SOCK: sock, POLL_INTERVAL_MS: "1000",
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

  // Exactly once + no loss: the outbox row acks (drains) right after the credit lands. The ack is a WRITE in the
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
