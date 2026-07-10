// The ONE crossing between the two worlds (D2): payments → proxy, `credit {hash, micros, idempotency_key}`.
// This module is the shared wire contract only — no store, no I/O — so each world can import it without
// dragging the other's code into its binary.
//
// Transport is HTTP over a unix domain socket (Bun.serve({unix}) / fetch(url, {unix})). Authentication is the
// socket FILE's permissions: on Linux, connect(2) requires WRITE permission on the socket path — a
// kernel-enforced, unspoofable uid gate. (Bun exposes neither peer credentials nor the socket fd, so
// SO_PEERCRED is unreachable; the filesystem gate is the same trust root, enforced at connect time instead of
// read after accept.) The proxy owns the socket's mode; see credit-server.ts for the bind-time rules.

// Bump on ANY change to the request/response shape. The server refuses a mismatch (fail closed + loud) so a
// partial rollback that pairs new payments with an old proxy wedges the durable outbox instead of crediting
// under a shape the two sides don't share.
export const CREDIT_WIRE_VERSION = 1;
export const CREDIT_PATH = "/credit";
export const CREDIT_WIRE_HEADER = "x-nullsink-credit-wire";

export type CreditRequest = { hash: string; micros: number; idempotency_key: string };

// The receiver's two DEFINITE outcomes. Both mean the credit is durably in the ledger (applied now, or applied
// by an earlier delivery), so the sender acks on either.
export type CreditOutcome = "applied" | "already_applied";

// What the sender learns. `ok:false` is AMBIGUOUS — the credit may or may not have landed (e.g. the proxy
// committed and the response was lost) — so the outbox row stays unacked and is retried; the receiver's
// applied_orders guard makes the redelivery a no-op. NEVER ack on anything but ok:true.
export type DeliveryResult = { ok: true; outcome: CreditOutcome } | { ok: false; reason: string };

// Validate an inbound credit. Rejects anything the settle path would never produce, so a malformed (or hostile)
// message can't move money. `micros` may be 0: a dust payment can round its proportional share down to zero.
export function parseCreditRequest(body: unknown): CreditRequest | null {
  if (!body || typeof body !== "object") return null;
  const { hash, micros, idempotency_key: key } = body as Record<string, unknown>;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (typeof micros !== "number" || !Number.isSafeInteger(micros) || micros < 0) return null;
  if (typeof key !== "string" || key.length === 0 || key.length > 200) return null;
  return { hash, micros, idempotency_key: key };
}
