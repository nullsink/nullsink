import { CodeBlock } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// The /api reference's canonical sample: highlights land on what the reader must replace.
export const Curl = () => (
  <Void>
    <CodeBlock
      label="curl"
      code={`curl https://nullsink.is/v1/messages \\
  -H "x-api-key: 0sink_YOUR_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "claude-opus-4-8",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'`}
      highlights={["0sink_YOUR_KEY", "claude-opus-4-8"]}
    />
  </Void>
);

// Short header sample — the two-line integration snippet.
export const RequestHeaders = () => (
  <Void>
    <CodeBlock
      label="request headers"
      code={`x-api-key: 0sink_YOUR_KEY
anthropic-version: 2023-06-01`}
      highlights={["0sink_YOUR_KEY"]}
    />
  </Void>
);

// `comment` dims annotation lines; a highlight inside a comment still tints acid.
export const WithComments = () => (
  <Void>
    <CodeBlock
      label="python"
      code={`# point the SDK at nullsink — everything else is unchanged
client = Anthropic(
    base_url="https://nullsink.is",
    api_key="0sink_YOUR_KEY",  # prepaid, anonymous
)`}
      comment="#"
      highlights={["0sink_YOUR_KEY"]}
    />
  </Void>
);
