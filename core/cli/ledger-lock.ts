// Cross-process exclusion between ledger-opening `nsk` commands and destructive ledger maintenance.
//
// `flock` locks belong to the inherited open-file description, not to the short-lived helper process that
// acquires them. We therefore open the lock here, pass that exact descriptor to `flock`, and keep our copy
// open for the lifetime of nsk. restore.sh takes the exclusive side of this same lock before touching live
// state, so it cannot race a read/write CLI command into a two-database swap.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { dirname, join } from "node:path";

let ledgerLockFd: number | undefined;

function pathExistsFailClosed(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`cannot inspect maintenance marker ${path}`, { cause: error });
  }
}

function ledgerDirectory(): string {
  // DB_PATH is the pair's canonical anchor even for `orders`. Falling back to an independently-overridden
  // pending path could put balance and order commands on different lock inodes; isolated environments can
  // override DB_PATH or NULLSINK_LEDGER_LOCK explicitly.
  return dirname(process.env.DB_PATH ?? "/var/lib/nullsink/balances.db");
}

function maintenancePaths(): {
  lock: string;
  restoreGuard: string;
  restoreActivationGuard: string;
  deployGuard: string;
} {
  const dir = ledgerDirectory();
  return {
    lock: process.env.NULLSINK_LEDGER_LOCK ?? join(dir, ".ledger.lock"),
    restoreGuard:
      process.env.NULLSINK_RESTORE_GUARD ?? join(dir, ".restore-in-progress"),
    restoreActivationGuard:
      process.env.NULLSINK_RESTORE_ACTIVATION_GUARD ??
      join(dir, ".restore-activation-pending"),
    deployGuard: process.env.NULLSINK_DEPLOY_GUARD ?? join(dir, ".deploy-in-progress"),
  };
}

function assertMaintenanceInactive(
  restoreGuard: string,
  restoreActivationGuard: string,
  deployGuard: string,
): void {
  if (pathExistsFailClosed(restoreGuard)) {
    throw new Error(
      `an interrupted ledger restore is gated at ${restoreGuard}; recover it before running nsk`,
    );
  }
  if (pathExistsFailClosed(restoreActivationGuard)) {
    throw new Error(
      `a validated ledger restore awaits activation at ${restoreActivationGuard}; resume it before running nsk`,
    );
  }
  if (pathExistsFailClosed(deployGuard)) {
    throw new Error(
      `an interrupted app deploy is gated at ${deployGuard}; recover it before running nsk`,
    );
  }
}

/** Acquire a process-lifetime shared lock before any ledger module is imported. */
export function acquireLedgerLockOrExit(): void {
  if (ledgerLockFd !== undefined) return;

  // New SQLite main/WAL/SHM files and the lock itself must never be group/world-readable. Set this before
  // even creating the lock; the dynamic import that opens a DB happens only after this function returns.
  process.umask(0o077);

  const { lock, restoreGuard, restoreActivationGuard, deployGuard } = maintenancePaths();
  try {
    // This first check gives a useful durable-recovery diagnostic instead of a generic lock-contention one.
    assertMaintenanceInactive(restoreGuard, restoreActivationGuard, deployGuard);

    const fd = openSync(
      lock,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`unsafe ledger lock path: ${lock}`);
      // Narrow an old installation's permissive lock in-place. Failing to do so is a hard error because this
      // file lives beside the money ledgers and should reveal no operator activity to other users.
      fchmodSync(fd, 0o600);

      // fd 3 in the helper is a dup of `fd`; once flock attaches to that shared open-file description, our
      // descriptor keeps it alive after the helper exits. GNU util-linux flock returns 1 on -n contention.
      const result = spawnSync("flock", ["-s", "-n", "3"], {
        stdio: ["ignore", "ignore", "pipe", fd],
        encoding: "utf8",
      });
      if (result.error) {
        // The supported production target is Linux and must fail closed without util-linux flock. macOS does
        // not ship flock; permitting its local test/dev CLI keeps that unsupported host usable without
        // changing Linux behavior. Durable marker checks and mode hardening still apply there.
        if (
          process.platform !== "linux" &&
          (result.error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          assertMaintenanceInactive(restoreGuard, restoreActivationGuard, deployGuard);
          ledgerLockFd = fd;
          return;
        }
        throw new Error("flock is required to protect the live ledger", { cause: result.error });
      }
      if (result.status !== 0) {
        throw new Error("ledger maintenance is active; refusing to open the ledger");
      }

      // Close the marker race with restore: restore holds the exclusive lock before it creates/removes its
      // durable marker, so a clear second check proves maintenance cannot begin until this process exits.
      assertMaintenanceInactive(restoreGuard, restoreActivationGuard, deployGuard);
      ledgerLockFd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`nsk: ${message}`);
    process.exit(1);
  }
}
