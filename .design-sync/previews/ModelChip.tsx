import { ModelChip } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// One copy-on-click id chip, as it sits in a /models provider card.
export const Default = () => (
  <Void>
    <div className="model-chips">
      <ModelChip id="claude-opus-4-8" />
    </div>
  </Void>
);

// The danger register: an id the proxy prices but the upstream currently 404s — red tag, red-tinted
// border, still copyable.
export const Down = () => (
  <Void>
    <div className="model-chips">
      <ModelChip id="gpt-5.5-pro" down />
    </div>
  </Void>
);

// A provider card's chip row (.model-chips wrap) the way /models composes it, one id down.
export const Row = () => (
  <Void>
    <div className="model-chips">
      <ModelChip id="claude-opus-4-8" />
      <ModelChip id="claude-haiku-4-5" />
      <ModelChip id="claude-fable-5" />
      <ModelChip id="gpt-5.5" />
      <ModelChip id="gpt-5.5-pro" down />
    </div>
  </Void>
);
