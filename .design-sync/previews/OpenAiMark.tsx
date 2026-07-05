import { OpenAiMark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The /models provider card head: the mark at .pcard-logo size (26px, bone) beside the acid rail,
// title, and model count — exactly how Models.tsx composes it.
export const ModelsCard = () => (
  <Void>
    <div className="pcard">
      <div className="pcard-rail" aria-hidden="true" />
      <div className="pcard-body">
        <div className="pcard-head">
          <OpenAiMark className="pcard-logo" />
          <div className="pcard-name">
            <h3 className="pcard-title">OpenAI</h3>
            <span className="pcard-count">12 models</span>
          </div>
        </div>
      </div>
    </div>
  </Void>
);

// The /api rail head: the mark as a 12px .ep-ico inside the acid-ringed .ep-disc coin, beside
// the uppercase rail name — the page's signature accent (Api.tsx Coins + Rail).
export const ApiCoin = () => (
  <Void>
    <div className="rail-head">
      <span className="ep-coins" aria-hidden="true">
        <span className="ep-disc">
          <OpenAiMark className="ep-ico" />
        </span>
      </span>
      <span className="rail-name">openai-compatible</span>
    </div>
  </Void>
);
