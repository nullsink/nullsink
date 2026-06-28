import { Layout } from "../Layout.tsx";
import { AnthropicMark, CodeBlock, KvRow, Ns, OpenAiMark, TinfoilMark } from "../ui.tsx";
import { DISCORD_URL, EXT, MATRIX_URL } from "../lib/links.ts";
import { MARGIN, MARKUP_PCT, usd } from "../lib/api.ts";

// "get started" — the developer on-ramp (route /start): everything needed to go from a funded key to a
// working request without reading the server repo — the quick path, per-provider integration behind
// CSS-only radio tabs, and the honest fine print. The ONE first-400 gotcha is kept here (set a max output
// tokens); the billing MECHANICS, other deliberate limits, and the premium-features policy live on
// /how-it-works (cross-linked).
// Every claim mirrors the proxy's actual contract (core src/handler.ts and the rejection table in the
// core README); if the proxy changes, change this page — same stay-true-to-the-code rule as /about.
// Static: no state, no fetch — prerenders to plain HTML and reads with JS off (the copy buttons are the
// only JS, the tabs are :checked CSS, and the samples remain selectable text regardless).
// CodeBlock `highlights` tint the two things a reader must touch — their key, the model id — acid.

const ANTHROPIC_CURL = `curl https://nullsink.is/v1/messages \\
  -H "x-api-key: 0sink_YOUR_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "claude-opus-4-8",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

const ANTHROPIC_ENV = `export ANTHROPIC_BASE_URL=https://nullsink.is
export ANTHROPIC_API_KEY=0sink_YOUR_KEY`;

// Claude Code: use ANTHROPIC_AUTH_TOKEN (sent as Authorization: Bearer, which the proxy accepts) —
// NOT ANTHROPIC_API_KEY, which a logged-in Claude subscription silently overrides (CC sends the sub's
// OAuth token → 401). ANTHROPIC_AUTH_TOKEN outranks the subscription, so `claude` runs against the proxy
// without a /logout.
const CLAUDE_CODE_ENV = `export ANTHROPIC_BASE_URL=https://nullsink.is
export ANTHROPIC_AUTH_TOKEN=0sink_YOUR_KEY
claude`;

const OPENAI_CURL = `curl https://nullsink.is/v1/chat/completions \\
  -H "authorization: Bearer 0sink_YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-5.2",
    "max_completion_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

const OPENAI_ENV = `export OPENAI_BASE_URL=https://nullsink.is/v1
export OPENAI_API_KEY=0sink_YOUR_KEY`;

// Tinfoil — open-weight models on the same OpenAI-compatible surface (same base url + Bearer key as OpenAI),
// so the only thing that changes from the OpenAI tab is the model id.
const TINFOIL_CURL = `curl https://nullsink.is/v1/chat/completions \\
  -H "authorization: Bearer 0sink_YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "glm-5-2",
    "max_completion_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

const BALANCE_CURL = `curl https://nullsink.is/balance -H "x-api-key: 0sink_YOUR_KEY"
# -> {"balance_usd": 20}`;

