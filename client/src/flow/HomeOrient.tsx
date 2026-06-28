import { Ns, AnthropicMark, OpenAiMark, TinfoilMark } from "../ui.tsx";
import { Terms } from "./Terms.tsx";
import { BUY_MAX_USD, BUY_MIN_USD } from "../lib/api.ts";

// The landing's orient column (right of the buy card): the pitch, the terms, then the models + service
// status. Static — no fetch, prerenders and reads with JS off. Unmounts once a purchase is in flight (see
// App.tsx). The status rows are plain copy, not provider data — so they can't drift.
export function HomeOrient() {
  return (
    <aside className="home-orient">
      <p className="home-intro">
        <Ns /> is an API proxy for frontier and open-weight models. Buy a prepaid key here, then point your
        own tools at it. No sign-up.
      </p>

      <Terms />

      <dl className="avail">
        <div className="avail-row">
          <dt>
            <a className="model-link" href="/models/">
              models
            </a>
          </dt>
          <dd>
            <span className="model-stack" aria-hidden="true">
              <span className="stack-disc">
                <TinfoilMark className="stack-ico" />
              </span>
              <span className="stack-disc">
                <AnthropicMark className="stack-ico" />
              </span>
              <span className="stack-disc">
                <OpenAiMark className="stack-ico" />
              </span>
            </span>
          </dd>
        </div>
        <div className="avail-row">
          <dt>API access</dt>
          <dd className="on">
            <span className="avail-dot" aria-hidden="true" />
            live
          </dd>
        </div>
        <div className="avail-row">
          <dt>Web chat</dt>
          <dd className="soon">
            <span className="avail-dot" aria-hidden="true" />
            roadmap
          </dd>
        </div>
      </dl>

      <p className="home-fine">
        Early access: ${BUY_MIN_USD}–${BUY_MAX_USD} per purchase while we scale. Brief outages may be
        frequent.
      </p>
    </aside>
  );
}
