import { useEffect, useMemo, useState } from "react";
import { qrSvg } from "./lib/qr.ts";
import { BUILD_VERSION } from "./version.ts";

// The sink mark — pixels funnel to a point, then fall into a void bar. currentColor
// so it recolors via `color`. Inlined (not <img>) to keep it on a self-origin page.
export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 350 350" role="img" aria-label="nullsink mark" fill="currentColor">
      <rect x="0" y="0" width="70" height="70" />
      <rect x="140" y="0" width="70" height="70" />
      <rect x="280" y="0" width="70" height="70" />
      <rect x="70" y="70" width="70" height="70" />
      <rect x="210" y="70" width="70" height="70" />
      <rect x="140" y="140" width="70" height="70" />
      <rect x="0" y="280" width="350" height="70" />
    </svg>
  );
}

// The sink mark with the "alive" pulse: each square fades on a shared 2.2s loop, offset by a per-square
// phase so the funnel breathes instead of blinking in unison. The offsets are mulberry32(seed) * 2.2 from
// the pattern generator — frozen here for SEED 4817, so it's deterministic and needs no runtime RNG. To
// reseed: re-run the generator and paste the new delays. Decorative motion → yields to prefers-reduced-motion
// (see .pulse-mark in app.css). Separate from <Mark> so the static brand wordmark never animates.
const PULSE_GEO = [
  { x: 0, y: 0, w: 70, h: 70 },
  { x: 140, y: 0, w: 70, h: 70 },
  { x: 280, y: 0, w: 70, h: 70 },
  { x: 70, y: 70, w: 70, h: 70 },
  { x: 210, y: 70, w: 70, h: 70 },
  { x: 140, y: 140, w: 70, h: 70 },
  { x: 0, y: 280, w: 350, h: 70 },
];
const PULSE_DELAYS = ["2.19s", "0.76s", "2.16s", "1.42s", "1.10s", "1.87s", "0.92s"]; // SEED 4817
export function PulseMark({ className }: { className?: string }) {
  return (
    <svg
      className={"pulse-mark" + (className ? " " + className : "")}
      viewBox="0 0 350 350"
      role="img"
      aria-label="nullsink mark"
      fill="currentColor"
    >
      {PULSE_GEO.map((g, i) => (
        <rect key={i} x={g.x} y={g.y} width={g.w} height={g.h} style={{ animationDelay: PULSE_DELAYS[i] }} />
      ))}
    </svg>
  );
}