export function Start() {
  return (
    <Layout>
      <section className="section">
        <h1 className="page-h1">get started</h1>

        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Your key is the whole account.
          </span>
        </p>
        <p className="note">
          <span className="marker" aria-hidden="true">1</span>
          <span>
            <span className="lead-term">get a key</span> — <a href="/#buy">buy credit</a> on the home
            page. Your browser mints the key and shows it once; <span className="hl">save it somewhere safe</span>.
          </span>
        </p>
        <p className="note">
          <span className="marker" aria-hidden="true">2</span>
          <span>
            <span className="lead-term">point your tools at <Ns /></span> — only the base URL and the API
            key change.
          </span>
        </p>
        <p className="note">
          <span className="marker" aria-hidden="true">3</span>
          <span>
            <span className="lead-term">send requests</span> — each one debits the key at the
            provider&apos;s per-token price. Top up the same key any time.
          </span>
        </p>
      </section>

      <section className="section">
        <h2>use your key</h2>
        <div className="useit-tabs">
          {/* CSS-only radio-tab mechanism: the radios precede the tablist and both panels (the
              :checked ~ sibling combinator needs that order); visually hidden but keyboard-focusable.
              Anthropic is the default. */}
          <input className="useit-radio" type="radio" name="start-tab" id="start-anthropic" defaultChecked />
          <input className="useit-radio" type="radio" name="start-tab" id="start-openai" />
          <input className="useit-radio" type="radio" name="start-tab" id="start-tinfoil" />
          {/* No role="tablist": these are honestly labelled radios (focusable, arrow-key switchable). */}
          <div className="useit-tablist">
            <label className="useit-tab" htmlFor="start-anthropic">
              <AnthropicMark className="useit-tab-logo" /> Anthropic
            </label>
            <label className="useit-tab" htmlFor="start-openai">
              <OpenAiMark className="useit-tab-logo" /> OpenAI
            </label>
            <label className="useit-tab" htmlFor="start-tinfoil">
              <TinfoilMark className="useit-tab-logo" /> Tinfoil
            </label>
          </div>

          <div className="useit-panel" id="start-panel-anthropic">
            <p className="section-copy">
              The proxy serves Anthropic&apos;s Messages API. Official SDKs work, as does anything that
              accepts a base-url override.
            </p>
            <dl className="kv">
              <KvRow k="base url" values={["https://nullsink.is"]} />
              <KvRow k="auth header" values={["x-api-key", "Authorization: Bearer"]} />
              <KvRow k="endpoint" values={["/v1/messages"]} />
            </dl>
            <CodeBlock
              label="curl"
              code={ANTHROPIC_CURL}
              highlights={["0sink_YOUR_KEY", "claude-opus-4-8"]}
            />
            <CodeBlock
              label="any anthropic sdk · env"
              code={ANTHROPIC_ENV}
              highlights={["0sink_YOUR_KEY"]}
            />
          </div>

          <div className="useit-panel" id="start-panel-openai">
            <p className="section-copy">
              Chat Completions and Responses are served, in OpenAI&apos;s request and response formats. The
              base url carries the <code>/v1</code> the Anthropic one omits; that&apos;s how the SDKs build
              their URLs.
            </p>
            <dl className="kv">
              <KvRow k="base url" values={["https://nullsink.is/v1"]} />
              <KvRow k="auth header" values={["Authorization: Bearer"]} />
              <KvRow k="endpoints" values={["/chat/completions", "/responses"]} />
            </dl>
            <CodeBlock label="curl" code={OPENAI_CURL} highlights={["0sink_YOUR_KEY", "gpt-5.2"]} />
            <CodeBlock label="any openai sdk · env" code={OPENAI_ENV} highlights={["0sink_YOUR_KEY"]} />
          </div>

          <div className="useit-panel" id="start-panel-tinfoil">
            <p className="section-copy">
              Open-weight models — gpt-oss, Llama, GLM, Kimi, Gemma — run inside a sealed enclave that
              can&apos;t read your prompts. They speak the same OpenAI Chat Completions API: same base url and
              Bearer key as the OpenAI tab, just an open-weight model id (browse the{" "}
              <a href="/models/">supported models</a>).
            </p>
            <dl className="kv">
              <KvRow k="base url" values={["https://nullsink.is/v1"]} />
              <KvRow k="auth header" values={["Authorization: Bearer"]} />
              <KvRow k="endpoint" values={["/chat/completions"]} />
            </dl>
            <CodeBlock label="curl" code={TINFOIL_CURL} highlights={["0sink_YOUR_KEY", "glm-5-2"]} />
            <CodeBlock label="any openai sdk · env" code={OPENAI_ENV} highlights={["0sink_YOUR_KEY"]} />
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Claude Code</h2>
        <p className="section-copy">
          Point Claude Code at <Ns /> with two environment variables, then start <code>claude</code>. Use{" "}
          <code>ANTHROPIC_AUTH_TOKEN</code> for the key (it travels as a Bearer token, which the proxy
          accepts), <em>not</em> <code>ANTHROPIC_API_KEY</code>.
        </p>
        <CodeBlock label="shell" code={CLAUDE_CODE_ENV} highlights={["0sink_YOUR_KEY"]} />
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Signed into a Claude subscription? A logged-in session silently overrides{" "}
            <code>ANTHROPIC_API_KEY</code>, so use <code>ANTHROPIC_AUTH_TOKEN</code> instead. Its Bearer
            token outranks the subscription. Then point it at a <a href="/models/">supported model</a>.
          </span>
        </p>
      </section>

      <section className="section">
        <h2>pricing</h2>
        <ul className="dash-list">
          <li>
            <span className="lead-term">When you buy:</span> the coin price is your credit plus ~{MARKUP_PCT}%
            markup. $10 of credit costs about {usd(10 * MARGIN)} in your chosen coin (Monero or Bitcoin).
          </li>
          <li>
            <span className="lead-term">When you spend:</span> each request debits the provider&apos;s
            exact published per-token rate.
          </li>
        </ul>
        <p className="section-copy">
          One key spends on either provider. See the <a href="/models/">supported models</a>. The hold, the
          refund to actual usage, and how streaming is billed are in{" "}
          <a href="/how-it-works/">how it works</a>.
        </p>
      </section>

      <section className="section">
        <h2>before your first request</h2>
        <p className="section-copy">
          {/* acid-highlighted: the gotcha every first integration hits; the rest live on /how-it-works */}
          <span className="hl">Always set a max output tokens</span> — <code>max_tokens</code> (Anthropic)
          or <code>max_completion_tokens</code> / <code>max_output_tokens</code> (OpenAI). Without one a
          request can be rejected (<code>max_tokens_required</code>). Other limits — unsupported models,
          premium features off by default, OpenAI statelessness — are explained in{" "}
          <a href="/how-it-works/">how it works</a>.
        </p>
      </section>

      <section className="section">
        <h2>check a balance</h2>
        <p className="section-copy">
          From the <a href="/">home page</a> (&quot;I have a key&quot;), or straight from the API:
        </p>
        <CodeBlock label="curl" code={BALANCE_CURL} highlights={["0sink_YOUR_KEY"]} />
        <p className="section-copy">
          Stuck? Ask on{" "}
          <a href={DISCORD_URL} {...EXT}>
            discord
          </a>{" "}
          or{" "}
          <a href={MATRIX_URL} {...EXT}>
            matrix
          </a>
          , or email <a href="mailto:admin@nullsink.is">admin@nullsink.is</a>. We keep no request logs, so
          include the rough time and the error body.
        </p>
      </section>
    </Layout>
  );
}
