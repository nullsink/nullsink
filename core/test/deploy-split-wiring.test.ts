// The proxy/payments split is enforced in code, but the production boundary also depends on three
// deploy artifacts that TypeScript cannot typecheck: Caddyfile, systemd units, and setup.sh's seeded
// environment. A mismatched port or CREDIT_SOCK still lets both binaries start, then leaves public paths
// 502ing or paid credits stuck in pending.db. Keep this deliberately static: it checks the committed
// production contract without needing Caddy or systemd installed in the test runner.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const deploy = (name: string) => fileURLToPath(new URL(`../deploy/${name}`, import.meta.url));
const src = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url));
const releaseWorkflow = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)),
  "utf8",
);

const caddy = readFileSync(deploy("Caddyfile"), "utf8");
const proxyUnit = readFileSync(deploy("nullsink-proxy.service"), "utf8");
const paymentsUnit = readFileSync(deploy("nullsink-payments.service"), "utf8");
const walletUnit = readFileSync(deploy("monero-wallet-rpc.service"), "utf8");
const tinfoilUnit = readFileSync(deploy("tinfoil-proxy.service"), "utf8");
const setup = readFileSync(deploy("setup.sh"), "utf8");
const deployScript = readFileSync(deploy("deploy.sh"), "utf8");
const deployLib = readFileSync(deploy("lib.sh"), "utf8");
const migration = readFileSync(deploy("migrate-service-isolation.sh"), "utf8");
const labelExport = readFileSync(deploy("backup-bitcoin-labels.sh"), "utf8");
const alert = readFileSync(deploy("alert.sh"), "utf8");
const backup = readFileSync(deploy("backup.sh"), "utf8");
const backupUnit = readFileSync(deploy("backup.service"), "utf8");
const labelUnit = readFileSync(deploy("nullsink-bitcoin-label-export.service"), "utf8");
const backupReport = readFileSync(deploy("backup-report.sh"), "utf8");
const backupTimer = readFileSync(deploy("backup.timer"), "utf8");
const restore = readFileSync(deploy("restore.sh"), "utf8");
const statusCheck = readFileSync(deploy("status-check.sh"), "utf8");
const statusUnit = readFileSync(deploy("status-check.service"), "utf8");
const proxy = readFileSync(src("proxy.ts"), "utf8");
const payments = readFileSync(src("payments.ts"), "utf8");

function upstreamFor(path: string): string | null {
  // Caddy's exact-path `handle` blocks are the deploy contract. Stop at the next handle block so a
  // later reverse_proxy cannot make a missing route falsely pass.
  const block = caddy.match(new RegExp(`handle ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([\\s\\S]*?)(?=\\n\\thandle |\\n\\t# --- Everything else|$)`));
  return block?.[1].match(/reverse_proxy 127\.0\.0\.1:(\d+)/)?.[1] ?? null;
}

function namedMatcher(name: string): string {
  const startMarker = `\t\t@${name} {\n`;
  const start = caddy.indexOf(startMarker);
  if (start === -1) return "";
  const end = caddy.indexOf("\n\t\t}\n", start + startMarker.length);
  return end === -1 ? "" : caddy.slice(start, end + "\n\t\t}".length);
}

