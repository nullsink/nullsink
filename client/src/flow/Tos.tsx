import { Layout } from "../Layout.tsx";
import { Ns } from "../ui.tsx";
import { EXT } from "../lib/links.ts";
import { MARKUP_PCT } from "../lib/api.ts";

// The full Terms of Service. The short in-page box on the landing page (flow/Terms.tsx) is the
// point-of-sale summary; THIS is the binding contract it summarises. Like the privacy policy, every
// statement must stay true to the system: bearer credit (a key is whoever holds it; only the hash is
// stored), Monero or Bitcoin + proportional crediting (core/src/handler.ts + core/src/ledger/settle.ts), no refunds, no key recovery,
// experimental with low limits, and AI output produced by third-party providers under THEIR policies.
//
// Two things are deliberately left for the operator to finalise before this is relied upon in production:
//   - §16 Governing law and disputes — the jurisdiction is a real decision.
//   - A lawyer in the operating jurisdiction should review the liability + warranty + governing-law clauses.
// Static content: prerenders to plain HTML, reads with JS off, no third-party origin (CSP-clean).
export function Tos() {
  return (
    <Layout>
      <section className="legal">
        <h1 className="legal-h1">Terms of service</h1>
        <p className="legal-updated">
          Last updated: <time dateTime="2026-07-14">14 July 2026</time>
        </p>

        <p className="legal-lead">
          These are the terms for using <Ns />. The service is experimental and deliberately minimal, and
          these terms reflect that: prepaid credit bought with Monero or Bitcoin, no accounts, no refunds, and no
          recovery if you lose your key. By using the service you agree to them.
        </p>

        <h2>1. Agreement to these terms</h2>
        <p>
          By accessing or using the service (the &quot;service&quot;), you agree to these terms of service
          (the &quot;terms&quot;). If you do not agree, do not use the service. These terms incorporate our{" "}
          <a href="/privacy/">Privacy Policy</a>, and your use of the underlying AI models is also subject to
          the policies of the providers we route to (see section 9). Where a provider&apos;s policy conflicts
          with these terms as to the use of that provider&apos;s models, the provider&apos;s policy governs
          that use.
        </p>

        <h2>2. Who we are</h2>
        <p>
          The service is a prepaid gateway to third-party large language model (LLM) APIs, operated by an
          independent operator (the &quot;nullsink operator&quot;, &quot;we&quot;, &quot;us&quot;). There is
          no company behind the service at this time. You can reach us at{" "}
          <a href="mailto:admin@nullsink.is">admin@nullsink.is</a>.
        </p>

        <h2>3. Eligibility</h2>
        <p>
          You must be at least 18 years old, or the age of majority where you live if that is higher, and
          able to form a binding contract. You must not be a person that applicable sanctions or
          export-control laws prohibit us from dealing with, and you must not be located in an embargoed
          country or territory (see section 12). By using the service you represent that you meet these
          requirements.
        </p>

        <h2>4. The service</h2>
        <p>
          The service lets you buy prepaid credit and spend it on requests to supported third-party LLM
          APIs, metered at the upstream per-token cost plus our margin. It is provider-agnostic: one key can
          spend on any supported provider. It is intentionally stateless: we issue no accounts, hold no
          identity, and keep no access logs or prompt/response logs. Content-minimized exceptional events are
          retained only as described in the Privacy Policy. We never carry out identity verification or know-your-customer
          (KYC) checks, and never will: there is no account and nothing to verify. Purchase and usage limits
          are kept low while the service is experimental and may change over time. The service is provided for
          your own lawful use.
        </p>

        <h2>5. Your key and your balance</h2>
        <p>
          Self-serve keys are generated in your browser (or locally by the buyer CLI). An optional manual
          issuance tool can mint a break-glass key on the service box and display it once. We receive a key
          when you authenticate, hash it in-process, and store only its hash together with a balance. Because of this:
        </p>
        <ul>
          <li>
            <span className="lead-term">A key is bearer credit.</span> Anyone who holds it can spend its
            balance. Treat it like cash and keep it secret.
          </li>
          <li>
            <span className="lead-term">You alone safeguard it.</span> We cannot recover, reset, transfer,
            or reissue a key, and we cannot identify who holds one.
          </li>
          <li>
            <span className="lead-term">Lose the key and the credit is gone.</span> There is no recovery
            path and no refund.
          </li>
          <li>
            <span className="lead-term">We may decline further credit.</span> Where we reasonably believe a
            key is tied to a breach of these terms (see section 8), we may refuse to serve it or to apply
            further credit, without refund.
          </li>
        </ul>

        <h2>6. Payment, pricing, and our margin</h2>
        <p>Payment is accepted in Monero (XMR) or Bitcoin (BTC), to a single-use address quoted at the time of purchase. You choose the coin at checkout.</p>
        <ul>
          <li>Pay the full quoted amount in a single transaction. Each address is single-use.</li>
          <li>
            We apply credit in proportion to the coin actually received against the quote: underpayment
            credits less, overpayment credits more.
          </li>
          <li>
            If you pay in another cryptocurrency, the swap to your chosen coin is performed by a third party
            under its own rates, fees, and terms; we only ever receive, and credit, the coin that arrives.
          </li>
          <li>
            The price includes our margin (currently about {MARKUP_PCT}%), shown in the quote. The exchange rate and
            the credit are locked when the quote is issued and are not re-fetched when your payment arrives.
          </li>
          <li>
            A quote is valid only for the window shown in it. Payments typically confirm in about 20–45
            minutes.
          </li>
          <li>We do not control the Monero or Bitcoin networks, exchange rates, or confirmation times.</li>
        </ul>

        <h2>7. No refunds</h2>
        <p>
          All payments are final, and crypto payments cannot be reversed. We do not offer refunds. We
          may, at our sole discretion and without obligation, correct a crediting error; apart from that, no
          payment, credit, or unused balance is refundable, including if you lose your key, if your access
          is stopped for a breach of these terms, or if the service is discontinued (see section 10).
        </p>

        <h2>8. Acceptable use</h2>
        <p>You agree not to use the service to:</p>
        <ul>
          <li>break any applicable law, or infringe or misappropriate anyone&apos;s rights;</li>
          <li>
            generate, solicit, or distribute material that sexually exploits or endangers minors, or any
            other content prohibited by the providers we route to;
          </li>
          <li>create malware, mount attacks, commit fraud, send spam, or help anyone do these;</li>
          <li>
            attempt to deanonymise, overload, probe, or interfere with the service, its infrastructure, or
            other users, or to circumvent its billing, rate, or security controls;
          </li>
          <li>
            resell or use the service in a way that breaks the upstream providers&apos; usage policies
            (section 9).
          </li>
        </ul>
        <p>
          You are responsible for the content you submit and for what you do with the output. We may refuse,
          suspend, or terminate access for any breach, or where we reasonably believe the service is being
          used to cause harm, without notice and without refund.
        </p>

        <h2>9. Third-party AI providers</h2>
        <p>
          Requests are fulfilled by third-party providers (currently Anthropic, OpenAI when enabled, and
          Tinfoil when enabled).
          Your use of their models is also governed by their usage policies, incorporated here by reference:{" "}
          <a href="https://www.anthropic.com/legal/aup" {...EXT}>
            Anthropic
          </a>
          ,{" "}
          <a href="https://openai.com/policies/usage-policies" {...EXT}>
            OpenAI
          </a>
          ,{" "}
          <a href="https://tinfoil.sh/terms" {...EXT}>
            Tinfoil
          </a>
          . Output is generated by these AI models. It may be inaccurate, incomplete, offensive, or
          otherwise unsuitable, and it is provided without warranty. You are responsible for reviewing
          output before relying on it and for any use you make of it. We do not control these providers and
          are not responsible for their availability, content policies, or decisions, any of which may
          change or interrupt the service.
        </p>

        <h2>10. Availability, changes, and discontinuation</h2>
        <p>
          The service is experimental and is provided on an &quot;as is&quot; and &quot;as available&quot;
          basis, with no service-level commitment and no guarantee of uptime, capacity, or continuity. We
          may change, limit, suspend, or discontinue any part of it at any time, with or without notice.
          Balances do not expire under normal operation, but the service may be reduced or shut down, and if
          that happens any unused balance may be lost and will not be refunded. Do not pre-load more credit
          than you are prepared to lose.
        </p>

        <h2>11. Disclaimer of warranties</h2>
        <p>
          To the fullest extent permitted by law, the service is provided without warranties of any kind,
          whether express, implied, or statutory, including any implied warranties of merchantability,
          fitness for a particular purpose, title, non-infringement, accuracy, or that the service will be
          uninterrupted, secure, or error-free. Some jurisdictions do not allow the exclusion of certain
          warranties, so some of these exclusions may not apply to you.
        </p>

        <h2>12. Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, we will not be liable for any indirect, incidental,
          special, consequential, exemplary, or punitive damages, or for any loss of profits, data, credit,
          or goodwill, arising out of or relating to your use of (or inability to use) the service, even if
          we were advised of the possibility. To the fullest extent permitted by law, our total aggregate
          liability for all claims relating to the service will not exceed the total amount you paid to us in
          the three (3) months before the event giving rise to the claim. Some jurisdictions do not allow
          certain limitations, so some of these may not apply to you, and nothing in these terms limits
          liability that cannot be limited by law.
        </p>

        <h2>13. Sanctions and export</h2>
        <p>
          You represent that you are not subject to applicable sanctions and are not located in an embargoed
          jurisdiction, and you agree not to use the service in breach of any export-control or sanctions
          laws. We may refuse or end access where we believe in good faith that providing it would breach
          such laws.
        </p>

        <h2>14. Indemnification</h2>
        <p>
          You agree to indemnify and hold harmless the nullsink operator from any claim, loss, or expense
          (including reasonable legal fees) arising out of your use of the service, your content, or your
          breach of these terms or of any applicable law or provider policy.
        </p>

        <h2>15. Intellectual property</h2>
        <p>
          The service, the nullsink name, and the site&apos;s design are ours or our licensors&apos;. These
          terms grant you no rights in them beyond using the service as intended. As between you and us, you
          keep whatever rights you have in the inputs you submit and the outputs you receive, subject to the
          providers&apos; terms; we claim no ownership of them and, consistent with our Privacy Policy, do
          not retain them.
        </p>

        <h2>16. Governing law and disputes</h2>
        <p>
          Before bringing any formal dispute, you agree to contact us at{" "}
          <a href="mailto:admin@nullsink.is">admin@nullsink.is</a> and try in good faith to resolve it
          informally. These terms are governed by the laws of the operating jurisdiction of the nullsink
          operator, without regard to its conflict-of-laws rules, and the courts of that place have
          exclusive jurisdiction, except that nothing here removes any mandatory protection available to you
          as a consumer under the law of your country of residence.
        </p>

        <h2>17. Changes to these terms</h2>
        <p>
          We may update these terms as the service changes. The &quot;last updated&quot; date above reflects
          the current version, and any material change will be posted on this page. By continuing to use the
          service after a change takes effect, you accept the updated terms.
        </p>

        <h2>18. General</h2>
        <p>
          If any provision of these terms is held unenforceable, the rest remain in effect. Our not
          enforcing a provision is not a waiver of it. You may not assign these terms; we may assign them in
          connection with a transfer of the service. These terms, together with the Privacy Policy and the
          incorporated provider policies, are the entire agreement between you and us about the service.
        </p>

        <h2>19. Contact</h2>
        <p>
          Questions about these terms, and abuse reports:{" "}
          <a href="mailto:admin@nullsink.is">admin@nullsink.is</a>. Security reports: see{" "}
          <a href="/.well-known/security.txt" {...EXT}>
            /.well-known/security.txt
          </a>
          .
        </p>
      </section>
    </Layout>
  );
}
