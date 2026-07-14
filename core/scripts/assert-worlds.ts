// Build-time attestability check, deliberately independent at three layers:
//   1. TypeScript-AST runtime closures enforce the exhaustive source ownership policy.
//   2. Bun metafiles prove which local modules the bundler actually embedded and cross-check the AST graph.
//   3. Distinctive symbols are checked in the compiled executables themselves.
// A source-parser bug, stale ownership exemption, or bundler surprise therefore fails the build rather than
// silently widening the sealed proxy binary.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  INTENTIONAL_SHARED_RUNTIME,
  inspectServiceWorlds,
  sorted,
  sourceModuleName,
} from "./world-policy";

const PROXY = "nullsink-proxy-linux-x64";
const PAYMENTS = "nullsink-payments-linux-x64";
const PROXY_META = "nullsink-proxy.metafile.json";
const PAYMENTS_META = "nullsink-payments.metafile.json";

for (const file of [PROXY, PAYMENTS, PROXY_META, PAYMENTS_META]) {
  if (!existsSync(file)) {
    console.error(`assert-worlds: missing ${file} — run the build first`);
    process.exit(1);
  }
}

function fail(label: string, values: Iterable<string>): void {
  const items = sorted(values);
  if (!items.length) return;
  console.error(`assert-worlds: ${label}: ${items.join(", ")}`);
  process.exit(1);
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => right.has(item)));
}

function difference(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => !right.has(item)));
}

const worlds = inspectServiceWorlds();
fail("unresolved local runtime imports", worlds.unresolved.map(({ importer, specifier }) => `${importer} -> ${specifier}`));
fail("opaque runtime imports are forbidden", worlds.opaque.map(({ importer, expression }) => `${importer} -> ${expression}`));
fail("service roots reach local modules outside src", worlds.outsideSource);
fail("unreviewed modules are shared by proxy + payments", worlds.unexpectedShared);
fail("shared-module allowances are stale", worlds.staleSharedAllowances);
fail("unreviewed modules are proxy-only", worlds.unexpectedProxyOnly);
fail("proxy-only allowances are stale or misowned", worlds.staleProxyOnlyAllowances);
fail("unreviewed modules are payments-only", worlds.unexpectedPaymentsOnly);
fail("payments-only allowances are stale or misowned", worlds.stalePaymentsOnlyAllowances);
fail("non-service modules are reachable by a service", worlds.reachedNonService);
fail("src modules lack an owner", worlds.unclassifiedSource);
fail("non-service module allowances are stale", worlds.staleNonServiceAllowances);

type Metafile = { inputs?: Record<string, unknown> };

function bundledSourceModules(file: string): Set<string> {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Metafile;
  if (!parsed.inputs || typeof parsed.inputs !== "object") {
    console.error(`assert-worlds: ${file} has no inputs map`);
    process.exit(1);
  }
  const names = new Set<string>();
  for (const input of Object.keys(parsed.inputs)) {
    const path = isAbsolute(input) ? input : resolve(input);
    const name = sourceModuleName(path);
    if (name) names.add(name);
  }
  return names;
}

const proxyInputs = bundledSourceModules(PROXY_META);
const paymentsInputs = bundledSourceModules(PAYMENTS_META);
if (!proxyInputs.has("proxy.ts") || !paymentsInputs.has("payments.ts")) {
  console.error("assert-worlds: metafile positive control FAILED — composition root missing from its own bundle");
  process.exit(1);
}

// Bun may tree-shake a structurally reachable module, so the metadata can be a subset of the AST closure.
// It must never contain a local source module the parser did not reach: that would expose a syntax blind spot.
fail("proxy metafile contains modules absent from its AST graph", difference(proxyInputs, worlds.proxy));
fail("payments metafile contains modules absent from its AST graph", difference(paymentsInputs, worlds.payments));
fail(
  "Bun embedded an unreviewed module in both service binaries",
  difference(intersection(proxyInputs, paymentsInputs), INTENTIONAL_SHARED_RUNTIME),
);

const has = (binary: Buffer, needle: string): boolean => binary.includes(Buffer.from(needle, "utf8"));

// Present only in payment-world behavior (pending.db SQL + the rail wallet call). The source + metafile
// checks above are exhaustive; these symbols are an independent assertion against the executable bytes.
const PAYMENT_MARKERS = ["INTO credit_outbox", "FROM pending_orders", "incomingTransfers"];
// Present only in prompt-world behavior (balances.db SQL).
const PROMPT_MARKER = "INTO applied_orders";

const proxy = readFileSync(PROXY);
const payments = readFileSync(PAYMENTS);

// Positive controls keep the byte-level checks from becoming vacuous after a query/symbol rename.
const missingInPayments = PAYMENT_MARKERS.filter((marker) => !has(payments, marker));
if (missingInPayments.length) {
  console.error(`assert-worlds: binary positive control FAILED — payments lacks ${missingInPayments.join(", ")}; update the markers`);
  process.exit(1);
}
if (!has(proxy, PROMPT_MARKER)) {
  console.error(`assert-worlds: binary positive control FAILED — proxy lacks "${PROMPT_MARKER}"; update the marker`);
  process.exit(1);
}

fail("compiled proxy contains payment-world symbols", PAYMENT_MARKERS.filter((marker) => has(proxy, marker)));
if (has(payments, PROMPT_MARKER)) {
  console.error(`assert-worlds: compiled payments contains prompt-world symbol: ${PROMPT_MARKER}`);
  process.exit(1);
}

console.log("assert-worlds: ✓ AST ownership, Bun inputs, and compiled symbols preserve the two-world boundary");
