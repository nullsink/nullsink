// Proxy-side ledger client. It owns the boot session and ambiguity policy; handler.ts continues to use only
// MeteringLedgerPort and never sees wire/session details.
import type { MeteringLedgerPort } from "./port";
import {
  LEDGER_BALANCE_PATH,
  LEDGER_OPEN_HOLD_PATH,
  LEDGER_SETTLE_HOLD_PATH,
  LEDGER_START_SESSION_PATH,
  LEDGER_WIRE_HEADER,
  LEDGER_WIRE_VERSION,
  type LedgerErrorCode,
} from "./wire";

type UnixFetch = (url: string, init: RequestInit & { unix: string }) => Promise<Response>;
type Json = Record<string, unknown>;

export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerUnavailableError";
  }
}

export class FatalLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalLedgerError";
  }
}

export type LedgerSessionStart = {
  outcome: "started" | "current";
  recoveredHolds: number;
  recoveredMicros: number;
};

export type LedgerSocketClient = MeteringLedgerPort & {
  sessionId: string;
  startSession(): Promise<LedgerSessionStart>;
};

export type LedgerClientOpts = {
  path: string;
  sessionId: string;
  fetch?: UnixFetch;
  attemptTimeoutMs?: number;
  operationTimeoutMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // Required behavior at activation: log and terminate the stale/indeterminate proxy. Throwing is the safe
  // default for tests and dormant use; PR 3 supplies the process-level fatal callback.
  fatal?: (error: FatalLedgerError) => never;
};

type CallResult = { response: Response; body: Json };

