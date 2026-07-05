import { Layout } from "nullsink-client";
import type { ReactNode } from "react";

// nullsink is dark-first; the card chrome is white, so the story sits on its own void surface.
// No padding here: the shell is min-height:100vh and brings its own margins, so any wrapper
// padding just pushes the footer past the card viewport.
const Void = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "var(--ns-void)" }}>{children}</div>
);

// The full page shell: header bar (wordmark home link + api/models nav, "api" active), the content
// column with simple page children, and the footer — policy/community links over the never-collect
// chip row. min-height:100vh by design; it needs a single-card full-page viewport, not a grid cell.
export const Page = () => (
  <Void>
    {/* the skip-link is an a11y affordance (absolute, above the shell) — in a static card it just
        pokes onto the white chrome, so hide it here. */}
    <style>{`.skip-link { display: none; }`}</style>
    <Layout nav="api">
      <h1 className="page-h1">api</h1>
      <p className="note">
        <span>
          Point a stock SDK at <code>https://nullsink.is</code> — only the base URL and the key change.
        </span>
      </p>
    </Layout>
  </Void>
);
