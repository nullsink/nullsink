# Node-box migration runbook — bitcoind to its own box

Ordered cutover for moving the BTC rail's bitcoind off the app box onto a WireGuard node box.
`setup-nodes.sh` (run first, on the node box) installs bitcoind, the firewall, and a wg0 skeleton.

The order is load-bearing: **the chain is fully synced before the drain**, so the rail-down window is
minutes — and a pruned node cannot `restorewallet` a snapshot whose best block has fallen behind its
prune window.

**Gate before step 4:** run the pre-cutover audit (multiple independent adversarial reviews of this
runbook + the final box configs). The drain window is the one place a paid deposit can be silently lost.

**Rollback ladder** — each step's true undo (it is NOT "one env flip" throughout):
- steps 1–3: restart the app box's local bitcoind; nothing else was touched.
- step 4 (drained): re-add `bitcoin` to `PAY_RAILS` + restart nullsink.
- step 5 (password rotated): restore the saved `BITCOIN_RPC_PASSWORD=` line + flip `BITCOIN_RPC_URL`
  back to localhost (or re-pair locally with `regen-bitcoin-rpcauth.sh`).
- after step 6 (node live, new orders keyed on it): a bare env flip is FORBIDDEN — the local wallet is
  stale (index collisions + unlabeled deposits the poller can never match). Roll back only by a fresh
  drain + reverse wallet migration (backupwallet on the node → restorewallet on the app box) + a local
  rpcauth re-pair.

1. **WireGuard up.** If the provider image ships ufw, purge it first (`ufw disable && apt-get purge ufw`) —
   the nftables config flushes its rules, and a still-enabled ufw re-asserts on reboot and blocks the
   WireGuard port. Then finish `/etc/wireguard/wg0.conf` on both boxes (`setup-nodes.sh` prints the node's
   ready-made `[Peer]` block); `systemctl enable --now wg-quick@wg0`; verify with `wg show` + ping the peer.

2. **Datadir + conf — no wallet yet.** `install -d -o nullsink -g nullsink -m700 /var/lib/bitcoind`, then
   write `/var/lib/bitcoind/bitcoin.conf`: `prune=<match the app box's value>`, `server=1`, `listen=0`
   (outbound-only P2P — the node needs no inbound peers), `rpcbind=127.0.0.1`, `rpcbind=<NODE_WG_IP>`,
   `rpcallowip=127.0.0.1`, `rpcallowip=<APP_WG_IP>`. Leave `wallet=nullsink` out until step 4 — bitcoind
   refuses to start when a conf-listed wallet is missing.

3. **Get the chain — decide the path FIRST, before any `systemctl start`.**
   **Fast path (prod):** seed from the app box's own synced node. Preconditions: `bitcoind --version`
   prints the IDENTICAL version on both boxes, and the node box's bitcoind has NEVER run — if it has,
   stop it and `rm -rf /var/lib/bitcoind/{blocks,chainstate}` first (rsync into a datadir that has run
   merges two LevelDB instances and two block-obfuscation keys; a pruned datadir cannot reindex its way
   out). Then:
   (a) pass 1, source RUNNING: `rsync -a` of `blocks/` and `chainstate/` — the WHOLE directories
       (`blocks/` includes `blocks/index/` and `blocks/xor.dat`, the per-datadir obfuscation key; never
       cherry-pick `blk*.dat`). Nothing else from the datadir is needed.
   (b) `systemctl stop bitcoind` on the app box — NEVER `bitcoin-cli stop` (the unit's Restart=always
       resurrects it in 5s and rsync copies a live database). Verify `systemctl is-active` reports
       `inactive` and the journal shows a clean shutdown before continuing.
   (c) pass 2: `rsync -a --delete` (delta only — the deposit-blind window is just this pass, minutes).
   (d) `systemctl start bitcoind` on the app box. POLL BLIND / unit pages during (b)–(d) are expected —
       do not "fix" them mid-copy.
   (e) node box: `chown -R nullsink:nullsink /var/lib/bitcoind && chmod 700 /var/lib/bitcoind`
       (numeric uids differ across boxes; `rsync -a` preserves them).
   (f) `systemctl enable --now bitcoind`; wait for `initialblockdownload:false`.
   **From-scratch IBD (staging / small chains):** just `systemctl enable --now bitcoind` and wait.
   The app box's rail stays fully live throughout, except pass 2's brief blind window.

