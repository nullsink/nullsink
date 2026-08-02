# Billing failure acceptance contract

This document is the human-review layer for nullsink's failure billing. Implementation and unit tests may
change; these externally observable outcomes must not change without an explicit product decision.

| Scenario | What the caller observes | Settlement |
| --- | --- | --- |
| Provider fails before returning response headers | `502` or `504` | Full refund |
| Provider returns non-2xx | Relayed or sanitized error | Full refund |
| Buffered provider returns 2xx and a complete usage-bearing body | Complete response | Exact reported usage |
| Buffered provider returns 2xx headers, then its body breaks | nullsink returns `502`; no partial provider body is forwarded | Conservative input-only charge |
| Caller disconnects before nullsink has response headers/body to return | Caller receives no response | Downstream abort is not propagated; accepted upstream work continues and settles by its normal terminal outcome |
| SSE provider returns 2xx, then fails before usage or visible output | Caller already has a `200` stream which then fails | Full refund |
| Anthropic SSE reports cumulative usage, then fails | Caller already has a partial `200` stream | Latest provider-reported cumulative usage |
| OpenAI SSE emits visible output, then fails before final usage | Caller already has a partial `200` stream | Estimated input plus visible output; never the output maximum |
| Client cancels any OpenAI stream before final usage | Partial response; upstream generation is cancelled | Estimated input plus visible streamed output; metadata-only means input only |
| Upstream failure is observed and the client subsequently cancels | Partial/failed response | Upstream-failure policy wins; never the reasoning output maximum |
| Shutdown drains a live stream | Connection closes during restart | Reported usage, or estimated input plus visible output; otherwise full refund |
| Stream-settlement deadline stops a stalled client | Stream terminates | Reported usage, or estimated input plus visible output; otherwise input only |

Every forwarded request must additionally satisfy all of these invariants:

- The final debit is between zero and the up-front hold.
- Repeated/racing settlement attempts have exactly one financial effect and one primary metric effect.
- A provider/operator secret is never returned to the caller.
- Network chunk boundaries do not affect settlement.
- Exact provider usage overrides an estimate.
- No settlement charge may use the raw byte hold or configured output maximum; those are reservations only.
- Provider-reported and estimated failure charges are measured separately by count and microdollars.

The executable contract is `core/test/billing-failure-contract.test.ts`. Generated chunk-boundary and usage
invariants are in `core/test/billing-failure-contract.property.test.ts`; real handler terminal permutations
are in `core/test/billing-terminal-state.property.test.ts`.
