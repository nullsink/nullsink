# nullsink Bitcoin node box

This standalone release bundle carries day-two assets for the pruned watch-only Bitcoin Core wallet used
by the app over WireGuard. It contains no nullsink app service, ledger, billing database, provider key, or
alerting stack.

- `upgrade.sh` health-gates a pinned Bitcoin Core upgrade and rolls back its binaries on failure.
- `regen-rpcauth.sh` transactionally rotates node authentication, restores the previous config if the
  restarted node is unhealthy, and prints the matching app password only after recovery.
- `bitcoind.service` and `nftables.conf` are node-role inputs for declarative provisioning.

Fresh-host provisioning is intentionally not implemented as an imperative shell script. It will move to
the Ansible role tracked in issue #162; until then, this bundle supports existing nodes only. Verify its
checksum and GitHub build attestation before use.

The app box must configure an explicit HTTP(S) `BITCOIN_RPC_URL` for the node. App releases neither ship
nor manage bitcoind.
