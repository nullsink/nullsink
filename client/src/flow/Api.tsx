import type { ComponentType, ReactNode } from "react";
import { Layout } from "../Layout.tsx";
import { AnthropicMark, CodeBlock, Copy, KvRow, ModelChip, Ns, OpenAiMark, SquareGlyph, TinfoilMark } from "../ui.tsx";
import { EXT, GITHUB_URL } from "../lib/links.ts";

// /api — the API reference, read as TWO WIRE FORMATS side by side. The left rail is always Anthropic
// Messages, the right rail is always OpenAI-compatible; each format-specific concept (auth, endpoints,
// max-tokens, models, quickstart, errors) renders as a two-up <FormatPair> so a caller can scan one format
// straight down. Format-agnostic facts (base url, catalog, error codes) render as full-width <SharedBand>
// bands. Per-client setup (Claude Code / Hermes / OpenClaw / Pi) is the task-oriented integration guide;
// this page links out to it rather than carry a second, tutorial-shaped document. Every fact mirrors the
// proxy's real contract (core src/handler.ts + providers/) — if the served surface changes, change this
// page. Static: prerenders and reads with JS off (the copy buttons are the only JS). CodeBlock `highlights`
// tint the two things a caller swaps — their key and the model id.

const ANTHROPIC_HEADERS = `x-api-key: 0sink_YOUR_KEY
anthropic-version: 2023-06-01`;

const OPENAI_HEADERS = `Authorization: Bearer 0sink_YOUR_KEY`;

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
    "model": "gpt-5.5",
    "max_completion_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

// The error envelope is each format's NATIVE shape (so a stock SDK classifies the failure). The OpenAI form
// covers /chat/completions, /responses, AND Tinfoil, carrying the reason in `code`; Anthropic's /v1/messages
// wears its own, carrying the reason in `message`. Same reason string either way.
const ANTHROPIC_ERROR_SHAPE = `{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "max_tokens_required"
  }
}`;
const OPENAI_ERROR_SHAPE = `{
  "error": {
    "message": "max_tokens_required",
    "type": "invalid_request_error",
    "code": "max_tokens_required"
  }
}`;

// A representative slice of each format's served ids — the full, live catalog is GET /v1/models and the
// /models page. Tinfoil's open-weight set runs in an attested enclave, so it takes the seal.
const CLAUDE_IDS = ["claude-opus-4-8", "claude-haiku-4-5", "claude-fable-5"];
const OPENAI_IDS = ["gpt-5.5", "gpt-5.5-pro"];
const TINFOIL_IDS = ["gpt-oss-120b", "glm-5-2", "kimi-k2-6"];

// Tinfoil is the sealed-enclave provider, so its coin takes the purple seal ring instead of acid (same
// semantic as the SquareGlyph sealed marker on /models).
const SEALED = new Set<ComponentType<{ className?: string }>>([TinfoilMark]);

// The two rails, defined once: which coin(s) each carries and its name. LEFT is always Anthropic Messages,
// RIGHT is always OpenAI-compatible (OpenAI + the sealed Tinfoil provider share that wire format).
const RAILS = {
  anthropic: { marks: [AnthropicMark], name: "anthropic messages" },
  openai: { marks: [OpenAiMark, TinfoilMark], name: "openai-compatible" },
} as const;

// The three provider marks together — the "applies to both formats" signal that marks a shared band and the
// legend's middle cell (it replaces a "shared" text tag: all three coins = every provider).
const SHARED_MARKS = [AnthropicMark, OpenAiMark, TinfoilMark];

// Provider coins — the page's signature accent, shared by the legend and every rail head.
function Coins({ marks }: { marks: ComponentType<{ className?: string }>[] }) {
  return (
    <span className="ep-coins" aria-hidden="true">
      {marks.map((M, i) => (
        <span key={i} className={"ep-disc" + (SEALED.has(M) ? " sealed" : "")}>
          <M className="ep-ico" />
        </span>
      ))}
    </span>
  );
}

// One rail: a head (coins + format name) over a body. `side` picks which format it is.
function Rail({ side, children }: { side: keyof typeof RAILS; children: ReactNode }) {
  const r = RAILS[side];
  return (
    <div className="rail">
      <div className="rail-head">
        <Coins marks={[...r.marks]} />
        <span className="rail-name">{r.name}</span>
      </div>
      <div className="rail-body">{children}</div>
    </div>
  );
}

