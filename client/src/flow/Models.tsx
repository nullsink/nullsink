import { type ComponentType, useState } from "react";
import { Layout } from "../Layout.tsx";
import { PulseMark, AnthropicMark, OpenAiMark, GeminiMark, GroqMark, TinfoilMark, SquareGlyph, ModelChip } from "../ui.tsx";
import { EXT } from "../lib/links.ts";
import models from "../models.json";

// The supported-models page. Models are grouped by the question that actually matters for a privacy proxy:
// WHO CAN READ YOUR MESSAGES. A sealed TEE (Tinfoil) can't read your text at all — privacy by silicon; a
// frontier provider (Anthropic, OpenAI) still processes it, under a no-logs policy — privacy by policy. The
// ids come from the vendored models.json snapshot (sync-models.ts ← core prices.json, newest-first), so the
// page can't list a model the proxy would reject. Each id is a copy-on-click chip. The page prerenders and
// reads with JS off: it ships the preview chips as plain text; the "all N models" reveal needs JS.

type Provider = (typeof models.providers)[number];

const byId = new Map<string, Provider>(models.providers.map((p) => [p.id, p]));

// provider id → inline logo mark. The data carries ids + labels; this adds the mark the JSON can't.
const LOGO: Record<string, ComponentType<{ className?: string }>> = {
  tinfoil: TinfoilMark,
  anthropic: AnthropicMark,
  openai: OpenAiMark,
};

// Listed/priced but the live upstream 404s for our account right now (a staged rollout we don't have access
// to yet). Shown, flagged "down" in the danger register, still copyable — the proxy prices it, so a request
// gets a clean refund on the 404. DISPLAY-ONLY: gating it at the proxy is a separate core change.
const UNAVAILABLE = new Set(["claude-fable-5"]);

// Chips shown before the "all N models" reveal. A card with more than this collapses to the newest PREVIEW;
// the rest expand in place below (the toggle stays under the chips, so the list never splits around it).
const PREVIEW = 6;

// The two trust tiers, in display order. Each names the providers it holds (looked up in models.json); a
// provider missing from the snapshot is simply skipped, so the page degrades to whatever the proxy prices.
const TIERS = [
  { key: "sealed", label: "Sealed", tagline: "privacy by silicon", sealed: true, providers: ["tinfoil"] },
  {
    key: "policy",
    label: "Proprietary",
    tagline: "privacy by policy",
    sealed: false,
    providers: ["anthropic", "openai"],
  },
] as const;

// On the roadmap, not yet routable (so deliberately not in models.json). Dimmed rows that set expectations.
const ROADMAP: { id: string; name: string; meta: string; Logo: ComponentType<{ className?: string }> }[] = [
  { id: "groq", name: "Groq", meta: "open weight", Logo: GroqMark },
  { id: "gemini", name: "Google Gemini", meta: "proprietary", Logo: GeminiMark },
];

function Chips({ ids }: { ids: string[] }) {
  return (
    <div className="model-chips">
      {ids.map((id) => (
        <ModelChip key={id} id={id} down={UNAVAILABLE.has(id)} />
      ))}
    </div>
  );
}

function ProviderCard({ provider, sealed }: { provider: Provider; sealed: boolean }) {
  const [open, setOpen] = useState(false);
  const Logo = LOGO[provider.id];
  const collapses = provider.models.length > PREVIEW;
  const visible = open || !collapses ? provider.models : provider.models.slice(0, PREVIEW);
  return (
    <div className={"pcard" + (sealed ? " sealed" : "")}>
      <div className="pcard-rail" aria-hidden="true" />
      <div className="pcard-body">
        <div className="pcard-head">
          {Logo && <Logo className="pcard-logo" />}
          <div className="pcard-name">
            <span className="pcard-title">{provider.label}</span>
            <span className="pcard-count">{provider.models.length} models</span>
          </div>
          <div className="pcard-tags">
            {sealed && (
              <span className="pill tee">
                <SquareGlyph sealed className="tee-mark" />
                Open weight
              </span>
            )}
            <span className="pill avail">available</span>
          </div>
        </div>
        <Chips ids={visible} />
        {collapses && (
          <button type="button" className="model-more-btn" onClick={() => setOpen((o) => !o)}>
            {open ? "show less" : `all ${provider.models.length} models`}
          </button>
        )}
      </div>
    </div>
  );
}

export function Models() {
  return (
    <Layout>
      <section className="section models">
        <h1 className="page-h1">Supported models</h1>

        <p className="note">
          <span className="marker" aria-hidden="true">$</span>
          <span>
            The model list and per-token prices come from{" "}
            <a href="https://models.dev" {...EXT}>
              models.dev
            </a>
            . You pay each provider&apos;s published rate.
          </span>
        </p>

        {/* The trust framing: the "who can read your messages" lede beside a static you → nullsink →
            {proprietary | enclave} diagram. The diagram is decorative (aria-hidden) — the lede says it in
            words. The right branch is a spine with a short wire into each node (sealed branch in seal). */}
        <div className="trust">
          <div className="trust-copy">
            <ul className="trust-points">
              <li className="lead">nullsink strips your identity.</li>
              <li>Proprietary models — the provider reads your text.</li>
              <li>Sealed models — even the provider can&apos;t read it.</li>
            </ul>
          </div>
          <div className="trust-path" aria-hidden="true">
            <span className="node">you</span>
            <span className="wire" />
            <span className="node sink">
              <PulseMark className="sink-mark" />
              <span className="node-cap">nullsink</span>
            </span>
            <span className="wire" />
            <span className="trust-branch">
              <span className="branch-row sealed">
                <span className="wire" />
                <span className="node sealed">
                  <SquareGlyph sealed /> enclave · sealed
                </span>
              </span>
              <span className="branch-row">
                <span className="wire" />
                <span className="node">
                  <SquareGlyph /> proprietary · receives plaintext
                </span>
              </span>
            </span>
          </div>
        </div>

        {TIERS.map((tier) => {
          const provs = tier.providers.map((id) => byId.get(id)).filter((p): p is Provider => p != null);
          if (provs.length === 0) return null;
          return (
            <section className={"tier" + (tier.sealed ? " sealed" : "")} key={tier.key}>
              <div className="tier-head">
                <SquareGlyph sealed={tier.sealed} className="tier-mark" />
                <span className="tier-label">{tier.label}</span>
                <span className="tier-tag">{tier.tagline}</span>
              </div>
              {provs.map((p) => (
                <ProviderCard key={p.id} provider={p} sealed={tier.sealed} />
              ))}
            </section>
          );
        })}

        <section className="tier roadmap">
          <div className="roadmap-head">On the roadmap</div>
          {ROADMAP.map(({ id, name, meta, Logo }) => (
            <div className="rm-row" key={id}>
              <Logo className="rm-logo" />
              <div className="rm-name">
                <span className="rm-title">{name}</span>
                <span className="rm-meta">{meta}</span>
              </div>
            </div>
          ))}
        </section>
      </section>
    </Layout>
  );
}
