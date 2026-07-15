// Poll alert tests. The pure cases pin the classifier, while the process test boots the real payments root and
// forces settle() to throw after a successful wallet response. That boundary matters: Promise.allSettled must
// isolate one rail without silently discarding the failure or clearing its blind streak.
import { test, expect, afterEach } from "bun:test";
import { classifyPollOutcome } from "../src/ledger/poll";
import { openOrderStore } from "../src/ledger/orders";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Subprocess } from "bun";

const ALERT = 5;

test("a transient failure increments the streak and stays WARN below the threshold", () => {
  expect(classifyPollOutcome(0, false, ALERT)).toEqual({ fails: 1, event: "transient" });
  expect(classifyPollOutcome(3, false, ALERT)).toEqual({ fails: 4, event: "transient" });
});

test("the streak reaching the threshold escalates to POLL BLIND (ERROR) and stays blind on every further miss", () => {
  expect(classifyPollOutcome(4, false, ALERT)).toEqual({ fails: 5, event: "blind" });
  expect(classifyPollOutcome(5, false, ALERT)).toEqual({ fails: 6, event: "blind" });
});

test("success clears the streak; recovery is announced ONCE, only if we had crossed the threshold", () => {
  expect(classifyPollOutcome(6, true, ALERT)).toEqual({ fails: 0, event: "recovered" }); // was blind → recovered
  expect(classifyPollOutcome(3, true, ALERT)).toEqual({ fails: 0, event: null }); // sub-threshold streak → silent clear
  expect(classifyPollOutcome(0, true, ALERT)).toEqual({ fails: 0, event: null }); // steady state → nothing
});

const PAYMENTS = fileURLToPath(new URL("../src/payments.ts", import.meta.url));
let child: Subprocess | null = null;
let walletServer: ReturnType<typeof Bun.serve> | null = null;
let tmpDir = "";

afterEach(async () => {
  if (child) {
    child.kill();
    await child.exited;
    child = null;
  }
  walletServer?.stop(true);
  walletServer = null;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address == null || typeof address === "string") {
        probe.close();
        reject(new Error("failed to allocate test port"));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntil(check: () => boolean, process: Subprocess, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (process.exitCode != null) throw new Error(`payments process exited early (${process.exitCode})`);
    if (Date.now() >= deadline) throw new Error("timed out waiting for payments poll output");
    await Bun.sleep(25);
  }
}

function capture(stream: ReadableStream<Uint8Array>, append: (chunk: string) => void): Promise<void> {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode());
  })();
}

test("a post-wallet settle failure becomes categorical POLL BLIND and recovers exactly once", async () => {
  tmpDir = `/tmp/nullsink-poll-${process.pid}-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });
  const pendingDb = `${tmpDir}/pending.db`;
  const secretHash = "SECRET_TOKEN_HASH_SHOULD_NOT_LOG";
  const secretAddress = "SECRET_ADDRESS_SHOULD_NOT_LOG";
  const secretTxid = "SECRET_TXID_SHOULD_NOT_LOG";
  const secretDbError = "SECRET_DB_ERROR_SHOULD_NOT_LOG";

  const seed = openOrderStore(pendingDb);
  expect(seed.tryAddOrder({
    rail: "monero",
    order_index: 7,
    address: secretAddress,
    hash: secretHash,
    expected_atomic: 100,
    credit_micros: 1_000_000,
    received_atomic: 0,
    created_at: Date.now(),
    rate_usd: 100,
  }, 10)).toBe(true);
  // incomingTransfers succeeds, then this trigger makes settle's durable enqueue throw. Its message is a
  // canary: the operational alert must classify the failure without persisting exception detail.
  seed.db.run(`CREATE TRIGGER fail_test_settlement BEFORE INSERT ON credit_outbox
    BEGIN SELECT RAISE(FAIL, '${secretDbError}'); END`);
  seed.db.close();

  let walletCalls = 0;
  walletServer = Bun.serve({
    port: await freePort(),
    fetch: async (req) => {
      const body = await req.json() as { id?: string };
      walletCalls++;
      return Response.json({
        jsonrpc: "2.0",
        id: body.id ?? "0",
        result: {
          in: [{
            amount: 100,
            subaddr_index: { minor: 7 },
            confirmations: 20,
            locked: false,
            txid: secretTxid,
          }],
        },
      });
    },
  });

  const spawned = Bun.spawn({
    cmd: [process.execPath, PAYMENTS],
    env: {
      ...process.env,
      PAYMENTS_PORT: String(await freePort()),
      HOST: "127.0.0.1",
      PAY_RAILS: "monero",
      MONERO_WALLET_RPC_URL: `http://127.0.0.1:${walletServer.port}/json_rpc`,
      MONERO_CONFIRMATIONS: "1",
      MONERO_TIMEOUT_MS: "1000",
      PENDING_DB_PATH: pendingDb,
      CREDIT_SOCK: `${tmpDir}/missing-credit.sock`,
      CREDIT_TIMEOUT_MS: "100",
      POLL_INTERVAL_MS: "1000",
      POLL_FAIL_ALERT: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  child = spawned;

  let stdout = "";
  let stderr = "";
  const stdoutDone = capture(spawned.stdout, (chunk) => { stdout += chunk; });
  const stderrDone = capture(spawned.stderr, (chunk) => { stderr += chunk; });

  await waitUntil(() => stderr.includes("POLL BLIND"), spawned);
  expect(walletCalls).toBeGreaterThanOrEqual(1); // wallet succeeded; the failure was in the post-wallet path
  expect(stderr).toContain("[poll] [monero] POLL BLIND: 1 consecutive poll failures");
  expect(stderr).not.toContain("[poll] tick failed");
  for (const secret of [secretHash, secretAddress, secretTxid, secretDbError])
    expect(`${stdout}\n${stderr}`).not.toContain(secret);

  // Repair the injected settle fault. The next complete rail tick announces recovery; the following healthy
  // tick must stay silent, proving recovery is emitted once rather than on every success.
  const repair = openOrderStore(pendingDb);
  repair.db.run("DROP TRIGGER fail_test_settlement");
  repair.db.close();
  await waitUntil(() => stdout.includes("deposit detection restored"), spawned);
  await Bun.sleep(1_250);
  expect(stdout.match(/deposit detection restored/g)?.length).toBe(1);

  spawned.kill();
  await spawned.exited;
  await Promise.all([stdoutDone, stderrDone]);
  child = null;
}, 10_000);
