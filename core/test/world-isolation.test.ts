// Attestability guard. The proxy binary is the unit we attest, so it must never bundle payment-world
// code (rails clients, the order store, settle, /buy); symmetrically the payments binary must not carry the
// metered path or the balance store. That's a STRUCTURAL property, not a tree-shaking hope: we root the
// closures at the COMPOSITION ROOTS (proxy.ts / payments.ts — the actual compiled binaries), not just their
// handlers, so a root's non-handler imports (shutdown, ratelimit, the poller, settle) are covered too. The one
// place the two worlds meet (test/support/handler-combined.ts) is imported by no root.
//
// We walk the transitive closure of VALUE imports (`import type` / `export type` are erased at compile time and
// contribute no bundled code, so they're excluded). A stray cross-world import fails here loudly rather than
// silently fattening the attested surface. The compiled-binary symbol check lands with the two roots.
import { test, expect } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// Value imports only: skips `import type ...` / `export type ...`, which TypeScript erases.
const VALUE_IMPORT = /^[ \t]*(?:import|export)[ \t]+(?!type[ \t])[^;]*?from[ \t]+"(\.[^"]+)"/gm;

// `./x` → x.ts; `./dir` → dir/index.ts; an already-suffixed path → itself. Must check isFile(): existsSync is
// true for a bare directory, which would then be read as a file.
function resolveModule(spec: string): string | null {
  for (const cand of [`${spec}.ts`, `${spec}/index.ts`, spec]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

// Every src module reachable from `entry` through runtime (value) imports, as src-relative paths.
function valueClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(SRC, entry)];
  while (stack.length) {
    const file = resolveModule(stack.pop()!);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(VALUE_IMPORT)) stack.push(resolve(dirname(file), m[1]!));
  }
  return new Set([...seen].map((f) => f.slice(SRC.length)));
}

const PAYMENT_WORLD = [
  "rails/index.ts", "rails/monero.ts", "rails/bitcoin.ts", "rails/rate.ts",
  "ledger/orders.ts", "ledger/settle.ts", "ledger/orderstatus.ts", "ledger/poll.ts",
  "endpoints/buy.ts", "endpoints/payments.ts", "endpoints/payment-reads.ts", "payments-handler.ts", "credit-sender.ts",
];
const PROMPT_WORLD = ["providers/index.ts", "ledger/db.ts", "hold.ts", "endpoints/proxy.ts", "endpoints/reads.ts", "handler.ts", "credit-server.ts"];

// Root at the COMPOSITION ROOTS, not the handlers: the proxy binary is `bun build proxy.ts`, and it imports
// modules the handler doesn't (shutdown, ratelimit, env, metrics, the credit server). Rooting at handler.ts
// left those as a blind spot; rooting here covers the whole attested surface and subsumes the handler check.
test("the proxy binary's closure (rooted at proxy.ts) contains NO payment-world module", () => {
  const reachable = valueClosure("proxy.ts");
  expect(PAYMENT_WORLD.filter((m) => reachable.has(m))).toEqual([]);
});

test("the payments binary's closure (rooted at payments.ts) contains NO prompt-world module", () => {
  const reachable = valueClosure("payments.ts");
  expect(PROMPT_WORLD.filter((m) => reachable.has(m))).toEqual([]);
});

// The two halves of the credit crossing are world-owned too: the proxy runs the server, payments runs the sender,
// and they share only credit-wire.ts (a pure contract with no store and no I/O).
test("credit-server (prompt world) imports NO payment-world module", () => {
  const reachable = valueClosure("credit-server.ts");
  expect(PAYMENT_WORLD.filter((m) => reachable.has(m))).toEqual([]);
});

test("credit-sender (payment world) imports NO prompt-world module", () => {
  const reachable = valueClosure("credit-sender.ts");
  expect(PROMPT_WORLD.filter((m) => reachable.has(m))).toEqual([]);
});

test("the endpoints barrel is imported by NO world module (it joins both worlds)", () => {
  // Only the combined test router (test/support/handler-combined.ts) + tests may pull the barrel; the world
  // handlers use endpoints/{proxy,payments}.
  for (const world of ["handler.ts", "payments-handler.ts"]) {
    expect(valueClosure(world).has("endpoints/index.ts")).toBe(false);
  }
});

test("no composition root imports the combined test router", () => {
  // Importing test/support/handler-combined.ts would drag the other world into that binary. It lives outside
  // src/, so match on the module name anywhere in the closure rather than a src-relative path. Assert the
  // roots EXIST before asserting what they don't import: a `continue`-on-missing would turn a renamed/deleted
  // root into a silent pass, which is exactly the failure this guard is supposed to be incapable of.
  for (const root of ["proxy.ts", "payments.ts"]) {
    expect(existsSync(resolve(SRC, root))).toBe(true);
    expect([...valueClosure(root)].filter((m) => m.includes("handler-combined"))).toEqual([]);
  }
});
