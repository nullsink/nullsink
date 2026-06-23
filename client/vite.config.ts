import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// nullsink purchase page (experimental client).
//
// Production: `bun run build` emits static assets that Caddy serves from file_server.
// Every dependency is bundled in — no CDN, no external origin — so the page satisfies
// the launch CSP `default-src 'self'`. Fonts ship via @fontsource (self-hosted woff2).
//
// Dev has two modes for the /buy + /order-status + /balance API:
//   bun run dev        -> proxy those paths to the local app (127.0.0.1:8080)
//   bun run dev:mock   -> a built-in mock (MOCK=1) that walks the whole flow with no backend over a
//                         ~30s wall-clock timeline; see dev-mock.ts for the timing constants and the
//                         error/expiry knobs.
const API = "http://127.0.0.1:8080";
const MOCK = process.env.MOCK === "1";

// Load the dev-only mock ONLY under MOCK=1, via dynamic import — so neither the mock nor its node:crypto
// dependency is pulled into the config graph for `bun run dev` / `bun run build`. (vite.config.ts itself
// never reaches the browser bundle, but keeping the import gated documents the dev-only intent.)
const mockPlugins = MOCK ? [(await import("./dev-mock.ts")).mockApi()] : [];

export default defineConfig({
  plugins: [react(), ...mockPlugins],
  build: {
    // Never inline assets as data: URIs — under CSP `default-src 'self'` a data: font/image
    // would be blocked. Force every asset to a self-hosted file.
    assetsInlineLimit: 0,
    // Single entry, modern-browser target: drop the modulepreload polyfill (dead helper code
    // and a needless CSP edge case).
    modulePreload: { polyfill: false },
  },
  server: MOCK
    ? undefined
    : { proxy: { "/buy": API, "/order-status": API, "/balance": API, "/v1": API } },
});
