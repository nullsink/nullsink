# Security policy

nullsink is a prepaid, account-less proxy in front of third-party LLM APIs, funded with cryptocurrency. It
handles **real money** (prepaid balances, on-chain deposits) and makes **privacy guarantees** (no accounts,
no IP, no request logs). We take security and privacy reports seriously and appreciate responsible disclosure.

This policy covers the whole repository — both the `core/` service and the `client/` UI.

## Reporting a vulnerability

**Email:** security@nullsink.is

- **Encrypt sensitive details** with our PGP key, published at
  <https://nullsink.is/.well-known/security-pgp.asc> (and machine-readably via
  <https://nullsink.is/.well-known/security.txt>). Fingerprint:
  `2944 14D5 3A90 CCA3 B0F0 4E7C E494 1F1F F3F2 FF08`. PGP-aware clients can also auto-discover it (WKD)
  when emailing `security@nullsink.is`.
- If you prefer, use GitHub's **private vulnerability reporting** on this repository.
- Please do **not** open a public issue, PR, or discussion for a security report.

Include what you'd want if you were triaging it: a clear description, the affected commit/version, a minimal
proof-of-concept or reproduction, and the impact you think it has.

## What we especially care about

This project's threat model is money + privacy, so these rank highest:

- **Billing integrity** — anything that lets a request escape metering or overdraft a balance: free/under-billed
  usage, hold-sizing bypass, refund/settlement exploits, negative or inflated balances.
- **Privacy** — anything that de-anonymizes a user or links a payment to a token: leaking the payment↔token
  link, exposing IPs/identity, or recovering it from logs, the databases, or timing.
- **Custody & secrets** — exposure of the upstream provider key, wallet/RPC credentials, or any path that
  reaches spend authority (the design keeps the box watch-only; report anything that breaks that).
- **Auth / gating** — bypassing the token gate or the model/feature gates, or coercing an unsupported (off-card,
  fee-bearing) call.

## Scope

**In scope:** the code in this repository — the proxy and operator CLIs (`core/src`, `core/cli`), the dev
scripts (`core/scripts`), the deploy configuration (`core/deploy`), and the purchase UI (`client/`).

**Out of scope:**

- **The live hosted service** (`nullsink.is` and its box). Please do **not** test against production — no
  scanning, no test orders against the real wallets, no attempts to access other users' balances or orders.
  Demonstrate findings against your **own local instance**.
- Volumetric attacks / DoS / resource exhaustion (we use deliberate, privacy-preserving global caps, not
  per-identity limits — that's a documented trade-off, not a bug).
- Social engineering, physical access, and vulnerabilities in third-party dependencies without a
  nullsink-specific exploit.
- Missing "best-practice" hardening with no demonstrated impact.

## Safe harbor

We will not pursue or support legal action against good-faith research that follows this policy: stay within
scope, don't access or modify data that isn't yours, keep your proof-of-concept minimal, don't disrupt the
service, and give us reasonable time to fix before any public disclosure. If in doubt, ask first.

## What to expect

This is a small project, so please be patient. We aim to acknowledge a report within **5 business days**, will
keep you updated as we investigate, and prefer **coordinated disclosure** — we'll agree on a timeline and are
happy to credit you (or keep you anonymous) once a fix ships. There is no paid bug-bounty program at this time.
