import { KeyBlock } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The one key component, in its default masked state (last 4 shown; show/hide and the acid
// copy control are live). Token shape matches the real mint: 0sink_ + 43 base64url chars + checksum.
export const Masked = () => (
  <Void>
    <KeyBlock token="0sink_Zx4bQm9TfWnK3pLcYh8dRvA2sJgE6uNqB1oXaP7iyC5tkDw9e" />
  </Void>
);
