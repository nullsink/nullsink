// The metering proxy's complete money interface. Request handling deliberately sees promises: production
// injects the Unix-socket client while unit tests can use the in-process SQLite adapter, without changing a
// billing path or accidentally leaving a money write un-awaited.
import type { BalanceStore } from "./db";

export type MeteringLedgerPort = {
  getBalance(hash: string): Promise<number | null>;
  openHold(hash: string, micros: number, holdId: string): Promise<boolean>;
  settleHold(holdId: string, chargedMicros: number): Promise<boolean>;
};

// Test-only local composition. Production uses the socket client; unit/property tests retain a fast
// in-process adapter without changing the handler's asynchronous money contract.
export function localMeteringLedger(store: BalanceStore): MeteringLedgerPort {
  return {
    getBalance: async (hash) => store.getBalance(hash),
    openHold: async (hash, micros, holdId) => store.openHold(hash, micros, holdId),
    settleHold: async (holdId, chargedMicros) => store.settleHold(holdId, chargedMicros),
  };
}
