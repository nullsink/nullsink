import { Component, type ErrorInfo, type ReactNode } from "react";
import { Layout } from "./Layout.tsx";

// The one render-error backstop. Without it, a throw during render in ANY view white-screens the user with
// no fallback and no signal — at our traffic that could silently cost the one person trying the product.
//
// Transparent by design: the happy path returns `children` with NO wrapper element, so the rendered DOM is
// byte-identical with or without it — main.tsx (hydrate) and prerender.tsx (SSG) both wrap the tree here, so
// the static markup and the client's first render still agree (no hydration mismatch). React error boundaries
// are NOT invoked during renderToString, so a build-time throw still fails the prerender loudly (we want
// that — never ship a broken page); this only catches a throw in the BROWSER.
//
// Privacy: the only side effect on a crash is a local console.error — no network, no telemetry, nothing
// leaves the tab. The "no analytics" promise holds; this just hands a self-hoster (or a user with the console
// open) the stack instead of a blank screen. Recovery is a full-page nav home — a fresh document re-renders
// from scratch.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("nullsink: render error", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Layout>
        <section className="hero">
          <h1 className="note">
            <span>
              <span className="hl">error</span> — this page hit a snag.
            </span>
          </h1>
        </section>

        <section className="section">
          <p className="about-copy">
            Something broke while rendering this page — that&apos;s on our end, not yours. Reload to try
            again, or head back <a href="/">home</a>.
          </p>
        </section>
      </Layout>
    );
  }
}
