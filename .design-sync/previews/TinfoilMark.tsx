import { TinfoilMark } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The /models provider card head, sealed variant: Tinfoil is the enclave provider, so the card
// rail takes the purple seal instead of acid (.pcard.sealed).
export const SealedModelsCard = () => (
  <Void>
    <div className="pcard sealed">
      <div className="pcard-rail" aria-hidden="true" />
      <div className="pcard-body">
        <div className="pcard-head">
          <TinfoilMark className="pcard-logo" />
          <div className="pcard-name">
            <h3 className="pcard-title">Tinfoil</h3>
            <span className="pcard-count">6 models</span>
          </div>
        </div>
      </div>
    </div>
  </Void>
);

// The /api coin: Tinfoil's .ep-disc takes the sealed (purple) ring, not acid — the enclave
// treatment Api.tsx gives it on the openai-compatible rail head.
export const SealedApiCoin = () => (
  <Void>
    <div className="rail-head">
      <span className="ep-coins" aria-hidden="true">
        <span className="ep-disc sealed">
          <TinfoilMark className="ep-ico" />
        </span>
      </span>
      <span className="rail-name">sealed enclave</span>
    </div>
  </Void>
);