4. **Drain, then migrate (the short window).** Gates before draining: open BTC orders near zero AND none
   older than ~18h — the 24h order backstop reaps on age regardless of deposits seen, so a buyer paying
   late in the drain on an old order is the kill zone. Run `systemctl start backup.service` NOW: the fresh
   artifact's pending.db + wallet-label export is the recovery sheet for every open order.
   Drain: remove `bitcoin` from `PAY_RAILS` in `/etc/nullsink.env` + `systemctl restart nullsink`. The
   drain is the sole defense against a paid-but-uncredited deposit: a `/buy` served after the snapshot
   derives an address the migrated wallet never recorded (recovery = manual re-`setlabel` from pending.db).
   Migrate: `backupwallet /var/lib/bitcoind/nullsink.bak` on the app box — inside the datadir; the unit's
   sandbox makes `/root` unwritable and `/tmp` a private namespace — then copy it to
   `/var/lib/bitcoind/nullsink.bak` on the node box, `chown nullsink:nullsink`, `restorewallet "nullsink"
   /var/lib/bitcoind/nullsink.bak`, add `wallet=nullsink` to the conf, `systemctl restart bitcoind`.
   Migrate, never re-import from the xpub: an order's PK is the wallet's derivation index — a fresh
   keypool collides with keyed orders, a pruned node can't rescan, and a reset keypool re-issues indices
   whose old un-swept UTXOs would match future orders after the 24h idempotency-marker purge (a
   double-credit path, not merely an inconvenience). If a cutover attempt aborts, destroy the `.bak` and
   take a fresh `backupwallet` inside the next attempt's drain — a stale snapshot recreates the
   prune-window and collision failures. Afterwards delete every transient copy of the wallet backup on
   both boxes and any hop machine — it holds the xpub, which derives all past and future deposit
   addresses. Open orders freeze during the drain (reaping is rail-scoped) but render `/order-status` in
   the wrong coin's scale — cosmetic only.

5. **rpcauth.** FIRST save the app box's current `BITCOIN_RPC_PASSWORD=` line aside — rotation destroys
   it, and it is the step-5 rollback. On the node box: `sudo PRINT_PASSWORD=1
   deploy/regen-bitcoin-rpcauth.sh`; paste the printed `BITCOIN_RPC_PASSWORD` into the app box's
   `/etc/nullsink.env`; set `BITCOIN_RPC_URL=http://<NODE_WG_IP>:8332/wallet/nullsink`; confirm
   `BITCOIN_RPC_USER=nullsink` (the env template ships it empty — unset means the app sends no auth
   header at all).

6. **Re-enable + verify.** Gate: the node reports `blocks`==`headers`, `initialblockdownload:false`, AND
   `getwalletinfo` shows `scanning:false` — "restorewallet returned" is not "synced". Re-add `bitcoin` to
   `PAY_RAILS` **in its original position** (the first rail is the `/buy` default) + `systemctl restart
   nullsink`. Verify immediately: `systemctl start status-check.service && journalctl -u
   status-check.service -n 30`. Trust ONLY that probe and a real deposit — the app box's `bitcoin-cli`
   still cookie-auths against the old local node and proves nothing about the live path. End-to-end gate:
   a real BTC deposit credits at 3 confirmations; clearnet `:8332` on the node box TIMES OUT from a third
   host (the firewall drops, it does not refuse); an XMR deposit still credits (the Monero path must be
   untouched).

7. **Decommission.** On the APP box: `systemctl disable --now bitcoind` AND remove
   `/var/lib/bitcoind/bitcoin.conf` — a later `setup.sh` re-run resurrects any local node whose conf
   still exists. Reclaim the datadir when comfortable. Only now does the step-3/4 rollback path end.

**Staging (signet).** Same runbook, rehearsed first — staging IS the release candidate for the prod move.
Differences: `bitcoin.conf` adds `signet=1`; RPC is 38332 (`BITCOIN_RPC_URL=http://<NODE_WG_IP>:38332/wallet/nullsink`);
the signet chain is ~1-2 GB so IBD is minutes and the step-3 fast path is unnecessary. Conf gotcha: on any
non-mainnet chain, network-specific options — `rpcbind`, `rpcport`, `wallet`, `listen` — are silently
ignored at the top level; put them under a `[signet]` section. The reverse trap on prod: a copy-pasted
`[signet]` block is silently ignored on mainnet — write the prod conf at the top level.

**Stranded-deposit recovery** (a paid order was reaped): the deposit sits in the wallet labeled with its
order index; the payment↔key link is in the pre-drain backup's pending.db. Find uncredited UTXOs
(`listunspent`, then check `applied_orders` in balances.db for `bitcoin:<txid>:<n>` — absent means never
credited), recover the hash from the backup, credit `credit_micros × received/expected`. NOTE: `nsk topup`
refuses a hash that has never been credited (a first-time buyer has no tokens row) — that case needs a
one-off `credit()` script, not the CLI.

This runbook is not one-shot: it is the standing procedure for provisioning or rebuilding a node box —
staging, prod, a hosting move, or disaster recovery all re-execute it (a rebuild skips the step-4 drain
when the wallet is already off the app box; restore it from the app box's backup artifact instead).
