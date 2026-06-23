// routeFor() is load-bearing for the prerender/hydration contract: production serves a prerendered file
// per matched route and dist/404.html for everything else, then the client hydrates routeFor(pathname).
// The old fallback returned the landing page for an unmatched path — which, now that an unmatched path is
// served the prerendered 404, would hydrate the landing onto the 404 markup (a mismatch). These pins guard
// that: known paths resolve (with or without a trailing slash), and anything unknown resolves to NOT_FOUND.
import { test, expect } from "bun:test";
import { NOT_FOUND, ROUTES, routeFor } from "./routes.tsx";

test("the root path resolves to the landing route", () => {
  expect(routeFor("/")).toBe(ROUTES[0]);
});

test("a known subpage resolves, with or without a trailing slash", () => {
  const about = ROUTES.find((r) => r.path === "/about")!;
  expect(routeFor("/about")).toBe(about);
  expect(routeFor("/about/")).toBe(about);
});

test("an unknown path resolves to the not-found view, not the landing", () => {
  expect(routeFor("/does-not-exist")).toBe(NOT_FOUND);
  expect(routeFor("/about/extra")).toBe(NOT_FOUND);
  expect(routeFor("/start/deeper/still")).toBe(NOT_FOUND);
});

test("NOT_FOUND stays out of the navigable route table", () => {
  // It must never be linked from nav or listed in the sitemap — only reachable as the routeFor fallback.
  expect(ROUTES).not.toContain(NOT_FOUND);
  expect(ROUTES.some((r) => r.file === NOT_FOUND.file)).toBe(false);
});
