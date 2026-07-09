// PROMPT-world endpoint assembly (/balance, /v1/models). Imported by handler.ts. Deliberately NOT the
// endpoints/ barrel: the barrel pulls buy.ts, and the proxy binary must not carry payment-world code (the
// stage-4 attested unit stays minimal). Import this module, never "./endpoints", from the prompt world.
import { makeBalance, makeModels } from "./reads";
import type { ProxyEndpointDeps } from "./types";

export function makeProxyEndpoints(d: ProxyEndpointDeps) {
  return {
    balance: makeBalance(d),
    models: makeModels(d),
  };
}
