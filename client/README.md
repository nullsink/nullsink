# Client workspace

`client/` is the React purchase site. It mints tokens in the browser and prerenders every public route to
self-contained static HTML. The production build loads no CDN resources and works without JavaScript except
for interactive actions such as minting, copying, and polling.

See the [root README](../README.md) for repository-wide setup.

## Which command should I run?

Run these from `client/` after one repository-root `bun install`.

| Command | Result |
| --- | --- |
| `bun run dev` | Start Vite and proxy API routes to local core services |
| `bun run dev:mock` | Start the UI with the in-process mock backend |
| `bun run build` | Typecheck, bundle, and prerender `dist/` |
| `bun run preview` | Serve the built static site |
| `bun run sync:models` | Regenerate `src/models.json` from the core price catalog |
| `bun run typecheck` | Check the app and tests with TypeScript |
| `bun test` | Run the happy-dom/testing-library suite |

The normal development proxy expects payments on `127.0.0.1:8081` and the metered proxy on
`127.0.0.1:8080`.

## Where does each client concern live?

```text
index.html          document shell and prerender head markers
vite.config.ts      development proxies, mock selection, and build policy
prerender.tsx       one static HTML output per route
sync-models.ts      core price catalog -> src/models.json
dev-mock.ts         development-only backend

src/
  routes.tsx        route metadata shared by prerender and browser entry
  App.tsx           landing and purchase page
  Layout.tsx        shared header and footer
  flow/             public pages and purchase flow
  lib/              API client, token minting, links, and QR generation
  models.json       committed model snapshot rendered by /models
```

## What must stay synchronized with core?

- `src/lib/api.ts` and `src/lib/token.ts` import pure modules from `core/src/` so purchase markup and token
  validation cannot drift.
- Regenerate and commit `src/models.json` whenever the core price catalog changes.
- `routes.tsx` is the source for both prerendering and browser hydration; there is no client router.
- Keep the `<!-- route:head:start/end -->` markers in `index.html`; the prerender build requires them.
- The production origin is explicit in `src/routes.tsx`; self-hosted forks must change it.

## What license applies?

AGPL-3.0-or-later; see the repository [LICENSE](../LICENSE) and the network-use note in the
[root README](../README.md#what-license-and-contribution-rules-apply).
