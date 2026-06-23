import { createHash } from "node:crypto";
import type { Connect, Plugin } from "vite";

// Dev-only mock for /buy + /order-status + /balance (MOCK=1, i.e. `bun run dev:mock`). Lives in the Vite
// dev server, never the bundle (imported only when MOCK=1). Walks the WHOLE purchase flow with no backend
// while exercising the real fetch / JSON / loading / error paths.
//
// Faithful to the real server (core/src/handler.ts) in the ways that matter to the client:
//   - the two-key model: /buy + /order-status are keyed by the HASH; /balance by the RAW token. We
//     mirror the link the way the server does — hash the token (sha256 hex) to find the same order
//     (core/src/ledger/db.ts:hashToken). So a token's order, status, and credited balance all line up.
//   - the same 400 validations (invalid_json / invalid_hash / invalid_amount) so the client's
//     buyErrorMessage() mapping is exercisable.
//   - the same response shapes (8dp amount strings, the order-status state union, etc).
//
// What is FAKED vs the real server: there's no chain or poller, so payment progress is driven off a
// wall-clock timeline anchored at /buy time. Each manual "check ↻" tap reads the state for the elapsed
// time, regardless of WHEN the user taps — so the order-status state machine and the /balance flip are
// both consistent against one clock, the way the real server's poller-fed view + ledger would be.

// --- demo timeline (tweak these to re-pace the walkthrough) ------------------
// One full cycle is ~SEEN → CONFIRM (1 conf / step) → FINALIZE → CREDITED, anchored at /buy. Times are
// ms since the /buy that created the order. Kept to ~30s end-to-end: long enough that the payment screen
// and a "confirming n/N" tick are actually visible, short enough to demo without waiting.
const SEEN_AFTER_MS = 4_000; // payment "seen" — received jumps to the full expected (users pay in one tx)
const CONFIRM_WINDOW_MS = 12_000; // confs ramp 0 → N over this span, INDEPENDENT of N — so a 3-conf (BTC) and
// a 10-conf (XMR) order both finalize at the same wall-clock, just showing a different "n/N".
const FINALIZE_AFTER_MS = SEEN_AFTER_MS + CONFIRM_WINDOW_MS; // 16s: all confs met
const FINALIZE_WINDOW_MS = 4_000; // brief "confirmed — verifying credit…" window before it credits
const CREDITED_AFTER_MS = FINALIZE_AFTER_MS + FINALIZE_WINDOW_MS; // 20s: balance is funded, order closes
const ORDER_CLOSED_AFTER_MS = CREDITED_AFTER_MS + 2_000; // 22s: order row drops → /order-status reads `closed`
//
// elapsed (ms since /buy)            state            /balance
//   [0,         SEEN_AFTER_MS)        waiting          401 invalid_token
//   [SEEN,      FINALIZE_AFTER_MS)    confirming n/N   401 invalid_token   (n = floor(elapsed-SEEN / step), capped)
//   [FINALIZE,  CREDITED_AFTER_MS)    finalizing       401 invalid_token
//   [CREDITED,  ORDER_CLOSED_AFTER_MS) finalizing*     200 { balance_usd } (*still has a row; balance is live)
//   [ORDER_CLOSED, ∞)                 closed           200 { balance_usd } (row reaped; /balance is the truth)

// --- simulated network latency -----------------------------------------------
// Jittered small delay on EVERY mock response, so the client's busy / "checking…" states actually render.
// Kept snappy on purpose — slow enough to see, not slow enough to annoy.
const LATENCY_MIN_MS = 120;
const LATENCY_MAX_MS = 500;
const latency = () => LATENCY_MIN_MS + Math.floor(Math.random() * (LATENCY_MAX_MS - LATENCY_MIN_MS));