// A format-specific concept, rendered as an aligned two-up: an eyebrow (the concept heading + an optional
// hint) over the Anthropic | OpenAI rails. The concept is a real <h2> so the section outline stays intact
// for screen readers (it matches the <h2> a SharedBand renders).
function FormatPair({
  concept,
  hint,
  left,
  right,
}: {
  concept: string;
  hint?: string;
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <section className="section">
      <div className="fpair-eyebrow">
        <h2 className="concept">{concept}</h2>
        {hint && <span className="fpair-hint">{hint}</span>}
      </div>
      <div className="fpair-grid">
        <Rail side="anthropic">{left}</Rail>
        <Rail side="openai">{right}</Rail>
      </div>
    </section>
  );
}

// A format-agnostic fact: a full-width band headed by the three provider coins (the "shared" marker), a
// title, and an optional sub-note, over a pcard-style left-railed body.
function SharedBand({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="section">
      <div className="band">
        <div className="band-head">
          <Coins marks={SHARED_MARKS} />
          <h2>{title}</h2>
          {sub && <span className="band-sub">{sub}</span>}
        </div>
        <div className="band-body">{children}</div>
      </div>
    </section>
  );
}

// One endpoint row inside a rail or band: method · path · a copy button for the full URL. No provider coin
// here — the rail head already carries it (bands are format-agnostic).
function EpRow({ method, path }: { method: string; path: string }) {
  return (
    <div className="ep">
      <span className="ep-method">{method}</span>
      <span className="ep-path">{path}</span>
      <Copy value={`https://nullsink.is${path}`} />
    </div>
  );
}

// A model-id chip row (each id copies on click).
function Chips({ ids }: { ids: string[] }) {
  return (
    <div className="chips">
      {ids.map((id) => (
        <ModelChip key={id} id={id} />
      ))}
    </div>
  );
}

