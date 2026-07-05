import { PrivatemodeMark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The /models roadmap row — where Privatemode lives in the app today: the mark at .rm-logo size
// (22px, muted) beside its name and meta line, the whole row dimmed (Models.tsx ROADMAP).
export const RoadmapRow = () => (
  <Void>
    <div className="rm-row">
      <PrivatemodeMark className="rm-logo" />
      <div className="rm-name">
        <span className="rm-title">Privatemode AI</span>
        <span className="rm-meta">sealed · open weight</span>
      </div>
    </div>
  </Void>
);
