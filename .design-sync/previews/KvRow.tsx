import { KvRow } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so every story sits on its own void surface.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)", padding: 20 }}>{children}</div>
);

// A single key/value row inside the app's <dl className="kv"> wrapper, as /api renders base url.
export const BaseUrl = () => (
  <Void>
    <dl className="kv">
      <KvRow k="base url" values={["https://nullsink.is"]} />
    </dl>
  </Void>
);

// The /api reference composition: three rows in one <dl>, the endpoints row carrying two values.
export const Reference = () => (
  <Void>
    <dl className="kv">
      <KvRow k="base url" values={["https://nullsink.is"]} />
      <KvRow k="endpoints" values={["/v1/messages", "/v1/chat/completions"]} />
      <KvRow k="auth header" values={["x-api-key"]} />
    </dl>
  </Void>
);