// --- rails + pricing (mirrors the server's quote math; fixed per-coin rates so the demo is deterministic) -
const MARGIN = 1.1; // mirrors api.ts MARGIN / the server MARGIN
// The active rails (GET /rails), and per-rail demo config. scale = atomic units per whole coin
// (1e8 sats / 1e12 piconero); decimals = its display width; scheme/param differ per coin's wallet URI.
const RAILS = {
  default: "monero",
  rails: [
    { name: "monero", unit: "XMR", confirmations: 10 },
    { name: "bitcoin", unit: "BTC", confirmations: 3 },
  ],
};
type RailCfg = { unit: string; confirmations: number; rate: number; scale: number; decimals: number; payTo: string; uri: (a: string) => string };
const RAIL_CFG: Record<string, RailCfg> = {
  monero: { unit: "XMR", confirmations: 10, rate: 160, scale: 1_000_000_000_000, decimals: 12, payTo: "88nullsinkDemoMoneroSubaddrForTheWalkthroughOnlyNotARealWalletAddress00000000000q4WmZ9pK", uri: (a) => `monero:88nullsinkDemoMoneroSubaddrForTheWalkthroughOnlyNotARealWalletAddress00000000000q4WmZ9pK?tx_amount=${a}` },
  bitcoin: { unit: "BTC", confirmations: 3, rate: 68_000, scale: 100_000_000, decimals: 8, payTo: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", uri: (a) => `bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=${a}` },
};
// expected coin rounded UP in atomic units so the margin is never eroded — same as the server.
const expectedAtomic = (creditUsd: number, c: RailCfg) => Math.ceil(((creditUsd * MARGIN) / c.rate) * c.scale);
const toCoin = (atomic: number, c: RailCfg) => (atomic / c.scale).toFixed(c.decimals);

// Client limits (api.ts BUY_MIN_USD / BUY_MAX_USD). The real server allows a wider band, but the client
// clamps to this and the mock rejecting outside it lets us exercise the invalid_amount path realistically.
const BUY_MIN_USD = 2;
const BUY_MAX_USD = 50;

// pre-funded demo key: any token starting `0sink_demo` reads as a $7.50 balance, for owned-key UI testing
// (paste it on home → "check balance", or start a top-up against it) without running a timeline. A
// ready-to-paste valid one: 0sink_demo0000000000000000000000000000000000000007nDC
const DEMO_PREFUND_USD = 7.5;

// --- error / edge injection (so the error + expiry UIs are walkable) ----------
// Drive /buy down a specific failure path with a sentinel credit_usd OR a special pasted key (hash checked
// at /buy):
//   credit_usd 13 (or a key starting 0sink_rate)   -> 503 rate_unavailable   ("couldn't price right now")
//   credit_usd 14 (or a key starting 0sink_busy)   -> 503 busy_try_later     ("system busy")
//   credit_usd 15 (or a key starting 0sink_limit)  -> 429 rate_limited
//   credit_usd 16 (or a key starting 0sink_wallet) -> 502 wallet_unavailable ("temporarily unavailable")
//   credit_usd 17                                  -> 400 unknown_rail        ("that coin isn't available")
//   a key starting 0sink_expired                   -> a valid quote whose expires_at is already in the past,
//                                                  so the pay screen shows the expired state immediately.
//   a key starting 0sink_soon                       -> a quote that expires ~15s out, so you can WATCH the UI
//                                                  flip to the expired notice on its own (the auto-expire).
// The key triggers are matched by HASHING known sentinel tokens at startup (the client only sends the
// hash to /buy). Use these exact tokens — each is a valid 0sink_ token (43 random + a 4-char checksum), so
// they paste cleanly into the "I have a key" field:
//   0sink_rate000000000000000000000000000000000000000zT6N   -> rate_unavailable
//   0sink_busy000000000000000000000000000000000000000S3Iw   -> busy_try_later
//   0sink_limit00000000000000000000000000000000000000U5g0   -> rate_limited
//   0sink_wallet0000000000000000000000000000000000000SbOU   -> wallet_unavailable
//   0sink_expired000000000000000000000000000000000000OBsS   -> already-expired quote
//   0sink_soon000000000000000000000000000000000000000gYB2   -> quote expiring ~15s out (watch the auto-flip)
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const SENTINEL = {
  rate_unavailable: sha256hex("0sink_rate000000000000000000000000000000000000000zT6N"),
  busy_try_later: sha256hex("0sink_busy000000000000000000000000000000000000000S3Iw"),
  rate_limited: sha256hex("0sink_limit00000000000000000000000000000000000000U5g0"),
  wallet_unavailable: sha256hex("0sink_wallet0000000000000000000000000000000000000SbOU"),
  expired: sha256hex("0sink_expired000000000000000000000000000000000000OBsS"),
  soon: sha256hex("0sink_soon000000000000000000000000000000000000000gYB2"),
} as const;
const buyInjection: Record<number, { status: number; code: string }> = {
  13: { status: 503, code: "rate_unavailable" },
  14: { status: 503, code: "busy_try_later" },
  15: { status: 429, code: "rate_limited" },
  16: { status: 502, code: "wallet_unavailable" },
  17: { status: 400, code: "unknown_rail" },
};

// expires_at the buyer is told (the real server uses a multi-hour ORDER_TTL_MS; we keep that generous
// window so the quote does NOT expire mid-timeline — the 0sink_expired sentinel is the way to demo expiry).
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const SOON_EXPIRY_MS = 15_000; // 0sink_soon sentinel: expire ~15s out so the auto-expire flip is watchable

const HASH_RE = /^[0-9a-f]{64}$/;

// One in-flight order per hash (a fresh /buy for the same hash overwrites it — matching the client, which
// only ever has one purchase live). createdAt anchors the timeline; baselineUsd carries a top-up's prior
// balance so /balance can return baseline + credit once credited (see /balance below).
type Order = {
  hash: string;
  rail: string; // which rail this order quoted in — drives unit + required + amount in statusFor
  creditUsd: number;
  expectedAtomic: number;
  createdAt: number;
  expiresAt: number;
  baselineUsd: number; // prior credited balance for this hash, so a top-up sums instead of replacing
};
const orders = new Map<string, Order>();

// elapsed → order-status state. Pure function of the wall clock so every check is consistent.
function statusFor(order: Order, now: number) {
  const elapsed = now - order.createdAt;
  const c = RAIL_CFG[order.rail] ?? RAIL_CFG[RAILS.default];
  const required = c.confirmations;
  const expected = toCoin(order.expectedAtomic, c);
  if (elapsed >= ORDER_CLOSED_AFTER_MS) return { state: "closed" as const };
  if (elapsed < SEEN_AFTER_MS) {
    return { state: "waiting" as const, confirmations: 0, required, received: toCoin(0, c), expected, unit: c.unit, expires_at: order.expiresAt };
  }
  // seen: received jumps to the FULL expected (users pay in one tx). Confs ramp 0→N over CONFIRM_WINDOW_MS
  // regardless of N, so XMR (10) and BTC (3) both finalize at the same wall-clock, showing a different n/N.
  const confs = Math.min(required, Math.floor(((elapsed - SEEN_AFTER_MS) / CONFIRM_WINDOW_MS) * required));
  const state = confs < required ? ("confirming" as const) : ("finalizing" as const);
  return { state, confirmations: confs, required, received: expected, expected, unit: c.unit, expires_at: order.expiresAt };
}

// Credited balance for a hash at `now`. The order carries a baseline (the prior credited balance, set at
// /buy time). While THIS order is still confirming, the credited balance is just that baseline — so a
// top-up on a funded key keeps showing the existing balance, never flickering to 401 mid-wait. Once the
// timeline passes the credited point, the new credit is added. A baseline-only $0 (a fresh key still
// confirming its first order) reads as null → 401, the not-yet-funded case.
function creditedUsd(hash: string, now: number): number | null {
  const order = orders.get(hash);
  if (!order) return null;
  const credited = now - order.createdAt >= CREDITED_AFTER_MS;
  const usd = order.baselineUsd + (credited ? order.creditUsd : 0);
  return usd > 0 ? usd : null;
}

export function mockApi(): Plugin {
  return {
    name: "nullsink-mock-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];

        // small typed JSON responder that applies the simulated latency to EVERY reply.
        const send = (status: number, body: unknown) => {
          setTimeout(() => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
          }, latency());
        };

        if (req.method === "POST" && url === "/buy") {
          readJson(req, (body) => {
            if (body === INVALID_JSON) return send(400, { error: "invalid_json" });
            const hash = typeof body?.hash === "string" ? body.hash : null;
            if (!hash || !HASH_RE.test(hash)) return send(400, { error: "invalid_hash" });
            const creditUsd = body?.credit_usd;
            if (
              typeof creditUsd !== "number" ||
              !Number.isFinite(creditUsd) ||
              creditUsd < BUY_MIN_USD ||
              creditUsd > BUY_MAX_USD
            )
              return send(400, { error: "invalid_amount" });

            // resolve the pay rail (default if omitted); an unknown rail is a 400, mirroring the server.
            const rail = typeof body?.rail === "string" ? body.rail : RAILS.default;
            const cfg = RAIL_CFG[rail];
            if (!cfg) return send(400, { error: "unknown_rail" });

            // error injection: by sentinel amount, or by sentinel key hash (see the table above).
            const inj =
              buyInjection[creditUsd] ??
              (hash === SENTINEL.rate_unavailable
                ? { status: 503, code: "rate_unavailable" }
                : hash === SENTINEL.busy_try_later
                  ? { status: 503, code: "busy_try_later" }
                  : hash === SENTINEL.rate_limited
                    ? { status: 429, code: "rate_limited" }
                    : hash === SENTINEL.wallet_unavailable
                      ? { status: 502, code: "wallet_unavailable" }
                      : null);
            if (inj) return send(inj.status, { error: inj.code });

            const now = Date.now();
            // a top-up against an already-credited key sums onto the prior balance. We carry that prior
            // balance as the new order's baseline so /balance returns baseline + credit once credited.
            const prior = creditedUsd(hash, now) ?? 0;
            const atomic = expectedAtomic(creditUsd, cfg);
            // expiry sentinels: 0sink_expired hands back an ALREADY-past quote (expired UI shows at once);
            // 0sink_soon expires ~15s out so the client's auto-expire timer flips the UI while you watch.
            const expiresAt =
              hash === SENTINEL.expired
                ? now - 60_000
                : hash === SENTINEL.soon
                  ? now + SOON_EXPIRY_MS
                  : now + ORDER_TTL_MS;
            orders.set(hash, {
              hash,
              rail,
              creditUsd,
              expectedAtomic: atomic,
              createdAt: now,
              expiresAt,
              baselineUsd: prior,
            });
            const amount = toCoin(atomic, cfg);
            send(200, {
              pay_to: cfg.payTo,
              amount,
              unit: cfg.unit,
              pay_uri: cfg.uri(amount),
              rate_usd: cfg.rate,
              confirmations_required: cfg.confirmations,
              expires_at: expiresAt,
            });
          });
          return;
        }

        if (req.method === "POST" && url === "/order-status") {
          readJson(req, (body) => {
            if (body === INVALID_JSON) return send(400, { error: "invalid_json" });
            const hash = typeof body?.hash === "string" ? body.hash : null;
            if (!hash || !HASH_RE.test(hash)) return send(400, { error: "invalid_hash" });
            const order = orders.get(hash);
            if (!order) return send(200, { state: "closed" }); // no open order → bare closed (server parity)
            send(200, statusFor(order, Date.now()));
          });
          return;
        }

        if (req.method === "GET" && url === "/balance") {
          const token = req.headers["x-api-key"] as string | undefined;
          if (!token) return send(401, { error: "invalid_token" });
          // demo shortcut: any 0sink_demo* key is a pre-funded balance, no timeline needed (owned-key testing).
          if (token.startsWith("0sink_demo")) return send(200, { balance_usd: DEMO_PREFUND_USD });
          // real two-key link: hash the raw token to find the order keyed by that hash (server parity).
          const bal = creditedUsd(sha256hex(token), Date.now());
          if (bal === null) return send(401, { error: "invalid_token" });
          return send(200, { balance_usd: bal });
        }

        if (req.method === "GET" && url === "/rails") return send(200, RAILS);

        next();
      });
    },
  };
}

// Read a request body and parse JSON, calling back with the parsed value, or the INVALID_JSON sentinel on
// a parse failure (so callers can map it to a 400 invalid_json the way the server does).
const INVALID_JSON = Symbol("invalid_json");
function readJson(req: Connect.IncomingMessage, cb: (body: any) => void): void {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try {
      cb(JSON.parse(raw || "{}"));
    } catch {
      cb(INVALID_JSON);
    }
  });
}
