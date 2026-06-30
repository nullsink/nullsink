// The route table — the single source of truth shared by the client render (src/main.tsx) and the
// build-time SSG (prerender.tsx). Each route names its component, its output file under dist/, and the
// per-route <head> (title/description/canonical) that prerender bakes in. Navigation is plain <a href>
// full-page loads: there are only a couple of static pages, so a client-side router would add JS to
// solve a problem we don't have. See prerender.tsx for how `file`/`url`/the head fields are consumed.
import type { ReactElement } from "react";
import { App } from "./App.tsx";
import { Api } from "./flow/Api.tsx";
import { Models } from "./flow/Models.tsx";
import { NotFound } from "./flow/NotFound.tsx";
import { Privacy } from "./flow/Privacy.tsx";
import { Tos } from "./flow/Tos.tsx";

const PROD = "https://nullsink.is";

export interface Route {
  path: string; // client pathname, no trailing slash except root ("" for the not-found fallback — no real path equals it)
  file: string; // output path under dist/ (a directory index → clean URL via Caddy file_server)
  url: string; // absolute canonical URL (scrapers + <link rel=canonical> need absolute); "" → emit no canonical/og:url (the 404)
  title: string;
  description: string;
  noindex?: boolean; // emit <meta robots=noindex> instead of the default index,follow — the 404 only (see prerender headFor)
  Component: () => ReactElement;
}

export const ROUTES: Route[] = [
  {
    path: "/",
    file: "index.html",
    url: `${PROD}/`,
    title: "nullsink: anonymous LLM proxy",
    description:
      "Anonymous LLM proxy. Mint a prepaid key in your browser, pay with Monero or Bitcoin, and use any Anthropic or OpenAI SDK. No account, no request logs.",
    Component: App,
  },
  {
    path: "/api",
    file: "api/index.html",
    url: `${PROD}/api/`,
    title: "nullsink: api reference",
    description:
      "The nullsink HTTP API: Anthropic and OpenAI endpoints, base URLs and auth, copy-paste curl, and the error codes. Point a stock SDK at it by changing only the base URL and the key.",
    Component: Api,
  },
  {
    path: "/models",
    file: "models/index.html",
    url: `${PROD}/models/`,
    title: "nullsink: supported models",
    description:
      "Models you can call through the nullsink proxy, grouped by provider. Catalogue derived from models.dev.",
    Component: Models,
  },
  {
    path: "/privacy",
    file: "privacy/index.html",
    url: `${PROD}/privacy/`,
    title: "nullsink: privacy policy",
    description:
      "What nullsink handles (a token hash and a balance) and what it never keeps (your IP, prompts, identity, or request logs). No account, no cookies, no tracking.",
    Component: Privacy,
  },
  {
    path: "/terms",
    file: "terms/index.html",
    url: `${PROD}/terms/`,
    title: "nullsink: terms of service",
    description:
      "Terms for using nullsink: prepaid credit bought with Monero or Bitcoin, bearer keys, no refunds, no key recovery, experimental with low limits. AI output comes from third-party providers under their policies.",
    Component: Tos,
  },
];

// The not-found view. Kept OUT of ROUTES so it's never navigated to, listed in the sitemap, or matched as
// a real path — it's only the fallback routeFor() returns below, plus the extra page prerender writes to
// dist/404.html. The path/url/noindex fields work as the field comments above gloss. The Caddyfile serves
// dist/404.html (with the 404 status) for any unmatched request, and routeFor() returns this same Component
// for that URL — so the served markup and the client's first render agree (no hydration mismatch).
export const NOT_FOUND: Route = {
  path: "",
  file: "404.html",
  url: "",
  title: "nullsink: page not found",
  description: "This page isn't here — the URL doesn't match anything nullsink serves.",
  noindex: true,
  Component: NotFound,
};

// Resolve a browser pathname to its route, tolerating an optional trailing slash, falling back to the
// not-found view (so an unknown path hydrates the same 404 the edge served — see NOT_FOUND). Used
// client-side only; prerender iterates ROUTES (and renders NOT_FOUND separately).
export function routeFor(pathname: string): Route {
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return ROUTES.find((r) => r.path === p) ?? NOT_FOUND;
}
