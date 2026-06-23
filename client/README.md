# nullsink client

The purchase UI: a React 19 + Vite app where a user mints a prepaid bearer key in the
browser, funds it with Monero or Bitcoin, and copies integration snippets. Every route is
prerendered to static HTML (works with JS off) and fully self-contained — no CDN — to
satisfy a strict `default-src 'self'` CSP. It talks to `core/` over plain HTTP/JSON.

See the [root README](../README.md) for monorepo setup and dev commands.

## Run

Dependencies install once at the repo root (`bun install`); run these from `client/`:

| Script | What it does |
| --- | --- |
| `bun run dev` | dev server; proxies `/buy`, `/order-status`, `/balance`, `/v1` to a local core on `127.0.0.1:8080` |
| `bun run dev:mock` | dev server with no backend — serves an in-process mock (`dev-mock.ts`) |
| `bun run build` | typecheck, bundle, then prerender to `dist/` |
| `bun run preview` | serve the built `dist/` |
| `bun run sync:models` | regenerate `src/models.json` from core's prices (manual) |
| `bun run typecheck` | `tsc` for app + tests |
| `bun test` | run the test suite (happy-dom + testing-library) |

## Source map

```
index.html       the shell; holds the <!-- route:head:start/end --> markers
vite.config.ts   dev proxy, mock gate, CSP-driven build options
prerender.tsx    build-time SSG — one static HTML file per route
sync-models.ts   regenerates src/models.json from core
dev-mock.ts      dev-only mock backend (MOCK=1)

src/
  main.tsx        browser entry — hydrate or render
  routes.tsx      the route table (drives both prerender and main)
  App.tsx         landing + buy page
  Layout.tsx      shared shell (header, footer)
  ui.tsx          shared presentational bits
  flow/           the page views + quote/pay flow (KeyFlow, QuotePay, ...)
  lib/            api.ts, token.ts (in-browser minting), links.ts, qr.ts
  models.json     committed snapshot rendered by /models
```

## Things to know

- **No router.** `routes.tsx` drives both `prerender.tsx` (build) and `main.tsx` (hydrate); navigation is plain `<a href>` full-page loads. The `<!-- route:head:start/end -->` markers in `index.html` are load-bearing — prerender fails without them.
- **`lib/api.ts` and `lib/token.ts` import from `../../../core/src/`** (`pricing-config.ts`, `token-format.ts`) so the UI and server agree on markup and token format. Those core files are bundled into the page, so they must stay pure and browser-safe.
- **`src/models.json` is a committed snapshot;** regenerate and commit it when core's prices change.
- **The production origin is hardcoded** in `src/routes.tsx` — change it if you self-host.

## License

AGPL-3.0-or-later — see [LICENSE](./LICENSE) (and the root README for the §13 network clause).
