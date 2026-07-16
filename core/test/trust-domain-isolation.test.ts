// Attestability guard. The proxy binary is the unit we attest, so it must never bundle payments trust-domain code;
// symmetrically, payments must not carry the proxy/balance trust domain. These tests root the graph at the actual
// composition roots and parse every runtime import with TypeScript's AST. Build-time verification separately
// checks Bun's metafiles and compiled-binary symbols (scripts/assert-trust-domains.ts).
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { runtimeModuleGraph } from "../scripts/trust-domain-graph";
import {
  INTENTIONAL_PAYMENTS_ONLY_RUNTIME,
  INTENTIONAL_PROXY_ONLY_RUNTIME,
  INTENTIONAL_SHARED_RUNTIME,
  inspectTrustDomains,
  sorted,
} from "../scripts/trust-domain-policy";

type RuntimeForm = { name: string; source: string };

// Each fixture makes one module proxy-owned (reachable from proxy.ts), then references it from payments.ts
// using another legal runtime-import spelling. If the parser misses that spelling, `owned.ts` disappears from
// the intersection and the test fails. These are graph tests, not regex unit tests: resolution + traversal are
// exercised along with parsing.
const RUNTIME_IMPORT_FORMS: RuntimeForm[] = [
  { name: "single-quoted named import", source: `import { value } from './owned'; void value;` },
  { name: "double-quoted default import", source: `import value from "./owned"; void value;` },
  { name: "side-effect import", source: `import './owned';` },
  { name: "empty named import", source: `import {} from './owned';` },
  { name: "named re-export", source: `export { value } from './owned';` },
  { name: "empty named re-export", source: `export {} from './owned';` },
  { name: "star re-export", source: `export * from "./owned";` },
  { name: "dynamic import", source: `export const load = () => import('./owned');` },
  { name: "CommonJS require", source: `const owned = require("./owned"); void owned;` },
  { name: "TypeScript import-equals require", source: `import owned = require('./owned'); void owned;` },
  { name: "mixed value/type import", source: `import { type Shape, value } from './owned'; void value;` },
  { name: "mixed value/type re-export", source: `export { type Shape, value } from "./owned";` },
];

function fixtureIntersection(paymentsSource: string): string[] {
  const dir = mkdtempSync(resolve(tmpdir(), "nullsink-trust-domain-graph-"));
  try {
    writeFileSync(resolve(dir, "owned.ts"), "export default 1; export const value = 1; export type Shape = number;\n");
    writeFileSync(resolve(dir, "proxy.ts"), `import './owned';\n`);
    writeFileSync(resolve(dir, "payments.ts"), `${paymentsSource}\n`);
    const proxy = runtimeModuleGraph([resolve(dir, "proxy.ts")]);
    const payments = runtimeModuleGraph([resolve(dir, "payments.ts")]);
    expect(proxy.unresolved).toEqual([]);
    expect(payments.unresolved).toEqual([]);
    expect(proxy.opaque).toEqual([]);
    expect(payments.opaque).toEqual([]);
    return [...proxy.modules]
      .filter((module) => payments.modules.has(module))
      .map((module) => relative(dir, module))
      .sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const fixture of RUNTIME_IMPORT_FORMS) {
  test(`runtime module graph detects a cross-trust-domain ${fixture.name}`, () => {
    expect(fixtureIntersection(fixture.source)).toEqual(["owned.ts"]);
  });
}

test("runtime module graph excludes imports and re-exports that TypeScript erases", () => {
  const typeOnly = `
    import type { Shape } from './owned';
    import { type Shape as InlineShape } from "./owned";
    import type Owned = require('./owned');
    export type { Shape as ExportedShape } from './owned';
    export { type Shape as InlineExportedShape } from "./owned";
    type LazyShape = import('./owned').Shape;
    export type Combined = Shape | InlineShape | Owned.Shape | LazyShape;
  `;
  expect(fixtureIntersection(typeOnly)).toEqual([]);
});

test("runtime module graph reports computed dynamic imports and requires instead of silently dropping them", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "nullsink-trust-domain-opaque-"));
  try {
    const entry = resolve(dir, "entry.ts");
    writeFileSync(
      entry,
      `const target = './owned'; import(target); require('./' + 'owned'); module.require(target);\n`,
    );
    const graph = runtimeModuleGraph([entry]);
    expect(graph.opaque.map(({ expression }) => expression)).toEqual(["target", "'./' + 'owned'"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the composition-root graphs resolve every local runtime import and stay inside src", () => {
  const trustDomains = inspectTrustDomains();
  expect(trustDomains.unresolved).toEqual([]);
  expect(trustDomains.opaque).toEqual([]);
  expect(sorted(trustDomains.outsideSource)).toEqual([]);
  expect(trustDomains.proxy.has("proxy.ts")).toBe(true);
  expect(trustDomains.payments.has("payments.ts")).toBe(true);
});

test("every exclusive module remains in its reviewed trust domain", () => {
  const trustDomains = inspectTrustDomains();
  expect(sorted(trustDomains.unexpectedProxyOnly)).toEqual([]);
  expect(sorted(trustDomains.staleProxyOnlyAllowances)).toEqual([]);
  expect(sorted(trustDomains.proxyOnly)).toEqual(sorted(INTENTIONAL_PROXY_ONLY_RUNTIME));
  expect(sorted(trustDomains.unexpectedPaymentsOnly)).toEqual([]);
  expect(sorted(trustDomains.stalePaymentsOnlyAllowances)).toEqual([]);
  expect(sorted(trustDomains.paymentsOnly)).toEqual(sorted(INTENTIONAL_PAYMENTS_ONLY_RUNTIME));
});

test("only the exhaustively reviewed infrastructure set is shared by both services", () => {
  const trustDomains = inspectTrustDomains();
  expect(sorted(trustDomains.unexpectedShared)).toEqual([]);
  expect(sorted(trustDomains.staleSharedAllowances)).toEqual([]);
  expect(sorted(trustDomains.shared)).toEqual(sorted(INTENTIONAL_SHARED_RUNTIME));
});

test("every src module is service-owned or explicitly non-service", () => {
  const trustDomains = inspectTrustDomains();
  expect(sorted(trustDomains.reachedNonService)).toEqual([]);
  expect(sorted(trustDomains.unclassifiedSource)).toEqual([]);
  expect(sorted(trustDomains.staleNonServiceAllowances)).toEqual([]);
});
