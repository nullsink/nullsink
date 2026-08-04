// SQLite may create WAL sidecars on a read. Refuse root so those files cannot strand the unprivileged service.
export function rootGuardViolation(euid: number | undefined, allowRoot: string | undefined): boolean {
  return euid === 0 && allowRoot !== "1";
}

export function refuseRootOrExit(cmd?: string): void {
  if (!rootGuardViolation(process.geteuid?.(), process.env.NSK_ALLOW_ROOT)) return;
  console.error(
    "nsk: refusing to run as root — opening the ledger as root can strand root-owned WAL sidecars.\n" +
      `     run: sudo -u nullsink nsk ${cmd ?? "<command>"}\n` +
      "     (set NSK_ALLOW_ROOT=1 only for a deliberate break-glass run.)",
  );
  process.exit(1);
}
