import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

// Self-hosted IBM Plex Mono (the whole brand lives in one monospace). The @font-face rules live in
// ./fonts.css — declared by hand rather than via @fontsource's prebuilt CSS so we can set
// `font-display: optional` (no swap flicker; see that file). The woff2 binaries still come from the
// @fontsource package, bundled by Vite — no Google Fonts CDN, so the page stays within the launch CSP
// `default-src 'self'`. Weights: 300, 400 (body), 600 (display); latin subset only.
import "./fonts.css";

import "./tokens.css";
import "./app.css";
import { routeFor } from "./routes.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

const container = document.getElementById("app")!;
// Pick the view for the current URL. Production serves a prerendered file per route (see prerender.tsx),
// so the component chosen here must match the one prerender baked for this path — both read ROUTES.
const { Component } = routeFor(window.location.pathname);
const tree = (
  <StrictMode>
    <ErrorBoundary>
      <Component />
    </ErrorBoundary>
  </StrictMode>
);

// Production ships prerendered markup (see prerender.tsx) → hydrate it. The dev server serves the
// empty shell → fresh client render. One conditional keeps both paths correct.
if (container.firstElementChild) {
  hydrateRoot(container, tree);
} else {
  createRoot(container).render(tree);
}
