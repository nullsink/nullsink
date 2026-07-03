# Node-box migration runbook — bitcoind to its own box

Ordered cutover for moving the BTC rail's bitcoind off the app box onto a WireGuard node box.
`setup-nodes.sh` (run first, on the node box) installs bitcoind, the firewall, and a wg0 skeleton.

The order is load-bearing: **sync completes before the drain**, so the rail-down window is minutes —
and a pruned node cannot `restorewallet` a snapshot whose best block has fallen behind its prune window.

**Gate before step 4:** run the pre-cutover audit (multiple independent adversarial reviews of this
runbook + the final box configs). The drain window is the one place a paid deposit can be silently lost.

1. **WireGuard up.** Finish `/etc/wireguard/wg0.conf` on both boxes; `systemctl enable --now wg-quick@wg0`;
   verify with `wg show` + ping the peer.

2. **Datadir + conf — no wallet yet.** `install -d -o nullsink -g nullsink -m700 /var/lib/bitcoind`, then
   write `/var/lib/bitcoind/bitcoin.conf`: `prune=<MB>`, `server=1`, `rpcbind=127.0.0.1`,
   `rpcbind=<NODE_WG_IP>`, `rpcallowip=127.0.0.1`, `rpcallowip=<APP_WG_IP>`. Leave `wallet=nullsink` out
   until step 4 — bitcoind refuses to start when a conf-listed wallet is missing.

3. **Sync to completion.** `systemctl enable --now bitcoind`; wait for `initialblockdownload:false`
   (hours-to-days). The app box's rail stays fully live throughout.

4. **Drain, then migrate (the short window).** On the APP box remove `bitcoin` from `PAY_RAILS` in
   `/etc/nullsink.env` + `systemctl restart nullsink`. The drain is the sole defense against a
   paid-but-uncredited deposit: a `/buy` served after the snapshot derives an address the migrated wallet
   never recorded (recovery = manual re-`setlabel` from pending.db). Then migrate: `backupwallet` on the
   app box → copy over WG → `restorewallet` on the node box → add `wallet=nullsink` to the conf →
   `systemctl restart bitcoind`. Migrate, never re-import from the xpub: an order's PK is the wallet's
   derivation index — a fresh keypool collides with keyed orders, and a pruned node can't rescan.
   Open orders freeze during the drain (reaping is rail-scoped) but render `/order-status` in the wrong
   coin's scale — prefer draining when open BTC orders are near zero.

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
