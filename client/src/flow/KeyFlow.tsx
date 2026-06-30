import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BuyError, Quote, Rail } from "../lib/api.ts";
import { buyErrorMessage, checkBalance, getRails, RAILS_OPTIMISTIC, requestQuote, usd } from "../lib/api.ts";
import { generateToken, hashToken, keyFieldState } from "../lib/token.ts";
import { KeyBlock } from "../ui.tsx";
import { EXT } from "../lib/links.ts";
import { AmountStep } from "./AmountStep.tsx";
import { QuotePay } from "./QuotePay.tsx";

// Snap flow. Home is one form: pick an amount + a key (new by default, or paste an existing
// one), then one button. Minting and topping up are the SAME submit; the only difference is
// whether the key is generated or pasted. Checking a balance is an instant inline lookup, never
// a new screen. Then: pay → done. No key-management detour.
type Phase = "home" | "pay" | "done";

// The active purchase, frozen at submit time: which key, whether it was freshly minted, and the
// balance captured at quote time (so a top-up's success is a real delta, not just "> 0").
type Order = { token: string; wasNew: boolean; baseline: number };

// `onCheckoutChange` tells the page when a purchase is in flight (any non-home phase) so it can
// switch to the focused checkout — hiding the marketing sections while money is moving.
export function KeyFlow({ onCheckoutChange }: { onCheckoutChange?: (active: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>("home");
  const [amount, setAmount] = useState(10);
  const [agreed, setAgreed] = useState(false);
  // Active pay rails + the selected one. Seeded OPTIMISTICALLY (RAILS_OPTIMISTIC) so the picker is present at
  // first paint — including in the prerendered/JS-off page — instead of popping in after GET /rails resolves.
  // getRails() (below) reconciles against the server's authoritative set; the picker renders only when ≥2 rails.
  const [rails, setRails] = useState<Rail[]>(RAILS_OPTIMISTIC.rails);
  const [rail, setRail] = useState(RAILS_OPTIMISTIC.default);

  // Layout effect, NOT a passive effect: a passive effect fires after paint, so one frame of the
  // pay screen still sandwiched between the (not-yet-unmounted) marketing sections reaches the
  // screen — a visible flicker on every phase change. A setState inside a layout effect re-renders
  // synchronously before paint, so the page flips landing ↔ checkout in a single frame.
  useLayoutEffect(() => {
    onCheckoutChange?.(phase !== "home");
  }, [phase, onCheckoutChange]);

  // Phase changes are full context switches (landing ↔ checkout): the surrounding sections
  // mount/unmount, so a preserved scroll offset is meaningless — snap to top so the eye lands on
  // the new phase's heading (the key panel, the funded summary, or the form). Layout effect so the
  // scroll happens before paint (no flash at the stale offset); the ref guard keeps hydration from
  // yanking a visitor who arrived mid-scroll (e.g. at /#buy).
  const prevPhase = useRef(phase);
  useLayoutEffect(() => {
    if (prevPhase.current !== phase) window.scrollTo(0, 0);
    prevPhase.current = phase;
  }, [phase]);

  // Reconcile the optimistic seed against the server's authoritative set once on mount. Read-only +
  // privacy-neutral; getRails() falls back to a one-rail default on any failure, so this never blocks the form.
  // Keep the user's current coin if it survived into the reconciled set (they may have picked one before /rails
  // resolved); otherwise take the server default. Picker shows only when ≥2 rails.
  useEffect(() => {
    getRails().then((r) => {
      setRails(r.rails);
      setRail((cur) => (r.rails.some((x) => x.name === cur) ? cur : r.default));
    });
  }, []);

  // The "tick the terms box first" nudge: shown when submit is attempted without consent, cleared
  // the moment the box is ticked (the render condition includes !agreed).
  const [agreeNudge, setAgreeNudge] = useState(false);
  const agreeRef = useRef<HTMLInputElement>(null);

  const [paste, setPaste] = useState("");
  const [checking, setChecking] = useState(false);
  const [didCheck, setDidCheck] = useState(false);
  const [checkedBalance, setCheckedBalance] = useState<number | null>(null);
  // A transient /balance read failure (server read-throttle 429, network, or 5xx) is distinct from a
  // genuine "no balance" (the null RETURN, i.e. the 401 path). Without this we'd render "no balance" on a
  // throttle and tell someone with a funded key it's empty.
  const [checkError, setCheckError] = useState(false);

  // The save-gate for a freshly-minted key: payment details stay hidden until the user affirms the
  // key is saved. A minted key exists only in this tab's memory — if the tab dies during the ~30
  // minute confirmation wait, an unsaved key (and the credit being bought) is gone. The affirmative
  // act is the forcing function the muted hint can't be. Top-ups skip it: a pasted key is already
  // in the user's possession.
  const [savedAck, setSavedAck] = useState(false);

  // null = no purchase in flight. Set once at submit, cleared in buyMore.
  const [order, setOrder] = useState<Order | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [finalBalance, setFinalBalance] = useState(0);

  // Leave-warning whenever a key is on screen (pay + done, any key). For a minted key it's
  // load-bearing — it's unrecoverable, so a lost key loses the credit; for a pasted top-up it's
  // reassurance (that key is recoverable, but a confirm-on-leave still calms nerves mid-payment).
  // BEST-EFFORT ONLY: WKWebView-based browsers (DuckDuckGo, most in-app webviews) never show a
  // beforeunload prompt no matter what the page does — the structural guard is the click-capture
  // effect below. The non-empty returnValue is for legacy engines; modern ones ignore the text.
  useEffect(() => {
    if (phase === "home") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "A key is on screen. Leaving may lose it.";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  // The structural leave-guard: while a key is on screen, ANY link click on the page (header nav,
  // footer, in-flow links) is retargeted into a new tab, so the tab holding the key never navigates
  // away. This is what actually protects users whose browser suppresses beforeunload (see above).
  // Capture phase so it runs before navigation starts. The anchor is MUTATED (target=_blank) rather
  // than preventDefault + window.open: a real link click with target=_blank is never popup-blocked
  // (window.open can be, leaving silently dead links mid-purchase), and modifier-clicks (cmd/middle)
  // keep their native background-tab semantics. getAttribute/setAttribute, not .target, so a future
  // SVG <a> (SVGAnimatedString) can't break it.
  useEffect(() => {
    if (phase === "home") return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a || a.getAttribute("target") === "_blank") return;
      if (a.getAttribute("href")?.startsWith("#")) return; // same-page scroll, not a navigation
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [phase]);

  const acknowledge = useCallback(
    async (tok: string) => {
      setBusy(true);
      setErrorCode(null);
      try {
        const hash = await hashToken(tok);
        setQuote(await requestQuote(hash, amount, rail || undefined));
      } catch (e) {
        setErrorCode((e as BuyError).code ?? "unknown");
      } finally {
        setBusy(false);
      }
    },
    [amount, rail],
  );

  const keyState = keyFieldState(paste);

  async function check() {
    if (!keyState.willTopUp) return;
    setChecking(true);
    setCheckError(false);
    try {
      setCheckedBalance(await checkBalance(paste));
    } catch {
      // A THROWN error is transient (read-throttle 429 / network / 5xx), not "no balance" — that's the
      // null RETURN (401). Flag it so we show "try again" rather than implying the key is empty.
      setCheckedBalance(null);
      setCheckError(true);
    } finally {
      setDidCheck(true);
      setChecking(false);
    }
  }

  // Quote BEFORE navigating to the pay screen. An environmental failure (rate/wallet/busy/rate-limit)
  // then surfaces inline on THIS form, instead of stranding the user on the pay screen with a freshly
  // shown key and an error. Those errors also create NO order/address server-side (the handler
  // returns before that), so a failed attempt leaves zero state and a retry is clean.
  async function submit() {
    // Click-through acceptance still gates the purchase — but with an enabled button that EXPLAINS
    // on click (inline notice + focus the checkbox) instead of a disabled one: a dead button is
    // unfocusable, gives no reason, and the page's primary CTA shouldn't be born inert. The
    // affirmative act is still required, so enforceability is unchanged.
    if (!agreed) {
      setAgreeNudge(true);
      agreeRef.current?.focus();
      return;
    }
    // A non-blank but malformed key blocks the purchase (the CTA is also disabled in that state).
    if (keyState.malformed) return;
    const useExisting = keyState.willTopUp; // blank field → mint a new key; a valid token → top it up
    const tok = useExisting ? paste : generateToken();
    const wasNew = !useExisting;
    setBusy(true);
    setErrorCode(null);
    // Top-up: snapshot the existing balance first — the baseline a success delta is measured against.
    // A transient failure here is non-fatal: fall back to 0 (success is still balance > baseline).
    let baseline = 0;
    if (!wasNew) {
      try {
        baseline = (await checkBalance(tok)) ?? 0;
      } catch {
        baseline = 0;
      }
    }
    try {
      const hash = await hashToken(tok);
      const q = await requestQuote(hash, amount, rail || undefined);
      setOrder({ token: tok, wasNew, baseline });
      setQuote(q);
      setPhase("pay"); // navigate ONLY once a payable quote is in hand
    } catch (e) {
      setErrorCode((e as BuyError).code ?? "unknown");
    } finally {
      setBusy(false);
    }
  }

  function buyMore() {
    setPhase("home");
    setSavedAck(false); // the next minted key needs its own affirmation
    setAgreeNudge(false); // a stale nudge must not greet the fresh form (agreed resets below)
    setOrder(null);
    setPaste("");
    setDidCheck(false);
    setCheckedBalance(null);
    setCheckError(false);
    setQuote(null);
    setErrorCode(null);
    setAgreed(false); // each purchase re-acknowledges the terms (separate contract)
  }

  // ---- HOME: the buy form ----
  if (phase === "home") {
    return (
      <form
        className="section"
        onSubmit={(e) => {
          e.preventDefault(); // we mint + fetch in-page; never navigate (the raw key lives only in memory)
          submit();
        }}
      >
        {/* The optional key field leads the form: a returning user tops up here; a new user sees it once,
            leaves it blank, and continues straight down through amount → terms. Blank mints a fresh key; a
            valid token tops it up (check its balance with the button). */}
        <div className="have-key-inline">
          <div className="keyfield-head">
            <span>have a key?</span>
            <span className="keyfield-opt">optional</span>
          </div>
          <input
            className="paste-input"
            type="text"
            name="nullsink-key"
            placeholder="0sink_…"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value.trim());
              setDidCheck(false);
              setCheckError(false);
            }}
            aria-label="your 0sink_ token — leave blank to mint a new key"
          />
          {/* the check-balance control is always visible; it's disabled until a valid key is present. */}
          <div className="balance-check">
            <button type="button" className="check-btn" disabled={!keyState.willTopUp || checking} onClick={check}>
              {checking ? "checking…" : "check balance"}
            </button>
            {keyState.willTopUp &&
              didCheck &&
              (checkError ? (
                <span className="check-line none">couldn't check, try again in a moment</span>
              ) : (
                <span className={"check-line" + (checkedBalance === null ? " none" : "")}>
                  {checkedBalance !== null
                    ? `balance: ${usd(checkedBalance)}`
                    : "no balance for this key. deposits confirm in ~20-45 min"}
                </span>
              ))}
          </div>
          {keyState.malformed && (
            <div className="range-cap">that key doesn't look valid: check for a typo or missing characters</div>
          )}
          <p className="hint">Leave blank to mint a fresh key in your browser.</p>
        </div>

        <AmountStep
          amount={amount}
          setAmount={setAmount}
          rails={rails}
          rail={rail}
          setRail={setRail}
        />

        {/* Environmental /buy errors (rate/wallet/busy/rate-limit) surface here, pre-navigation. */}
        {errorCode && <div className="notice">{buyErrorMessage(errorCode)}</div>}

        {/* Click-through acceptance gates the purchase, so the full terms (linked to /terms/, opened in a new
            tab so the buy flow and its leave-warning aren't disturbed) are agreed before an irreversible
            payment. This is what makes them enforceable; it doesn't gate a balance check. */}
        <label className="agree">
          <input
            ref={agreeRef}
            type="checkbox"
            checked={agreed}
            onChange={(e) => {
              setAgreed(e.target.checked);
              setAgreeNudge(false); // any interaction with the box retires the nudge
            }}
          />
          <span>
            I have read and agree to the{" "}
            <a href="/terms/" {...EXT}>
              terms
            </a>
            .
          </span>
        </label>

        {/* role="alert" so the reason a click did nothing is announced, not just painted */}
        {agreeNudge && !agreed && (
          <div className="notice" role="alert">
            Tick the box above to agree to the terms first.
          </div>
        )}

        <button
          className="btn-primary"
          type="submit"
          disabled={busy || keyState.malformed}
        >
          {busy ? "requesting…" : keyState.willTopUp ? "add credit →" : "mint key →"}
        </button>

      </form>
    );
  }

  // ---- PAY ----
  if (phase === "pay") {
    if (!order) return null; // unreachable: phase is "pay" only after submit() sets the order
    const gated = order.wasNew && !savedAck; // save-gate: minted keys only (see savedAck above)
    return (
      <div className="section">
        <h1 className="flow-h1">{order.wasNew ? "Your new key" : "Add credit"}</h1>

        <KeyBlock token={order.token} />

        {gated ? (
          <>
            <p className="hint">
              This key is the only way to spend the credit. There&apos;s no account and no recovery.{" "}
              <span className="hl">Copy it somewhere safe</span>, then confirm to see the payment details.
            </p>
            <label className="agree">
              <input
                type="checkbox"
                checked={savedAck}
                onChange={(e) => setSavedAck(e.target.checked)}
              />
              <span>I saved my key.</span>
            </label>
          </>
        ) : (
          <QuotePay
            token={order.token}
            quote={quote}
            baseline={order.baseline}
            busy={busy}
            errorCode={errorCode}
            onRetry={() => acknowledge(order.token)}
            onFunded={(b) => {
              setFinalBalance(b);
              setPhase("done");
            }}
          />
        )}
      </div>
    );
  }

  // ---- DONE ----
  if (!order) return null; // unreachable: phase is "done" only after a funded order
  return (
    <div className="section">
      <h1 className="sr-only">{order.wasNew ? "Key funded" : "Credit added"}</h1>
      <div className="funded-head">
        <span className="funded-tag">{order.wasNew ? "funded" : "topped up"}</span>
        <span className="balance">
          {usd(finalBalance)}
          {!order.wasNew && order.baseline > 0 && (
            <span className="delta"> +{usd(finalBalance - order.baseline)}</span>
          )}
        </span>
      </div>

      <div className="done-keyblock">
        <KeyBlock token={order.token} />
      </div>

      {/* The hand-off: the next thing a funded first-timer needs is "now what?" — /api has the SDK
          examples. New tab: the key is still on screen, and losing it loses the credit. */}
      <p className="hint">
        Save your key, then point your SDK at it.{" "}
        <a href="/api/" {...EXT}>
          api reference
        </a>
        .
      </p>

      <button className="btn-primary" type="button" onClick={buyMore}>
        done
      </button>
    </div>
  );
}