test("the two roots, setup defaults, Caddy routes, and service units agree on the split ports", () => {
  expect(proxy).toContain('numEnv("PORT", 8080');
  expect(payments).toContain('numEnv("PAYMENTS_PORT", 8081');
  expect(migration).toContain("PORT=8080");
  expect(migration).toContain("PAYMENTS_PORT=8081");
  expect(proxyUnit).toContain("EnvironmentFile=/etc/nullsink-proxy.env");
  expect(paymentsUnit).toContain("EnvironmentFile=/etc/nullsink-payments.env");

  for (const path of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1/models", "/balance"])
    expect(upstreamFor(path)).toBe("8080");
  for (const path of ["/buy", "/order-status", "/rails"]) expect(upstreamFor(path)).toBe("8081");
});

test("both systemd units and both roots use the one credit-group-authenticated socket", () => {
  const socket = "/run/nullsink-credit/credit.sock";
  expect(proxy).toContain(`process.env.CREDIT_SOCK ?? "${socket}"`);
  expect(payments).toContain(`process.env.CREDIT_SOCK ?? "${socket}"`);
  expect(proxyUnit).toContain(`Environment=CREDIT_SOCK=${socket}`);
  expect(paymentsUnit).toContain(`Environment=CREDIT_SOCK=${socket}`);
  expect(proxyUnit).toContain("RuntimeDirectory=nullsink-credit");
  expect(proxyUnit).not.toContain("ExecStartPre=+/bin/chgrp nullsink-credit");
  expect(proxyUnit).toContain(
    "chgrp nullsink-credit /run/nullsink-credit /run/nullsink-credit/credit.sock",
  );
  expect(proxyUnit).toContain("chmod 0660 /run/nullsink-credit/credit.sock");
  expect(paymentsUnit).toContain("SupplementaryGroups=nullsink-credit");
});

test("payments starts only after the proxy credit socket is ready", () => {
  expect(proxyUnit).toContain("ExecStartPost=+/bin/sh -ec 'until [ -S /run/nullsink-credit/credit.sock ]");
  expect(proxyUnit).toContain("TimeoutStartSec=60");
  expect(paymentsUnit).toContain("After=nullsink-proxy.service");
});

test("the deployed principal, environment, state, and read-group matrix is least-privilege", () => {
  expect(proxyUnit).toContain("User=nullsink-proxy\nGroup=nullsink-proxy-read");
  expect(proxyUnit).toContain("StateDirectory=nullsink-proxy");
  expect(proxyUnit).not.toContain("nullsink-payments-read");
  expect(proxyUnit).not.toContain("/etc/nullsink-payments.env");

  expect(paymentsUnit).toContain("User=nullsink-payments\nGroup=nullsink-payments-read");
  expect(paymentsUnit).toContain("StateDirectory=nullsink-payments");
  expect(paymentsUnit).not.toContain("nullsink-proxy-read");
  expect(paymentsUnit).not.toContain("/etc/nullsink-proxy.env");

  expect(backupUnit).toContain("User=nullsink-backup\nGroup=nullsink-backup");
  expect(backupUnit).toContain("SupplementaryGroups=nullsink-proxy-read nullsink-payments-read");
  expect(backupUnit).toContain("EnvironmentFile=-/etc/nullsink-backup.env");
  expect(backupUnit).not.toContain("/etc/nullsink-payments.env");
  expect(labelUnit).toContain("User=nullsink-payments\nGroup=nullsink-payments-read");
  expect(labelUnit).toContain("EnvironmentFile=-/etc/nullsink-payments.env");

  expect(walletUnit).toContain("User=nullsink-payments\nGroup=nullsink-payments-read");
  expect(tinfoilUnit).toContain("User=nullsink-proxy\nGroup=nullsink-proxy-read");
  expect(tinfoilUnit).not.toContain("EnvironmentFile=");

  expect(migration).toContain('usermod -a -G "$PROXY_READ_GROUP,$PAYMENTS_READ_GROUP" "$OPERATOR_USER"');
  expect(migration).toContain('usermod -a -G "$PROXY_READ_GROUP,$PAYMENTS_READ_GROUP" "$BACKUP_USER"');
  expect(migration).toContain('usermod -a -G "$CREDIT_GROUP" "$PAYMENTS_USER"');
  expect(migration).not.toMatch(/usermod -a -G "\$CREDIT_GROUP" "\$(?:PROXY|BACKUP)_USER"/);
  expect(migration).toContain("active same-box bitcoind still uses the legacy operator uid");
  expect(migration).toContain('chown "root:$ROOT_GROUP" "$role_env"');
  expect(migration).toContain('chmod 0600 "$role_env"');
  expect(migration).not.toContain("nullsink-wallet");
  expect(deployLib).toContain("activate_isolation_sidecars");
  expect(deployLib).toContain("chown root:root /etc/monero-wallet-rpc.env");
  const restartSidecars = deployLib.slice(
    deployLib.indexOf("restart_isolation_sidecars()"),
    deployLib.indexOf("health_ok()"),
  );
  expect(restartSidecars.indexOf('systemctl stop "${active_units[@]}"')).toBeGreaterThan(-1);
  expect(restartSidecars.indexOf("activate_isolation_sidecars")).toBeGreaterThan(
    restartSidecars.indexOf('systemctl stop "${active_units[@]}"'),
  );
  expect(restartSidecars.indexOf('systemctl start "${active_units[@]}"')).toBeGreaterThan(
    restartSidecars.indexOf("activate_isolation_sidecars"),
  );
  expect(restartSidecars).not.toContain("systemctl restart");
  expect(setup.indexOf("activate_isolation_sidecars")).toBeGreaterThan(
    setup.indexOf("install_units"),
  );
});

test("credential-bearing curl configuration never appears in process arguments", () => {
  for (const script of [labelExport, statusCheck, alert]) {
    expect(script).toContain("curl --config -");
  }
  expect(labelExport).not.toContain("--user");
  expect(statusCheck).not.toContain(
    '-u "${BITCOIN_RPC_USER:-}:${BITCOIN_RPC_PASSWORD:-}"',
  );
  const sendBody = alert.slice(alert.indexOf("send() {"));
  expect(sendBody).not.toContain("https://api.telegram.org/bot");
});

test("the Monero wallet keeps ring metadata outside its protected home", () => {
  expect(walletUnit).toContain("StateDirectory=nullsink-wallet");
  expect(walletUnit).toContain("ProtectHome=true");
  expect(walletUnit).toContain("--shared-ringdb-dir %S/nullsink-wallet/.shared-ringdb");
  expect(walletUnit).not.toMatch(/--shared-ringdb-dir (?:~|\/home)/);
});

test("edge body caps and outages are disjoint, status-aware contracts", () => {
  // Both request_body and reverse_proxy enter handle_errors. Path-only matchers turn a terminal 413 into a
  // retryable outage, so every native body-cap matcher is pinned to 413 and every outage matcher to 5xx.
  expect(caddy).toContain("# --- Edge error contract.");
  for (const name of ["anthropic_too_large", "openai_too_large", "payments_too_large"])
    expect(namedMatcher(name), name).toContain("expression {err.status_code} == 413");
  for (const name of ["anthropic_outage", "openai_outage", "balance_outage", "proxy_outage", "payments_outage"])
    expect(namedMatcher(name), name).toContain("expression {err.status_code} >= 500 && {err.status_code} <600");

  // These limits are one fixed contract, not independent operator knobs that can drift from Caddy.
  expect(caddy).toContain("max_size 32MiB");
  expect(caddy).toContain("max_size 4KiB");
  expect(proxy).toContain("const MAX_MESSAGES_BODY_BYTES = 32 * 1024 * 1024;");
  expect(payments).toContain("const MAX_BUY_BODY_BYTES = 4 * 1024;");
  expect(proxy).not.toContain('numEnv("MAX_MESSAGES_BODY_BYTES"');
  expect(payments).not.toContain('numEnv("MAX_BUY_BODY_BYTES"');

  expect(caddy).toMatch(/header x-should-retry "false"\n\t\t\trespond `\{"type":"error","error":\{"type":"request_too_large","message":"payload_too_large"\}\}` 413/);
  expect(caddy).toMatch(/header x-should-retry "false"\n\t\t\trespond `\{"error":\{"message":"payload_too_large","type":"invalid_request_error","code":"payload_too_large"\}\}` 413/);
  expect(caddy).toContain('respond `{"error":"payload_too_large"}` 413');
  expect(caddy).toMatch(/header x-should-retry "true"\n\t\t\trespond `\{"type":"error","error":\{"type":"api_error","message":"service_unavailable"\}\}` 503/);
  expect(caddy).toMatch(/header x-should-retry "true"\n\t\t\trespond `\{"error":\{"message":"service_unavailable","type":"server_error","code":"service_unavailable"\}\}` 503/);
  expect(caddy).toContain('respond `{"error":"proxy_error"}` 503');
  expect(caddy).toContain('respond `{"error":"payments_error"}` 503');
});

test("balance responses are never stored by an intermediary", () => {
  // /balance is a GET keyed by the bearer-like x-api-key header. Caddy's deferred set means an upstream
  // response cannot overwrite no-store while its headers are copied to the client. An error route is a new
  // handler chain, so its Caddy-generated proxy outage also sets no-store explicitly.
  expect(caddy).toMatch(/handle \/balance \{[\s\S]*?header >Cache-Control "no-store"[\s\S]*?reverse_proxy 127\.0\.0\.1:8080/);
  expect(caddy).toMatch(/handle @balance_outage \{\n\t\t\theader Cache-Control "no-store"/);
});

test("backup and restore preserve the scrubbed-outbox money invariant", () => {
  // The outbox snapshot must precede the ledger snapshot: any tombstone/ack captured in pending.db is then
  // guaranteed to have its applied_orders marker captured in the later balances.db snapshot.
  expect(backup.indexOf(".backup '$work/pending.db'")).toBeGreaterThan(-1);
  expect(backup.indexOf(".backup '$work/balances.db'")).toBeGreaterThan(backup.indexOf(".backup '$work/pending.db'"));

  // A tombstone has no payload to replay. Restore must verify its receiver marker, never re-arm it, and reject
  // a balances-only restore over a deployment that already has pending.db.
  expect(restore).toContain("scrubbed credit tombstone(s) have no matching ledger marker");
  expect(restore).toContain("WHERE acked_at IS NOT NULL\n          AND hash <> ''");
  expect(restore).toContain("UPDATE credit_outbox SET acked_at = NULL WHERE hash <> '';");
  expect(restore).toContain("unsafe partial restore refused");
  expect(restore).not.toMatch(/SET acked_at = NULL WHERE hash = ''/);
});

test("control-plane storage paths are isolated while retaining an explicit legacy fallback", () => {
  for (const script of [backup, restore, statusCheck]) {
    expect(script).toContain('DB_DIR="${DB_DIR:-}"');
    expect(script).toContain('BALANCES_DB_PATH="${BALANCES_DB_PATH:-${DB_DIR:+$DB_DIR/balances.db}}"');
    expect(script).toContain('PENDING_DB_PATH="${PENDING_DB_PATH:-${DB_DIR:+$DB_DIR/pending.db}}"');
    expect(script).toContain('/var/lib/nullsink-proxy/balances.db');
    expect(script).toContain('/var/lib/nullsink-payments/pending.db');
  }
  for (const unit of [backupUnit, statusUnit]) {
    expect(unit).toContain("Environment=BALANCES_DB_PATH=/var/lib/nullsink-proxy/balances.db");
    expect(unit).toContain("Environment=PENDING_DB_PATH=/var/lib/nullsink-payments/pending.db");
    expect(unit).toContain("Environment=BACKUP_DIR=/var/lib/nullsink-backup");
  }
});

test("the first isolated deploy refuses before any release mutation until explicit preparation", () => {
  const binary = deployScript.indexOf('install_binary "$REF"');
  const suspend = deployScript.indexOf("suspend_control_timers");
  const tree = deployScript.indexOf('install_deploy_tree "$REF" "$APP_DIR"');
  const marker = deployScript.indexOf("if [ ! -f /etc/nullsink-service-isolation.prepared ]");
  const apply = deployScript.indexOf("apply_repo_config                      #");
  const restart = deployScript.indexOf("restart_app", apply);
  const timers = deployScript.indexOf("enable_timers", restart);
  expect(marker).toBeGreaterThan(-1);
  expect(suspend).toBeGreaterThan(marker);
  expect(binary).toBeGreaterThan(suspend);
  expect(tree).toBeGreaterThan(-1);
  expect(tree).toBeGreaterThan(binary);
  expect(apply).toBeGreaterThan(tree);
  expect(restart).toBeGreaterThan(apply);
  expect(timers).toBeGreaterThan(restart);
  expect(deployScript.slice(marker, suspend)).toContain(
    "no release artifact, unit, or service was changed",
  );
  expect(deployScript.slice(marker, suspend)).not.toContain("prepare_service_isolation");
  expect(deployScript.indexOf("trap restore_timers_on_exit EXIT")).toBeLessThan(tree);
  expect(deployScript.slice(apply, restart)).not.toContain("enable_timers");
  expect(setup).toContain("Existing billing state requires an explicit, quiet-window migration");
  expect(readFileSync(deploy("README.md"), "utf8")).toContain(
    "not** the old `/opt/nullsink/deploy/deploy.sh`",
  );
});

test("release archives and root extraction cannot inherit the CI runner identity", () => {
  expect(
    releaseWorkflow.match(/tar --owner=0 --group=0 --numeric-owner -czf/g)?.length,
  ).toBe(2);
  expect(deployLib.match(/tar --no-same-owner -x/g)?.length).toBe(2);
  expect(deployLib).toContain('chown -R root:root "$staging/deploy"');
  expect(deployLib).toContain('chown -R root:root "$staging"');

  const installTree = deployLib.slice(
    deployLib.indexOf("install_deploy_tree()"),
    deployLib.indexOf("install_client_ui()"),
  );
  expect(installTree.indexOf('tar --no-same-owner')).toBeGreaterThan(-1);
  expect(installTree.indexOf('chown -R root:root')).toBeGreaterThan(
    installTree.indexOf('tar --no-same-owner'),
  );
  expect(installTree.indexOf('mv "$staging/deploy" "$dest/deploy"')).toBeGreaterThan(
    installTree.indexOf('chown -R root:root'),
  );
});

test("deploy drains root one-shots around the live tree and restores only prior active timers on failure", () => {
  const suspend = deployLib.slice(
    deployLib.indexOf("suspend_control_timers()"),
    deployLib.indexOf("restore_control_timers()"),
  );
  const restore = deployLib.slice(
    deployLib.indexOf("restore_control_timers()"),
    deployLib.indexOf("enable_timers()"),
  );
  expect(suspend).toContain("systemctl is-active --quiet");
  expect(suspend.indexOf("systemctl stop status-check.timer backup.timer")).toBeLessThan(
    suspend.indexOf("systemctl stop status-check.service backup.service"),
  );
  expect(restore).toContain('systemctl start "${CONTROL_TIMERS_WERE_ACTIVE[@]}"');
  expect(deployScript).toContain("trap restore_timers_on_exit EXIT");
  expect(deployScript).toContain("trap - EXIT");
});

test("backup publication and routine reporting follow the Step 2 egress contract", () => {
  const validation = backup.indexOf('"$script_dir/restore.sh" "$work/backup.tar"');
  const encryption = backup.indexOf('age -r "$BACKUP_AGE_RECIPIENT"');
  const publication = backup.indexOf('mv -n "$artifact_tmp" "$artifact"');
  const reporting = backup.indexOf('"$script_dir/backup-report.sh"');
  expect(validation).toBeGreaterThan(-1);
  expect(encryption).toBeGreaterThan(validation);
  expect(publication).toBeGreaterThan(encryption);
  expect(reporting).toBeGreaterThan(publication);
  expect(backup).toContain('BACKUP_KEEP="${BACKUP_KEEP:-84}"');
  expect(backupTimer).toContain("OnCalendar=*-*-* 00/4:00:00 UTC");

  // The report queries sensitive tables only through fixed aggregate projections. These forbidden column
  // names should appear solely in the privacy comment, never in SQL/output construction.
  const reportBody = backupReport.slice(backupReport.indexOf("set -euo pipefail"));
  expect(reportBody).not.toMatch(/\b(?:hash|address|idempotency_key|order_index|asset_atomic)\b/);
  expect(backupReport).toContain("GROUP BY day, asset");
  expect(backupReport).toContain("WHERE acked_at IS NULL");
  expect(backupReport).toContain("SUM(balance)");
});
