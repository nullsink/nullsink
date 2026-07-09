// Pay-rail registry + selection. The composition root (src/payments.ts) picks the active rails by the PAY_RAILS
// env (comma list; legacy PAY_RAIL = a single name) and injects their capabilities into the handler + poller.
import { moneroRail } from "./monero";
import { bitcoinRail } from "./bitcoin";
import type { PayRail } from "./types";

export type { PayRail, NewAddress, Incoming } from "./types";

export const RAILS: Record<string, PayRail> = {
  monero: moneroRail,
  bitcoin: bitcoinRail,
};

// Resolve a rail by name, or throw — the boot path in src/payments.ts logs the message and exits on it.
export function selectRail(name: string): PayRail {
  const rail = RAILS[name];
  if (!rail) throw new Error(`unknown rail=${name} (known: ${Object.keys(RAILS).join(", ")})`);
  return rail;
}

// Resolve a comma-separated PAY_RAILS list into the active rails, IN LIST ORDER — the first is the default
// rail /buy uses when a request omits one. Throws on an unknown or empty name (the boot path logs + exits).
export function selectRails(csv: string): Map<string, PayRail> {
  const names = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error("PAY_RAILS is empty");
  const map = new Map<string, PayRail>();
  for (const name of names) map.set(name, selectRail(name)); // selectRail throws on an unknown name
  return map;
}
