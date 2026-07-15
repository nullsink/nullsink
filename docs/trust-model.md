# Trust model

nullsink is a prepaid, account-less LLM proxy paid in Monero or Bitcoin. This doc states
what it guarantees, how the code enforces each guarantee, and — honestly — what it does
**not** protect against. The point is to let you verify the claims against the source rather
than take them on faith. See [architecture.md](architecture.md) for how the pieces fit.

## What we guarantee, and how

| Guarantee | How the code enforces it |
| --- | --- |
| **No accounts** — just a bearer token | `token-format.ts`: a token is `0sink_` + 256 bits of randomness + a typo checksum. There is no signup; possession of the string is the only credential. |
| **Only the hash is stored** | `ledger/db.ts` (`hashToken`): balances are keyed by the SHA-256 of the token. The raw token is read from a request header, hashed in-process, and never written to disk. A leak of the balances DB yields no usable credentials. |
| **No local access/content logs; exceptional events are minimized** | Caddy has no access log and strips client-IP forwarding. Prompts and outputs stream through and are never stored by nullsink. `handler.ts` emits content-minimized per-event lines only for exceptional upstream/billing outcomes; they carry no token/hash/IP/prompt/response or free-form provider text. OpenAI requests force `store:false`, which disables application-state storage but not default abuse-monitoring retention. Tinfoil's content non-retention rests on enclave ephemerality, and a local attesting proxy verifies its published image before forwarding (see [tinfoil-attestation.md](tinfoil-attestation.md)). Aggregate metrics are described below. |
| **The live logical payment ↔ token link is cleared after delivery** | The direct link lives only in `pending.db` (`ledger/orders.ts`), separate from balances. Settlement retains it in the unacked outbox while paid credit still needs delivery; a definite ledger ack atomically clears the hash and amount from that active row. Transaction-derived idempotency keys/timestamps and per-sale accounting remain, but carry no token hash or address. SQLite/WAL remnants and backups are scoped honestly below. |
| **Your key and identity never leak upstream** | `http/headers.ts` strips the headers that identify the caller or our account before forwarding — the client's auth (we inject our own), any org/beta headers, and the client's SDK fingerprint — and scrubs our org/project headers off responses; the exact list is the `STRIP` set in the source. |
| **Watch-only custody** | The wallets on the box are view-only (Monero) / watch-only (Bitcoin). `rails/monero.ts` and `rails/bitcoin.ts` only mint addresses and read incoming transfers — there is no spend, sweep, or withdraw call anywhere in the code. The spend key stays cold/offline. |
| **Rate limits don't identify you** | `ratelimit.ts` is a single global bucket — no per-IP or per-token keying. The code handles no client IP at all. |
| **Your balance can't go negative** | The debit is an atomic conditional update (`ledger/db.ts`), and settlement bounds every refund to the hold it releases (`handler.ts`, `billActual`). See [billing-model.md](billing-model.md). |
| **Errors don't leak our key, billing, or provider state** | `handler.ts` (`relayOrMaskUpstream`) relays only clearly user-fixable errors verbatim and masks everything else (our key status, our billing state, provider outages) behind an opaque code. |

## What we do collect

Running a service this data-light still needs *some* operational signal — without it an operator
can't tell a healthy box from a broken one, or see where users are hitting friction. So nullsink
keeps **aggregate metrics**: plain counters and high-water marks, held in memory for each window,
flushed to a single periodic `[metrics]` system-journal line, then reset (`metrics.ts`). Only that
aggregate line follows the host journal's retention; there is no per-request metrics record.

Exceptional upstream, stream, and billing failures also emit one content-minimized journal event so the
operator can repair money or provider faults. These may contain an endpoint/status and nullsink&apos;s own fixed
category, but never a token, token hash, client IP, payment address,
transaction id, prompt, or response. They follow the same rotating journal retention.

Each is a count of events — requests forwarded versus cleanly billed, upstream errors by category,
requests turned away at the gate (bad token, insufficient funds, unsupported model), money-safety
anomalies, and peak concurrency. None of them carries a token, hash, IP, address, txid, or any
prompt or output. A rising counter shows the operator that, say, auth checks are failing or streams
are aborting — as a total only, with nothing that ties it to a person or a request. That's enough
to fix outages and smooth the edges users actually hit, and too coarse to profile anyone.

## What this does not protect against

Being honest about the edges matters more than the marketing:

- **The box is trusted.** Watch-only custody and unlinkability hold *as long as the running
  box behaves like this source*. A compromised or malicious operator could record what the
  code doesn't. Today's lever against that is the source itself; cryptographic proof that the
  live box runs it (build provenance, attestation) is still future work — see *Verifiability*.
- **Upstream enclave: verified genuine, not version-pinned.** For Tinfoil, a local attesting proxy
  verifies that we route to a real enclave running Tinfoil's published image. That
  is operator integrity — it does not give you end-to-end confidentiality, since metering still
  reads your plaintext on the box. And we pin the verifier *binary* but not the measurement it
  checks, so we trust whatever Tinfoil publishes as its latest release; see
  [tinfoil-attestation.md](tinfoil-attestation.md).
- **On-chain deposits are public.** The blockchain shows a payment to an address; what
  nullsink limits is the *direct logical link* from that payment to a token. The active payment
  record temporarily holds that link so credit can land, then clears it after delivery. The privacy of the
  deposit itself depends on the coin you chose — Monero shields amounts and addresses, Bitcoin
  is transparent. The watch-only wallet keeps generated addresses with non-token labels (a fixed service
  label for Monero and an order index for Bitcoin), but no token or token hash.
- **Logical deletion is not immediate forensic erasure.** Clearing the live outbox columns removes the
  application's active payment↔token record; SQLite pages/WAL can retain older bytes until WAL truncation
  or byte reuse. On-box backups are plaintext unless encryption is configured; off-box upload is permitted
  only for encrypted artifacts. Both can retain earlier active state under separate retention policies.
- **The network edge sees timing and sizes.** Caddy terminates TLS and fronts the app; an
  observer at that layer — or on the network — sees that you reached nullsink, and the timing
  and byte sizes of traffic, even though bodies are never logged.
- **A lost token is unrecoverable.** There is no account to recover through and no reset. Lose
  the token, lose the balance. This is by design.
- **Limits are a blunt fail-safe.** Under a determined flood the global limits throttle
  everyone equally. That's deliberate: a per-user bucket would mean identifying everyone just to
  target an abuser.

## Verifiability

nullsink is AGPL-3.0-or-later, and under §13 the running source is offered to you — so the
guarantees above are checkable in this repo rather than promised. Released artifacts ship with a `SHA256SUMS` file, so a box can confirm it runs the
exact binary CI built. Stronger proof that the live box runs exactly this source (reproducible builds, build provenance, a
version+digest endpoint, remote attestation) is planned but **not yet shipped** — so for now,
"verify" means reading the source you're entitled to.
