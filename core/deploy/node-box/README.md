# nullsink Bitcoin node box

This standalone release bundle runs the pruned watch-only Bitcoin Core wallet used by the app over
WireGuard. It contains no nullsink app service, ledger, billing database, provider key, or alerting stack.

- `setup.sh` bootstraps a fresh node host without inventing a chain/wallet migration procedure.
- `upgrade.sh` health-gates a pinned Bitcoin Core upgrade and rolls back its binaries on failure.
- `regen-rpcauth.sh` rotates node authentication and prints the matching app password once.
- `bitcoind.service` and `nftables.conf` are installed only by `setup.sh` on this host role.

The app box must configure an explicit non-loopback `BITCOIN_RPC_URL` for this node. App releases neither
ship nor manage bitcoind.
