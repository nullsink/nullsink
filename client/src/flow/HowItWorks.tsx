import { Layout } from "../Layout.tsx";
import { MARKUP_PCT } from "../lib/api.ts";

// "how it works" — the trust bridge (route /how-it-works): a plain-language walk through the system.
// Kept deliberately NON-internal: no wallet / subaddress / atomic-debit / store-flag jargon — just
// user-visible guarantees, scannable (short paras + bullets). Payment is "crypto" (Monero or Bitcoin,
// other coins via swap), NOT coin-specific — the buy flow carries the per-coin detail. NO open-source /
// "mirrors the code" claims on this page (owner direction). Every claim still
// mirrors the proxy's contract (core/src/handler.ts,
// src/ledger/settle.ts, src/ledger/db.ts, src/log.ts); guardrails: the hold is a sound upper bound (only
// the FINAL bill is exact); we forward prompts but don't store them ("don't keep", never "can't see");
// the payment↔key link is dropped at settlement.
// Static: prerenders, reads with JS off.
export function HowItWorks() {
  return (
    <Layout>
      <section className="section">
        <h1 className="page-h1">how it works</h1>
      </section>

      <section className="section">
        <h2>the key is the account</h2>
        <p className="section-copy">
          Your key is minted in your browser; <span className="hl">only a hash of it ever reaches us</span>.
          We store that hash and a balance. No name, email, or card. Lose it and there&apos;s nothing to
          recover, so save it.
        </p>
      </section>

      <section className="section">
        <h2>buying credit</h2>
        <p className="section-copy">
          You pay with crypto. Once it confirms, your key is credited for what you sent, at the rate you
          were quoted. The link between your payment and your key is dropped once the order settles.
        </p>
      </section>

      <section className="section">
        <h2>making a request</h2>
        <p className="section-copy">
          Point any Anthropic or OpenAI SDK at one URL. Every request reaches the provider under our account,
          not yours, so nothing in it ties back to you. Requests keep each provider&apos;s normal format;
          setup is on <a href="/start/">get started</a>.
        </p>
      </section>

      <section className="section">
        <h2>how billing works</h2>
        <p className="section-copy">
          You pay the provider&apos;s exact per-token rate. The ~{MARKUP_PCT}% markup is paid once, when you buy credit.
        </p>
        <ul className="dash-list">
          <li>
            <span className="lead-term">Held up front, refunded to actual usage.</span> Each request reserves
            the most it could cost, then refunds the rest. Your balance can&apos;t go negative.
          </li>
          <li>
            <span className="lead-term">Errors cost nothing.</span> A failed or rejected request refunds in full.
          </li>
          <li>
            <span className="lead-term">Streaming is billed exactly.</span> Disconnect mid-stream and you
            pay only for what was generated.
          </li>
        </ul>
      </section>

      <section className="section">
        <h2>what we don&apos;t keep</h2>
        <ul className="dash-list">
          <li><span className="lead-term">your IP</span> — never logged</li>
          <li><span className="lead-term">your prompts and responses</span> — forwarded, never stored</li>
          <li><span className="lead-term">request logs</span> — none</li>
        </ul>
        <p className="section-copy">
          OpenAI keeps prompts by default. We turn that off. The full account is in the{" "}
          <a href="/privacy/">privacy policy</a>.
        </p>
      </section>

      <section className="section">
        <h2>what we reject</h2>
        <p className="section-copy">Some requests are refused before we send them, so they cost nothing:</p>
        <ul className="dash-list">
          <li>no max-output-tokens set</li>
          <li>a model we don&apos;t price, or sent to the wrong endpoint</li>
          <li>premium or usage-priced features — server-side tools, audio, non-standard tiers</li>
        </ul>
        <p className="section-copy">
          Premium features are <span className="hl">off by default</span>; your own tools work normally.
          We&apos;ll add support for more of them over time.
        </p>
      </section>
    </Layout>
  );
}
