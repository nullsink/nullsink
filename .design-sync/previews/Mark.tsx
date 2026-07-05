import { Mark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The mark has no intrinsic size — the app sizes it via `.wordmark .mark` (1.7cap, acid).
// A large fontSize on the .wordmark context scales it up to logo scale.
export const AcidLogo = () => (
  <Void>
    <span className="wordmark" style={{ fontSize: 56 }}>
      <Mark className="mark" />
    </span>
  </Void>
);

// The small icon sizes the app uses elsewhere: .pcard-logo (26px, bone) and .rm-logo (22px, muted).
export const BoneIcons = () => (
  <Void>
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      <Mark className="pcard-logo" />
      <Mark className="rm-logo" />
    </div>
  </Void>
);
