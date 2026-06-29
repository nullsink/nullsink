import type { ReactNode } from "react";
import { Layout } from "../Layout.tsx";
import { CodeBlock, KvRow, Ns } from "../ui.tsx";
import { MARKUP_PCT } from "../lib/api.ts";

// /api — the API reference. nullsink is an HTTP proxy that speaks the Anthropic and OpenAI wire formats, so a
// stock SDK works once the base URL + key change. Minimal prose: the served routes, what each does, and the
// few snippets any caller needs. Every fact mirrors the proxy's real contract (core src/handler.ts +
// endpoints/) — if the served surface changes, change this page. Static: prerenders and reads with JS off
// (the copy buttons are the only JS). CodeBlock `highlights` tint the two things a caller swaps — their key
// and the model id — acid.

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

const BALANCE_CURL = `curl https://nullsink.is/balance -H "x-api-key: 0sink_YOUR_KEY"
# -> {"balance_usd": 20}`;

// One endpoint row: method · path · a one-line note. The whole site is monospace, so the path needs no
// special face — bone weight against the muted note carries it.
function Ep({ method, path, children }: { method: string; path: string; children: ReactNode }) {
  return (
    <div className="ep">
      <span className="ep-method">{method}</span>
      <span className="ep-path">{path}</span>
      <span className="ep-desc">{children}</span>
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
            <Ns /> speaks the Anthropic and OpenAI APIs. Point a stock SDK at it — only the base URL and the
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
            Anthropic SDKs use the bare host; OpenAI SDKs add <code>/v1</code>. Your key authenticates you to{" "}
            <Ns /> and is never forwarded to the provider.
          </span>
        </p>
      </section>

      <section className="section">
        <h2>endpoints</h2>
        <div className="ep-group">
          <div className="ep-group-label">inference · spends credit</div>
          <Ep method="POST" path="/v1/messages">Anthropic Messages</Ep>
          <Ep method="POST" path="/v1/chat/completions">OpenAI Chat Completions</Ep>
          <Ep method="POST" path="/v1/responses">OpenAI Responses</Ep>
        </div>
        <div className="ep-group">
          <div className="ep-group-label">account · free</div>
          <Ep method="GET" path="/balance">
            remaining credit → <code>{"{ balance_usd }"}</code>
          </Ep>
          <Ep method="POST" path="/buy">quote a crypto top-up for a key</Ep>
          <Ep method="POST" path="/order-status">progress of an in-flight payment</Ep>
          <Ep method="GET" path="/rails">the coins you can pay with</Ep>
        </div>
        <p className="note">
          <span className="marker" aria-hidden="true">!</span>
          <span>
            Inference request and response bodies are the provider&apos;s native schema. Open-weight model ids
            run in a sealed enclave on the OpenAI surface — same endpoints, an open-weight id.
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
        <h2>check a balance</h2>
        <CodeBlock label="curl" code={BALANCE_CURL} highlights={["0sink_YOUR_KEY"]} />
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
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Inference errors arrive in the provider&apos;s native envelope so a stock SDK classifies them;{" "}
            <Ns />&apos;s own endpoints return <code>{"{ error }"}</code>. Buying credit adds ~{MARKUP_PCT}% to
            the provider list price; spending debits their exact per-token rate.
          </span>
        </p>
      </section>
    </Layout>
  );
}
