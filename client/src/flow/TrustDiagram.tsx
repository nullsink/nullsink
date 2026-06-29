import { PulseMark, SquareGlyph } from "../ui.tsx";

// The trust framing as a static you → nullsink → {proprietary | enclave} diagram (decorative, aria-hidden).
// EXTRACTED from /models and NOT currently rendered anywhere — parked here for a planned rework of the trust
// section. The .trust* styles in app.css still back it. Re-import + render when the section returns.
export function TrustDiagram() {
  return (
    <div className="trust">
      <div className="trust-path" aria-hidden="true">
        <span className="node">you</span>
        <span className="wire" />
        <span className="node sink">
          <PulseMark className="sink-mark" />
          <span className="node-cap">nullsink</span>
        </span>
        <span className="wire" />
        <span className="trust-branch">
          <span className="branch-row sealed">
            <span className="wire" />
            <span className="node sealed">
              <SquareGlyph sealed /> enclave · sealed
            </span>
          </span>
          <span className="branch-row">
            <span className="wire" />
            <span className="node">
              <SquareGlyph /> proprietary · receives plaintext
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}
