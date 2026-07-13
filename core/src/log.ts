// Operational logging. This system stores almost no user data by design, so these journald lines ARE the
// primary debugging + monitoring signal — no per-request record, no APM, nothing else. Two hard rules:
//
//   1. PRIVACY INVARIANT — a warn/error/info line must NEVER carry a user-linkable field: never a token
//      hash next to an address, never a txid next to a hash. When in doubt, log a count or a truncated
//      id, not the linking pair.
//
//   2. LEVELS map to journald priority so `journalctl -p err` / `-p warning` filter. systemd parses a
//      leading `<N>` (SyslogLevelPrefix, on by default for StandardOutput=journal); we emit it only under
//      systemd (INVOCATION_ID set by the unit), omitting it in local dev so you don't read literal `<3>`.
//      warn/error → stderr, info → stdout.
//
// Categories are a small, stable, greppable set: [boot] [buy] [bill] [upstream] [poll] [wallet] [credit]
// [shutdown] [metrics]. Watch
// `[bill] … refunded in full` — the ONLY signal we served real usage and billed nothing for it (no
// per-request record to reconcile against), so it's logged at ERROR with an unmistakable shape. Alert on
// that line specifically.

const UNDER_SYSTEMD = process.env.INVOCATION_ID != null;
const pfx = (n: number) => (UNDER_SYSTEMD ? `<${n}>` : "");

// Normalize an unknown caught value to a message string — replaces the `err instanceof Error ?
// err.message : err` repeated at every catch site.
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// info → journald priority 6. Startup / lifecycle facts.
export function info(tag: string, msg: string): void {
  console.log(`${pfx(6)}[${tag}] ${msg}`);
}

// warn → priority 4. Transient / self-healing / client-visible-and-refunded — does NOT need a human.
export function warn(tag: string, msg: string): void {
  console.error(`${pfx(4)}[${tag}] ${msg}`);
}

// error → priority 3. A money or correctness anomaly that a human should look at.
export function error(tag: string, msg: string): void {
  console.error(`${pfx(3)}[${tag}] ${msg}`);
}
