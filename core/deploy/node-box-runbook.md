# Node-box migration runbook — bitcoind to its own box

Ordered cutover for moving the BTC rail's bitcoind off the app box onto a WireGuard node box.
`setup-nodes.sh` (run first, on the node box) installs bitcoind, the firewall, and a wg0 skeleton.

The order is load-bearing: **sync completes before the drain**, so the rail-down window is minutes —
and a pruned node cannot `restorewallet` a snapshot whose best block has fallen behind its prune window.

**Gate before step 4:** run the pre-cutover audit (multiple independent adversarial reviews of this
runbook + the final box configs). The drain window is the one place a paid deposit can be silently lost.

1. **WireGuard up.** If the provider image ships ufw, purge it first (`ufw disable && apt-get purge ufw`) —
   the nftables config flushes its rules, and a still-enabled ufw re-asserts on reboot and blocks the
   WireGuard port. Then finish `/etc/wireguard/wg0.conf` on both boxes (`setup-nodes.sh` prints the node's
   ready-made `[Peer]` block); `systemctl enable --now wg-quick@wg0`; verify with `wg show` + ping the peer.

2. **Datadir + conf — no wallet yet.** `install -d -o nullsink -g nullsink -m700 /var/lib/bitcoind`, then
   write `/var/lib/bitcoind/bitcoin.conf`: `prune=<MB>`, `server=1`, `rpcbind=127.0.0.1`,
   `rpcbind=<NODE_WG_IP>`, `rpcallowip=127.0.0.1`, `rpcallowip=<APP_WG_IP>`. Leave `wallet=nullsink` out
   until step 4 — bitcoind refuses to start when a conf-listed wallet is missing.

3. **Sync to completion.** `systemctl enable --now bitcoind`; wait for `initialblockdownload:false`.
   From-scratch IBD is hours-to-days; the app box's rail stays fully live throughout.
   **Fast path — seed from the app box's own synced node** (same pinned version, both x86-64): stop
   bitcoind on the app box, copy `blocks/` + `chainstate/` from its datadir to the node box over WG
   (`rsync`; ~15 GB — do NOT copy `wallets/` or `bitcoin.conf`), restart the app box's bitcoind, start the
   node box's; it catches up the tail in minutes. Deposit detection pauses while the source is stopped —
   deposits are on-chain-durable and credit when it's back, but expect a status-check page. Copy only your
   own node's data; never a third-party snapshot.

4. **Drain, then migrate (the short window).** On the APP box remove `bitcoin` from `PAY_RAILS` in
   `/etc/nullsink.env` + `systemctl restart nullsink`. The drain is the sole defense against a
   paid-but-uncredited deposit: a `/buy` served after the snapshot derives an address the migrated wallet
   never recorded (recovery = manual re-`setlabel` from pending.db). Then migrate: `backupwallet` on the
   app box → copy over WG → `restorewallet` on the node box → add `wallet=nullsink` to the conf →
   `systemctl restart bitcoind`. Migrate, never re-import from the xpub: an order's PK is the wallet's
   derivation index — a fresh keypool collides with keyed orders, and a pruned node can't rescan.
   Open orders freeze during the drain (reaping is rail-scoped) but render `/order-status` in the wrong
   coin's scale — prefer draining when open BTC orders are near zero. Afterwards delete every transient
   copy of the wallet backup (`.dat` on both boxes and any hop machine) — it holds the xpub, which derives
   all past and future deposit addresses.

5. **rpcauth.** On the node box: `sudo PRINT_PASSWORD=1 deploy/regen-bitcoin-rpcauth.sh`; paste the
   printed `BITCOIN_RPC_PASSWORD` into the app box's `/etc/nullsink.env`; set
   `BITCOIN_RPC_URL=http://<NODE_WG_IP>:8332/wallet/nullsink`.

6. **Re-enable + verify.** Re-add `bitcoin` to `PAY_RAILS` **in its original position** (the first rail is
   the `/buy` default) + `systemctl restart nullsink`. Verify immediately:
   `systemctl start status-check.service && journalctl -u status-check.service -n 30` — the BTC probe uses
   the app's exact Basic-auth path, so a mismatched rpcauth pair fails here on the spot. End-to-end gate:
   a real BTC test deposit credits at 3 confirmations; clearnet `:8332` on the node box refused from a
   third host; an XMR deposit still credits (the Monero path must be untouched).

7. **Decommission.** Once step 6 verifies: on the APP box `systemctl disable --now bitcoind`; reclaim
   `/var/lib/bitcoind` when comfortable. Until this step, rollback is one env flip — `BITCOIN_RPC_URL`
   back to localhost + `systemctl restart nullsink`.

**Staging (signet).** Same runbook, rehearsed first — staging IS the release candidate for the prod move.
Differences: `bitcoin.conf` adds `signet=1`; RPC is 38332 (`BITCOIN_RPC_URL=http://<NODE_WG_IP>:38332/wallet/nullsink`);
the signet chain is ~1-2 GB so IBD is minutes and the step-3 fast path is unnecessary. Conf gotcha: on any
non-mainnet chain, network-specific options — `rpcbind`, `rpcport`, `wallet` — are silently ignored at the
top level; put them under a `[signet]` section (step 2's rpcbind lines and step 4's `wallet=nullsink` both).

This runbook is not one-shot: it is the standing procedure for provisioning or rebuilding a node box —
staging, prod, a hosting move, or disaster recovery all re-execute it (a rebuild skips the step-4 drain
when the wallet is already off the app box; restore it from the app box's backup artifact instead).
