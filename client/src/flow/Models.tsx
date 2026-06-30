import { type ComponentType, useState } from "react";
import { Layout } from "../Layout.tsx";
import { AnthropicMark, OpenAiMark, GeminiMark, GroqMark, PrivatemodeMark, TinfoilMark, SquareGlyph, ModelChip, ExtMark } from "../ui.tsx";
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

// provider id → homepage. The card title links out to it (the same provider sites the home page links).
const SITE: Record<string, string> = {
  tinfoil: "https://tinfoil.sh",
  anthropic: "https://www.anthropic.com",
  openai: "https://openai.com",
};

// Listed/priced but the live upstream 404s for our account right now (a staged rollout we don't have access
// to yet). Shown, flagged "down" in the danger register, still copyable — the proxy prices it, so a request
// gets a clean refund on the 404. DISPLAY-ONLY: gating it at the proxy is a separate core change.
const UNAVAILABLE = new Set(["claude-fable-5"]);

// Chips shown before the "all N models" reveal. A card with more than this collapses to the newest PREVIEW;
// the rest expand in place below (the toggle stays under the chips, so the list never splits around it).
const PREVIEW = 6;

// "5 models" / "1 model" — pluralize the count so a single-model provider doesn't read "1 models".
const modelCount = (n: number): string => `${n} model${n === 1 ? "" : "s"}`;

// The two trust tiers, in display order. Each names the providers it holds (looked up in models.json); a
// provider missing from the snapshot is simply skipped, so the page degrades to whatever the proxy prices.
const TIERS = [
  { key: "sealed", label: "Sealed", tagline: "privacy by silicon", sealed: true, providers: ["tinfoil"] },
  {
    key: "policy",
    label: "Closed source",
    tagline: "privacy by policy",
    sealed: false,
    providers: ["anthropic", "openai"],
  },
] as const;

// On the roadmap, not yet routable (so deliberately not in models.json). Dimmed rows that set expectations.
// Privatemode AI is a sealed-enclave provider (attested TEE, open-weight models) — the SAME class as Tinfoil,
// so it reads "sealed · open weight", not "confidential".
const ROADMAP: { id: string; name: string; meta: string; Logo: ComponentType<{ className?: string }> }[] = [
  { id: "privatemode", name: "Privatemode AI", meta: "sealed · open weight", Logo: PrivatemodeMark },
  { id: "groq", name: "Groq", meta: "open weight", Logo: GroqMark },
  { id: "gemini", name: "Google Gemini", meta: "closed source", Logo: GeminiMark },
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
            <h3 className="pcard-title">
              {SITE[provider.id] ? (
                <a href={SITE[provider.id]} {...EXT}>
                  <span className="title-name">{provider.label}</span>
                  <ExtMark className="title-ext" />
                </a>
              ) : (
                provider.label
              )}
            </h3>
            <span className="pcard-count">{modelCount(provider.models.length)}</span>
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
            {open ? "show less" : `all ${modelCount(provider.models.length)}`}
          </button>
        )}
      </div>
    </div>
  );
}

export function Models() {
  return (
    <Layout nav="models">
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

        {TIERS.map((tier) => {
          const provs = tier.providers.map((id) => byId.get(id)).filter((p): p is Provider => p != null);
          if (provs.length === 0) return null;
          return (
            <section className={"tier" + (tier.sealed ? " sealed" : "")} key={tier.key}>
              <div className="tier-head">
                <SquareGlyph sealed={tier.sealed} className="tier-mark" />
                <h2 className="tier-label">{tier.label}</h2>
                <span className="tier-tag">{tier.tagline}</span>
              </div>
              {provs.map((p) => (
                <ProviderCard key={p.id} provider={p} sealed={tier.sealed} />
              ))}
            </section>
          );
        })}

        <section className="tier roadmap">
          <h2 className="roadmap-head">On the roadmap</h2>
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
