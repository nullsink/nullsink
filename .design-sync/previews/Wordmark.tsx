import { Wordmark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The full lockup as the header renders it: pulsing mark, the name, and the build tag ("dev" locally).
export const Header = () => (
  <Void>
    <Wordmark />
  </Void>
);
