import { Layout } from "../Layout.tsx";
import { Ns } from "../ui.tsx";
import { EXT } from "../lib/links.ts";

// The privacy policy. A formal, prose policy (numbered sections) rendered in the legal-page style. The
// claims here are NOT marketing — they are what the system actually does, so every statement must stay true
// to the code: token hashed in-browser (lib/token.ts), only the hash stored (core/src/ledger/db.ts), no IP at the edge
// or app (Caddyfile strips X-Forwarded-For, keeps no access log), no request logs (core/src/log.ts privacy
// invariant), prompts forwarded to the upstream provider (core/src/handler.ts). If the behaviour changes, change
// this. Static content: prerenders to plain HTML, reads with JS off, no third-party origin (CSP-clean).
export function Privacy() {
  return (
    <Layout>
      <section className="legal">
        <h1 className="legal-h1">Privacy policy</h1>
        <p className="legal-updated">
          Last updated: <time dateTime="2026-07-18">18 July 2026</time>
        </p>

        <p className="legal-lead">
          <Ns /> is built so that there is very little to collect. There are no accounts, no identities,
          and no request logs. This policy sets out exactly what that means: the small amount we handle,
          what we never keep, and where your data goes when you make a request.
        </p>

        <h2>1. Who we are</h2>
        <p>
          In this policy, &quot;we&quot;, &quot;us&quot;, and &quot;nullsink&quot; mean a prepaid gateway
          to third-party large language model (LLM) APIs, operated by an independent operator (the
          &quot;nullsink operator&quot;). There is no company behind the service at this time. For the
          limited data described below, the nullsink operator is the data controller. You can reach us at{" "}
          <a href="mailto:admin@nullsink.is">admin@nullsink.is</a>.
        </p>

        <h2>2. Information we handle, and what we do not</h2>
        <p>The service is designed to minimise data at every step.</p>
        <p>What we store:</p>
        <ul>
          <li>
            <span className="lead-term">A token hash.</span> Your key is generated in your own browser.
            The raw bearer key is sent when you authorise an API or balance request; we hash it in
            process and store only its SHA-256 hash together with a balance. We cannot derive your key
            from the hash, and outside the temporary payment lifecycle below we do not link that balance
            record to a payment or personal identity.
          </li>
          <li>
            <span className="lead-term">A balance.</span> A single number: how much prepaid credit the
            hash has left.
          </li>
          <li>
            <span className="lead-term">Temporary payment details.</span> While a purchase is in progress
            we store the payment address, the expected and received coin amounts, the credit to apply,
            and a timestamp, linked to the token hash. When payment settles, that active order is deleted;
            a delivery record retains the token hash and credit amount only until the balance ledger gives a
            definite acknowledgement. We then clear those two fields and keep the payment-side idempotency key
            and timestamps so the same deposit cannot be credited twice. An unpaid order is deleted after its
            payment-monitoring horizon.
          </li>
        </ul>
        <p>What we never store:</p>
        <ul>
          <li>
            <span className="lead-term">Your IP address.</span> Our edge writes no access logs, and the
            client IP is stripped before it reaches the application, so the application never sees it.
          </li>
          <li>
            <span className="lead-term">Your prompts or the model&apos;s responses.</span> Request content
            passes through us to the provider you call and is metered for billing, but we do not record it
            (see section 4).
          </li>
          <li>
            <span className="lead-term">Accounts, names, emails, phone numbers, or card details.</span>{" "}
            There are none to collect.
          </li>
          <li>
            <span className="lead-term">Cookies, local storage, device identifiers, or analytics.</span>{" "}
            The site sets no cookies and loads no third-party scripts. There is no cookie banner because
            there is nothing to consent to.
          </li>
        </ul>
        <p>
          The one exception: if you email us, we receive your email address and whatever you write. See
          section 4 and section 6.
        </p>

        <h2>3. How we use what we handle</h2>
        <ul>
          <li>
            The token hash and balance let us authorise and meter API calls and apply credit. That is
            their only purpose.
          </li>
          <li>
            The temporary payment details let us match an incoming payment to the right token and
            deliver its credit safely. After acknowledged delivery, we clear the direct payment-to-token
            link and retain only the marker needed to prevent duplicate credit.
          </li>
          <li>Any email you send us is used only to answer you.</li>
        </ul>
        <p>
          We do not sell, rent, or share any of this, and we do not use it for advertising or profiling.
          We could not build a profile of you even if we wanted to, because we hold nothing that identifies
          you. Where the GDPR applies, our legal basis for handling the token hash and balance is the
          performance of our contract with you (running the service you paid for); for the brief payment
          record we also rely on our legitimate interest in crediting payments correctly.
        </p>

        <h2>4. Where your data goes</h2>
        <p>Some processing necessarily involves others.</p>
        <ul>
          <li>
            <span className="lead-term">LLM providers.</span> When you call the API, the content of your
            request and its response are sent to the provider you address (currently Anthropic, OpenAI,
            or Tinfoil when enabled) so that it can answer you. We are the meter, not a store: we forward the request
            under our own provider account and never attach your identity, because we have none to attach.
            On the OpenAI path we force <code>store:false</code>, which disables optional application-state
            storage; it does not by itself disable OpenAI&apos;s separate abuse-monitoring retention. Provider
            handling and any approved data controls remain governed by the provider&apos;s policy. Your use of
            those models is governed by the provider&apos;s terms and privacy policy:{" "}
            <a href="https://www.anthropic.com/legal/privacy" {...EXT}>
              Anthropic
            </a>
            ,{" "}
            <a href="https://openai.com/policies/privacy-policy" {...EXT}>
              OpenAI
            </a>
            , and{" "}
            <a href="https://tinfoil.sh/privacy" {...EXT}>
              Tinfoil
            </a>
            .
          </li>
          <li>
            <span className="lead-term">Payment network.</span> Payments are made in Monero or Bitcoin to a
            single-use address. Our wallet keeps the addresses it generates, but they carry a fixed,
            non-identifying label (an order number), not your token. The payments service temporarily links
            an active order and then an undelivered credit to the token hash so it can credit the right balance;
            it clears that link after acknowledged delivery. Neither payment network receives your token or
            token hash. Bitcoin&apos;s ledger is public; Monero&apos;s is private by design. Both networks are
            outside our control.
          </li>
          <li>
            <span className="lead-term">TLS certificate authority.</span> We use Let&apos;s Encrypt to
            secure the connection; the certificate authority sees only the domain name.
          </li>
          <li>
            <span className="lead-term">Hosting and network.</span> The service runs on a hosted server.
            While we keep no IP logs, the underlying network and hosting provider can see network-level
            traffic, as with any internet service.
          </li>
          <li>
            <span className="lead-term">Exchange-rate sources.</span> To quote a price we query public
            coin exchange rates (Kraken, with CoinGecko as a fallback). We send no information about you
            in those queries; we only ask for a price.
          </li>
          <li>
            <span className="lead-term">Email.</span> If you email us, your message is handled by our email
            provider in the ordinary course of delivering mail.
          </li>
        </ul>

        <h2>5. How long we keep things</h2>
        <ul>
          <li>
            A balance is kept for as long as the token holds credit, because the balance is the credit. It
            carries no identity.
          </li>
          <li>
            Active payment details are deleted when a payment settles, or after the payment-monitoring horizon
            if it does not. A settled credit&apos;s token hash and amount remain in the delivery queue only until
            the balance ledger definitely acknowledges them; those fields are then cleared.
          </li>
          <li>We keep no access logs or request logs, so there are none to retain.</li>
          <li>Email correspondence is kept only as long as needed to deal with your inquiry.</li>
        </ul>

        <h2>6. Your rights</h2>
        <p>
          Because we hold no information that identifies you, most data-protection rights have little to
          act on, and we usually cannot connect a token to a person even if asked. Subject to applicable
          law (including the GDPR and the CCPA/CPRA where they apply):
        </p>
        <ul>
          <li>
            There is no personal profile to access, correct, export, or delete, because we do not maintain
            one.
          </li>
          <li>
            Your balance is controlled by whoever holds the secret token. We cannot reset, recover,
            transfer, or delete a balance on request, because we cannot verify who you are and there is no
            recovery path. Losing the key loses the credit; this is described in the terms.
          </li>
          <li>
            If you have emailed us, that correspondence is the one place we may hold your personal data, and
            you can ask us to delete it.
          </li>
          <li>
            We do not sell or share personal information and do not run targeted advertising, so there is
            nothing to opt out of.
          </li>
        </ul>
        <p>
          To make a request about email correspondence, contact{" "}
          <a href="mailto:admin@nullsink.is">admin@nullsink.is</a>.
        </p>

        <h2>7. International processing</h2>
        <p>
          The service may be operated and hosted outside your country, and the providers we forward
          requests to may process them in the United States or elsewhere. Because we do not collect
          personal data, cross-border transfer mechanisms generally do not apply; we mention this only so
          the data flow is clear.
        </p>

        <h2>8. Children</h2>
        <p>
          The service is not directed to anyone under 18, and we do not knowingly handle data from
          children.
        </p>

        <h2>9. Changes to this policy</h2>
        <p>
          We may update this policy as the service changes. The &quot;last updated&quot; date above
          reflects the current version, and any material change will be posted on this page.
        </p>

        <h2>10. Contact</h2>
        <p>
          Questions about privacy: <a href="mailto:admin@nullsink.is">admin@nullsink.is</a>. Security
          reports: see{" "}
          <a href="/.well-known/security.txt" {...EXT}>
            /.well-known/security.txt
          </a>
          .
        </p>
      </section>
    </Layout>
  );
}
