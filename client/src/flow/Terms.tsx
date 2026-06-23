// The policy / warning label: an acid-bordered box with a plain bullet list (not a table). ONLY the two
// non-recoverable warnings (no refunds; lose the key, lose the balance) are highlighted (.hl.danger) — a
// warning label where every line shouts is a label where nothing does, so the rest stay plain with a
// bold lead-in (.lead-term).
export function Terms() {
  return (
    <div className="terms">
      <div className="terms-head">terms</div>
      <ul className="terms-list">
        <li>
          <span className="hl danger">Refunds aren&apos;t possible</span>; payment is final.
        </li>
        <li>
          <span className="lead-term">Credit is for API use only</span>; it can&apos;t be cashed out or
          transferred.
        </li>
        <li>
          Each address is single-use; <span className="lead-term">pay the full amount in one transaction</span>.
        </li>
        <li>
          <span className="hl danger">Lose your key and the credit is gone</span>.
        </li>
        <li>Payments typically confirm in 20–45 minutes, depending on the coin.</li>
      </ul>
    </div>
  );
}
