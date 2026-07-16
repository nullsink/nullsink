// Proxy side of the credit crossing: receive a credit over the unix socket and apply it to the balance ledger.
// PROXY TRUST DOMAIN module — imports the balance store, never the order store, rails, or settle.
import { existsSync, statSync, unlinkSync } from "node:fs";
import { CREDIT_PATH, CREDIT_WIRE_HEADER, CREDIT_WIRE_VERSION, parseCreditRequest } from "./credit-wire";
import * as log from "./log";
import type { BalanceStore } from "./ledger/db";

// The credit endpoint. Exactly-once rests HERE: creditOnce commits the balance credit and its applied_orders
// marker in ONE transaction, so a redelivery of the same idempotency_key is a no-op that still reports a
// DEFINITE outcome (already_applied). We reply only AFTER creditOnce returns — never fire-and-forget — because a
// response the sender is allowed to ack must mean the credit is already durable. creditOnce is synchronous, so
// the ordering (request → credit committed → respond) is structural.
export function createCreditHandler(balances: BalanceStore, now: () => number = Date.now): (req: Request) => Promise<Response> {
  return async function handleCredit(req: Request): Promise<Response> {
    if (req.method !== "POST" || new URL(req.url).pathname !== CREDIT_PATH)
      return Response.json({ error: "unsupported_endpoint" }, { status: 404 });

    // Fail CLOSED and loud on a wire-version skew (a partial rollback pairing new payments with an old proxy):
    // better to wedge the durable outbox — nothing is lost — than to credit under a shape the two sides don't share.
    const wire = req.headers.get(CREDIT_WIRE_HEADER);
    if (wire !== String(CREDIT_WIRE_VERSION)) {
      log.error("credit", `wire version mismatch: got ${wire ?? "none"}, expected ${CREDIT_WIRE_VERSION} — refusing`);
      return Response.json({ error: "wire_version_mismatch" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const c = parseCreditRequest(body);
    if (!c) return Response.json({ error: "invalid_credit" }, { status: 400 });

    const applied = balances.creditOnce(c.hash, c.micros, c.idempotency_key, now());
    return Response.json({ result: applied ? "applied" : "already_applied" });
  };
}

// Bind the credit socket. Three bind-time rules, all load-bearing:
//
//  1. PATHNAME socket, never abstract-namespace ("\0…"): an abstract socket has no file, hence no permission
//     gate, hence no authentication — anyone on the box could send credits.
//  2. umask 0077 around the bind, so the socket is owner-only from the instant it exists. Bun creates it at the
//     process umask (commonly 0755 → world-readable, owner-writable); narrowing it afterwards would leave a
//     TOCTOU window. Today BOTH services run as the same uid, so payments IS the socket's owner and connect(2)
//     finds the write bit it needs; owner-only is therefore the whole gate, and it is sufficient — a same-uid
//     attacker could write balances.db directly. When the two services get separate uids, the deploy must
//     grant the payments uid that write bit (a group or a POSIX ACL); nothing does so today.
//  3. A stale socket file survives an ungraceful death (Bun unlinks only on clean close, and otherwise throws
//     EADDRINUSE). Unlinking it before bind is safe ONLY because systemd guarantees a single instance
//     (stop-old-before-start-new); we additionally refuse to unlink anything that isn't a socket.
export function serveCreditSocket(opts: { path: string; balances: BalanceStore; now?: () => number }): { stop: () => void } {
  if (existsSync(opts.path)) {
    if (!statSync(opts.path).isSocket()) throw new Error(`credit socket path exists and is not a socket: ${opts.path}`);
    unlinkSync(opts.path); // stale socket from an ungraceful prior death (single-instance guaranteed by systemd)
  }
  const prevUmask = process.umask(0o077);
  try {
    const server = Bun.serve({ unix: opts.path, fetch: createCreditHandler(opts.balances, opts.now) });
    log.info("credit", `credit socket listening on ${opts.path}`);
    return {
      stop: () => {
        server.stop(true);
      },
    };
  } finally {
    process.umask(prevUmask);
  }
}
