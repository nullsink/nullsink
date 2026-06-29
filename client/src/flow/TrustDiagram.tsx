import { PulseMark, SquareGlyph } from "../ui.tsx";

// The trust framing as a static you → nullsink → {sealed | closed source} diagram (decorative, aria-hidden):
// who can read your messages. Rendered on /models under the price note; the tier sections below carry the
// meaning. The .trust* styles (app.css) lay it out as a full-width band, wires flexing to fill the column.
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
              <SquareGlyph /> closed source · receives plaintext
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}
