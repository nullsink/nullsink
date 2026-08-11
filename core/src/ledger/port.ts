// The metering proxy's complete money interface. Request handling deliberately sees promises even while
// production still uses the in-process SQLite store: Step 5 can replace this adapter with a Unix-socket
// client without changing any billing path or accidentally leaving a money write un-awaited.
import type { BalanceStore } from "./db";

export type MeteringLedgerPort = {
  getBalance(hash: string): Promise<number | null>;
  openHold(hash: string, micros: number, holdId: string): Promise<boolean>;
  settleHold(holdId: string, chargedMicros: number): Promise<boolean>;
};

// Temporary local composition for the pre-extraction proxy. SQLite remains synchronous internally, while
// the proxy-facing contract is unconditionally async. Keeping the adapter here—not in handler.ts—makes the
// eventual socket client a straight implementation swap rather than another request-path refactor.
export function localMeteringLedger(store: BalanceStore): MeteringLedgerPort {
  return {
    getBalance: async (hash) => store.getBalance(hash),
    openHold: async (hash, micros, holdId) => store.openHold(hash, micros, holdId),
    settleHold: async (holdId, chargedMicros) => store.settleHold(holdId, chargedMicros),
  };
}
