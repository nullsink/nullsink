import { MoneroMark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The selected pay-rail button (.seg.coins .on) from the amount step: the mark is currentColor,
// so it takes the ink-on-acid of its selected segment (AmountStep.tsx).
export const SelectedRail = () => (
  <Void>
    <div className="seg coins">
      <button type="button" className="on" aria-pressed="true">
        <MoneroMark className="coin-mark" />
        <span className="coin-name">monero</span>
        <span className="coin-tic">XMR</span>
      </button>
    </div>
  </Void>
);

// The same button unselected: the mark drops to the segment's muted mono ink.
export const UnselectedRail = () => (
  <Void>
    <div className="seg coins">
      <button type="button" aria-pressed="false">
        <MoneroMark className="coin-mark" />
        <span className="coin-name">monero</span>
        <span className="coin-tic">XMR</span>
      </button>
    </div>
  </Void>
);
