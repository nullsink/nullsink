import type { ComponentType, ReactNode } from "react";
import { Layout } from "../Layout.tsx";
import { AnthropicMark, CodeBlock, Copy, KvRow, Ns, OpenAiMark, TinfoilMark } from "../ui.tsx";
import { EXT } from "../lib/links.ts";

// /api — the API reference. nullsink mirrors the Anthropic and OpenAI wire formats, so a stock SDK works once
// the base URL + key change. Minimal prose: the served routes, what each does, and the few snippets any
// caller needs. Every fact mirrors the proxy's real contract (core src/handler.ts + providers/) — if the
// served surface changes, change this page. Static: prerenders and reads with JS off (the copy buttons are
// the only JS). CodeBlock `highlights` tint the two things a caller swaps — their key and the model id — acid.

// Provider docs: the request/response bodies are each provider's native schema, so their reference applies
// verbatim (see the note under the endpoints). Each links the provider's own "create" endpoint page.
const ANTHROPIC_DOCS = "https://platform.claude.com/docs/en/api/messages/create";
const OPENAI_CHAT_DOCS =
  "https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create";
const OPENAI_RESPONSES_DOCS = "https://developers.openai.com/api/reference/resources/responses/methods/create";

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

// The two error envelopes — each provider's native shape (so a stock SDK classifies the failure), our code
// riding in `message` (Anthropic, no code field) / `code` (OpenAI). max_tokens_required shown as the example.
const ERROR_SHAPE = `# anthropic · 400 on POST /v1/messages
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "max_tokens_required"
  }
}

# openai · 400 on POST /v1/chat/completions
{
  "error": {
    "message": "max_tokens_required",
    "type": "invalid_request_error",
    "code": "max_tokens_required"
  }
}`;

// Provider mark(s) in acid-ringed coins — the page's signature accent, shared by the base-url and endpoint rows.
function Marks({ marks }: { marks: ComponentType<{ className?: string }>[] }) {
  return (
    <span className="ep-marks" aria-hidden="true">
      {marks.map((M, i) => (
        <span key={i} className="ep-disc">
          <M className="ep-ico" />
        </span>
      ))}
    </span>
  );
}

// One endpoint row: provider mark(s) · method · path · a one-line note (a provider-doc link on the inference
// rows). The whole site is monospace, so the path needs no special face — bone against the muted note.
function Ep({
  marks,
  method,
  path,
  href,
  children,
}: {
  marks: ComponentType<{ className?: string }>[];
  method: string;
  path: string;
  href?: string;
  children: ReactNode;
}) {
  return (
    <div className="ep">
      <Marks marks={marks} />
      <span className="ep-method">{method}</span>
      <span className="ep-path">{path}</span>
      <span className="ep-desc">
        {href ? (
          <a href={href} {...EXT}>
            {children}
          </a>
        ) : (
          children
        )}
      </span>
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
    <Layout>
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
        {/* the coin on each base URL marks which provider it serves — /v1 is shared by OpenAI + Tinfoil */}
        <div className="ep-group">
          <div className="ep">
            <Marks marks={[AnthropicMark]} />
            <span className="ep-path">
              https://nullsink.is <Copy value="https://nullsink.is" />
            </span>
            <span className="ep-desc">anthropic</span>
          </div>
          <div className="ep">
            <Marks marks={[OpenAiMark, TinfoilMark]} />
            <span className="ep-path">
              https://nullsink.is/v1 <Copy value="https://nullsink.is/v1" />
            </span>
            <span className="ep-desc">openai · tinfoil</span>
          </div>
        </div>
        <dl className="kv">
          <KvRow k="auth headers" values={["x-api-key", "Authorization: Bearer"]} />
        </dl>
      </section>

      <section className="section">
        <h2>endpoints</h2>
        <div className="ep-group">
          <Ep marks={[AnthropicMark]} method="POST" path="/v1/messages" href={ANTHROPIC_DOCS}>
            Anthropic Messages
          </Ep>
          <Ep
            marks={[OpenAiMark, TinfoilMark]}
            method="POST"
            path="/v1/chat/completions"
            href={OPENAI_CHAT_DOCS}
          >
            OpenAI Chat Completions
          </Ep>
          <Ep marks={[OpenAiMark]} method="POST" path="/v1/responses" href={OPENAI_RESPONSES_DOCS}>
            OpenAI Responses
          </Ep>
        </div>
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Request and response bodies are each provider&apos;s native schema — the linked docs apply
            verbatim.
          </span>
        </p>
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
            <span className="lead-term">model</span> — must be one <Ns /> prices (
            <a href="/models/">models</a>); anything else returns <code>unsupported_model</code>.
          </li>
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
        <CodeBlock label="error response" code={ERROR_SHAPE} />
      </section>
    </Layout>
  );
}
