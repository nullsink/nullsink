// The trust-domain policy is intentionally exhaustive. Ownership is derived from the three real composition
// roots; only small reviewed sets may appear in pairwise runtime intersections, and every src module must either be
// reachable from a service or be named as intentionally non-service. This avoids sampled deny-lists whose
// omissions make a boundary test silently vacuous.
import { readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeModuleGraph, type OpaqueRuntimeImport, type UnresolvedLocalImport } from "./trust-domain-graph";

export const CORE_DIR = fileURLToPath(new URL("../", import.meta.url));
export const SRC_DIR = resolve(CORE_DIR, "src");
export const PROXY_ROOT = "proxy.ts";
export const LEDGER_ROOT = "ledger-service.ts";
export const PAYMENTS_ROOT = "payments.ts";

// Exact pairwise intersections. These include the two modules shared by all three roots; keeping each complete
// makes every crossing independently reviewable and avoids a permissive generic "shared" bucket.
export const INTENTIONAL_SHARED_RUNTIME = new Set([
  "endpoints/read-throttle.ts",
  "env.ts",
  "http/body.ts",
  "http/errors.ts",
  "http/headers.ts",
  "http/index.ts",
  "log.ts",
  "metrics.ts",
  "ratelimit.ts",
  "version.ts",
]);
export const INTENTIONAL_PROXY_LEDGER_RUNTIME = new Set([
  "ledger/hash.ts",
  "ledger/wire.ts",
  "log.ts",
  "version.ts",
]);
export const INTENTIONAL_PAYMENTS_LEDGER_RUNTIME = new Set([
  "credit-wire.ts",
  "ledger/sqlite.ts",
  "log.ts",
  "version.ts",
]);

// Exact exclusive ownership. Merely proving that a module is not shared is insufficient: a sensitive
// payment module could otherwise move wholesale into the proxy closure (or vice versa) and still pass.
export const INTENTIONAL_PROXY_ONLY_RUNTIME = new Set([
  "cost/index.ts",
  "cost/prices.json",
  "cost/pricing.ts",
  "cost/usage/anthropic.ts",
  "cost/usage/index.ts",
  "cost/usage/openai.ts",
  "cost/usage/types.ts",
  "endpoints/proxy.ts",
  "endpoints/reads.ts",
  "handler.ts",
  "hold.ts",
  "http/proxy-token.ts",
  "ledger/client.ts",
  "providers/anthropic.ts",
  "providers/index.ts",
  "providers/openai.ts",
  "providers/tinfoil.ts",
  "proxy.ts",
  "shutdown.ts",
]);

export const INTENTIONAL_PAYMENTS_ONLY_RUNTIME = new Set([
  "credit-sender.ts",
  "endpoints/buy.ts",
  "endpoints/payment-reads.ts",
  "endpoints/payments.ts",
  "endpoints/types.ts",
  "ledger/orders.ts",
  "ledger/orderstatus.ts",
  "ledger/poll.ts",
  "ledger/settle.ts",
  "payments-handler.ts",
  "payments.ts",
  "pricing-config.ts",
  "rails/bitcoin.ts",
  "rails/catalog.ts",
  "rails/index.ts",
  "rails/monero.ts",
  "rails/rate.ts",
  "rails/units.ts",
]);

export const INTENTIONAL_LEDGER_ONLY_RUNTIME = new Set([
  "credit-server.ts",
  "ledger-service.ts",
  "ledger/db.ts",
  "ledger/server.ts",
]);

// Source modules intentionally absent from all three service binaries. Type-only contracts erase at runtime;
// the others serve local tools or the browser client. Exactness prevents stale exemptions.
export const INTENTIONAL_NON_SERVICE_MODULES = new Set([
  "providers/types.ts",
  "rails/types.ts",
  "ledger/financials.ts",
  "ledger/port.ts",
  "token-format.ts",
]);

const TRACKED_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);

function slash(path: string): string {
  return path.split(sep).join("/");
}

export function sourceModuleName(path: string, srcDir = SRC_DIR): string | null {
  const name = relative(srcDir, path);
  return name === "" || name.startsWith(`..${sep}`) || isAbsolute(name) ? null : slash(name);
}

function allSourceModules(dir = SRC_DIR, root = SRC_DIR): Set<string> {
  const modules = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      for (const module of allSourceModules(path, root)) modules.add(module);
    } else if (TRACKED_SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      modules.add(slash(relative(root, path)));
    }
  }
  return modules;
}

function namedModules(modules: Set<string>, srcDir: string): Set<string> {
  return new Set([...modules].map((path) => sourceModuleName(path, srcDir)).filter((name): name is string => name != null));
}

function difference(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => !right.has(item)));
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => right.has(item)));
}

