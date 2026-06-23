import { Layout } from "../Layout.tsx";
import { Ns } from "../ui.tsx";

// SEO landing (route /openai-api-no-phone): captures "OpenAI API without phone number" / "OpenAI API no
// credit card" (OpenAI's own sign-up requires a phone + a card on file). A real explainer (how the proxy
// solves it, the 3 steps, what we don't keep), not a doorway — CTA to /start. Honest, not absolute —
// don't overclaim. Claims mirror the proxy contract (no account, prepaid crypto, key hashed in-browser,
// OpenAI "do not store" forced on); prerenders, reads JS-off.
export function OpenAiApiNoPhone() {
  return (
    <Layout>
      <section className="section">
        <h1 className="page-h1">use the OpenAI API without a phone number</h1>
        <p className="section-copy">
          <Ns /> is a proxy to the OpenAI API. You mint a prepaid key in your browser, fund it with
          cryptocurrency, and point the stock OpenAI SDK at one base URL. There&apos;s no sign-up, so no
          phone verification, no SMS code, and no card on file. The key is the whole account.
        </p>
      </section>

      <section className="section">
        <h2>how it works</h2>
        <ul className="dash-list">
          <li>
            <span className="lead-term">mint a key</span> — your browser generates it and shows it once;{" "}
            <span className="hl">only a hash of it ever reaches us</span>. No phone, no email.
          </li>
          <li>
            <span className="lead-term">fund it with crypto</span> — pay in Monero or Bitcoin (other coins
            via swap) instead of a card. The payment is unlinked from your key once the order settles.
          </li>
          <li>
            <span className="lead-term">point your SDK at <Ns /></span> — set the base URL and the key; the
            proxy serves OpenAI&apos;s native Chat Completions and Responses APIs, so the official SDKs work
            unchanged.
          </li>
        </ul>
        <p className="section-copy">
          The proxy swaps your key for ours, so OpenAI never sees your token. The request lifecycle is in{" "}
          <a href="/how-it-works/">how it works</a>; the models you can call are on{" "}
          <a href="/models/">supported models</a>.
        </p>
      </section>

      <section className="section">
        <h2>what we don&apos;t collect</h2>
        <ul className="dash-list">
          <li><span className="lead-term">no account</span> — no phone, email, name, or card</li>
          <li><span className="lead-term">your IP</span> — never logged</li>
          <li><span className="lead-term">your prompts and responses</span> — forwarded, never stored</li>
          <li><span className="lead-term">request logs</span> — none</li>
        </ul>
        <p className="section-copy">
          OpenAI retains prompts by default. The proxy sets the &quot;do not store&quot; flag, so OpenAI
          keeps no prompt or output. This makes your usage private, not invisible. Your requests still reach
          OpenAI to be answered. The full account is in the <a href="/privacy/">privacy policy</a>.
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
