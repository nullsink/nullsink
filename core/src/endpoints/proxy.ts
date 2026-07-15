// PROXY TRUST DOMAIN endpoint assembly (/balance, /v1/models). Imported by handler.ts. Kept a trust-domain-specific
// module on purpose: the proxy binary must never carry payments trust domain code (it is the unit the sealed
// tier attests), so the proxy trust domain imports this and only this — never a module that pulls buy.ts.
import { makeBalance, makeModels } from "./reads";
import type { ProxyEndpointDeps } from "./types";

export function makeProxyEndpoints(d: ProxyEndpointDeps) {
  return {
    balance: makeBalance(d),
    models: makeModels(d),
  };
}
