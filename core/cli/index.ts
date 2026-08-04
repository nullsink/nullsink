// Transitional on-box reader. It deliberately exposes only the two read-only views still needed by operations;
// funding and recovery commands are absent. Dynamic imports keep version/usage DB-free and let the root guard
// run before either SQLite store opens.
import { BUILD_VERSION } from "../src/version";
import { refuseRootOrExit } from "./guard";

const COMMANDS: Record<string, () => Promise<(args: string[]) => void>> = {
  balances: () => import("./balances").then((m) => m.runBalances),
  financials: () => import("./financials").then((m) => m.runFinancials),
};

const USAGE =
  "usage: nsk <command> [args]\n\n" +
  "commands:\n" +
  "  balances [--format table|csv|json]                               every token hash + live balance\n" +
  "  financials [--since ..] [--until ..] [--format table|csv|json]   live sales journal + liability\n" +
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
refuseRootOrExit(cmd);
load()
  .then((run) => run(process.argv.slice(3)))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
