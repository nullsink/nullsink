import { Ns } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The brand name as a highlighter mark inside body text, as the prose pages use it.
export const InProse = () => (
  <Void>
    <p style={{ color: "var(--ns-bone)", maxWidth: 480, margin: 0 }}>
      <Ns /> is an API proxy for frontier and open-weight models. Buy a prepaid key here, then point
      your existing client at it — no account, no email, nothing to sign.
    </p>
  </Void>
);
