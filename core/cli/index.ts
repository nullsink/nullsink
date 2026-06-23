// `nsk <command> [args]` — the operator CLI, compiled to a standalone binary (nsk-linux-x64) from the SAME
// tag/CI run as the server, so the two can't drift. Box-ops subcommands only; they open the on-disk SQLite
// ledger, so run them as the service user (e.g. `sudo -u nullsink nsk balance <hash>`). The dev-only
// sync-prices tool and the buyer-side gen-token tool are deliberately NOT bundled here.
//
// Subcommands are loaded with dynamic import(), NOT static imports, on purpose: src/ledger/db opens the WAL
// ledger in a module-load singleton, so statically importing a subcommand here would open balances.db before
// the root guard runs (and even for `version`). Lazy-loading keeps the DB closed until after the guard, and
// leaves `version` DB-free. KEEP index.ts's own static imports DB-free (just version + guard) or the guard
// is defeated.
import { BUILD_VERSION } from "../src/version";
import { refuseRootOrExit } from "./guard";

const COMMANDS: Record<string, () => Promise<(args: string[]) => void>> = {
  issue: () => import("./issue").then((m) => m.runIssue),
  topup: () => import("./topup").then((m) => m.runTopup),
  balance: () => import("./balance").then((m) => m.runBalance),
  balances: () => import("./balances").then((m) => m.runBalances),
  financials: () => import("./financials").then((m) => m.runFinancials),
};

const USAGE =
  "usage: nsk <command> [args]\n\n" +
  "commands:\n" +
  "  issue <dollars>             mint a token worth $N, print it once\n" +
  "  topup <hash> <dollars>      add $N to an existing token\n" +
  "  balance <hash>              print a token's remaining balance\n" +
  "  balances [--format table|csv|json]                               every token's hash + balance\n" +
  "  financials [--since ..] [--until ..] [--format table|csv|json]   sales journal + liability\n" +
  "  version                     print the build version";

const cmd = process.argv[2];
if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  console.log(BUILD_VERSION);
  process.exit(0);
}
const load = cmd ? COMMANDS[cmd] : undefined;
if (!load) {
  console.error(cmd ? `${USAGE}\n\nunknown command: ${cmd}` : USAGE);
  process.exit(1);
}
// Known ledger-opening command resolved — refuse to run as root BEFORE the dynamic import below opens
// balances.db (a root open strands root-owned -wal/-shm the service user can't write; see guard.ts).
refuseRootOrExit(cmd);
load()
  .then((run) => run(process.argv.slice(3)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
