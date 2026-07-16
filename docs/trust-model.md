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
| **No request logs, no content retention** | `log.ts` records only operational lines — never a per-request entry, and never a user-linkable pair (no token hash beside a txid or address). Prompts and outputs stream straight through and are never stored; the OpenAI provider also forces `store:false` so the upstream retains nothing. (Tinfoil gets no such flag — `store` is OpenAI-specific — and its non-retention rests on enclave ephemerality; a local attesting proxy verifies, before forwarding, that we reach a genuine enclave running Tinfoil's published image — operator integrity, see [tinfoil-attestation.md](tinfoil-attestation.md).) Aggregate metrics are kept — see *What we do collect*, below. |
| **Delivered payments and tokens have no retained direct link** | The payment ↔ token link lives only in `pending.db` (`ledger/orders.ts`), separate from balances. Settlement moves it from the active order to an unacknowledged delivery row; a definite ledger ack clears that row's token hash and amount. Its transaction-derived idempotency key and timestamps remain to prevent duplicate credit, and the revenue record contains no hash or address. |
| **Your key and identity never leak upstream** | `http/headers.ts` strips the headers that identify the caller or our account before forwarding — the client's auth (we inject our own), any org/beta headers, and the client's SDK fingerprint — and scrubs our org/project headers off responses; the exact list is the `STRIP` set in the source. |
| **Watch-only custody** | The wallets on the box are view-only (Monero) / watch-only (Bitcoin). `rails/monero.ts` and `rails/bitcoin.ts` only mint addresses and read incoming transfers — there is no spend, sweep, or withdraw call anywhere in the code. The spend key stays cold/offline. |
| **Rate limits don't identify you** | `ratelimit.ts` is a single global bucket — no per-IP or per-token keying. The code handles no client IP at all. |
| **Your balance can't go negative** | The debit is an atomic conditional update (`ledger/db.ts`), and settlement bounds every refund to the hold it releases (`handler.ts`, `billActual`). See [billing-model.md](billing-model.md). |
| **Errors don't leak our key, billing, or provider state** | `handler.ts` (`relayOrMaskUpstream`) relays only clearly user-fixable errors verbatim and masks everything else (our key status, our billing state, provider outages) behind an opaque code. |

## What we do collect

Running a service this data-light still needs *some* operational signal — without it an operator
can't tell a healthy box from a broken one, or see where users are hitting friction. So nullsink
keeps **aggregate metrics**: plain counters and high-water marks, held in memory, flushed to a
single periodic `[metrics]` log line and reset on restart (`metrics.ts`). Nothing is persisted.

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
  nullsink limits is the *direct logical link* from that payment to a token. The active order and
  unacknowledged delivery record temporarily hold that link so credit can land, then clear it. The privacy of the
  deposit itself depends on the coin you chose — Monero shields amounts and addresses, Bitcoin
  is transparent — while nullsink's part is only to hide the link. (The watch-only wallet keeps
  the addresses it generated, so they're identifiable as nullsink's, but never tied to a token.)
- **Logical scrubbing reduces recovery redundancy.** SQLite pages, WAL files, and backups may retain
  older bytes after the live columns are cleared. More importantly, a scrubbed delivery row cannot replay
  a credit lost by restoring `balances.db` without its matching `pending.db`; the two ledgers must be backed
  up and restored as a matched pair.
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
