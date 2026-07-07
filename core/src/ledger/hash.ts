// sha256(token) as lowercase hex. The token is a bearer secret; only its hash ever touches disk. Pure
// (no DB), in its own module so the metering/proxy path can hash a token WITHOUT importing the balance
// store (ledger/db) — the stage-2 split keeps the prompt world off payment-world modules. db.ts re-exports
// this for the CLIs + tests that open the store anyway.
export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}
