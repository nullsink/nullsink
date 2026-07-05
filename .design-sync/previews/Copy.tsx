import { Copy } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The bordered default — the standard copy control beside a value (endpoint rows, amounts).
export const Default = () => (
  <Void>
    <Copy value="https://nullsink.is" />
  </Void>
);

// The filled (acid) variant — copy as the primary action, as in the key cell.
export const Filled = () => (
  <Void>
    <Copy value="0sink_Zx4bQm9TfWnK3pLcYh8dRvA2sJgE6uNqB1oXaP7iyC5tkDw9e" filled />
  </Void>
);

// A custom label for context-specific copies.
export const CustomLabel = () => (
  <Void>
    <Copy value="claude-opus-4-8" label="copy id" />
  </Void>
);