// Provider marks for the /models page. Single-path, monochrome, fill=currentColor (viewBox 0 0 40 40) —
// sourced from models.dev's logo set and inlined (NOT <img>) so they inherit `color` and stay on a
// self-origin page under CSP `default-src 'self'`. Same inline + currentColor treatment as the brand Mark.
export function OpenAiMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" role="img" aria-label="OpenAI" fill="currentColor">
      <path d="M32.8377 17.282C33.2127 16.25 33.3072 15.218 33.2127 14.1875C33.1197 13.1571 32.7447 12.1251 32.2752 11.1876C31.4322 9.78209 30.2127 8.6571 28.8072 8.0001C27.3072 7.34461 25.7127 7.15711 24.1197 7.53211C23.3698 6.78212 22.5253 6.12512 21.5878 5.65713C20.6503 5.18913 19.5253 5.00013 18.4948 5.00013C16.8851 4.99074 15.3125 5.48246 13.9948 6.40712C12.6824 7.34311 11.7449 8.6571 11.2754 10.1571C10.1504 10.4376 9.21289 10.9071 8.27539 11.4696C7.4324 12.1251 6.77541 12.9696 6.21291 13.8126C5.36992 15.2195 5.08792 16.8125 5.27542 18.407C5.46399 19.9968 6.11605 21.496 7.1504 22.718C6.79608 23.7086 6.66795 24.7659 6.77541 25.8124C6.86991 26.8444 7.2449 27.8749 7.7129 28.8124C8.55739 30.2194 9.77538 31.3444 11.1824 31.9999C12.6824 32.6569 14.2753 32.8444 15.8698 32.4694C16.6198 33.2194 17.4628 33.8749 18.4003 34.3444C19.3378 34.8139 20.4628 34.9999 21.4948 34.9999C23.1043 35.0097 24.6769 34.5185 25.9947 33.5944C27.3072 32.6569 28.2447 31.3444 28.7127 29.8444C29.7719 29.6432 30.7682 29.1934 31.6197 28.5319C32.4627 27.8749 33.2127 27.1249 33.6822 26.1874C34.5251 24.7819 34.8071 23.1875 34.6196 21.5945C34.4322 20 33.8697 18.5015 32.8377 17.282ZM21.5878 33.0304C20.0878 33.0304 18.9628 32.5609 17.9323 31.7179C17.9323 31.7179 18.0253 31.6234 18.1198 31.6234L24.1197 28.1554C24.2862 28.0803 24.4196 27.9469 24.4947 27.7804C24.5698 27.636 24.6021 27.4731 24.5877 27.3109V18.875L27.1197 20.375V27.3124C27.1455 28.0547 27.0215 28.7945 26.755 29.4878C26.4885 30.181 26.085 30.8134 25.5687 31.3473C25.0523 31.8811 24.4337 32.3054 23.7497 32.5949C23.0658 32.8843 22.3305 33.0314 21.5878 33.0304ZM9.49488 27.8749C8.83789 26.7499 8.55739 25.4374 8.83789 24.125C8.83789 24.125 8.93239 24.2195 9.02539 24.2195L15.0253 27.6874C15.1693 27.7638 15.3325 27.7966 15.4948 27.7819C15.6823 27.7819 15.8698 27.7819 15.9628 27.6874L23.2753 23.4695V26.3749L17.1823 29.9374C16.5506 30.3042 15.8527 30.5427 15.1287 30.6393C14.4046 30.7358 13.6686 30.6884 12.9629 30.4999C11.4629 30.1249 10.2449 29.1874 9.49488 27.8749ZM7.9004 14.8445C8.56239 13.7234 9.58826 12.8627 10.8074 12.4056V19.532C10.8074 19.718 10.8074 19.907 10.9004 20C10.9755 20.1665 11.1089 20.2998 11.2754 20.375L18.5878 24.5944L16.0573 26.0944L10.0574 22.625C9.41842 22.2639 8.85742 21.7797 8.40684 21.2004C7.95627 20.6211 7.62506 19.9582 7.4324 19.25C7.05741 17.8445 7.1504 16.157 7.9004 14.8445ZM28.6197 19.625L21.3073 15.407L23.8377 13.9071L29.8377 17.375C30.7752 17.9375 31.5252 18.6875 31.9947 19.625C32.4642 20.5625 32.7447 21.5945 32.6502 22.7195C32.5603 23.7755 32.1699 24.7837 31.5252 25.6249C30.8697 26.4694 30.0252 27.1249 28.9947 27.4999V20.375C28.9947 20.1875 28.9947 20 28.9002 19.907C28.9002 19.907 28.8072 19.718 28.6197 19.625ZM31.1502 15.875C31.1502 15.875 31.0572 15.782 30.9627 15.782L24.9627 12.3126C24.7752 12.2196 24.6822 12.2196 24.4947 12.2196C24.3072 12.2196 24.1197 12.2196 24.0252 12.3126L16.7128 16.532V13.6251L22.8073 10.0626C23.7448 9.50009 24.7752 9.31259 25.9002 9.31259C26.9322 9.31259 27.9627 9.68759 28.9002 10.3446C29.7447 11.0001 30.4947 11.8446 30.8697 12.7821C31.2447 13.7196 31.3377 14.8445 31.1502 15.875ZM15.4003 21.125L12.8699 19.625V12.5946C12.8699 11.5626 13.1503 10.4376 13.7128 9.59459C14.2753 8.6571 15.1198 8.0001 16.0573 7.53211C17.0127 7.05249 18.0956 6.88812 19.1503 7.06261C20.1823 7.15711 21.2128 7.62511 22.0573 8.2821C22.0573 8.2821 21.9628 8.3751 21.8698 8.3751L15.8698 11.8446C15.7033 11.9197 15.57 12.0531 15.4948 12.2196C15.4003 12.4071 15.4003 12.5001 15.4003 12.6876V21.125ZM16.7128 18.125L19.9948 16.25L23.2753 18.125V21.875L19.9948 23.75L16.7128 21.875V18.125Z" />
    </svg>
  );
}

export function AnthropicMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" role="img" aria-label="Anthropic" fill="currentColor">
      <path d="M26.9568 9.88184H22.1265L30.7753 31.7848H35.4917L26.9568 9.88184ZM13.028 9.88184L4.4917 31.7848H9.32203L11.2305 27.1793H20.2166L22.0126 31.6724H26.8444L18.0832 9.88184H13.028ZM12.5783 23.1361L15.4987 15.3853L18.5315 23.1361H12.5783Z" />
    </svg>
  );
}

export function GeminiMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" role="img" aria-label="Google Gemini" fill="currentColor">
      <path d="M37 20.034C27.8809 20.5837 20.5808 27.8809 20.0326 37H19.966C19.4163 27.8809 12.1177 20.5837 3 20.034V19.9674C12.1191 19.4163 19.4163 12.1191 19.966 3H20.0326C20.5822 12.1191 27.8809 19.4163 37 19.9674V20.034Z" />
    </svg>
  );
}

