// Versioned proxy → ledger contract. This module contains only data shapes and validation: no database and no
// I/O. Session details stay inside the socket client so request handling continues to see only the narrow
// MeteringLedgerPort.
export const LEDGER_WIRE_VERSION = 1;
export const LEDGER_WIRE_HEADER = "x-nullsink-ledger-wire";
export const LEDGER_START_SESSION_PATH = "/session/start";
export const LEDGER_BALANCE_PATH = "/balance";
export const LEDGER_OPEN_HOLD_PATH = "/hold/open";
export const LEDGER_SETTLE_HOLD_PATH = "/hold/settle";
export const LEDGER_MAX_BODY_BYTES = 4 * 1024;

export type StartSessionRequest = { session_id: string };
export type BalanceRequest = { session_id: string; hash: string };
export type OpenHoldRequest = { session_id: string; hold_id: string; hash: string; micros: number };
export type SettleHoldRequest = { session_id: string; hold_id: string; charged_micros: number };

export type LedgerErrorCode =
  | "wire_version_mismatch"
  | "invalid_request"
  | "stale_session"
  | "conflict"
  | "unknown_token"
  | "insufficient_balance"
  | "unknown_hold";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const bag = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const safeMicros = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const validSessionId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
export const validHoldId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export function parseStartSessionRequest(value: unknown): StartSessionRequest | null {
  const body = bag(value);
  return body && validSessionId(body.session_id) ? { session_id: body.session_id } : null;
}

export function parseBalanceRequest(value: unknown): BalanceRequest | null {
  const body = bag(value);
  return body && validSessionId(body.session_id) && typeof body.hash === "string" && HASH.test(body.hash)
    ? { session_id: body.session_id, hash: body.hash }
    : null;
}

export function parseOpenHoldRequest(value: unknown): OpenHoldRequest | null {
  const body = bag(value);
  return body
    && validSessionId(body.session_id)
    && validHoldId(body.hold_id)
    && typeof body.hash === "string"
    && HASH.test(body.hash)
    && safeMicros(body.micros)
    ? { session_id: body.session_id, hold_id: body.hold_id, hash: body.hash, micros: body.micros }
    : null;
}

export function parseSettleHoldRequest(value: unknown): SettleHoldRequest | null {
  const body = bag(value);
  return body
    && validSessionId(body.session_id)
    && validHoldId(body.hold_id)
    && safeMicros(body.charged_micros)
    ? { session_id: body.session_id, hold_id: body.hold_id, charged_micros: body.charged_micros }
    : null;
}
