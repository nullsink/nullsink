import { useState } from "react";
import { BUY_MAX_USD, BUY_MIN_USD } from "./lib/api.ts";
import { Layout } from "./Layout.tsx";
import { KeyFlow } from "./flow/KeyFlow.tsx";
import { Terms } from "./flow/Terms.tsx";

// The landing page. Order follows the conversion path: hero → terms (directly above the purchase they
// gate) → the buy form → the integration quick-reference. The reference reads last because it's only
// useful to someone who already holds a key; the buy form is the page's one job, so it isn't buried
// under it.
//
// FOCUSED CHECKOUT: once a purchase is in flight (KeyFlow leaves its home phase), the marketing
// sections unmount and the page reduces to header + the flow + footer — no competing exits while
// money is moving, and no content below the widget to shift when its phases change height (which is
// why no min-height floor is needed). KeyFlow snaps scroll to top at each phase change.
// The prerendered (and JS-off) page is always the full landing: checkout starts false and only a
// user action can set it.
export function App() {
  const [checkout, setCheckout] = useState(false);
  return (
    <Layout>
      {!checkout && (
        <>
          {/* Three annotation lines, each marked by a decorative acid glyph (hidden from assistive
              tech): "?" = what this is (the page's one h1), "→" = the mechanics, "!" = the deal
              terms (price + cap) — the facts that qualify a visitor in ten seconds: payment rail,
              what it costs, how much they can load. Numbers render from the same constants the buy
              form uses (lib/api.ts), so the hero can't drift from the form. */}
          <section className="hero">
            <h1 className="note">
              <span className="marker" aria-hidden="true">?</span>
              <span>A simple LLM proxy, <span className="hl">private</span> by design.</span>
            </h1>
            <p className="note">
              <span className="marker" aria-hidden="true">→</span>
              <span>
                No account, no sign-up: mint a prepaid API key in your browser, fund it with Monero,
                Bitcoin, or any other coin via swap, and point any Anthropic or OpenAI SDK at it.
              </span>
            </p>
            <p className="note">
              <span className="marker danger" aria-hidden="true">!</span>
              <span>
                Early days: purchases are ${BUY_MIN_USD}–${BUY_MAX_USD} while capacity grows. Load can fluctuate while we
                scale, so brief outages may be frequent.
              </span>
            </p>
          </section>

          <section className="section" id="terms">
            <Terms />
          </section>
        </>
      )}

      <main id="buy">
        <KeyFlow onCheckoutChange={setCheckout} />
      </main>
    </Layout>
  );
}
