# Target architecture

[Issue #58](https://github.com/nullsink/nullsink/issues/58) tracks the app-box decomposition. This
document is the code-verified status companion: the issue states the goal, while this page separates
released behavior, changes on `main`, and work that has not started.

## What is the target app box?

The target keeps three OS-isolated services on one application box:

| Service | Owns | May call |
| --- | --- | --- |
| Stateless metering proxy | Public `/v1/*` and `/balance` handling, provider credentials, and in-flight requests only | Ledger operations for balance, hold, and settlement; configured upstream providers |
| Ledger service | `balances.db`, token balances, holds, crash recovery, and `applied_orders` | No payment rail or model provider |
| Payments service | Purchase routes, `pending.db`, revenue, the durable credit outbox, and watch-only rail access | Ledger's credit-only interface; rate and wallet/node RPCs |

Caddy remains the public edge. `pending.db` remains payment-side; the phrase “ledger service owns the
DBs” in issue #58 should be read as ownership of the balance ledger, not both application databases.
The payments-to-ledger message remains `credit`; proxy-to-ledger balance/hold/settle operations use a
separate internal interface.

## What has shipped, and what has not?

Status checked against the repository on 2026-07-19; the latest release is v1.9.1.

| Boundary | Status | Evidence or remaining work |
| --- | --- | --- |
| Dedicated Bitcoin node-box option | Released in v1.4.x | Watch-only Bitcoin RPC can cross WireGuard; same-host Bitcoin Core remains supported. |
| Proxy/payments process split | Released in v1.8.0 | Separate binaries, ports, routers, databases, and runtime dependency closures. |
| Durable credit crossing | Released in v1.8.0 | Payments outbox retries over a pathname Unix socket; `applied_orders` makes redelivery harmless. |
| Delivered-link scrubbing | On `main` after v1.9.1 via #124 | Definite acknowledgement clears the outbox hash and amount; legacy acknowledged payloads replay once. |
| Matched backup recovery | On `main` after v1.9.1 via #124 | Restore verifies scrubbed tombstones against `applied_orders` and rejects unsafe partial recovery. |
| Encrypted backup egress | Present in the repository | Coordinated SQLite snapshots can be age-encrypted and sent with an operator-supplied push command; financial reporting egress is not yet defined. |
| Retire direct database access by `nsk` | Not started | Issue/top-up need an administrative credit path; balance and financial reads need narrow interfaces or offline reporting. |
| Separate service users, environments, and state roots | Not started | Proxy and payments still share `User=nullsink`, `/etc/nullsink.env`, and `/var/lib/nullsink`. |
| Standalone ledger service | Not started | The proxy still opens `balances.db` and performs holds, credit application, and boot recovery. |
| Stateless metering proxy | Blocked on ledger extraction | The proxy cannot become stateless until every balance and hold operation crosses the ledger interface. |

The Monero and Bitcoin implementations already share the rail interface and public discovery. Whether
both are enabled in a particular deployment is operator configuration, not a repository guarantee.

## In what order can the remaining boundary ship?

1. **Define financial egress.** Specify the permitted aggregate fields, access path, retention, and
   recovery evidence without rebuilding a delivered payment-to-token history.
2. **Retire live cross-database `nsk` access.** Send issue/top-up through an administrative outbox and
   replace direct reads with narrow internal reads or offline reports.
3. **Separate OS principals.** Give proxy and payments different users, environment files, and state
   roots; grant the credit socket explicitly through a group or ACL.
4. **Extract the ledger.** Move `balances.db`, holds, `applied_orders`, and boot recovery behind two
   internal interfaces: proxy balance/hold/settle and payments credit-only.
5. **Make the proxy stateless.** Prove that a ledger outage rejects inference before upstream forwarding
   and that shutdown/crash hold recovery still preserves the no-overdraft invariant.

Each step must preserve the [money and reliability invariants](invariants.md). No broker or distributed
transaction is required: the payments outbox remains the durable queue.

## Is the diagram attached to issue #58 still accurate?

No. Its central three-service direction remains useful, but these details are stale or too broad:

| Issue #58 diagram claim | Verified position now |
| --- | --- |
| A generic enclave verifier sits between the proxy and all upstream LLM APIs | Anthropic and OpenAI use direct TLS. Only Tinfoil traffic passes through `tinfoil-proxy`, which verifies Tinfoil's remote enclave. |
| The metering proxy is labelled “stateless → TEE” | Statelessness is blocked on ledger extraction. A nullsink proxy TEE is separate feasibility work, not a current guarantee or one of the remaining app-box steps. |
| The credit crossing is labelled “queued · exactly-once” | Socket delivery is at least once and can be ambiguous. The balance effect is exactly once because the receiving ledger stores an idempotency marker. |
| The proxy/payments process split is drawn as a planned upgrade | The split is released in v1.8.0; only extraction of the embedded ledger remains planned. |
| Delivered-link scrubbing and matched restore behavior are absent | Both are on `main` after v1.9.1 via #124. |
| A self-hosted monerod and onion mirror appear in the same target | Neither is required for the three-service app-box decomposition. The current Monero path supports a remote node over Tor; public onion/relay work is a separate network decision. |
| “Ledger service owns the DBs” | The target ledger owns `balances.db`. Payments continues to own `pending.db`, revenue, orders, and the credit outbox. |
| Backups and operator tooling are omitted | They are boundary-relevant: backups already form an optional encrypted egress path, while `nsk` remains the explicit live cross-database exception. |

The compact ownership map in [System boundaries](architecture.md#what-runs-in-the-shipped-topology) is the
canonical current-state diagram. This page is canonical for target status; the historical issue image
should not be used as a deployment or security reference.

## Which choices still need an owner decision?

- What financial fields may leave the app box, through which authenticated path, and for how long.
- Whether read-only `nsk` commands become internal service calls or operate only on verified snapshots.
- Whether a nullsink proxy TEE is still a goal after ledger extraction.
- Whether to operate a self-hosted Monero node box or a public onion/geographic relay; neither is needed
  to finish issue #58's app-box boundary.
- What operational evidence is required before declaring Bitcoin and Monero equal primary rails in
  production.
