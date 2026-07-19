# Tinfoil attestation

The Tinfoil path uses a local verifying proxy to attest the upstream enclave before forwarding a model
request.

## What does attestation prove?

Attestation proves, cryptographically, that we route to a genuine SEV-SNP enclave running
Tinfoil's published model image. It closes the hole where a spoofed or compromised endpoint
could retain content while we forwarded in good faith.

It is an **integrity** guarantee, not user-facing confidentiality. nullsink meters by reading
request content — to size the hold, enforce the output cap, and bill from usage — so a user's
plaintext is always in nullsink's memory. Attestation verifies the *backend*; it never moves
where plaintext lives. The confidentiality boundary stays at enclave↔nullsink. User end-to-end
confidentiality would require a different architecture (the user attesting the enclave
themselves, with nullsink a blind tunnel billing off the enclave's signed usage), which gives
up sound holds and cap enforcement — a different product. See [trust-model.md](trust-model.md).

## How does the verifying sidecar work?

`tinfoil-proxy` ([tinfoilsh/tinfoil-proxy](https://github.com/tinfoilsh/tinfoil-proxy)) runs as
a systemd daemon on `127.0.0.1:3301`, alongside the rail daemons. The app points
`TINFOIL_BASE_URL` at it, so every Tinfoil request is verified before it leaves the box:

1. On startup the proxy attests the enclave at `inference.tinfoil.sh`: the **SEV-SNP hardware
   report**, the **code measurement** (compared against the expected measurement from the latest
   release of Tinfoil's enclave-config repo, `tinfoilsh/confidential-model-router`, published as a
   Sigstore bundle and committed to the transparency log), and the **enclave-bound TLS key** (the
   attestation carries the SHA-256 of the enclave's TLS public key; the proxy pins it for the
   session and re-verifies on rotation).
2. It then reverse-proxies `/v1` to the enclave, passing `Authorization` through unchanged.
3. It **fails closed**: if attestation fails it exits before binding `:3301`, so the app's
   Tinfoil requests get connection-refused rather than an unverified forward. OpenAI and
   Anthropic are unaffected — only the Tinfoil path depends on the proxy.

The core binary stays zero-dep: the proxy is an ops component like the wallet daemons, not an
in-process library in the security-critical hot path. The Tinfoil API key stays app-side in
`/etc/nullsink.env` — the app injects it and the proxy forwards it, so the key never enters the
proxy unit's environment.

## How is the sidecar deployed?

Deployed entirely under `core/deploy/` (read those files for specifics — they're commented):
`setup.sh` pins + checksum-verifies the binary and installs/enables the proxy when a Tinfoil key is
present, defaulting `TINFOIL_BASE_URL` to it; `tinfoil-proxy.service` is the hardened systemd unit;
`status-check.sh` adds a liveness probe. Two non-obvious choices worth stating once: the unit takes
no `IPAddress*` filter (it needs clearnet egress to the enclave + GitHub + Sigstore, like
`nullsink-proxy.service`), and `deploy.sh` is unchanged — it refreshes the unit on redeploy but never
restarts the sidecar. Fresh boxes install it through `setup.sh`; existing boxes activate a refreshed pin
explicitly with `upgrade-component.sh tinfoil`.

## Which gaps remain?

- **No measurement/version pinning.** We pin the proxy *binary* by SHA-256, but the proxy then
  trusts whatever Tinfoil publishes as its *latest* release (gated only by Sigstore transparency)
  — there is no CLI flag to pin a specific release or measurement. The trusted measurement changes
  on each release (a few times a week), so any proxy restart silently adopts the newest, and pinning
  is impractical here anyway (see *Why we don't pin* below). The pin must not be overstated: the
  verifier *binary* is pinned, the trust *target* is not.
- **Startup-only liveness.** The `:3301` probe proves attestation at startup, not ongoing. A
  mid-session enclave cert-rotation failure surfaces as upstream 502s in the app journal.
- **Availability coupling.** Fail-closed ties Tinfoil availability to GitHub/Sigstore
  reachability at proxy (re)start; `RestartSec` backoff and the status-check page cover it, and it
  does not affect the other providers.
- **Loopback hop.** app→proxy is plain HTTP on `127.0.0.1` (it carries the bearer key, loopback-only).

## Why is the enclave measurement not pinned?

We considered pinning a specific reviewed measurement (and refusing any other), but it's
impractical against Tinfoil's deployment: the fleet serves only the latest release and the
measurement changes on every release (a few times a week), so a hard pin would fail closed on
every rollout — with no security gain, since the live enclave is always the newest and an old pin
can't be served. Auto-latest (verify against the newest published, Sigstore-logged release) is the
sensible default and also auto-receives Tinfoil's security fixes. The realistic guard is **drift
detection** — record the verified measurement and alert when it changes unexpectedly — which we can
do box-side with no Tinfoil change (tracked in the backlog). Pinning would only be worthwhile if
Tinfoil offered a slow/stable release channel.
