# nullsink — build conventions

Dark-first, mono-led, one accent used as a scalpel. The stylesheet closure already styles `body` (void background, bone text, IBM Plex Mono 15px) — build directly on it. Never introduce a white page container; surfaces stay `var(--ns-void)` with hairline borders.

## Setup
No provider or wrapper is needed. Components come from `window.Nullsink.*`. `Layout` is the page shell (header bar + nav + footer with the never-collect chips) — pass page content as children and use it for any full page.

## Styling idiom
Semantic CSS classes from the shipped stylesheet plus `var(--ns-*)` tokens. Style your own glue with these real names — don't invent utility classes:

- **Tokens**: `--ns-void` (bg), `--ns-bone` (text), `--ns-muted` / `--ns-faint` (secondary/tertiary), `--ns-line` (hairline borders), `--ns-acid` (THE accent), `--ns-red` (danger), `--ns-seal` (sealed-enclave semantic only), `--ns-font-mono`, `--ns-weight-display` (600), `--ns-tracking-display`.
- **Page scaffolding**: `.section` (40px stack rhythm; direct-child `h2` gets the 22px display treatment), `.page-h1`, `.flow-h1`, `.hero`.
- **Emphasis**: `.hl` — acid highlighter block behind ink text, the signature mark; reserve for short words. `.hl.danger` variant (red) ONLY for what can cost money. Plain acid text = status, never an action.
- **Actions**: `.btn-primary` (acid fill, full-width CTA), `.copy` (quiet bordered micro-button; add `.acid` when copy is the primary action), `.seg` (segmented control; `button.on` gets the acid fill).
- **Supporting text**: `.hint` (13px muted), `.notice` (acid left-rail strip), `.note` (marker + text row).
- **Micro-labels**: 11–12px, `text-transform: uppercase`, `letter-spacing: 0.05em`, muted — see `.copy`, `.field-label`, `.keyfield-head` for the pattern.

Rules of the look: corners are square (the only radii are round status dots); no shadows — structure comes from single hairlines (`1px solid var(--ns-line)`); acid appears once or twice per view; red only beside money-loss warnings.

## Where the truth lives
Read `styles.css` and its imports before styling: `tokens/tokens.css` (the full `--ns-*` palette with usage comments) and `_ds_bundle.css` (every class above plus page-level compositions — `.pcard` provider cards, `.tier` trust tiers, `.kvrow` reference rows, `.ep` endpoint rows, `.nots` never-collect chips). Per-component usage: `components/<group>/<Name>/<Name>.prompt.md`.

## Idiomatic example
```jsx
const { Layout, CodeBlock, Ns, Copy } = window.Nullsink;

<Layout nav="api">
  <section className="section">
    <h2>point your SDK at <Ns /></h2>
    <p className="hint">prepaid, anonymous — the key is the whole account.</p>
    <CodeBlock
      label="request headers"
      code={"x-api-key: 0sink_YOUR_KEY"}
      highlights={["0sink_YOUR_KEY"]}
    />
    <button className="btn-primary">get a key</button>
  </section>
</Layout>
```
