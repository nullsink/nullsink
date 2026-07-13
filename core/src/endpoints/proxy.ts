// PROMPT-world endpoint assembly (/balance, /v1/models). Imported by handler.ts. Kept a world-scoped
// module on purpose: the proxy binary must never carry payment-world code (it is the unit the sealed
// tier attests), so the prompt world imports this and only this — never a module that pulls buy.ts.
import { makeBalance, makeModels } from "./reads";
import type { ProxyEndpointDeps } from "./types";

export function makeProxyEndpoints(d: ProxyEndpointDeps) {
  return {
    balance: makeBalance(d),
    models: makeModels(d),
  };
}
