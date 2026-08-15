// Ledger-side proxy socket. The server owns all session and hold semantics; the proxy can request only a
// balance read, conditional hold, or bounded settlement. No generic RPC surface and no arbitrary SQL escape.
import { existsSync, statSync, unlinkSync } from "node:fs";
import * as log from "../log";
import type { BalanceStore } from "./db";
import {
  LEDGER_BALANCE_PATH,
  LEDGER_MAX_BODY_BYTES,
  LEDGER_OPEN_HOLD_PATH,
  LEDGER_SETTLE_HOLD_PATH,
  LEDGER_START_SESSION_PATH,
  LEDGER_WIRE_HEADER,
  LEDGER_WIRE_VERSION,
  parseBalanceRequest,
  parseOpenHoldRequest,
  parseSettleHoldRequest,
  parseStartSessionRequest,
} from "./wire";

export type LedgerMutation = "start_session" | "open_hold" | "settle_hold";
export type LedgerServerHooks = {
  // Fault-injection seam: tests throw after a transaction commits but before its response is returned, proving
  // the socket client's retry reaches an idempotent definite result. Production supplies no hook.
  afterCommit?: (mutation: LedgerMutation) => void | Promise<void>;
};

const jsonError = (error: string, status: number) => Response.json({ error }, { status });

async function readBody(req: Request): Promise<unknown | Response> {
  if (Number(req.headers.get("content-length") ?? 0) > LEDGER_MAX_BODY_BYTES)
    return jsonError("payload_too_large", 413);
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > LEDGER_MAX_BODY_BYTES) return jsonError("payload_too_large", 413);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError("invalid_json", 400);
  }
}

export function createLedgerHandler(
  balances: BalanceStore,
  now: () => number = Date.now,
  hooks: LedgerServerHooks = {},
): (req: Request) => Promise<Response> {
  return async function handleLedger(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || ![
      LEDGER_START_SESSION_PATH,
      LEDGER_BALANCE_PATH,
      LEDGER_OPEN_HOLD_PATH,
      LEDGER_SETTLE_HOLD_PATH,
    ].includes(path)) return jsonError("unsupported_endpoint", 404);

    if (req.headers.get(LEDGER_WIRE_HEADER) !== String(LEDGER_WIRE_VERSION))
      return jsonError("wire_version_mismatch", 400);
    const decoded = await readBody(req);
    if (decoded instanceof Response) return decoded;

    if (path === LEDGER_START_SESSION_PATH) {
      const body = parseStartSessionRequest(decoded);
      if (!body) return jsonError("invalid_request", 400);
      const result = balances.beginSession(body.session_id, now());
      if (result.outcome === "stale_session") return jsonError("stale_session", 409);
      await hooks.afterCommit?.("start_session");
      return Response.json({
        result: result.outcome,
        recovered_holds: result.recoveredHolds,
        recovered_micros: result.recoveredMicros,
      });
    }

    if (path === LEDGER_BALANCE_PATH) {
      const body = parseBalanceRequest(decoded);
      if (!body) return jsonError("invalid_request", 400);
      const result = balances.getSessionBalance(body.session_id, body.hash);
      if (result.stale) return jsonError("stale_session", 409);
      return result.balance === null
        ? Response.json({ result: "missing" })
        : Response.json({ result: "found", balance_micros: result.balance });
    }

    if (path === LEDGER_OPEN_HOLD_PATH) {
      const body = parseOpenHoldRequest(decoded);
      if (!body) return jsonError("invalid_request", 400);
      const outcome = balances.openSessionHold(body.session_id, body.hash, body.micros, body.hold_id, now());
      if (outcome === "opened") await hooks.afterCommit?.("open_hold");
      if (outcome === "opened" || outcome === "already_open") return Response.json({ result: outcome });
      if (outcome === "unknown_token") return jsonError(outcome, 404);
      if (outcome === "insufficient_balance") return jsonError(outcome, 402);
      if (outcome === "stale_session" || outcome === "conflict") return jsonError(outcome, 409);
      return jsonError("invalid_request", 400);
    }

    const body = parseSettleHoldRequest(decoded);
    if (!body) return jsonError("invalid_request", 400);
    const outcome = balances.settleSessionHold(body.session_id, body.hold_id, body.charged_micros, now());
    if (outcome === "settled") await hooks.afterCommit?.("settle_hold");
    if (outcome === "settled" || outcome === "already_settled") return Response.json({ result: outcome });
    if (outcome === "unknown_hold") return jsonError(outcome, 404);
    if (outcome === "stale_session" || outcome === "conflict") return jsonError(outcome, 409);
    return jsonError("invalid_request", 400);
  };
}

// Owner-only from the instant of bind. The activation PR widens the completed pathname socket to the dedicated
// proxy→ledger group in ExecStartPost, mirroring the already-proven credit-socket pattern.
export function serveLedgerSocket(opts: {
  path: string;
  balances: BalanceStore;
  now?: () => number;
  hooks?: LedgerServerHooks;
}): { stop: () => void } {
  if (existsSync(opts.path)) {
    if (!statSync(opts.path).isSocket()) throw new Error(`ledger socket path exists and is not a socket: ${opts.path}`);
    unlinkSync(opts.path);
  }
  const previousUmask = process.umask(0o077);
  try {
    const server = Bun.serve({
      unix: opts.path,
      maxRequestBodySize: LEDGER_MAX_BODY_BYTES,
      fetch: createLedgerHandler(opts.balances, opts.now, opts.hooks),
      error: () => {
        log.error("ledger", "request handler failed");
        return jsonError("ledger_error", 500);
      },
    });
    return { stop: () => void server.stop(true) };
  } finally {
    process.umask(previousUmask);
  }
}
