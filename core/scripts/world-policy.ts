// The service-world policy is intentionally exhaustive. Ownership is derived from the two real composition
// roots; only a small reviewed set may appear in BOTH runtime closures, and every src module must either be
// reachable from a service or be named as intentionally non-service. This avoids sampled deny-lists whose
// omissions make a boundary test silently vacuous.
import { readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeModuleGraph, type UnresolvedLocalImport } from "./world-graph";

export const CORE_DIR = fileURLToPath(new URL("../", import.meta.url));
export const SRC_DIR = resolve(CORE_DIR, "src");
export const PROXY_ROOT = "proxy.ts";
export const PAYMENTS_ROOT = "payments.ts";

// Pure infrastructure/contracts deliberately used by both binaries. This is an ALLOW-list for the exact
// intersection, not a sample: a new shared module fails until its cross-world use is explicitly reviewed.
export const INTENTIONAL_SHARED_RUNTIME = new Set([
  "credit-wire.ts",
  "endpoints/read-throttle.ts",
  "env.ts",
  "http/body.ts",
  "http/errors.ts",
  "http/headers.ts",
  "http/index.ts",
  "ledger/sqlite.ts",
  "log.ts",
  "metrics.ts",
  "ratelimit.ts",
  "version.ts",
]);

// Source modules intentionally absent from both service binaries. The first two are erased type contracts;
// the others are runtime helpers owned by the operator CLI/browser client. Exactness is checked below so a
// removed/renamed module cannot leave a stale exemption.
export const INTENTIONAL_NON_SERVICE_MODULES = new Set([
  "providers/types.ts",
  "rails/types.ts",
  "ledger/financials.ts",
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

export type WorldInspection = {
  proxy: Set<string>;
  payments: Set<string>;
  shared: Set<string>;
  proxyOnly: Set<string>;
  paymentsOnly: Set<string>;
  unexpectedShared: Set<string>;
  staleSharedAllowances: Set<string>;
  reachedNonService: Set<string>;
  unclassifiedSource: Set<string>;
  staleNonServiceAllowances: Set<string>;
  outsideSource: Set<string>;
  unresolved: UnresolvedLocalImport[];
};

export function inspectServiceWorlds(coreDir = CORE_DIR): WorldInspection {
  const srcDir = resolve(coreDir, "src");
  const proxyGraph = runtimeModuleGraph([resolve(srcDir, PROXY_ROOT)]);
  const paymentsGraph = runtimeModuleGraph([resolve(srcDir, PAYMENTS_ROOT)]);
  const proxy = namedModules(proxyGraph.modules, srcDir);
  const payments = namedModules(paymentsGraph.modules, srcDir);
  const shared = intersection(proxy, payments);
  const serviceModules = union(proxy, payments);
  const sourceModules = allSourceModules(srcDir);
  const outsideSource = new Set(
    [...union(proxyGraph.modules, paymentsGraph.modules)]
      .filter((path) => sourceModuleName(path, srcDir) == null)
      .map((path) => slash(relative(coreDir, path))),
  );

  return {
    proxy,
    payments,
    shared,
    proxyOnly: difference(proxy, payments),
    paymentsOnly: difference(payments, proxy),
    unexpectedShared: difference(shared, INTENTIONAL_SHARED_RUNTIME),
    staleSharedAllowances: difference(INTENTIONAL_SHARED_RUNTIME, shared),
    reachedNonService: intersection(serviceModules, INTENTIONAL_NON_SERVICE_MODULES),
    unclassifiedSource: difference(difference(sourceModules, serviceModules), INTENTIONAL_NON_SERVICE_MODULES),
    staleNonServiceAllowances: difference(INTENTIONAL_NON_SERVICE_MODULES, sourceModules),
    outsideSource,
    unresolved: [...proxyGraph.unresolved, ...paymentsGraph.unresolved],
  };
}

export function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}
