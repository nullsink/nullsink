import { Layout } from "../Layout.tsx";
import { Ns } from "../ui.tsx";
import { EXT } from "../lib/links.ts";

// The privacy policy. A formal, prose policy (numbered sections) rendered in the legal-page style. The
// claims here are NOT marketing — they are what the system actually does, so every statement must stay true
// to the code: token hashed in-browser (lib/token.ts), only the hash stored (core/src/ledger/db.ts), no IP
// retention at the edge and no client IP at the app (Caddy strips forwarding and keeps no access log),
// content-minimized exceptional journal events (core/src/handler.ts), and prompts forwarded upstream. If the behaviour changes, change
// this. Static content: prerenders to plain HTML, reads with JS off, no third-party origin (CSP-clean).
export function Privacy() {
  return (
    <Layout>
      <section className="legal">
        <h1 className="legal-h1">Privacy policy</h1>
        <p className="legal-updated">
          Last updated: <time dateTime="2026-07-14">14 July 2026</time>
        </p>

        <p className="legal-lead">
          <Ns /> is built so that there is very little to collect. There are no accounts, no identities,
          and no access logs or prompt/response logs. This policy sets out exactly what that means: the small amount we handle,
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
            <span className="lead-term">A token hash.</span> In the self-serve web flow your key is generated
            in your browser; the buyer CLI can generate it locally too. An optional break-glass operator tool
            can instead mint a key on the service box and display it once. The raw bearer key is sent over TLS
            when you authenticate an API call or check its balance; we hash it in-process and never persist it
            in the application databases. Purchase and payment-status requests send
            only the SHA-256 hash. We store that hash with a balance and cannot derive your key from it; it is
            not linked to any name or email. While an API call is in progress, a short-lived hold record also
            carries the hash, reserved amount, and an opaque random identifier so a crash can refund it safely.
          </li>
          <li>
            <span className="lead-term">A balance.</span> A single number: how much prepaid credit the
            hash has left.
          </li>
          <li>
            <span className="lead-term">Temporary payment details.</span> While a purchase is in progress
            we store the payment address, the expected and received coin amounts, the credit to apply,
            and a timestamp, linked to the token hash. At settlement the active order is replaced by a
            delivery record containing the token hash and credit amount only while durable credit delivery
            is owed. After the balance ledger acknowledges it, those fields are cleared from the active
            logical outbox row. Unpaid active orders are removed after their payment horizon.
          </li>
          <li>
            <span className="lead-term">Payment idempotency and accounting records.</span> To prevent a
            deposit crediting twice, we retain its transaction-derived idempotency key and timestamps. We
            also keep an append-only sales journal containing the time, asset, coin amount, USD credit, and
            gross USD value of each sale. Neither record contains a token hash, raw token, payment address,
            name, email, prompt, or response after delivery is acknowledged.
          </li>
          <li>
            <span className="lead-term">Aggregate operational metrics.</span> Periodic system-journal lines
            contain totals and high-water marks such as request counts, broad error categories, and peak
            concurrency. They contain no token, token hash, IP address, payment address, transaction key,
            prompt, or response, and contain no field identifying an individual request.
          </li>
          <li>
            <span className="lead-term">Exceptional operational events.</span> A failed upstream or billing
            operation can produce one content-minimized journal line with its category, provider endpoint or
            status, using only nullsink&apos;s own fixed categories. These lines contain
            no bearer token, token hash, IP address, payment address, transaction key, prompt, or response.
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
            credit it. The active order is closed at settlement, and the remaining direct token link is
            cleared from the logical outbox row after the balance ledger acknowledges delivery.
          </li>
          <li>The idempotency record prevents double credit; the sales journal supports reconciliation and accounting.</li>
          <li>Aggregate operational metrics let us detect outages and billing anomalies without request-level logs.</li>
          <li>Any email you send us is used only to answer you.</li>
        </ul>
        <p>
          We do not sell, rent, or share any of this, and we do not use it for advertising or profiling.
          We could not build a profile of you even if we wanted to, because we hold nothing that identifies
          you. Where the GDPR applies, our legal basis for handling the token hash and balance is the
          performance of our contract with you (running the service you paid for); for payment,
          reconciliation, accounting, and aggregate operational records we also rely on our legitimate
          interests in crediting correctly, preventing duplication, keeping financial records, and operating
          the service safely, together with any applicable legal accounting obligations.
        </p>

        <h2>4. Where your data goes</h2>
        <p>Some processing necessarily involves others.</p>
        <ul>
          <li>
            <span className="lead-term">LLM providers.</span> When you call the API, the content of your
            request and its response are sent to the provider you address (currently Anthropic, OpenAI when
            enabled, and Tinfoil when enabled) so that it can answer you. We are the meter, not a store: we forward the request
            under our own provider account and never attach your identity, because we have none to attach.
            On the OpenAI path we set <code>store:false</code>, which disables application-state storage but
            does not by itself disable abuse-monitoring retention; under OpenAI&apos;s standard controls those
            logs may include content for up to 30 days. Anthropic&apos;s standard API retention deletes inputs
            and outputs within 30 days, subject to trust-and-safety, legal, and contractual exceptions. The
            Tinfoil path uses an attested confidential-compute enclave; Tinfoil states that interaction
            content is inaccessible and not retained, while limited usage metadata is retained for billing
            and operations. Provider handling is governed by the
            provider&apos;s terms and privacy policy:{" "}
            <a href="https://www.anthropic.com/legal/privacy" {...EXT}>
              Anthropic
            </a>
            ,{" "}
            <a href="https://openai.com/policies/privacy-policy" {...EXT}>
              OpenAI
            </a>
            ,{" "}
            <a href="https://tinfoil.sh/privacy" {...EXT}>
              Tinfoil
            </a>
            .
          </li>
          <li>
            <span className="lead-term">Payment network.</span> Payments are made in Monero or Bitcoin to a
            single-use address. Our watch-only wallet keeps generated addresses with non-token labels (a
            fixed service label for Monero and an order index for Bitcoin), but no token or token hash.
            Separately, our active payment database temporarily links that
            order to a token hash solely so the deposit can be credited, then clears the direct logical link
            after acknowledged delivery as described above. The payment networks never receive your token.
            Bitcoin&apos;s ledger is public; Monero&apos;s is private by design. Both are outside our control.
          </li>
          <li>
            <span className="lead-term">Optional third-party swaps.</span> If you choose the swap link, your
            browser opens Trocador with the destination coin and network, the single-use payment address, and
            the quoted amount already filled in. We do not send Trocador your raw key or token hash. Trocador
            receives ordinary connection metadata such as your IP address, browser user agent, and language;
            it and the partner exchange you choose may retain swap details such as coins, amounts, addresses,
            and transaction hashes under their own policies, not this one. Review Trocador&apos;s{" "}
            <a href="https://trocador.app/en/privacypolicy/" {...EXT}>
              privacy policy
            </a>{" "}
            and the selected exchange&apos;s policy before continuing.
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
            Balance ledger rows, including the one-way token hash and amount, are retained even after the
            balance reaches zero. They carry no name or other identity.
          </li>
          <li>
            The active order link is removed at settlement. The token hash and credit amount used for
            delivery are cleared from the active logical outbox row after the balance ledger acknowledges
            the credit. Unpaid active orders are removed after their payment horizon. SQLite pages and WAL
            files can retain older bytes until WAL truncation or byte reuse. On-box disaster-recovery backups
            are plaintext unless backup encryption is configured; off-box upload is permitted only for
            encrypted artifacts. Both can retain earlier active state under their separate retention policies.
            This is logical application deletion, not a promise of immediate forensic erasure.
          </li>
          <li>
            Transaction-derived idempotency keys and timestamps are retained to prevent double credit.
            Sales-journal rows are retained as needed for reconciliation and accounting; they have no direct
            token or address field.
          </li>
          <li>
            Aggregate metrics and content-minimized exceptional operational events remain only under the host
            system journal&apos;s rotating retention policy. We keep no access logs or routine per-request logs.
          </li>
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
