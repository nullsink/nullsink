import { Ns, Copy } from "../ui.tsx";
import { Terms } from "./Terms.tsx";
import { BASE_URL, BUY_MAX_USD, BUY_MIN_USD } from "../lib/api.ts";

// The landing's orient column (right of the buy card): the pitch, a copy-paste base URL, what's live, and
// the terms. Static — no fetch, prerenders and reads with JS off (the one copy button is the only JS).
// Unmounts once a purchase is in flight (see App.tsx). The availability list is plain service-status copy,
// not provider data — so it needs no /rails fetch and can't drift.
export function HomeOrient() {
  return (
    <aside className="home-orient">
      <p className="home-intro">
        <Ns /> is an API proxy for frontier and open-weight models. Buy a prepaid key here, then point your
        own tools at it. No sign-up, nothing to log in to.
      </p>

      <div className="qs">
        <div className="qs-label">point your tool here</div>
        <div className="qs-row">
          <span className="qs-k">base url</span>
          <span className="qs-v">{BASE_URL}</span>
          <Copy value={BASE_URL} />
        </div>
        <p className="qs-note">
          Works with any Anthropic or OpenAI SDK, curl, or Claude Code. <a href="/models/">See models →</a>
        </p>
      </div>

      <dl className="avail">
        <div className="avail-row">
          <dt>API access</dt>
          <dd className="on">
            <span className="avail-dot" aria-hidden="true" />
            live
          </dd>
        </div>
        <div className="avail-row">
          <dt>Hosted chat</dt>
          <dd className="soon">
            <span className="avail-dot" aria-hidden="true" />
            roadmap
          </dd>
        </div>
      </dl>

      <Terms />

      <p className="home-fine">
        Early access: ${BUY_MIN_USD}–${BUY_MAX_USD} per purchase while we scale. Brief outages may be
        frequent.
      </p>
    </aside>
  );
}
