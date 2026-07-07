// Refuse to run nsk as root. Every subcommand opens a WAL-mode ledger (balances.db via src/ledger/db, or
// pending.db for `orders`); opening it as root creates root-owned -wal / -shm sidecars the unprivileged
// service user then can't write, which breaks the live ledger until someone repairs ownership (see
// cli/README.md). nsk fails closed rather than risk that. Escape hatch: NSK_ALLOW_ROOT=1 for a deliberate,
// reviewed break-glass run.

// Pure policy decision (no I/O), so it's unit-testable: are we root with no override? `euid` is
// process.geteuid()'s result — undefined on platforms without uids (nothing to enforce there).
export function rootGuardViolation(euid: number | undefined, allowRoot: string | undefined): boolean {
  return euid === 0 && allowRoot !== "1";
}

// Thin process shell around the policy: if violated, explain how to run it right and exit non-zero. index.ts
// calls this AFTER a ledger-opening command is resolved but BEFORE that command's run() opens the ledger —
// so the refusal lands before the DB (and its root-owned WAL sidecars) is ever created.
export function refuseRootOrExit(cmd?: string): void {
  if (!rootGuardViolation(process.geteuid?.(), process.env.NSK_ALLOW_ROOT)) return;
  console.error(
    "nsk: refusing to run as root — opening the ledger as root strands root-owned WAL sidecars the\n" +
      "     service user can't write (see cli/README.md). run it as the service user:\n" +
      `       sudo -u nullsink nsk ${cmd ?? "<command>"}\n` +
      "     (set NSK_ALLOW_ROOT=1 to override for a deliberate break-glass run.)",
  );
  process.exit(1);
}
