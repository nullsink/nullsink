import { SquareGlyph } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// Both variants side by side at a legible size (the glyph is 1em, so the parent fontSize scales it).
// Inks follow the app's tier headers: acid for frontier, --ns-seal for the sealed/TEE mark.
export const Variants = () => (
  <Void>
    <div style={{ display: "flex", alignItems: "center", gap: 48, fontSize: 28 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
        <span style={{ color: "var(--ns-acid)", display: "inline-flex" }}>
          <SquareGlyph />
        </span>
        <span style={{ fontSize: 15, color: "var(--ns-bone)" }}>frontier — hairline</span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
        <span style={{ color: "var(--ns-seal)", display: "inline-flex" }}>
          <SquareGlyph sealed />
        </span>
        <span style={{ fontSize: 15, color: "var(--ns-bone)" }}>sealed — filled</span>
      </span>
    </div>
  </Void>
);

// In context at text size: the sealed mark trailing a model row, as /models and /api render it.
export const InlineBadge = () => (
  <Void>
    <p style={{ color: "var(--ns-bone)", margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
      deepseek-r1-0528 <span style={{ color: "var(--ns-seal)", display: "inline-flex", fontSize: 13 }}><SquareGlyph sealed /></span>
    </p>
  </Void>
);
