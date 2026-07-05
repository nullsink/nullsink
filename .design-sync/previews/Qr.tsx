import { Qr } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The payment QR as QuotePay renders it: a monero: pay URI (address + amount), .qr sizing it to a
// 188px bordered tile on the void.
export const MoneroPayUri = () => (
  <Void>
    <Qr data="monero:888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ88J3X78richKRBuf7dyMta9pdbUCFhoG5FavZuAtPeH?tx_amount=0.847" />
  </Void>
);

// The BTC rail's equivalent: a bitcoin: URI with a bech32 address and amount.
export const BitcoinPayUri = () => (
  <Void>
    <Qr data="bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh?amount=0.00214" />
  </Void>
);