// One error code beside its cause.
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
      <div className="api-doc">
      <section className="section">
        <h1 className="page-h1">API reference</h1>
        <div className="note-cols">
          <p className="note">
            <span className="marker" aria-hidden="true">→</span>
            <span>
              <Ns /> mirrors the Anthropic and OpenAI wire formats. Point a stock SDK at it — only the base
              URL and the key change. <a href="/#buy">Mint a key</a>; model ids are on the{" "}
              <a href="/models/">models</a> page.
            </span>
          </p>
          <p className="note">
            <span className="marker" aria-hidden="true">!</span>
            <span>
              <span className="hl">Set a maximum output token count</span> — <code>max_tokens</code>{" "}
              (Anthropic), <code>max_completion_tokens</code> (OpenAI chat), or{" "}
              <code>max_output_tokens</code> (OpenAI responses). The standard strict configuration rejects
              an omission with <code>max_tokens_required</code>.
            </span>
          </p>
        </div>
      </section>

      {/* Decorative visual key for the coins — the two-rail model is already conveyed in real text by the
          intro note and each rail's visible name, so this is hidden from the a11y tree to avoid SR noise. */}
      <div className="legend" aria-hidden="true">
        <div className="legend-item">
          <Coins marks={[AnthropicMark]} />
          <span className="legend-name">anthropic messages</span>
        </div>
        <div className="legend-item">
          <Coins marks={SHARED_MARKS} />
          <span className="legend-name">both formats</span>
        </div>
        <div className="legend-item">
          <Coins marks={[OpenAiMark, TinfoilMark]} />
          <span className="legend-name">openai-compatible</span>
        </div>
      </div>

      <SharedBand title="Which base URL do I use?">
        <dl className="kv">
          <KvRow k="base url" values={["https://nullsink.is"]} />
        </dl>
        <p className="band-note">
          Endpoints live under <code>/v1</code>. An OpenAI SDK takes{" "}
          <code className="code-url">https://nullsink.is/v1</code> (it appends the tail); an Anthropic SDK
          takes the root <code className="code-url">https://nullsink.is</code> (it appends{" "}
          <code>/v1/messages</code>).
        </p>
      </SharedBand>

      <FormatPair
        concept="How do I authenticate?"
        left={
          <>
            <CodeBlock label="request headers" code={ANTHROPIC_HEADERS} highlights={["0sink_YOUR_KEY"]} />
            <p className="rail-note">
              <code>Authorization: Bearer</code> is also accepted.
            </p>
          </>
        }
        right={
          <>
            <CodeBlock label="request headers" code={OPENAI_HEADERS} highlights={["0sink_YOUR_KEY"]} />
            <p className="rail-note">
              <code>x-api-key</code> is also accepted.
            </p>
          </>
        }
      />

      <FormatPair
        concept="Which model endpoint do I call?"
        hint="native request/response schema each"
        left={<EpRow method="POST" path="/v1/messages" />}
        right={
          <>
            <EpRow method="POST" path="/v1/chat/completions" />
            <EpRow method="POST" path="/v1/responses" />
          </>
        }
      />

      <SharedBand title="How do I list models or check balance?">
        <EpRow method="GET" path="/v1/models" />
        <EpRow method="GET" path="/balance" />
        <p className="band-note">
          <code>GET /v1/models</code> lists every model this instance serves and its USD/Mtok price;{" "}
          <code>GET /balance</code> returns a key&apos;s remaining credit and specifically requires the token in
          <code> x-api-key</code>. The model catalog is unauthenticated. Full catalog on the{" "}
          <a href="/models/">models</a> page.
        </p>
      </SharedBand>

      <FormatPair
        concept="Which model ids are served?"
        left={
          <>
            <Chips ids={CLAUDE_IDS} />
            <p className="rail-note">
              Claude, first-party. <a href="/models/">All Claude models →</a>
            </p>
          </>
        }
        right={
          <>
            <Chips ids={OPENAI_IDS} />
            <div className="subgroup seal">
              <span className="subgroup-label seal">
                <SquareGlyph sealed className="tee-mark" />
                tinfoil · attested enclave
              </span>
              <Chips ids={TINFOIL_IDS} />
            </div>
            <p className="rail-note">
              <a href="/models/">All models →</a>
            </p>
          </>
        }
      />

      <FormatPair
        concept="How do I make a request?"
        left={
          <CodeBlock label="curl" code={ANTHROPIC_CURL} highlights={["0sink_YOUR_KEY", "claude-opus-4-8"]} />
        }
        right={<CodeBlock label="curl" code={OPENAI_CURL} highlights={["0sink_YOUR_KEY", "gpt-5.5"]} />}
      />

      <section className="section">
        <p className="note">
          <span className="marker" aria-hidden="true">→</span>
          <span>
            Wiring up an agent? Setup for <strong>Claude Code</strong>, <strong>Hermes</strong>,{" "}
            <strong>OpenClaw</strong> and <strong>Pi</strong> — including both wire formats —
            is in the{" "}
            <a href={`${GITHUB_URL}/blob/main/docs/client-integrations.md`} {...EXT}>
              integration guide
            </a>
            .
          </span>
        </p>
      </section>

      <FormatPair
        concept="Where is the error reason?"
        hint="each format's native envelope"
        left={
          <>
            <CodeBlock label="error · json" code={ANTHROPIC_ERROR_SHAPE} />
            <p className="rail-note">
              Reason carried in <code>error.message</code>.
            </p>
          </>
        }
        right={
          <>
            <CodeBlock label="error · json" code={OPENAI_ERROR_SHAPE} />
            <p className="rail-note">
              Reason carried in <code>error.code</code>. Covers <code>/chat/completions</code>,{" "}
              <code>/responses</code> and Tinfoil.
            </p>
          </>
        }
      />

      <SharedBand title="What does a rejected request mean?">
        <div className="band-cols">
          <ul className="err-list">
            <Err code="max_tokens_required">set the endpoint&apos;s maximum output token field</Err>
            <Err code="unsupported_model">the id isn&apos;t served — see /models</Err>
            <Err code="unsupported_option / unsupported_tool">remove a feature outside the token rate card</Err>
          </ul>
          <ul className="err-list">
            <Err code="insufficient_balance">the key is out of credit — top up</Err>
            <Err code="missing_api_key / invalid_token">send the complete funded token</Err>
            <Err code="rate_limited">too many requests right now — retry shortly</Err>
          </ul>
        </div>
        <ul className="dash-list">
          <li>
            <span className="lead-term">options</span> — <code>n</code> and <code>best_of</code> must be 1;
            unsupported ones return <code>unsupported_option</code>.
          </li>
          <li>
            <span className="lead-term">headers</span> — premium <code>anthropic-beta</code> features and
            org / project ids are stripped before forwarding.
          </li>
        </ul>
        <p className="band-note">
          Status codes, retry headers, and transient upstream failures are listed in the{" "}
          <a href={`${GITHUB_URL}/blob/main/docs/getting-started.md#what-does-a-rejected-model-request-mean`} {...EXT}>
            model-request error table
          </a>
          . Need a stripped feature or an unlisted model? Open a{" "}
          <a href={GITHUB_URL} {...EXT}>
            GitHub issue
          </a>
          .
        </p>
      </SharedBand>
      </div>
    </Layout>
  );
}