export function GroqMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" role="img" aria-label="Groq" fill="currentColor">
      <path d="M20.056 4.50022C14.0839 4.44597 9.20616 9.15015 9.15036 15.0106C9.09611 20.8726 13.8855 25.6621 19.8576 25.7163H23.6085V21.7391H20.056C16.3252 21.7825 13.2671 18.8468 13.2237 15.1827C13.1787 11.5216 16.1702 8.52086 19.901 8.47746H20.056C23.7868 8.47746 26.8108 11.4457 26.8216 15.1083V24.8809C26.8216 28.5109 23.8085 31.4683 20.1211 31.5132C18.3617 31.5007 16.6759 30.8049 15.42 29.5726L12.551 32.3905C14.5529 34.3571 17.239 35.4715 20.0451 35.4998H20.1877C26.0823 35.413 30.8175 30.7212 30.85 24.9351V14.8603C30.7059 9.0928 25.9165 4.50022 20.056 4.50022Z" />
    </svg>
  );
}

// Tinfoil's mark (a crumpled-foil triangle; viewBox 0 0 960 960) — same inline + currentColor treatment as
// the provider marks above, so it inherits the card's text colour and stays on a self-origin page under CSP.
export function TinfoilMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 960 960" role="img" aria-label="Tinfoil" fill="currentColor">
      <path d="M955.4,718.23l-674.69,205.77L6.34,708.97,268.9,35.01l686.5,683.22ZM164.94,665.52l143.05,112.11,397.97-121.37-387.26-385.41-153.76,394.66Z" />
    </svg>
  );
}

// The square glyph the /models tiers are built on: a hairline square = a frontier provider that reads your
// text; `sealed` fills an inner square — the enclave/TEE mark, "can't read it at all". 1em + currentColor,
// so it scales and tints to its context (a tier header, a status badge, the trust diagram). Decorative —
// the visible text label always carries the meaning, so it's aria-hidden.
export function SquareGlyph({ sealed = false, className }: { sealed?: boolean; className?: string }) {
  return <span className={"sqg" + (sealed ? " sealed" : "") + (className ? " " + className : "")} aria-hidden="true" />;
}

// Coin marks for the pay-rail picker (Simple Icons, CC0; viewBox 0 0 24 24) — same inline + currentColor
// treatment as the provider marks, so they take the mono ink / acid-on-selection colour of the .seg button.
export function MoneroMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-label="Monero" fill="currentColor">
      <path d="M12 0C5.376 0 0 5.376 0 12c0 1.32.213 2.59.606 3.78h3.591V6.195L12 12.811l7.803-6.616v9.585h3.591c.393-1.19.606-2.46.606-3.78C24 5.376 18.624 0 12 0M10.422 14.063L5.379 9.879v8.226H1.594C3.781 21.66 7.617 24 12 24s8.219-2.34 10.406-5.895h-3.785V9.879l-5.043 4.184L12 15.346z" />
    </svg>
  );
}
export function BitcoinMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" role="img" aria-label="Bitcoin" fill="currentColor">
      <path d="M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.546zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.328-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.974.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.52 2.75 2.084z" />
    </svg>
  );
}
// Pick the mark for a rail by its server name; an unknown rail (a future coin) renders no glyph, just its label.
export function CoinMark({ name, className }: { name: string; className?: string }) {
  if (name === "monero") return <MoneroMark className={className} />;
  if (name === "bitcoin") return <BitcoinMark className={className} />;
  return null;
}

// GitHub mark (Simple Icons, CC0; viewBox 0 0 24 24) — decorative glyph for the About "source" link, so
// aria-hidden (the link's text carries the accessible name). Inline + currentColor, like the marks above.
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark className="mark" />
      <span>nullsink</span>
      <span className="wordmark-ver">{BUILD_VERSION}</span>
    </span>
  );
}

// The brand name, always as a highlighter mark wherever it appears in body text.
export const Ns = () => <span className="hl">nullsink</span>;

// The rate-source attribution for the active coin, venue names emphasized as a small trust signal. Takes the
// unit so it reads "XMR price…" / "BTC price…" — the quote's coin, never a hard-coded one.
export function RateSource({ unit }: { unit: string }) {
  return (
    <>
      {unit} price from <span className="src-name">Kraken</span>,{" "}
      <span className="src-name">CoinGecko</span> as fallback.
    </>
  );
}

// How long the "copied" acknowledgement stays lit before reverting.
const COPY_FEEDBACK_MS = 1500;

// Shared copy behaviour for the Copy button below: a `copied` flag that auto-clears, and a click
// handler that writes to the clipboard then lights the flag (silent if the Clipboard API is
// unavailable; the source text is also user-select:all as a fallback).
function useCopy(value: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => {});
  return { copied, copy };
}

