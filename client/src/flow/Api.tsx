import type { ComponentType, ReactNode } from "react";
import { Layout } from "../Layout.tsx";
import { AnthropicMark, CodeBlock, Copy, KvRow, Ns, OpenAiMark, TinfoilMark } from "../ui.tsx";
import { EXT, GITHUB_URL } from "../lib/links.ts";

// /api — the API reference. nullsink mirrors the Anthropic and OpenAI wire formats, so a stock SDK works once
// the base URL + key change. Minimal prose: the served routes, what each does, and the few snippets any
// caller needs. Every fact mirrors the proxy's real contract (core src/handler.ts + providers/) — if the
// served surface changes, change this page. Static: prerenders and reads with JS off (the copy buttons are
// the only JS). CodeBlock `highlights` tint the two things a caller swaps — their key and the model id — acid.

const ANTHROPIC_CURL = `curl https://nullsink.is/v1/messages \\
  -H "x-api-key: 0sink_YOUR_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "claude-opus-4-8",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

const OPENAI_CURL = `curl https://nullsink.is/v1/chat/completions \\
  -H "authorization: Bearer 0sink_YOUR_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "gpt-5.2",
    "max_completion_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

const CLAUDE_CODE_ENV = `export ANTHROPIC_BASE_URL=https://nullsink.is
export ANTHROPIC_AUTH_TOKEN=0sink_YOUR_KEY
claude`;

// The error envelope is each provider's NATIVE shape (so a stock SDK classifies the failure), and BOTH are
// shown below. The OpenAI form covers /chat/completions, /responses, AND Tinfoil (OpenAI-compatible), carrying
// the reason in `code`; Anthropic's /v1/messages wears its own, carrying the reason in `message`. Same reason
// string either way.
const ERROR_SHAPE = `{
  "error": {
    "message": "max_tokens_required",
    "type": "invalid_request_error",
    "code": "max_tokens_required"
  }
}`;
const ANTHROPIC_ERROR_SHAPE = `{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "max_tokens_required"
  }
}`;

// Tinfoil is the sealed-enclave provider, so its coin takes the purple seal ring instead of acid (same
// semantic as the SquareGlyph sealed marker on /models).
const SEALED = new Set<ComponentType<{ className?: string }>>([TinfoilMark]);

// Provider mark(s) in coins — the page's signature accent, shared by the base-url and endpoint rows.
function Marks({ marks }: { marks: ComponentType<{ className?: string }>[] }) {
  return (
    <span className="ep-marks" aria-hidden="true">
      {marks.map((M, i) => (
        <span key={i} className={"ep-disc" + (SEALED.has(M) ? " sealed" : "")}>
          <M className="ep-ico" />
        </span>
      ))}
    </span>
  );
}

// One endpoint row: method · path · a copy button for the full URL · the provider mark(s). The whole site is
// monospace, so the path needs no special face — bone path against the muted method.
function Ep({
  marks,
  method,
  path,
}: {
  marks: ComponentType<{ className?: string }>[];
  method: string;
  path: string;
}) {
  return (
    <div className="ep">
      <span className="ep-method">{method}</span>
      <span className="ep-path">{path}</span>
      <Copy value={`https://nullsink.is${path}`} />
      <Marks marks={marks} />
    </div>
  );
}

// One error row: the machine-readable code beside its cause.
function Err({ code, children }: { code: string; children: ReactNode }) {
  return (
    <li>
      <code className="err-code">{code}</code>
      <span>{children}</span>
    </li>
  );
}

