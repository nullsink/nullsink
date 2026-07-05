import { ExtMark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The glyph has no intrinsic size — the app sizes it with .title-ext (0.78em square, acid, revealed
// on hover of the provider-name link on /models). A static capture can't hover, so this scoped rule
// forces the hover-revealed opacity for the screenshot; everything else is the app's own CSS.
const ForceVisible = () => (
  <style>{`
    .ds-force .title-ext { opacity: 1; }
    /* mirrors the app's .pcard.sealed .title-ext rule without dragging in the card chrome */
    .ds-force .sealed-ctx .title-ext { color: var(--ns-seal); }
  `}</style>
);

// As on /models: a provider-name link with the new-tab glyph beside it (.title-ext sizing, acid ink).
export const BesideProviderLink = () => (
  <Void>
    <ForceVisible />
    <div className="ds-force">
      <h3 className="pcard-title">
        <a href="https://www.anthropic.com" target="_blank" rel="noopener noreferrer">
          <span className="title-name">Anthropic</span>
          <ExtMark className="title-ext" />
        </a>
      </h3>
    </div>
  </Void>
);

// currentColor + em sizing: the same .title-ext glyph riding three text sizes, tinted by context.
export const ScalesWithText = () => (
  <Void>
    <ForceVisible />
    <div className="ds-force" style={{ display: "flex", alignItems: "baseline", gap: 28 }}>
      {/* no literal space before the glyph — .title-ext's own 0.9ch margin IS the gap (a space on top
          of it doubles the distance; the app composes name and glyph with nothing between). */}
      <span style={{ fontSize: 14 }}>
        github<ExtMark className="title-ext" />
      </span>
      <span style={{ fontSize: 20 }}>
        discord<ExtMark className="title-ext" />
      </span>
      {/* sealed providers swap the glyph to the seal accent (as .pcard.sealed does in the app). */}
      <span className="sealed-ctx" style={{ fontSize: 28, color: "var(--ns-seal)" }}>
        tinfoil<ExtMark className="title-ext" />
      </span>
    </div>
  </Void>
);
