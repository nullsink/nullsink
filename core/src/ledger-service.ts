// Composition root for the LEDGER service. This process is the sole writer of balances.db and exposes two
// deliberately separate Unix-socket capabilities:
//   - proxy socket: balance reads + replay-safe hold open/settle
//   - payments socket: exactly-once credit delivery
// The systemd unit gives each pathname to a different group, so neither caller receives the other's verbs.
import { serveCreditSocket } from "./credit-server";
import { openDb, DB_PATH } from "./ledger/db";
import { serveLedgerSocket } from "./ledger/server";
import * as log from "./log";
import { BUILD_VERSION } from "./version";

const LEDGER_SOCK = process.env.LEDGER_SOCK ?? "/run/nullsink-ledger/proxy.sock";
const CREDIT_SOCK = process.env.CREDIT_SOCK ?? "/run/nullsink-credit/credit.sock";

const balances = openDb(DB_PATH);
const proxySocket = serveLedgerSocket({ path: LEDGER_SOCK, balances });
const creditSocket = serveCreditSocket({ path: CREDIT_SOCK, balances });

log.info(
  "boot",
  `nullsink-ledger ${BUILD_VERSION} listening on metering ${LEDGER_SOCK} + credit ${CREDIT_SOCK}`,
);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  proxySocket.stop();
  creditSocket.stop();
  balances.db.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
