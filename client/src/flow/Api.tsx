import type { ComponentType, ReactNode } from "react";
import { Layout } from "../Layout.tsx";
import { AnthropicMark, CodeBlock, KvRow, Ns, OpenAiMark, TinfoilMark } from "../ui.tsx";
import { EXT } from "../lib/links.ts";

// /api — the API reference. nullsink mirrors the Anthropic and OpenAI wire formats, so a stock SDK works once
// the base URL + key change. Minimal prose: the served routes, what each does, and the few snippets any
// caller needs. Every fact mirrors the proxy's real contract (core src/handler.ts + providers/ + endpoints/)
// — if the served surface changes, change this page. Static: prerenders and reads with JS off (the copy
// buttons are the only JS). CodeBlock `highlights` tint the two things a caller swaps — their key and the
// model id — acid.

// Provider docs: the request/response bodies are each provider's native schema, so their reference applies
// verbatim (see the note under the endpoints). Linked off the inference rows.
const ANTHROPIC_DOCS = "https://docs.anthropic.com/en/api/messages";
const OPENAI_CHAT_DOCS = "https://platform.openai.com/docs/api-reference/chat";
const OPENAI_RESPONSES_DOCS = "https://platform.openai.com/docs/api-reference/responses";

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

// One endpoint row: provider mark(s) · method · path · a one-line note (a provider-doc link on the inference
// rows). The whole site is monospace, so the path needs no special face — bone against the muted note.
function Ep({
  marks = [],
  method,
  path,
  href,
  children,
}: {
  marks?: ComponentType<{ className?: string }>[];
  method: string;
  path: string;
  href?: string;
  children: ReactNode;
}) {
  return (
    <div className="ep">
      <span className="ep-marks" aria-hidden="true">
        {marks.map((M, i) => (
          <M key={i} className="ep-mark" />
        ))}
      </span>
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
      </section>

      <section className="section">
        <h2>base url &amp; auth</h2>
        <dl className="kv">
          <KvRow k="base url" values={["https://nullsink.is", "https://nullsink.is/v1"]} />
          <KvRow k="auth header" values={["x-api-key: 0sink_…", "Authorization: Bearer 0sink_…"]} />
        </dl>
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Two base URLs because the SDKs build paths differently — Anthropic from the bare host, OpenAI adds{" "}
            <code>/v1</code>. Use either auth header, whichever your SDK sends. Your key identifies you to{" "}
            <Ns /> and is never forwarded upstream.
          </span>
        </p>
      </section>

      <section className="section">
        <h2>endpoints</h2>
        <div className="ep-group">
          <div className="ep-group-label">inference · spends credit</div>
          <Ep marks={[AnthropicMark]} method="POST" path="/v1/messages" href={ANTHROPIC_DOCS}>
            Anthropic Messages
          </Ep>
          <Ep marks={[OpenAiMark, TinfoilMark]} method="POST" path="/v1/chat/completions" href={OPENAI_CHAT_DOCS}>
            OpenAI Chat Completions
          </Ep>
          <Ep marks={[OpenAiMark]} method="POST" path="/v1/responses" href={OPENAI_RESPONSES_DOCS}>
            OpenAI Responses
          </Ep>
        </div>
        <div className="ep-group">
          <div className="ep-group-label">account · free</div>
          <Ep method="GET" path="/balance">
            remaining credit → <code>{"{ balance_usd }"}</code>
          </Ep>
        </div>
        <p className="note">
          <span className="marker" aria-hidden="true">!</span>
          <span>
            Request and response bodies are each provider&apos;s native schema — the linked docs apply
            verbatim. <Ns /> only constrains what metering needs: a max output tokens, a model it prices (
            <a href="/models/">models</a>), and a few rejected options (<code>n</code>, <code>best_of</code>,
            premium betas).
          </span>
        </p>
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Open-weight ids route to Tinfoil — a sealed enclave sharing the OpenAI{" "}
            <code>/v1/chat/completions</code> surface, selected by the model id.
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
        <p className="section-copy">
          <span className="hl">Always set a max output tokens</span> — <code>max_tokens</code> (Anthropic) or{" "}
          <code>max_completion_tokens</code> (OpenAI). Without one the request is rejected with{" "}
          <code>max_tokens_required</code>.
        </p>
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
        <h2>errors</h2>
        <ul className="err-list">
          <Err code="max_tokens_required">set a max output tokens (above)</Err>
          <Err code="unsupported_model">the model id isn&apos;t served — see /models</Err>
          <Err code="unsupported_endpoint">that path or method isn&apos;t proxied</Err>
          <Err code="insufficient_balance">the key is out of credit — top up</Err>
          <Err code="invalid_token">the key is unknown or malformed</Err>
          <Err code="rate_limited">too many requests right now — retry shortly</Err>
        </ul>
      </section>
    </Layout>
  );
}
