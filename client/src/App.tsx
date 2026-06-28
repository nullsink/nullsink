import { useState } from "react";
import { Layout } from "./Layout.tsx";
import { KeyFlow } from "./flow/KeyFlow.tsx";
import { HomeOrient } from "./flow/HomeOrient.tsx";

// The landing page. Two columns: the buy card (LEFT) is the page's one job; the orient column (RIGHT)
// carries the pitch, the quick-start, what's live, and the terms. Once a purchase is in flight (KeyFlow
// leaves "home"), the orient column unmounts and the card morphs in place through pay → done, centering at
// the focused width — no competing exits while money is moving. Mobile is one column (orient above the
// card; the card alone during checkout). The prerendered (JS-off) page is the full two-column landing:
// `checkout` starts false and only a user action sets it.
//
// INVARIANT: <KeyFlow/> is mounted ONCE. The .home grid and <main id="buy"> render unconditionally in both
// states; only <HomeOrient/> is conditional and only the .checkout class flips. Never put KeyFlow behind a
// conditional/ternary parent or give it a state-dependent key — a remount would wipe the in-flight quote +
// polling mid-payment. `id="buy"` serves the /#buy deep-link from /start.
export function App() {
  const [checkout, setCheckout] = useState(false);
  return (
    <Layout wide>
      <div className={"home" + (checkout ? " checkout" : "")}>
        <main id="buy" className="home-buy">
          <KeyFlow onCheckoutChange={setCheckout} />
        </main>
        {!checkout && <HomeOrient />}
      </div>
    </Layout>
  );
}