function union(...sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

export type TrustDomainInspection = {
  proxy: Set<string>;
  ledger: Set<string>;
  payments: Set<string>;
  shared: Set<string>;
  proxyLedgerShared: Set<string>;
  paymentsLedgerShared: Set<string>;
  proxyOnly: Set<string>;
  ledgerOnly: Set<string>;
  paymentsOnly: Set<string>;
  unexpectedShared: Set<string>;
  staleSharedAllowances: Set<string>;
  unexpectedProxyLedgerShared: Set<string>;
  staleProxyLedgerSharedAllowances: Set<string>;
  unexpectedPaymentsLedgerShared: Set<string>;
  stalePaymentsLedgerSharedAllowances: Set<string>;
  unexpectedProxyOnly: Set<string>;
  staleProxyOnlyAllowances: Set<string>;
  unexpectedPaymentsOnly: Set<string>;
  stalePaymentsOnlyAllowances: Set<string>;
  unexpectedLedgerOnly: Set<string>;
  staleLedgerOnlyAllowances: Set<string>;
  reachedNonService: Set<string>;
  unclassifiedSource: Set<string>;
  staleNonServiceAllowances: Set<string>;
  outsideSource: Set<string>;
  unresolved: UnresolvedLocalImport[];
  opaque: OpaqueRuntimeImport[];
};

export function inspectTrustDomains(coreDir = CORE_DIR): TrustDomainInspection {
  const srcDir = resolve(coreDir, "src");
  const proxyGraph = runtimeModuleGraph([resolve(srcDir, PROXY_ROOT)]);
  const ledgerGraph = runtimeModuleGraph([resolve(srcDir, LEDGER_ROOT)]);
  const paymentsGraph = runtimeModuleGraph([resolve(srcDir, PAYMENTS_ROOT)]);
  const proxy = namedModules(proxyGraph.modules, srcDir);
  const ledger = namedModules(ledgerGraph.modules, srcDir);
  const payments = namedModules(paymentsGraph.modules, srcDir);
  const shared = intersection(proxy, payments);
  const proxyLedgerShared = intersection(proxy, ledger);
  const paymentsLedgerShared = intersection(payments, ledger);
  const serviceModules = union(proxy, ledger, payments);
  const sourceModules = allSourceModules(srcDir);
  const outsideSource = new Set(
    [...union(proxyGraph.modules, ledgerGraph.modules, paymentsGraph.modules)]
      .filter((path) => sourceModuleName(path, srcDir) == null)
      .map((path) => slash(relative(coreDir, path))),
  );

  return {
    proxy,
    ledger,
    payments,
    shared,
    proxyLedgerShared,
    paymentsLedgerShared,
    proxyOnly: difference(proxy, union(payments, ledger)),
    ledgerOnly: difference(ledger, union(proxy, payments)),
    paymentsOnly: difference(payments, union(proxy, ledger)),
    unexpectedShared: difference(shared, INTENTIONAL_SHARED_RUNTIME),
    staleSharedAllowances: difference(INTENTIONAL_SHARED_RUNTIME, shared),
    unexpectedProxyLedgerShared: difference(proxyLedgerShared, INTENTIONAL_PROXY_LEDGER_RUNTIME),
    staleProxyLedgerSharedAllowances: difference(INTENTIONAL_PROXY_LEDGER_RUNTIME, proxyLedgerShared),
    unexpectedPaymentsLedgerShared: difference(paymentsLedgerShared, INTENTIONAL_PAYMENTS_LEDGER_RUNTIME),
    stalePaymentsLedgerSharedAllowances: difference(INTENTIONAL_PAYMENTS_LEDGER_RUNTIME, paymentsLedgerShared),
    unexpectedProxyOnly: difference(difference(proxy, union(payments, ledger)), INTENTIONAL_PROXY_ONLY_RUNTIME),
    staleProxyOnlyAllowances: difference(INTENTIONAL_PROXY_ONLY_RUNTIME, difference(proxy, union(payments, ledger))),
    unexpectedPaymentsOnly: difference(difference(payments, union(proxy, ledger)), INTENTIONAL_PAYMENTS_ONLY_RUNTIME),
    stalePaymentsOnlyAllowances: difference(INTENTIONAL_PAYMENTS_ONLY_RUNTIME, difference(payments, union(proxy, ledger))),
    unexpectedLedgerOnly: difference(difference(ledger, union(proxy, payments)), INTENTIONAL_LEDGER_ONLY_RUNTIME),
    staleLedgerOnlyAllowances: difference(INTENTIONAL_LEDGER_ONLY_RUNTIME, difference(ledger, union(proxy, payments))),
    reachedNonService: intersection(serviceModules, INTENTIONAL_NON_SERVICE_MODULES),
    unclassifiedSource: difference(difference(sourceModules, serviceModules), INTENTIONAL_NON_SERVICE_MODULES),
    staleNonServiceAllowances: difference(INTENTIONAL_NON_SERVICE_MODULES, sourceModules),
    outsideSource,
    unresolved: [...proxyGraph.unresolved, ...ledgerGraph.unresolved, ...paymentsGraph.unresolved],
    opaque: [...proxyGraph.opaque, ...ledgerGraph.opaque, ...paymentsGraph.opaque],
  };
}

export function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}
