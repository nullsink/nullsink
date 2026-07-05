import { RateSource } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The attribution fragment inside the muted caption the app uses (.pay-meta), for the XMR quote.
export const Xmr = () => (
  <Void>
    <p className="pay-meta">
      <RateSource unit="XMR" />
    </p>
  </Void>
);

// Same caption for the BTC rail — the unit follows the quote's coin, never hard-coded.
export const Btc = () => (
  <Void>
    <p className="pay-meta">
      <RateSource unit="BTC" />
    </p>
  </Void>
);