export function makeLedgerSocketClient(opts: LedgerClientOpts): LedgerSocketClient {
  const socketFetch = opts.fetch ?? fetch as unknown as UnixFetch;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 1_000;
  const operationTimeoutMs = opts.operationTimeoutMs ?? 5_000;
  const retryDelayMs = opts.retryDelayMs ?? 50;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const fatal = opts.fatal ?? ((error: FatalLedgerError): never => { throw error; });

  const failFatal = (message: string): never => fatal(new FatalLedgerError(message));

  async function call(
    path: string,
    payload: Json,
    mutation: boolean,
    recognizedSuccess: (body: Json) => boolean,
  ): Promise<CallResult> {
    const serialized = JSON.stringify(payload); // build ONCE: every ambiguous retry sends byte-identical data
    const deadline = now() + operationTimeoutMs;
    let lastReason = "unavailable";
    for (;;) {
      try {
        const remainingMs = Math.max(1, deadline - now());
        const response = await socketFetch(`http://localhost${path}`, {
          unix: opts.path,
          method: "POST",
          headers: { "content-type": "application/json", [LEDGER_WIRE_HEADER]: String(LEDGER_WIRE_VERSION) },
          body: serialized,
          signal: AbortSignal.timeout(Math.min(attemptTimeoutMs, remainingMs)),
        });
        const body = await response.json().catch(() => null) as Json | null;
        // A typed 4xx is definite. A 2xx is definite only when this operation recognizes its complete shape;
        // an unknown success body could follow a committed mutation under a skewed/broken server, so retry it
        // exactly like a lost response instead of inventing an outcome.
        if (response.status < 500 && body && (!response.ok || recognizedSuccess(body)))
          return { response, body };
        lastReason = body ? `http_${response.status}` : "unrecognized_response";
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
      }

      // Reads never move money and can fail this request immediately. Mutations retry ambiguous outcomes with
      // the exact same session/hold/payload until the bounded operation budget expires.
      if (!mutation) throw new LedgerUnavailableError(`ledger read unavailable: ${lastReason}`);
      const remainingMs = deadline - now();
      if (remainingMs <= 0) return failFatal(`indeterminate ledger mutation ${path}: ${lastReason}`);
      await sleep(Math.min(retryDelayMs, remainingMs));
      if (now() >= deadline) return failFatal(`indeterminate ledger mutation ${path}: ${lastReason}`);
    }
  }

  function errorCode(result: CallResult): LedgerErrorCode | null {
    return typeof result.body.error === "string" ? result.body.error as LedgerErrorCode : null;
  }

  function fatalProtocol(path: string, result: CallResult): never {
    const code = errorCode(result) ?? `http_${result.response.status}`;
    return failFatal(`ledger protocol failure ${path}: ${code}`);
  }

  async function startSession(): Promise<LedgerSessionStart> {
    const result = await call(
      LEDGER_START_SESSION_PATH,
      { session_id: opts.sessionId },
      true,
      (body) => (body.result === "started" || body.result === "current")
        && typeof body.recovered_holds === "number"
        && Number.isSafeInteger(body.recovered_holds)
        && body.recovered_holds >= 0
        && typeof body.recovered_micros === "number"
        && Number.isSafeInteger(body.recovered_micros)
        && body.recovered_micros >= 0,
    );
    if (result.response.ok
      && (result.body.result === "started" || result.body.result === "current")
      && typeof result.body.recovered_holds === "number"
      && Number.isSafeInteger(result.body.recovered_holds)
      && result.body.recovered_holds >= 0
      && typeof result.body.recovered_micros === "number"
      && Number.isSafeInteger(result.body.recovered_micros)
      && result.body.recovered_micros >= 0) {
      return {
        outcome: result.body.result,
        recoveredHolds: result.body.recovered_holds,
        recoveredMicros: result.body.recovered_micros,
      };
    }
    return fatalProtocol(LEDGER_START_SESSION_PATH, result);
  }

  async function getBalance(hash: string): Promise<number | null> {
    const result = await call(
      LEDGER_BALANCE_PATH,
      { session_id: opts.sessionId, hash },
      false,
      (body) => body.result === "missing"
        || (body.result === "found"
          && typeof body.balance_micros === "number"
          && Number.isSafeInteger(body.balance_micros)
          && body.balance_micros >= 0),
    );
    if (result.response.ok && result.body.result === "missing") return null;
    if (result.response.ok
      && result.body.result === "found"
      && typeof result.body.balance_micros === "number"
      && Number.isSafeInteger(result.body.balance_micros)
      && result.body.balance_micros >= 0) return result.body.balance_micros;
    if (errorCode(result) === "stale_session") return failFatal("ledger rejected stale proxy session");
    return fatalProtocol(LEDGER_BALANCE_PATH, result);
  }

  async function openHold(hash: string, micros: number, holdId: string): Promise<boolean> {
    const result = await call(
      LEDGER_OPEN_HOLD_PATH,
      { session_id: opts.sessionId, hold_id: holdId, hash, micros },
      true,
      (body) => body.result === "opened" || body.result === "already_open",
    );
    if (result.response.ok && (result.body.result === "opened" || result.body.result === "already_open")) return true;
    const code = errorCode(result);
    if (code === "unknown_token" || code === "insufficient_balance") return false;
    if (code === "stale_session") return failFatal("ledger rejected stale proxy session");
    return fatalProtocol(LEDGER_OPEN_HOLD_PATH, result);
  }

  async function settleHold(holdId: string, chargedMicros: number): Promise<boolean> {
    const result = await call(
      LEDGER_SETTLE_HOLD_PATH,
      { session_id: opts.sessionId, hold_id: holdId, charged_micros: chargedMicros },
      true,
      (body) => body.result === "settled" || body.result === "already_settled",
    );
    if (result.response.ok && (result.body.result === "settled" || result.body.result === "already_settled")) return true;
    if (errorCode(result) === "unknown_hold") return false;
    if (errorCode(result) === "stale_session") return failFatal("ledger rejected stale proxy session");
    return fatalProtocol(LEDGER_SETTLE_HOLD_PATH, result);
  }

  return { sessionId: opts.sessionId, startSession, getBalance, openHold, settleHold };
}
