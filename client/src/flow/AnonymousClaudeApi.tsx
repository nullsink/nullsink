import { Layout } from "../Layout.tsx";
import { Ns } from "../ui.tsx";

// SEO landing (route /anonymous-claude-api): captures "anonymous Claude API" / "Claude API without
// account". A real explainer (how the proxy solves it, the 3 steps, what we don't keep), not a doorway —
// funnels to /start. "private", not "anonymous to everyone" — don't overclaim. Claims mirror the proxy
// contract (no account, key hashed in-browser, prepaid crypto, no request logs); prerenders, reads JS-off.
export function AnonymousClaudeApi() {
  return (
    <Layout>
      <section className="section">
        <h1 className="page-h1">use the Claude API without an account</h1>
        <p className="section-copy">
          <Ns /> is a proxy to Anthropic&apos;s Claude API. You mint a prepaid key in your own browser, fund
          it with cryptocurrency, and point the stock Anthropic SDK at one base URL. There is no sign-up, no
          email, no card, and no dashboard. The key is the whole account.
        </p>
      </section>

      <section className="section">
        <h2>how it works</h2>
        <ul className="dash-list">
          <li>
            <span className="lead-term">mint a key</span> — your browser generates it and shows it once;{" "}
            <span className="hl">only a hash of it ever reaches us</span>.
          </li>
          <li>
            <span className="lead-term">fund it with crypto</span> — pay in Monero or Bitcoin (other coins
            via swap). The link between the payment and your key is dropped once the order settles.
          </li>
          <li>
            <span className="lead-term">point your SDK at <Ns /></span> — set the base URL and the key; the
            proxy speaks Anthropic&apos;s native Messages API, so official SDKs and Claude Code work
            unchanged.
          </li>
        </ul>
        <p className="section-copy">
          The proxy strips your key from each request and adds ours, so Anthropic never sees your token. The
          models you can call are on <a href="/models/">supported models</a>.
        </p>
      </section>

      <section className="section">
        <h2>what we don&apos;t collect</h2>
        <ul className="dash-list">
          <li><span className="lead-term">no account</span> — no email, name, phone, or card</li>
          <li><span className="lead-term">your IP</span> — never logged</li>
          <li><span className="lead-term">your prompts and responses</span> — forwarded, never stored</li>
          <li><span className="lead-term">request logs</span> — none</li>
        </ul>
        <p className="section-copy">
          This makes your Claude usage private, not invisible. Your requests still reach Anthropic to be
          answered, and crypto networks are public. No record ties you to what you asked. The full account is
          in the <a href="/privacy/">privacy policy</a>.
        </p>
      </section>

      <section className="section">
        <h2>start</h2>
        <p className="section-copy">
          Base URLs and copy-paste examples are on{" "}
          <a href="/start/">get started</a>.
        </p>
      </section>
    </Layout>
  );
}