export function Api() {
  return (
    <Layout nav="api">
      <section className="section">
        <h1 className="page-h1">api</h1>
        <p className="note">
          <span className="marker" aria-hidden="true">→</span>
          <span>
            <Ns /> mirrors the Anthropic and OpenAI APIs. Point a stock SDK at it — only the base URL and the
            key change. <a href="/#buy">Mint a key</a>; model ids are on the <a href="/models/">models</a>{" "}
            page.
          </span>
        </p>
        <p className="note">
          <span className="marker" aria-hidden="true">!</span>
          <span>
            <span className="hl">Every request must set a max output tokens</span> — <code>max_tokens</code>{" "}
            (Anthropic) or <code>max_completion_tokens</code> (OpenAI), or it&apos;s rejected with{" "}
            <code>max_tokens_required</code>.
          </span>
        </p>
      </section>

      <section className="section">
        <h2>base url &amp; auth</h2>
        <dl className="kv">
          <KvRow k="base url" values={["https://nullsink.is"]} />
          <KvRow k="auth headers" values={["x-api-key", "Authorization: Bearer"]} />
        </dl>
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Endpoints live under <code>/v1</code>. OpenAI-compatible SDKs append only the endpoint tail, so
            give them the base URL with it — <code>https://nullsink.is/v1</code>.
          </span>
        </p>
      </section>

      <section className="section">
        <h2>endpoints</h2>
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>Request and response bodies are each provider&apos;s native schema.</span>
        </p>
        <div className="ep-group">
          <Ep marks={[AnthropicMark]} method="POST" path="/v1/messages" />
          <Ep marks={[OpenAiMark, TinfoilMark]} method="POST" path="/v1/chat/completions" />
          <Ep marks={[OpenAiMark]} method="POST" path="/v1/responses" />
        </div>
      </section>

      <section className="section">
        <h2>quickstart</h2>
        <CodeBlock
          label="anthropic · curl"
          code={ANTHROPIC_CURL}
          highlights={["0sink_YOUR_KEY", "claude-opus-4-8"]}
        />
        <CodeBlock label="openai · curl" code={OPENAI_CURL} highlights={["0sink_YOUR_KEY", "gpt-5.2"]} />
      </section>

      <section className="section">
        <h2>claude code</h2>
        <CodeBlock label="shell" code={CLAUDE_CODE_ENV} highlights={["0sink_YOUR_KEY"]} />
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Use <code>ANTHROPIC_AUTH_TOKEN</code> — a logged-in Claude subscription silently overrides{" "}
            <code>ANTHROPIC_API_KEY</code>. Then point it at a <a href="/models/">supported model</a>.
          </span>
        </p>
      </section>

      <section className="section">
        <h2>limits</h2>
        <ul className="dash-list">
          <li>
            <span className="lead-term">endpoints</span> — only the three above are proxied; other paths
            return <code>unsupported_endpoint</code>.
          </li>
          <li>
            <span className="lead-term">options</span> — <code>n</code> and <code>best_of</code> must be 1;
            unsupported ones return <code>unsupported_option</code>.
          </li>
          <li>
            <span className="lead-term">headers</span> — premium <code>anthropic-beta</code> features and
            org / project ids are stripped before forwarding.
          </li>
        </ul>
        <p className="section-copy">
          Need a stripped feature or an unlisted model? Email{" "}
          <a href="mailto:admin@nullsink.is">admin@nullsink.is</a> or open a{" "}
          <a href={GITHUB_URL} {...EXT}>
            GitHub issue
          </a>
          .
        </p>
      </section>

      <section className="section">
        <h2>errors</h2>
        <ul className="err-list">
          <Err code="max_tokens_required">set a max output tokens (above)</Err>
          <Err code="unsupported_model">the model id isn&apos;t served — see /models</Err>
          <Err code="unsupported_endpoint">that path or method isn&apos;t proxied</Err>
          <Err code="insufficient_balance">the key is out of credit — top up</Err>
          <Err code="invalid_token">the key is unknown or malformed</Err>
          <Err code="rate_limited">too many requests right now — retry shortly</Err>
        </ul>
        <CodeBlock label="openai · tinfoil" code={ERROR_SHAPE} />
        <CodeBlock label="anthropic" code={ANTHROPIC_ERROR_SHAPE} />
      </section>
    </Layout>
  );
}
