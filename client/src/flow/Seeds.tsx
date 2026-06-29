import { Layout } from "../Layout.tsx";
import { PulseMark } from "../ui.tsx";
import { SEED_CANDIDATES, WORDMARK_SEED } from "../lib/pulse.ts";

// TEMP page (/seeds): compare the wordmark pulse rhythm across candidate seeds. Each cell renders
// <PulseMark seed={n}/>, which derives its per-square delays via pulseDelays(n) — the exact path the live
// wordmark takes — so a cell shows precisely what shipping that seed looks like. The seed list + generator
// live in lib/pulse.ts (single source of truth). Not in the sitemap, noindex. DELETE this page + its nav
// link (Layout) + the .seed-* CSS once a seed is locked in.
export function Seeds() {
  return (
    <Layout>
      <section className="section">
        <h1 className="page-h1">pulse seeds</h1>
        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            Temp page — each mark breathes on a different seed (derived deterministically). Pick a rhythm and
            I&apos;ll set the wordmark to it, then delete this page.
          </span>
        </p>
        <div className="seed-grid">
          {SEED_CANDIDATES.map((seed) => (
            <div className={"seed-cell" + (seed === WORDMARK_SEED ? " on" : "")} key={seed}>
              <PulseMark className="seed-mark" seed={seed} />
              <span className="seed-label">
                {seed}
                {seed === WORDMARK_SEED ? " · live" : ""}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Layout>
  );
}
