# Tinfoil attestation (rung 2) — design note

Rung 1 (shipped) forwards to Tinfoil over plain HTTPS with no enclave verification —
`trust-model.md` records the gap as "trusted but not yet verified." Rung 2 verifies the
enclave before routing.

## Scope
Operator integrity: cryptographic proof we route to a genuine SEV-SNP enclave running the
published model image, closing the hole where a spoofed or compromised endpoint could
retain content while we forward in good faith. The user's confidentiality boundary stays
at enclave↔nullsink — metering reads plaintext to size the hold, enforce the cap, and bill.
So this is an integrity feature; user-facing end-to-end privacy would need a different
architecture (a blind tunnel billing off the enclave's signed usage) and is out of scope.

## Approach — verifying-proxy sidecar
Run Tinfoil's local verifying proxy as a systemd daemon alongside the rail daemons
(`bitcoind`, `monero-wallet-rpc`). Point `TINFOIL_BASE_URL` at `http://127.0.0.1:<port>`;
it attests, then forwards. The core binary stays zero-dep — the proxy is an ops component
like the wallet daemons. Chosen over an in-process `@tinfoilsh/verifier` (a runtime
dependency in the security-critical hot path) and over DIY SEV-SNP verification (large,
fragile crypto we'd then own).

## Open questions — confirm before building
- Tinfoil's current verifying-proxy tooling: exact binary, release artifacts, and how it
  pins/refreshes the expected enclave measurements.
- Keeping those trusted measurements current with Tinfoil's releases without manual drift.
- Failure handling: proxy down → Tinfoil unavailable; needs a health check + alert.

## Wiring sketch
- `core/deploy/tinfoil-proxy.service` — pinned systemd unit, modeled on
  `monero-wallet-rpc.service`.
- `deploy/setup.sh` + `deploy/deploy.sh` — install/refresh + health-gate the proxy.
- `TINFOIL_BASE_URL` → the localhost proxy; key injection unchanged.
- `trust-model.md` — move the Tinfoil line to "verified"; clarify in the README that
  zero-dep means the core package (the box runs sidecars by design).
- Re-add OpenAI-style modality/audio backstops to `premiumReject` if the curated model set
  ever gains a non-text id (pre-merge audit finding).
