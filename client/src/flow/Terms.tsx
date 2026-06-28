// The policy / warning label, styled after the /models provider cards: a hairline card with a left accent
// rail and a label/tagline head. ONLY the two non-recoverable warnings (no refunds; lose the key, lose the
// balance) are highlighted (.hl.danger) — a warning label where every line shouts is a label where nothing
// does, so the rest stay plain with an acid lead-in (.lead-term.acid) on the two you can't undo.
export function Terms() {
  return (
    <div className="terms">
      <div className="terms-rail" aria-hidden="true" />
      <div className="terms-body">
        <div className="terms-head">
          <span className="terms-label">terms</span>
          <span className="terms-tag">the fine print</span>
        </div>
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
      </div>
    </div>
  );
}
