import { PulseMark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The pulsing brand mark at logo scale, sized the way the app does (.wordmark .mark = 1.7cap, acid).
// It animates on a 2.2s loop via .pulse-mark CSS — a screenshot catches one frame of the fade.
export const AcidPulse = () => (
  <Void>
    <span className="wordmark" style={{ fontSize: 56 }}>
      <PulseMark className="mark" />
    </span>
  </Void>
);

// At the header's real size (the .wordmark is 19px), where it lives in production.
export const HeaderSize = () => (
  <Void>
    <span className="wordmark">
      <PulseMark className="mark" />
    </span>
  </Void>
);
