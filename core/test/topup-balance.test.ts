// nsk topup/balance operate on the token HASH and topup REFUSES an unknown one (so a mistyped hash can't
// mint a funded, unspendable phantom token). We spawn the real `nsk` entry (as guard.test.ts does) against a
// throwaway ledger, because the run* fns call process.exit and bind the module-load DB singleton — a
// subprocess is the only honest way to exercise the exit codes + the singleton together. The hash is
// computed inline (same sha256 as db.ts hashToken / gen-token.ts) so the test never opens a prod ledger.
import { test, expect, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DBP = "/tmp/nullsink-topup-cli.db";
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const rmDb = () => {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(DBP + s);
    } catch {
      /* not present */
    }
  }
};
afterEach(rmDb);

// Run the real nsk entry against the throwaway DB (NSK_ALLOW_ROOT so it holds under a root CI container).
// Unlike guard.test.ts's helper this does NOT wipe between calls — tests below chain issue → topup → balance
// on one ledger.
function nsk(args: string[]): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    env: { ...process.env, DB_PATH: DBP, NSK_ALLOW_ROOT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const hashOf = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");

function issueToken(dollars: string): string {
  const { out } = nsk(["issue", dollars]);
  const m = out.match(/0sink_[A-Za-z0-9_-]{47}/);
  if (!m) throw new Error(`no token in issue output: ${out}`);
  return m[0];
}

test("topup credits an EXISTING token by hash; balance reads it back", () => {
  rmDb();
  const hash = hashOf(issueToken("10"));
  expect(nsk(["balance", hash]).out.trim()).toBe("$10.000000");

  const { code, out } = nsk(["topup", hash, "5"]);
  expect(code).toBe(0);
  expect(out).toContain("New balance: $15.00");
  expect(nsk(["balance", hash]).out.trim()).toBe("$15.000000");
});

test("topup REFUSES an unknown (well-formed) hash — no phantom token minted", () => {
  rmDb();
  const unknown = "a".repeat(64);
  const { code, err } = nsk(["topup", unknown, "5"]);
  expect(code).toBe(1);
  expect(err).toContain("unknown token");
  // The row must not have been created: balance now reports it unknown too.
  expect(nsk(["balance", unknown]).code).toBe(1);
});

test("topup and balance reject a malformed hash before touching the ledger", () => {
  rmDb();
  // wrong length, uppercase, non-hex, leading space — all must fail the ^[0-9a-f]{64}$ gate.
  for (const bad of ["deadbeef", "A".repeat(64), "g".repeat(64), " " + "a".repeat(63)]) {
    expect(nsk(["topup", bad, "5"]).code).toBe(1);
    expect(nsk(["balance", bad]).code).toBe(1);
  }
  expect(nsk(["topup", "deadbeef", "5"]).err).toContain("invalid hash");
});
