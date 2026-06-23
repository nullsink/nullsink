import type { ComponentType } from "react";
import { Layout } from "../Layout.tsx";
import { Ns, OpenAiMark, AnthropicMark, GeminiMark, KimiMark, DeepSeekMark, MistralMark } from "../ui.tsx";
import { EXT } from "../lib/links.ts";
import models from "../models.json";
import { MARKUP_PCT } from "../lib/api.ts";

// The supported-models page: provider rows with the model list behind a native <details> disclosure.
// The live providers come from the vendored src/models.json snapshot (see sync-models.ts) — no fetch, no
// state, and <details> is plain HTML, so the page still prerenders and reads (and expands) with JS off.
// Collapsed it stays a provider-level summary; expanded it answers "is MY model on here?" without a model
// dump dominating the page. On-roadmap providers are marked coming soon. No pricing: the per-model rate is
// the upstream rate × margin, locked server-side, so it lives with the buy flow.

// provider id → inline logo mark (currentColor, so it takes the row's text color).
const LOGO: Record<string, ComponentType<{ className?: string }>> = {
  anthropic: AnthropicMark,
  openai: OpenAiMark,
  google: GeminiMark,
};

// Providers on the roadmap but not yet wired up: shown dimmed so the page sets expectations. They aren't
// in models.json (the proxy doesn't price them yet); move one here → live by adding it to sync-models.ts.
const COMING_SOON = [{ id: "google", label: "Google Gemini" }];

// Models that are listed/priced but that the live upstream 404s for our account right now (e.g. a model in
// staged rollout we don't have access to yet). Shown but flagged, so the page doesn't promise a route that
// 404s. DISPLAY-ONLY: the proxy still prices these (core prices.json), so a request gets a clean refund on
// the upstream 404 — gating them at the proxy is a separate core change (cli/sync-prices.ts ANTHROPIC_RETIRED).
// Flagged RED at the operator's request: a deliberate exception to the money-only red reservation noted in
// app.css (red elsewhere means "this can cost you"); here it means "down".
const UNAVAILABLE = new Set(["claude-fable-5"]);

function Logo({ id }: { id: string }) {
  const Mark = LOGO[id];
  return Mark ? <Mark className="provider-logo" /> : <span className="provider-logo" aria-hidden="true" />;
}

export function Models() {
  return (
    <Layout>
      <section className="section">
        <h1 className="page-h1">Supported models</h1>

        <p className="note">
          <span className="marker" aria-hidden="true">?</span>
          <span>
            The providers the <Ns /> proxy routes to. The list is derived from{" "}
            <a href="https://models.dev" {...EXT}>
              models.dev
            </a>
            .
          </span>
        </p>
        <p className="note">
          <span className="marker" aria-hidden="true">$</span>
          <span>
            Usage is billed at the provider&apos;s published per-token rate. The ~{MARKUP_PCT}% markup is paid
            once, when you buy credit — <a href="/start/">pricing details</a>.
          </span>
        </p>
        <p className="note">
          <span className="marker" aria-hidden="true">+</span>
          <span>More providers and models are added as capacity allows.</span>
        </p>

        <ul className="providers">
          {models.providers.map((p) => (
            <li className="provider" key={p.id}>
              <details className="provider-details">
                <summary className="provider-row">
                  <Logo id={p.id} />
                  <div className="provider-main">
                    <span className="provider-name">{p.label}</span>
                    <span className="provider-meta">{p.models.length} models</span>
                  </div>
                  <span className="provider-tag">available</span>
                  <span className="provider-toggle" aria-hidden="true" />
                </summary>
                <ul className="provider-models">
                  {p.models.map((id) => (
                    <li key={id} className={UNAVAILABLE.has(id) ? "unavailable" : undefined}>
                      {id}
                      {UNAVAILABLE.has(id) && <span className="model-tag-unavailable">unavailable</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
          {COMING_SOON.map((p) => (
            <li className="provider soon" key={p.id}>
              <div className="provider-row">
                <Logo id={p.id} />
                <div className="provider-main">
                  <span className="provider-name">{p.label}</span>
                  <span className="provider-meta">not yet available</span>
                </div>
                <span className="provider-tag soon">coming soon</span>
              </div>
            </li>
          ))}
          {/* Open-source / open-weight tier on the roadmap: three overlapping model marks instead of one
              provider logo, to signal breadth. Self-hosted is a future direction (see the competitive note). */}
          <li className="provider soon">
            <div className="provider-row">
              <span className="provider-logos" aria-hidden="true">
                <span className="stack-disc"><DeepSeekMark className="stack-ico" /></span>
                <span className="stack-disc"><KimiMark className="stack-ico" /></span>
                <span className="stack-disc"><MistralMark className="stack-ico" /></span>
              </span>
              <div className="provider-main">
                <span className="provider-name">Open-source models</span>
                <span className="provider-meta">self-hosted · not yet available</span>
              </div>
              <span className="provider-tag soon">coming soon</span>
            </div>
          </li>
        </ul>
      </section>
    </Layout>
  );
}
