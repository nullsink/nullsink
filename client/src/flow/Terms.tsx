import { EXT } from "../lib/links.ts";

// The policy / warning label, kept light: a left acid rail (the only frame) beside a small "terms" header
// and a plain dash list, no box. ONLY the two non-recoverable warnings (no refunds; lose the key, lose the
// balance) are highlighted (.hl.danger) — a warning label where every line shouts is a label where nothing
// does, so the rest stay plain with an acid lead-in (.lead-term.acid) on the two you can't undo.
export function Terms() {
  return (
    <div className="terms">
      <div className="terms-rail" aria-hidden="true" />
      <div className="terms-body">
        <div className="terms-head">terms</div>
        <ul className="terms-list">
          <li>
            <span className="hl danger">Refunds aren&apos;t possible</span>; payment is final.
          </li>
          <li>
            <span className="lead-term acid">Credit is for API use only</span>; it can&apos;t be cashed out or
            transferred.
          </li>
          <li>
            Each address is single-use;{" "}
            <span className="lead-term acid">pay the full amount in one transaction</span>.
          </li>
          <li>
            <span className="hl danger">Lose your key and the credit is gone</span>.
          </li>
          <li>Payments typically confirm in 20–45 minutes, depending on the coin.</li>
        </ul>
        <p className="terms-full">
          Summary only — the full{" "}
          <a href="/terms/" {...EXT}>
            terms of service
          </a>{" "}
          apply.
        </p>
      </div>
    </div>
  );
}
