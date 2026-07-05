import { CoinMark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The full pay-rail picker from the amount step — CoinMark resolves each glyph by its server rail
// name ("monero" selected, "bitcoin" idle), under the "pay with" label (AmountStep.tsx verbatim).
export const PayRailPicker = () => (
  <Void>
    <div className="coin-pick">
      <div className="custom-label" id="pay-with-label">pay with</div>
      <div className="seg coins" role="group" aria-labelledby="pay-with-label">
        <button type="button" className="on" aria-pressed="true">
          <CoinMark name="monero" className="coin-mark" />
          <span className="coin-name">monero</span>
          <span className="coin-tic">XMR</span>
        </button>
        <button type="button" aria-pressed="false">
          <CoinMark name="bitcoin" className="coin-mark" />
          <span className="coin-name">bitcoin</span>
          <span className="coin-tic">BTC</span>
        </button>
      </div>
      <p className="coin-desc">private on-chain · confirms in ~20-45 min</p>
    </div>
  </Void>
);

// Documented fallback: an unknown rail (a future coin) renders no glyph — the button carries
// just its label and ticker, and the segment still lays out correctly.
export const UnknownRailNoGlyph = () => (
  <Void>
    <div className="seg coins">
      <button type="button" aria-pressed="false">
        <CoinMark name="zcash" className="coin-mark" />
        <span className="coin-name">zcash</span>
        <span className="coin-tic">ZEC</span>
      </button>
    </div>
  </Void>
);
