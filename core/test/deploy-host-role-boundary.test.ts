import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEPLOY_DIR = fileURLToPath(new URL("../deploy/", import.meta.url));
const deploy = (name: string) => fileURLToPath(new URL(`../deploy/${name}`, import.meta.url));
const read = (name: string) => readFileSync(deploy(name), "utf8");
const workflow = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)),
  "utf8",
);

test("app deployment has no local Bitcoin Core runtime surface", () => {
  expect(existsSync(deploy("bitcoind.service"))).toBe(false);
  expect(existsSync(deploy("setup-nodes.sh"))).toBe(false);
  expect(existsSync(deploy("regen-bitcoin-rpcauth.sh"))).toBe(false);

  const appLib = read("lib.sh");
  const appSetup = read("setup.sh");
  const appDeploy = read("deploy.sh");
  const appUpgrade = read("upgrade-component.sh");
  for (const source of [appLib, appSetup, appDeploy, appUpgrade]) {
    expect(source).not.toMatch(/\/usr\/local\/bin\/bitcoind|\/var\/lib\/bitcoind|systemctl (?:enable|restart|start|stop) bitcoind/);
  }
  expect(appLib).not.toContain("BITCOIN_VERSION=");
  expect(appLib).not.toContain("stage_verified_bitcoind");
  expect(appSetup).toContain("bitcoin_rpc_is_configured");
  expect(appSetup).toContain("explicit HTTP(S) wallet endpoint");
  expect(appDeploy).toContain("Bitcoin Core lives on the node box");
});

test("app unit installation is an allowlist without bitcoind", () => {
  const appLib = read("lib.sh");
  const installUnits = appLib.slice(
    appLib.indexOf("install_units()"),
    appLib.indexOf("enable_app_units()"),
  );
  expect(installUnits).toContain("nullsink-proxy.service");
  expect(installUnits).toContain("nullsink-payments.service");
  expect(installUnits).toContain("backup.timer");
  expect(installUnits).not.toContain("bitcoind");
  expect(installUnits).not.toContain("deploy/*.service");
  const committed = readdirSync(DEPLOY_DIR)
    .filter((name) => /\.(?:service|timer)$/.test(name))
    .sort();
  const allowlisted = [...installUnits.matchAll(/\b[\w@-]+\.(?:service|timer)\b/g)]
    .map((match) => match[0])
    .sort();
  expect(allowlisted).toEqual(committed);
});

test("release artifacts physically separate app and node host roles", () => {
  expect(workflow).toContain("--exclude='deploy/node-box'");
  expect(workflow).toContain('nullsink-node-box-${TAG}.tar.gz');
  expect(workflow).toContain("nullsink-node-box-${{ env.TAG }}.tar.gz");

  for (const name of [
    "node-box/README.md",
    "node-box/lib.sh",
    "node-box/upgrade.sh",
    "node-box/regen-rpcauth.sh",
    "node-box/bitcoind.service",
    "node-box/nftables.conf",
  ]) {
    expect(existsSync(deploy(name)), name).toBe(true);
  }
  expect(existsSync(deploy("node-box/setup.sh"))).toBe(false);
});

test("app health monitors the remote Bitcoin rail without managing a local unit", () => {
  const status = read("status-check.sh");
  const unitLoop = status.slice(status.indexOf("for unit in"), status.indexOf("# --- 1b."));
  expect(unitLoop).not.toContain("bitcoind");
  expect(status).toContain("getblockchaininfo");
  expect(status).toContain("BITCOIN_RPC_URL must be an explicit HTTP(S) wallet endpoint");
});

test("node rpcauth rotation rolls back unless the restarted node becomes healthy", () => {
  const rotate = read("node-box/regen-rpcauth.sh");
  expect(rotate.indexOf('cp -a -- "$CONF" "$previous_conf"')).toBeLessThan(
    rotate.indexOf("rollback_armed=1"),
  );
  expect(rotate).toContain('cp -a -- "$previous_conf" "$CONF"');
  expect(rotate).toContain("systemctl is-active --quiet bitcoind");
  expect(rotate.indexOf("getblockchaininfo")).toBeLessThan(
    rotate.indexOf("printf 'BITCOIN_RPC_PASSWORD=%s\\n'"),
  );
  expect(rotate.lastIndexOf("rollback_armed=0")).toBeGreaterThan(
    rotate.indexOf("printf 'BITCOIN_RPC_PASSWORD=%s\\n'"),
  );
  expect(read("node-box/bitcoind.service")).not.toContain("OnFailure=");
});
