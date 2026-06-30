import { useEffect, useState } from "react";
import { AMOUNT_PRESETS, BUY_MAX_USD, BUY_MIN_USD, MARGIN, MARKUP_PCT, usd } from "../lib/api.ts";
import type { Rail } from "../lib/api.ts";
import { CoinMark } from "../ui.tsx";

// How long the out-of-range caption flashes acid after a clamp.
const FLASH_MS = 1000;

// One-line, honest per-coin descriptor under the picker. Unknown coins fall back to a neutral line.
const COIN_DESC: Record<string, string> = {
  monero: "private on-chain · confirms in ~20-45 min",
  bitcoin: "public on-chain · confirms in ~20-45 min",
};

// Pure amount picker: presets + a constrained field + the up-front price. No button — the
// parent form owns the single submit. Out-of-range input snaps on blur; the caption flashes.
export function AmountStep({
  amount,
  setAmount,
  rails,
  rail,
  setRail,
}: {
  amount: number;
  setAmount: (n: number) => void;
  rails: Rail[]; // active rails from /rails — the picker renders only when there are ≥2
  rail: string; // the selected rail name
  setRail: (r: string) => void;
}) {
  const [text, setText] = useState(String(amount));
  const [flash, setFlash] = useState(false);

  useEffect(() => setText(String(amount)), [amount]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  function commit() {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(amount));
      return;
    }
    const ranged = Math.min(BUY_MAX_USD, Math.max(BUY_MIN_USD, n));
    if (ranged !== n) setFlash(true); // flash only when out of range, not on rounding
    const val = Math.round(ranged * 100) / 100; // allow cents
    setAmount(val);
    setText(String(val));
  }

  return (
    <div className="amount-step">
      <div className="field-label">
        <span>amount</span>
        <span className={"range-inline" + (flash ? " flash" : "")}>
          <span>
            <span className="hl">min</span> ${BUY_MIN_USD}
          </span>
          <span>
            <span className="hl">max</span> ${BUY_MAX_USD}
          </span>
        </span>
      </div>
      {/* A clamp is a silent value change — announce the new amount politely (the visible caption only flashes). */}
      <span className="sr-only" role="status">{flash ? `amount set to ${usd(amount)}` : ""}</span>

      <div className="presets">
        {AMOUNT_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className="preset"
            aria-pressed={amount === p}
            onClick={() => setAmount(p)}
          >
            ${p}
          </button>
        ))}
      </div>

      <div className="custom">
        <div className="custom-label">or enter your own</div>
        <div className="custom-field">
          <span className="dollar" aria-hidden="true">$</span>
          <input
            className="amount-input"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))}
            onBlur={commit}
            // Enter here clamps the amount; it must NOT submit the parent form (you commit the
            // number first, then mint), so swallow the default submit.
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            aria-label="custom amount in USD"
          />
        </div>
      </div>

      <div className="price-line">
        {usd(amount)} credit + ~{MARKUP_PCT}% markup ≈{" "}
        <span className="hl">{usd(amount * MARGIN)}</span>
      </div>
      {/* Pay-rail picker — the coin is chosen HERE, before quoting, so one /buy fires with the right rail and
          the pay screen never has to re-quote a live single-use address. Renders only when ≥2 rails are active
          (one rail → single-coin flow, picker hidden). The .seg control marks the selected coin acid; the
          marks are currentColor so they take the same ink/acid. */}
      {rails.length >= 2 && (
        <div className="coin-pick">
          <div className="custom-label">pay with</div>
          <div className="seg coins">
            {rails.map((r) => (
              <button
                key={r.name}
                type="button"
                className={r.name === rail ? "on" : ""}
                aria-pressed={r.name === rail}
                onClick={() => setRail(r.name)}
              >
                <CoinMark name={r.name} className="coin-mark" />
                <span className="coin-name">{r.name}</span>
                <span className="coin-tic">{r.unit}</span>
              </button>
            ))}
          </div>
          <p className="coin-desc">{COIN_DESC[rail] ?? "paid on-chain"}</p>
        </div>
      )}
    </div>
  );
}
