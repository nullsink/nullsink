// Build-time prerender (SSG), after `vite build`: for each route, render to static HTML, swap in that
// route's <head> (title/description/canonical/OG), and write one file per route — so crawlers, unfurlers,
// and non-JS agents get real content + metadata, not an empty <div>. The client hydrates this
// (src/main.tsx); the mint -> pay -> done flow stays client-only (no key/quote ever lands in static HTML).
//
// dist/index.html (built by Vite from index.html) is the shared shell. The per-route head lives between
// the <!-- route:head:start/end --> markers; everything else (favicons, shared OG image, the module
// script, JSON-LD) is identical across routes. The /models page is a directory index
// (dist/models/index.html) so Caddy file_server serves it at the clean /models/ URL with no Caddyfile
// change. Output has no inline scripts/styles, so CSP `default-src 'self'` stays satisfied.
//
// Run with bun (native TS/JSX). No DOM is touched: the views use no browser APIs at render time
// (crypto/fetch fire only on interaction), so renderToString is deterministic and matches the client's
// first render.
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { NOT_FOUND, ROUTES, type Route } from "./src/routes.tsx";
import { ErrorBoundary } from "./src/ErrorBoundary.tsx";

const DIST = "dist";
const TEMPLATE = `${DIST}/index.html`;
const MOUNT = '<div id="app"></div>';
const HEAD_START = "<!-- route:head:start -->";
const HEAD_END = "<!-- route:head:end -->";
const STYLESHEET = '<link rel="stylesheet"'; // Vite injects this; the font preloads slot in just ahead of it

// Weights worth preloading: 400 = body text, 600 = the display h1 — both above the fold on the landing
// page. 300 (light) is rare here and would only compete for bandwidth. Keep this minimal: over-preloading
// fonts hurts LCP. Adjusting the set is a one-line change.
const PRELOAD_WEIGHTS = [400, 600];

// Escape a string for safe interpolation into an HTML attribute or text node.
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The default robots directive for indexable pages — mirrors index.html's in-marker default (the dev/
// landing fallback). The 404 (noindex) is the only route that overrides it. Keeping robots inside the
// per-route head (not index.html's static <head>) is what lets one page opt out: withHead swaps the whole
// marker block, so whatever headFor emits is what ships.
const ROBOTS_INDEX = "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";

// The per-route head tags. og:title/twitter:title reuse the page <title>; the shared tags (og:type,
// og:image, twitter:card, …) stay in index.html outside the marker block. A route with no url ("" — the
// 404) emits no canonical and no og:url (a not-found page has no canonical self); a noindex route ships
// robots=noindex in place of the indexable default.
function headFor(r: Route): string {
  const title = esc(r.title);
  const desc = esc(r.description);
  const tags = [`<meta name="robots" content="${r.noindex ? "noindex" : ROBOTS_INDEX}" />`];
  if (r.url) tags.push(`<link rel="canonical" href="${r.url}" />`);
  tags.push(
    `<title>${title}</title>`,
    `<meta name="description" content="${desc}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${desc}" />`,
  );
  if (r.url) tags.push(`<meta property="og:url" content="${r.url}" />`);
  tags.push(
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${desc}" />`,
  );
  return tags.join("\n    ");
}

// Replace the content between the head markers (the markers themselves are kept).
function withHead(html: string, headHtml: string): string {
  const start = html.indexOf(HEAD_START);
  const end = html.indexOf(HEAD_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`prerender: head markers ${HEAD_START} … ${HEAD_END} not found in ${TEMPLATE}`);
  }
  return html.slice(0, start + HEAD_START.length) + "\n    " + headHtml + "\n    " + html.slice(end);
}

// Build <link rel=preload> tags for the dominant font weights so the browser fetches the woff2 in parallel
// with the stylesheet. @fontsource ships font-display:swap, so without a preload the fallback->IBM Plex Mono
// swap (the FOUT flicker on every full-page load — navigation here is plain <a href>, so each page is a
// fresh document) is guaranteed; preloading lands the font by first paint and hides it. Filenames are
// content-hashed by Vite, so we glob them out of dist/assets at build time. crossorigin is REQUIRED even
// same-origin: fonts fetch CORS-anonymous, and a preload without it just double-fetches.
function fontPreloadTags(): string {
  const files = readdirSync(`${DIST}/assets`);
  return PRELOAD_WEIGHTS.map((w) => {
    const re = new RegExp(`^ibm-plex-mono-latin-${w}-normal-[\\w-]+\\.woff2$`);
    const file = files.find((f) => re.test(f));
    if (!file) throw new Error(`prerender: no preload woff2 for weight ${w} in ${DIST}/assets`);
    return `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${file}" />`;
  }).join("\n    ");
}

// Insert the font preloads immediately before Vite's stylesheet <link>, so the preload scanner finds them
// as early as possible (and ahead of the CSS request that would otherwise gate the font fetch).
function withFontPreloads(html: string): string {
  const i = html.indexOf(STYLESHEET);
  if (i === -1) throw new Error(`prerender: stylesheet link (${STYLESHEET}…) not found in ${TEMPLATE}`);
  return html.slice(0, i) + fontPreloadTags() + "\n    " + html.slice(i);
}

// Read the Vite-built shell and bake the (route-independent) font preloads in once; every route derives
// its file from this template, so each output inherits them.
const template = withFontPreloads(readFileSync(TEMPLATE, "utf8"));
if (!template.includes(MOUNT)) {
  throw new Error(`prerender: mount point ${MOUNT} not found in ${TEMPLATE}, aborting`);
}

// Every indexable route, plus the not-found page. NOT_FOUND lives outside ROUTES (never navigated to or
// listed in the sitemap) but still needs a prerendered dist/404.html for the edge's handle_errors to serve
// for unmatched paths — see core/deploy/Caddyfile.
for (const route of [...ROUTES, NOT_FOUND]) {
  const appHtml = renderToString(
    <StrictMode>
      <ErrorBoundary>
        <route.Component />
      </ErrorBoundary>
    </StrictMode>,
  );
  const html = withHead(template, headFor(route)).replace(MOUNT, `<div id="app">${appHtml}</div>`);
  const out = `${DIST}/${route.file}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`prerender: ${route.path || route.file} -> ${out} (${appHtml.length} chars)`);
}
