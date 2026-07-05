# design-sync notes — nullsink

- The design system is app-embedded: 22 exports in `client/src/ui.tsx` + `Layout` in `client/src/Layout.tsx`. No library dist — the converter runs with `--entry ./client/src/ui.tsx` (esbuild bundles the .tsx directly) and `extraEntries: ["./src/Layout.tsx"]` merges the shell. All 23 components are pinned in `componentSrcMap`; a new export in ui.tsx must be added there.
- Groups come from `@category` tags in the leading JSDoc of each export (brand / providers / coins / ui / shell). The JSDoc blocks were converted from `//` comments specifically so the converter can read them — keep new components documented as `/** … @category <group> */`.
- Tokens: `tokensPkg: ".."` + `tokensGlob: "src/tokens.css"` is deliberate — `copyTokens` resolves `tokensPkg` against `client/node_modules`, so `..` lands on the client package itself (there is no separate tokens package). Don't "fix" it to a package name.
- Fonts: the app's `src/fonts.css` uses `url("@fontsource/...")` bare specifiers (Vite resolves them; the converter can't) and `font-display: optional` (first-paint optimization that can leave previews in fallback). `.design-sync/fonts.css` is the DS copy: relative node_modules paths + `font-display: swap`. If the app adds a weight, mirror it there.
- Dark-first vs white card chrome: the emitted card html hard-sets `body{background:#fff}` (product convention, `emit.mjs` is contract). Every authored preview wraps stories in a local `Void` div (`background: var(--ns-void)`, padding 20). New previews must do the same or they render bone-on-white.
- `bun install --frozen-lockfile` at repo root; react/react-dom land in `client/node_modules` (not the root) — that's what `--node-modules` must point at.
- Playwright: cached chromium builds live in `~/Library/Caches/ms-playwright` (1228 at last sync); `npm i playwright` into `.ds-sync/` matched it.
- `--ns-font-sans` was dropped from tokens.css at the 2026-07-05 sync (user decision: the app never referenced or shipped Plex Sans). If long-form sans body text ever lands, reintroduce the token AND ship the font.

## Preview-authoring facts (folded from wave 1)
- The SVG marks are size-less and colorless (`className` only, currentColor). Previews must borrow a real app class: `.wordmark .mark` (1.7cap — wrap in `<span className="wordmark" style={{fontSize:N}}>` to scale), `.pcard-logo` (26px bone), `.rm-logo` (22px muted, inside `.rm-row` which is 0.65 opacity BY DESIGN), `.ep-ico` inside `.ep-disc` (acid ring; `.ep-disc.sealed` = purple), `.coin-mark` (15px, inside `.seg.coins` buttons). A bare sized div does NOT stretch a viewBox-only svg.
- ExtMark's only sizing class `.title-ext` ships `opacity: 0` (hover-revealed); static captures need a scoped `.ds-force .title-ext { opacity: 1 }` style inside the preview.
- KvRow needs the `<dl className="kv">` wrapper; ModelChip rows wrap in `.model-chips`; RateSource needs the `.pay-meta` caption wrapper; Qr self-sizes via `.qr` (188px tile).
- Never use a bare `.coins` class (app CSS deliberately only styles `.seg.coins`).
- SquareGlyph scales via parent fontSize (1em); frontier = acid hairline, sealed = `--ns-seal` filled.

## Known render warns
- PulseMark's capture lands mid-animation (some squares faded) — one frame of the 2.2s loop, not a bug; don't grade it needs-work.
- (none recorded yet — first sync in progress)

## Re-sync risks
- `client/src/models.json` model ids are baked into authored previews (ModelChip, CodeBlock highlights); if the catalog rotates, previews still render but show stale ids — cosmetic, refresh opportunistically.
- `version.ts` is "dev" locally, so Wordmark's version chip reads "dev" in previews; release builds stamp a real tag. Expected.
- The `Void` wrapper duplicates into every preview file by design (no shared import — keeps files self-contained and subagent-editable).
