// Compiled-binary attestability check. test/world-isolation.test.ts proves the IMPORT GRAPH is clean; this
// proves the BUNDLER agreed — the compiled proxy binary, which is the unit we attest, must carry no
// payment-world code. Runs as part of `bun run build`, so CI enforces it on every PR.
//
// Markers are SQL fragments / identifiers that exist in exactly one world. A positive control asserts each marker
// really is present in the binary that SHOULD have it — otherwise a renamed query would silently make this vacuous.
import { readFileSync, existsSync } from "node:fs";

const PROXY = "nullsink-proxy-linux-x64";
const PAYMENTS = "nullsink-payments-linux-x64";
for (const f of [PROXY, PAYMENTS]) {
  if (!existsSync(f)) {
    console.error(`assert-worlds: missing ${f} — run the build first`);
    process.exit(1);
  }
}

const has = (bin: Buffer, needle: string) => bin.includes(Buffer.from(needle, "utf8"));

// Present ONLY in payment-world code (pending.db SQL + the rail wallet call).
const PAYMENT_MARKERS = ["INTO credit_outbox", "FROM pending_orders", "incomingTransfers"];
// Present ONLY in prompt-world code (balances.db SQL) — the proxy's own world, used as a positive control.
const PROMPT_MARKER = "INTO applied_orders";

const proxy = readFileSync(PROXY);
const payments = readFileSync(PAYMENTS);

// Positive controls: if these fail the markers no longer identify the worlds — fix the markers, don't ignore it.
const missingInPayments = PAYMENT_MARKERS.filter((m) => !has(payments, m));
if (missingInPayments.length) {
  console.error(`assert-worlds: positive control FAILED — payments binary lacks ${missingInPayments.join(", ")}; the markers are stale.`);
  process.exit(1);
}
if (!has(proxy, PROMPT_MARKER)) {
  console.error(`assert-worlds: positive control FAILED — proxy binary lacks "${PROMPT_MARKER}"; the marker is stale.`);
  process.exit(1);
}

const leaked = PAYMENT_MARKERS.filter((m) => has(proxy, m));
if (leaked.length) {
  console.error(`assert-worlds: the PROXY binary contains payment-world code: ${leaked.join(", ")}`);
  console.error("The attested unit must stay minimal. Check for a cross-world import (test/world-isolation.test.ts).");
  process.exit(1);
}

// Mirror check: payments must not carry the balance ledger.
if (has(payments, PROMPT_MARKER)) {
  console.error(`assert-worlds: the PAYMENTS binary contains prompt-world code: ${PROMPT_MARKER}`);
  process.exit(1);
}

console.log(`assert-worlds: ✓ proxy carries no payment-world code; payments carries no balance ledger`);