// Copy button whose label swaps to "copied" for ~1.5s. No toast. `filled` swaps the bordered
// default for the acid (filled) variant — used where copy is the primary action (the key cell).
export function Copy({ value, label = "copy", filled = false }: { value: string; label?: string; filled?: boolean }) {
  const { copied, copy } = useCopy(value);
  return (
    <button type="button" className={"copy" + (filled ? " acid" : "") + (copied ? " copied" : "")} onClick={copy}>
      {copied ? "copied ✓" : label}
    </button>
  );
}

// A model id as a copy-on-click chip, for the /models cards: a click copies the exact id to paste into a
// config or SDK call, with a brief ✓. `down` flags an id the proxy prices but the upstream currently 404s
// for us — the danger register (a red tag + red-tinted border), still copyable since a call just refunds.
// Copy needs JS; with it off the chip still reads as the plain id (and is selectable). Same copy mechanics
// as <Copy>, so the "copied" acknowledgement and timing match.
export function ModelChip({ id, down = false }: { id: string; down?: boolean }) {
  const { copied, copy } = useCopy(id);
  return (
    <button
      type="button"
      className={"model-chip" + (down ? " down" : "") + (copied ? " copied" : "")}
      onClick={copy}
      aria-label={`copy ${id}${down ? " (unavailable)" : ""}`}
    >
      {id}
      {down && <span className="model-chip-down">down</span>}
      {copied && <span className="model-chip-ok" aria-hidden="true">✓</span>}
    </button>
  );
}

// One key/value integration row ("base url" → value + copy). `values` is a list so an endpoint row can
// carry more than one (OpenAI's two endpoints). Used by the /start integration panels.
export function KvRow({ k, values }: { k: string; values: string[] }) {
  return (
    <div className="kvrow">
      <dt className="kvk">{k}</dt>
      <dd className="kvv">
        {values.map((v) => (
          <span className="kvval" key={v}>
            {v} <Copy value={v} />
          </span>
        ))}
      </dd>
    </div>
  );
}

// A static code sample: labelled head with a copy control, then a <pre>. Render-pure (no browser APIs),
// so it prerenders; the copy button needs JS, but the code itself still reads (and selects) without it.
// `highlights` lists exact substrings (the placeholder key, the model id) to tint acid — the eye lands
// on what to replace / what to change. Copy always copies the raw, untinted string.
const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

export function CodeBlock({
  label,
  code,
  highlights = [],
}: {
  label: string;
  code: string;
  highlights?: string[];
}) {
  // Split on a capturing group so the matched substrings survive as their own parts, then tint
  // exactly those. Deterministic string work — safe for prerender and identical on hydration.
  const set = new Set(highlights);
  const parts = highlights.length
    ? code.split(new RegExp(`(${highlights.map((h) => h.replace(RE_ESCAPE, "\\$&")).join("|")})`, "g"))
    : [code];
  return (
    <div className="codeblock">
      <div className="code-head">
        <span>{label}</span>
        <Copy value={code} />
      </div>
      <pre className="code-body">
        <code>
          {parts.map((p, i) =>
            set.has(p) ? (
              <span key={i} className="code-hl">
                {p}
              </span>
            ) : (
              p
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

// Renders the QR as inline SVG markup from the bundled encoder (no network).
export function Qr({ data }: { data: string }) {
  const svg = useMemo(() => qrSvg(data), [data]);
  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// The one key component — used for both a freshly-minted key and an existing one being topped
// up. Masked by default (last 4 shown); reveal with "show". Copy is the filled (acid) control —
// it's the primary action here (save your key); show/hide is the bordered secondary one.
// UNRECOVERABLE is acid TEXT (a label, not a button) — that's the clickable-vs-decorative
// distinction: a fill/border carries an action, plain acid text is status.
export function KeyBlock({ token }: { token: string }) {
  const [hidden, setHidden] = useState(true);
  // Full-length mask so it reads as a real key on desktop (one line). On narrow screens the • run
  // wraps via .token's break rules (word-break + overflow-wrap), the same way the revealed token does.
  const masked = token.slice(0, 6) + "•".repeat(Math.max(0, token.length - 10)) + token.slice(-4);
  return (
    <div className="keycell">
      <div className="head">
        <span className="label">
          your key <span className="tag">unrecoverable</span>
        </span>
        <div className="head-right">
          <Copy value={token} label="copy" filled />
          <button type="button" className="copy" onClick={() => setHidden((h) => !h)}>
            {hidden ? "show" : "hide"}
          </button>
        </div>
      </div>
      <div className="body">
        <div className="token">{hidden ? masked : token}</div>
      </div>
    </div>
  );
}
