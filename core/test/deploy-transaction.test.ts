// Redeploy is a transaction across binaries, the operator CLI, the deploy tree, systemd/Caddy config, and
// the browser UI. These tests fault-inject its sourceable sequencing boundary and statically pin the concrete
// filesystem rollback contract that cannot safely be exercised against a developer's real /usr and systemd.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TX = fileURLToPath(new URL("../deploy/deploy-transaction.sh", import.meta.url));
const DEPLOY = fileURLToPath(new URL("../deploy/deploy.sh", import.meta.url));
const DEPLOY_GUARD = fileURLToPath(new URL("../deploy/deploy-guard.sh", import.meta.url));
const LIB = fileURLToPath(new URL("../deploy/lib.sh", import.meta.url));
const SETUP = fileURLToPath(new URL("../deploy/setup.sh", import.meta.url));
const DEPLOY_README = fileURLToPath(new URL("../deploy/README.md", import.meta.url));
const ROOT_README = fileURLToPath(new URL("../../README.md", import.meta.url));

const HARNESS = String.raw`
set -eu
TX="$1"; MODE="$2"; FAIL_STEP="$3"
# shellcheck source=/dev/null
source "$TX"
trace() { printf '%s\n' "$1"; [ "$FAIL_STEP" != "$1" ]; }
deploy_stage_manifest() { trace stage_manifest; }
deploy_stage_ui() { trace stage_ui; }
deploy_stage_binaries() { trace stage_binaries; }
deploy_stage_nsk() { trace stage_nsk; }
deploy_stage_tree() { trace stage_tree; }
deploy_prepare_guard() { trace prepare_guard; }
deploy_quiesce() { trace quiesce; }
deploy_activate_binaries() { trace activate_binaries; }
deploy_activate_nsk() { trace activate_nsk; }
deploy_activate_tree() { trace activate_tree; }
deploy_apply_config() { trace apply_config; }
deploy_commit_backend() { trace commit_backend; }
deploy_restart_new() { trace restart_new; }
deploy_health_new() { trace health_new; }
deploy_enable_timers() { trace enable_timers; }
deploy_record_success() { trace record_success; }
deploy_activate_ui() { trace activate_ui; }
deploy_rollback() { printf 'rollback:%s\n' "$1"; return 0; }
if [ "$MODE" = staging ]; then
  run_deploy_staging
else
  run_deploy_activation
fi
printf 'result:success\n'
`;

function run(mode: "staging" | "activation", fail = "never") {
  return Bun.spawnSync({
    cmd: ["bash", "-c", HARNESS, "harness", TX, mode, fail],
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result: ReturnType<typeof run>): string {
  return result.stdout.toString() + result.stderr.toString();
}

test.each(["stage_manifest", "stage_ui", "stage_binaries", "stage_nsk", "stage_tree"])("%s failure leaves activation entirely untouched", (step) => {
  const result = run("staging", step);
  const text = output(result);
  expect(result.exitCode).not.toBe(0);
  expect(text).toContain(step);
  expect(text).not.toContain("quiesce");
  expect(text).not.toContain("activate_");
  expect(text).not.toContain("rollback:");
  expect(text).not.toContain("result:success");
});

test.each([
  "prepare_guard",
  "quiesce",
  "activate_binaries",
  "activate_nsk",
  "activate_tree",
  "apply_config",
  "activate_ui",
  "commit_backend",
  "restart_new",
  "health_new",
  "enable_timers",
  "record_success",
])(
  "%s failure invokes rollback exactly once and stops the forward path",
  (step) => {
    const result = run("activation", step);
    const text = output(result);
    expect(result.exitCode).not.toBe(0);
    expect(text.match(/rollback:/g)?.length).toBe(1);
    expect(text).toContain(`rollback:${step}`);
    expect(text).not.toContain("result:success");
    const order = [
      "prepare_guard", "quiesce", "activate_binaries", "activate_nsk", "activate_tree", "apply_config",
      "activate_ui", "commit_backend", "restart_new", "health_new", "enable_timers", "record_success",
    ];
    for (const later of order.slice(order.indexOf(step) + 1))
      expect(text).not.toContain(`\n${later}\n`);
  },
);

test("successful activation flips the UI before durable commit, then health-checks before recording", () => {
  const result = run("activation");
  expect(result.exitCode).toBe(0);
  expect(output(result).trim().split("\n")).toEqual([
    "prepare_guard",
    "quiesce",
    "activate_binaries",
    "activate_nsk",
    "activate_tree",
    "apply_config",
    "activate_ui",
    "commit_backend",
    "restart_new",
    "health_new",
    "enable_timers",
    "record_success",
    "result:success",
  ]);
});

test("target-version health rejects an old process even when /healthz returns 200", () => {
  const harness = String.raw`
set -u
LIB="$1"; BODY="$2"; HEALTH_TIMEOUT=2
# shellcheck source=/dev/null
source "$LIB"
curl() { printf '%s' "$BODY"; }
sleep() { :; }
health_ok_version 8080 v1.8.3
`;
  const good = Bun.spawnSync({ cmd: ["bash", "-c", harness, "harness", LIB, "ok v1.8.3"] });
  const old = Bun.spawnSync({ cmd: ["bash", "-c", harness, "harness", LIB, "ok v1.8.2"] });
  expect(good.exitCode).toBe(0);
  expect(old.exitCode).not.toBe(0);
});

test.each(["INT", "TERM"])("rollback children inherit ignored %s until restoration finishes", (signal) => {
  const harness = String.raw`
set -u
TX="$1"; SIGNAL="$2"
# shellcheck source=/dev/null
source "$TX"
begin_deploy_rollback
bash -c 'kill -"$1" $$; echo CHILD:FINISHED' child "$SIGNAL"
echo ROLLBACK:FINISHED
finish_deploy_rollback 0
`;
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", harness, "harness", TX, signal],
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = output(result);
  expect(result.exitCode).toBe(0);
  expect(text).toContain("CHILD:FINISHED");
  expect(text).toContain("ROLLBACK:FINISHED");
});

test("the durable deploy guard brackets every mixed-backend mutation and rollback", () => {
  const deploy = readFileSync(DEPLOY, "utf8");
  const transaction = readFileSync(TX, "utf8");
  const prepare = transaction.indexOf("prepare_guard");
  const binaries = transaction.indexOf("activate_binaries", prepare);
  const applyConfig = transaction.indexOf("apply_config", binaries);
  const activateUi = transaction.indexOf("activate_ui", applyConfig);
  const commit = transaction.indexOf("commit_backend", activateUi);
  const restart = transaction.indexOf("restart_new", commit);
  expect(prepare).toBeGreaterThan(-1);
  expect(binaries).toBeGreaterThan(prepare);
  expect(applyConfig).toBeGreaterThan(binaries);
  expect(activateUi).toBeGreaterThan(applyConfig);
  expect(commit).toBeGreaterThan(activateUi);
  expect(restart).toBeGreaterThan(commit);

  const rollback = deploy.slice(deploy.indexOf("deploy_rollback()"), deploy.indexOf("deploy_exit_guard()"));
  expect(rollback.indexOf('deploy_arm_guard "rollback after $failed_step"')).toBeLessThan(
    rollback.indexOf("systemctl stop status-check.timer"),
  );
  expect(rollback.indexOf("deploy_disarm_guard")).toBeLessThan(rollback.indexOf("restart_app"));

  for (const unit of [
    "../deploy/nullsink-proxy.service",
    "../deploy/nullsink-payments.service",
    "../deploy/backup.service",
  ]) {
    const path = fileURLToPath(new URL(unit, import.meta.url));
    expect(readFileSync(path, "utf8")).toContain(
      "ConditionPathExists=!/var/lib/nullsink/.deploy-in-progress",
    );
  }
  const guard = readFileSync(DEPLOY_GUARD, "utf8");
  expect(guard).toContain("install_deploy_guard_dropins");
  expect(guard).toContain("deploy_sync_release_filesystems");
  expect(guard).toContain("sync -f");
  const dropins = guard.slice(guard.indexOf("install_deploy_guard_dropins()"));
  expect(dropins.indexOf('sync -f "$tmp"')).toBeLessThan(
    dropins.indexOf('mv -f "$tmp" "$dir/nullsink-deploy-guard.conf"'),
  );
  expect(dropins.indexOf('mv -f "$tmp" "$dir/nullsink-deploy-guard.conf"')).toBeLessThan(
    dropins.indexOf('sync -f "$dir"'),
  );
});

test("every release filesystem is flushed before durable deploy-marker deletion", () => {
  const harness = String.raw`
set -eu
root="$(mktemp -d)"; trap 'command rm -rf "$root"' EXIT
mkdir -p "$root/one" "$root/two" "$root/guard"
: > "$root/guard/deploy"
NULLSINK_DEPLOY_GUARD="$root/guard/deploy"
NULLSINK_DEPLOY_SYNC_PATHS="$root/one:$root/two"
source "$1"
sync() { printf 'SYNC:%s\n' "$2"; }
rm() { printf 'REMOVE:%s\n' "$2"; command rm "$@"; }
deploy_disarm_guard
`;
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", harness, "harness", DEPLOY_GUARD],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const lines = result.stdout.toString().trim().split("\n");
  expect(lines.slice(0, 3)).toEqual([
    expect.stringMatching(/SYNC:.*\/one$/),
    expect.stringMatching(/SYNC:.*\/two$/),
    expect.stringMatching(/REMOVE:.*\/guard\/deploy$/),
  ]);
  expect(lines[3]).toMatch(/SYNC:.*\/guard$/);
});

test("only one matching proxy/payments/UI release tag is accepted as a rollback baseline", () => {
  const harness = String.raw`
set -u
LIB="$1"; shift
# shellcheck source=/dev/null
source "$LIB"
matching_release_tag "$@"
`;
  const runTags = (proxy: string, payments: string, web: string) =>
    Bun.spawnSync({ cmd: ["bash", "-c", harness, "harness", LIB, proxy, payments, web], stdout: "pipe" });
  const good = runTags("nullsink-proxy-v1.8.2", "nullsink-payments-v1.8.2", "web-v1.8.2");
  expect(good.exitCode).toBe(0);
  expect(good.stdout.toString().trim()).toBe("v1.8.2");
  expect(runTags("nullsink-proxy-v1.8.2", "nullsink-payments-v1.8.1", "web-v1.8.2").exitCode).not.toBe(0);
  expect(runTags("proxy-current", "nullsink-payments-v1.8.2", "web-v1.8.2").exitCode).not.toBe(0);
  expect(runTags("/tmp/nullsink-proxy-v1.8.2", "nullsink-payments-v1.8.2", "web-v1.8.2").exitCode).not.toBe(0);
  expect(runTags("nullsink-proxy-v1/../../tmp", "nullsink-payments-v1/../../tmp", "web-v1/../../tmp").exitCode).not.toBe(0);

  const deploy = readFileSync(DEPLOY, "utf8");
  expect(deploy).toContain('[ -r "$prev_web_path/index.html" ]');
  expect(deploy).toContain('health_ok_app_version "$TXN_PREV_TAG"');
  const setup = readFileSync(SETUP, "utf8");
  expect(setup).toContain('[ -r "$web_path/index.html" ]');
});

test("release tags used in live paths are strict SemVer and reject path traversal", () => {
  const harness = String.raw`
set -u
source "$1"
valid_release_tag "$2"
`;
  const valid = ["v1.8.3", "v1.8.3-rc.1", "v2.0.0-beta+build.7"];
  const invalid = ["", "1.8.3", "v1.8", "v01.8.3", "v1.8.3/../../tmp", "v1.8.3-rc/evil"];
  for (const tag of valid)
    expect(Bun.spawnSync({ cmd: ["bash", "-c", harness, "harness", LIB, tag] }).exitCode).toBe(0);
  for (const tag of invalid)
    expect(Bun.spawnSync({ cmd: ["bash", "-c", harness, "harness", LIB, tag] }).exitCode).not.toBe(0);

  const setup = readFileSync(SETUP, "utf8");
  expect(setup.indexOf('valid_release_tag "$RELEASE_TAG"')).toBeLessThan(
    setup.indexOf('acquire_maintenance_lock "setup"'),
  );
  const deploy = readFileSync(DEPLOY, "utf8");
  expect(deploy).toContain('if ! valid_release_tag "$REF"; then');
});

test("quiesce stops timer-triggered one-shots before either app service", () => {
  const harness = String.raw`
set -u
DEPLOY="$1"; set -- v1.8.3
# shellcheck source=/dev/null
source "$DEPLOY"
systemctl() { printf '%s\n' "$*"; }
deploy_quiesce
`;
  const result = Bun.spawnSync({ cmd: ["bash", "-c", harness, "harness", DEPLOY], stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim().split("\n")).toEqual([
    "stop status-check.timer",
    "stop backup.timer",
    "stop status-check.service",
    "stop backup.service",
    "stop nullsink-payments",
    "stop nullsink-proxy",
  ]);

  const deploy = readFileSync(DEPLOY, "utf8");
  const rollback = deploy.slice(deploy.indexOf("deploy_rollback()"), deploy.indexOf("deploy_exit_guard()"));
  expect(rollback).toContain("systemctl stop status-check.service");
  expect(rollback).toContain("systemctl stop backup.service");
});

test("all staging and rollback snapshots precede the first live transaction callback", () => {
  const deploy = readFileSync(DEPLOY, "utf8");
  const stagingCallbacks = deploy.slice(
    deploy.indexOf("# --- Concrete staging callbacks"),
    deploy.indexOf("# --- Concrete activation callbacks"),
  );
  expect(stagingCallbacks).not.toMatch(/systemctl|ln -sfn|install -m|\/usr\/local/);

  const stage = deploy.indexOf("if ! run_deploy_staging");
  const snapshotBinary = deploy.indexOf('"$TXN_ROOT/previous-proxy-bin"', stage);
  const snapshotConfig = deploy.indexOf("if ! snapshot_live_config", snapshotBinary);
  const arm = deploy.indexOf("TXN_ACTIVE=1", snapshotConfig);
  const activate = deploy.indexOf("run_deploy_activation || activation_status=$?", arm);
  expect(stage).toBeGreaterThan(-1);
  expect(snapshotBinary).toBeGreaterThan(stage);
  expect(snapshotConfig).toBeGreaterThan(snapshotBinary);
  expect(arm).toBeGreaterThan(snapshotConfig);
  expect(activate).toBeGreaterThan(arm);
});

test("the snapshot that authorized the target deployer also authorizes every transaction artifact", () => {
  const deploy = readFileSync(DEPLOY, "utf8");
  const staging = deploy.slice(
    deploy.indexOf("deploy_stage_manifest()"),
    deploy.indexOf("# --- Concrete activation callbacks"),
  );
  expect(staging).not.toContain("stage_release_manifest");
  expect(staging).toContain('cp -p "$RELEASE_MANIFEST" "$TXN_ROOT/release/SHA256SUMS"');
  for (const callback of ["stage_client_ui", "stage_binary_assets", "stage_nsk_asset", "stage_deploy_tree"]) {
    const line = staging.split("\n").find((candidate) => candidate.includes(callback));
    expect(line).toContain('"$TXN_ROOT/release/SHA256SUMS"');
  }
});

test("same-tag binary and UI destinations are snapshotted and restored, not merely re-pointed", () => {
  const deploy = readFileSync(DEPLOY, "utf8");
  expect(deploy).toContain('cp -p "$TXN_PREV_PROXY_PATH" "$TXN_ROOT/previous-proxy-bin"');
  expect(deploy).toContain('cp -p "$TXN_ROOT/previous-proxy-bin" "$TXN_PREV_PROXY_PATH"');
  expect(deploy).toContain('cp -p "$TXN_PREV_PAY_PATH" "$TXN_ROOT/previous-payments-bin"');
  expect(deploy).toContain('cp -p "$TXN_ROOT/previous-payments-bin" "$TXN_PREV_PAY_PATH"');
  expect(deploy.match(/ln -sfn "\$TXN_PREV_PROXY" \/usr\/local\/lib\/nullsink\/current-proxy/g)?.length).toBe(1);
  expect(deploy.match(/ln -sfn "\$TXN_PREV_PAY" \/usr\/local\/lib\/nullsink\/current-payments/g)?.length).toBe(1);
  expect(deploy).toContain('mv "$final" "$WEB_TXN_ROOT/replaced-web"');
  expect(deploy).toContain('mv "$WEB_TXN_ROOT/replaced-web" "$final"');
  expect(deploy).toContain(
    'deploy_stage_ui() { stage_client_ui "$REF" "$WEB_TXN_ROOT/ui" "$TXN_ROOT/release/SHA256SUMS"; }',
  );

  // Intent must be durable before each live rename: INT/TERM can be delivered after mv returns but before
  // the next shell assignment, and rollback still has to infer the completed mutation.
  const activateTree = deploy.slice(deploy.indexOf("deploy_activate_tree()"), deploy.indexOf("deploy_apply_config()"));
  expect(activateTree.indexOf("TXN_OLD_TREE_MOVED=1")).toBeLessThan(
    activateTree.indexOf('mv "$APP_DIR/deploy" "$TXN_ROOT/previous-deploy"'),
  );
  const activateUi = deploy.slice(deploy.indexOf("deploy_activate_ui()"), deploy.indexOf("snapshot_live_config()"));
  expect(activateUi.indexOf("TXN_WEB_REPLACED=1")).toBeLessThan(
    activateUi.indexOf('mv "$final" "$WEB_TXN_ROOT/replaced-web"'),
  );
  expect(activateUi.indexOf("TXN_NEW_WEB_INSTALLED=1")).toBeLessThan(
    activateUi.indexOf('mv "$WEB_TXN_ROOT/ui/web" "$final"'),
  );
});

test("rollback restores old tree and exact unit/timer/Caddy snapshots before old services restart", () => {
  const deploy = readFileSync(DEPLOY, "utf8");
  const rollback = deploy.slice(deploy.indexOf("deploy_rollback()"), deploy.indexOf("deploy_exit_guard()"));
  const parkFailed = rollback.indexOf('mv "$APP_DIR/deploy" "$failed_tree"');
  const restoreTree = rollback.indexOf('mv "$TXN_ROOT/previous-deploy" "$APP_DIR/deploy"');
  const restoreConfig = rollback.indexOf("restore_live_config");
  const restartOld = rollback.indexOf("restart_app");
  expect(parkFailed).toBeGreaterThan(-1);
  expect(restoreTree).toBeGreaterThan(parkFailed);
  expect(restoreConfig).toBeGreaterThan(restoreTree);
  expect(restartOld).toBeGreaterThan(restoreConfig);
  expect(deploy).toContain('cp -a "/etc/systemd/system/$base" "$snapshot/systemd/$base"');
  expect(deploy).toContain('rm -f "/etc/systemd/system/$base"');
  expect(deploy).toContain('cp -a /etc/caddy/Caddyfile "$snapshot/Caddyfile"');
  expect(deploy).toContain('cp -a "$snapshot/Caddyfile" /etc/caddy/Caddyfile');
});

test.each(["success", "activate_failure"])("setup deploy-tree replacement is complete on %s", (mode) => {
  const harness = String.raw`
set -u
LIB="$1"; MODE="$2"; root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT
# shellcheck source=/dev/null
source "$LIB"
mkdir -p "$root/deploy"
printf old > "$root/deploy/old-only"
printf stale > "$root/deploy/stale"
stage_deploy_tree() {
  mkdir -p "$2/tree/deploy"
  printf new > "$2/tree/deploy/new-only"
  printf caddy > "$2/tree/deploy/Caddyfile"
}
if [ "$MODE" = activate_failure ]; then
  mv_calls=0
  mv() {
    mv_calls=$((mv_calls + 1))
    if [ "$mv_calls" -eq 2 ]; then return 1; fi
    command mv "$@"
  }
fi
status=0
install_deploy_tree v1.8.3 "$root" || status=$?
printf 'STATUS:%s\n' "$status"
[ -f "$root/deploy/old-only" ] && echo OLD:YES || echo OLD:NO
[ -f "$root/deploy/stale" ] && echo STALE:YES || echo STALE:NO
[ -f "$root/deploy/new-only" ] && echo NEW:YES || echo NEW:NO
`;
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", harness, "harness", LIB, mode],
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = output(result);
  expect(result.exitCode).toBe(0);
  if (mode === "success") {
    expect(text).toContain("STATUS:0");
    expect(text).toContain("OLD:NO");
    expect(text).toContain("STALE:NO");
    expect(text).toContain("NEW:YES");
  } else {
    expect(text).toContain("STATUS:1");
    expect(text).toContain("OLD:YES");
    expect(text).toContain("STALE:YES");
    expect(text).toContain("NEW:NO");
  }
});

test("the installed deployer fails closed and docs bootstrap the verified target deployer", () => {
  const deploy = readFileSync(DEPLOY, "utf8");
  const guard = deploy.indexOf("require_target_deployer || exit 1");
  const activation = deploy.lastIndexOf("deploy_binary");
  expect(guard).toBeGreaterThan(-1);
  expect(activation).toBeGreaterThan(guard);
  expect(deploy).toContain("refusing to run the already-installed deployer");

  const readme = readFileSync(DEPLOY_README, "utf8");
  expect(readme).toContain("Always run the **target release's** deployer");
  expect(readme.match(/\$base\/SHA256SUMS/g)?.length).toBe(1);
  expect(readme).toContain('asset="deploy-${tag}.tar.gz"');
  expect(readme).toContain("sha256sum -c deploy.SHA256SUMS");
  expect(readme).toContain('tar -xzf "$tmp/$asset" -C "$tmp/target"');
  expect(readme).toContain('sudo "$tmp/target/deploy/deploy.sh" "$tag" "$tmp/SHA256SUMS"');
  expect(readFileSync(ROOT_README, "utf8")).toContain("Do not run the\nalready-installed deployer");
});

test("setup reruns never upgrade coupled app/UI artifacts outside the deploy transaction", () => {
  const setup = readFileSync(SETUP, "utf8");
  const detect = setup.indexOf('CURRENT_LIVE_RELEASE="$(complete_live_release || true)"');
  const mismatch = setup.indexOf('[ "$CURRENT_LIVE_RELEASE" != "$RELEASE_TAG" ]', detect);
  const mismatchExit = setup.indexOf("exit 1", mismatch);
  const partial = setup.indexOf("has_live_release_pointer; then", mismatchExit);
  const partialExit = setup.indexOf("exit 1", partial);
  const partialDisable = setup.indexOf('systemctl disable --now "$PROXY_UNIT" "$PAYMENTS_UNIT"', partial);
  const firstMutation = setup.indexOf('step "Installing system packages"');
  const treeMutation = setup.indexOf('step "Installing the deploy tree', firstMutation);
  const unitMutation = setup.indexOf('step "Installing systemd units"', treeMutation);
  const completeSkip = setup.indexOf('APP_RELEASE_READY=1', unitMutation);
  const bootstrapInstall = setup.indexOf('if install_bootstrap_release "$RELEASE_TAG"', completeSkip);
  expect(detect).toBeGreaterThan(-1);
  expect(mismatch).toBeGreaterThan(detect);
  expect(mismatchExit).toBeGreaterThan(mismatch);
  expect(partial).toBeGreaterThan(mismatchExit);
  expect(partialExit).toBeGreaterThan(partial);
  expect(partialDisable).toBeGreaterThan(partial);
  expect(partialDisable).toBeLessThan(firstMutation);
  expect(firstMutation).toBeGreaterThan(partialExit);
  expect(treeMutation).toBeGreaterThan(firstMutation);
  expect(unitMutation).toBeGreaterThan(treeMutation);
  expect(completeSkip).toBeGreaterThan(unitMutation);
  expect(bootstrapInstall).toBeGreaterThan(completeSkip);
  expect(setup).toContain("setup made no changes; fetch + verify the target release's deploy bundle");
  expect(setup).toContain("partial/mixed app release pointers do not all target $RELEASE_TAG; setup made no changes");
  expect(setup).toContain("incomplete $RELEASE_TAG activation detected");
  expect(setup).toContain("refusing to install units or continue with mixed scripts");
  expect(setup).toContain('if [ "$APP_RELEASE_READY" -eq 1 ]; then\n  enable_app_units');
  expect(setup).toContain('systemctl disable --now "$PROXY_UNIT" "$PAYMENTS_UNIT"');
  expect(setup).toContain('if [ "$APP_RELEASE_READY" -eq 1 ] && [ "$FRESH_ENV" -eq 0 ]; then');
});

test("fresh setup authorizes every nullsink release asset with one manifest snapshot", () => {
  const setup = readFileSync(SETUP, "utf8");
  expect(setup.match(/stage_release_manifest "\$RELEASE_TAG"/g)?.length).toBe(1);
  expect(setup).toContain('SETUP_RELEASE_MANIFEST="$SETUP_RELEASE_DIR/SHA256SUMS"');
  expect(setup).toContain('install_deploy_tree "$RELEASE_TAG" "$APP_DIR" "$SETUP_RELEASE_MANIFEST"');
  expect(setup).toContain(
    'install_bootstrap_release "$RELEASE_TAG" "$SETUP_APP_STAGE" "$WEB_BASE" "$SETUP_RELEASE_MANIFEST"',
  );
});

const SETUP_BOOTSTRAP_HARNESS = String.raw`
set -eu
LIB="$1"; MODE="$2"
root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT
# shellcheck source=/dev/null
source "$LIB"
tag=v9.9.9
proxy="$root/current-proxy"; payments="$root/current-payments"; web="$root/current-web"

stage_binary_assets() { echo stage:binaries; mkdir -p "$2"; touch "$2/proxy" "$2/payments"; }
stage_client_ui() {
  echo stage:ui
  [ "$MODE" != ui-stage-fails ] || return 1
  mkdir -p "$2/web"; touch "$2/web/index.html"
}
activate_binary_assets() {
  echo activate:binaries
  ln -sfn "nullsink-proxy-$tag" "$proxy"
  ln -sfn "nullsink-payments-$tag" "$payments"
}
activate_client_ui_assets() {
  echo activate:ui
  ln -sfn "web-$tag" "$web"
}

case "$MODE" in
  ui-stage-fails)
    if install_bootstrap_release "$tag" "$root/stage" "$root/webbase" "$root/SHA256SUMS"; then
      echo RESULT:UNEXPECTED-SUCCESS
    else
      echo RESULT:STAGING-FAILED
    fi
    for pointer in "$proxy" "$payments" "$web"; do
      [ ! -e "$pointer" ] && [ ! -L "$pointer" ] || echo POINTER:MOVED
    done ;;
  same-target-partial)
    ln -s "nullsink-proxy-$tag" "$proxy"
    if release_pointers_target_tag "$tag" "$proxy" "$payments" "$web"; then
      echo PREFLIGHT:RESUME
    else
      echo PREFLIGHT:REJECT
    fi
    install_bootstrap_release "$tag" "$root/stage" "$root/webbase" "$root/SHA256SUMS"
    release_pointers_target_tag "$tag" "$proxy" "$payments" "$web"
    echo RESULT:REPAIRED ;;
  foreign-partial)
    ln -s nullsink-proxy-v9.9.8 "$proxy"
    if release_pointers_target_tag "$tag" "$proxy" "$payments" "$web"; then
      echo RESULT:UNEXPECTED-ACCEPT
    else
      echo RESULT:REJECTED
    fi ;;
  mixed-partial)
    ln -s "nullsink-proxy-$tag" "$proxy"
    ln -s nullsink-payments-v9.9.8 "$payments"
    if release_pointers_target_tag "$tag" "$proxy" "$payments" "$web"; then
      echo RESULT:UNEXPECTED-ACCEPT
    else
      echo RESULT:REJECTED
    fi ;;
esac
`;

function runSetupBootstrap(mode: string) {
  return Bun.spawnSync({
    cmd: ["bash", "-c", SETUP_BOOTSTRAP_HARNESS, "harness", LIB, mode],
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("fresh setup stages binaries and UI before activation, and UI staging failure moves no pointer", () => {
  const result = runSetupBootstrap("ui-stage-fails");
  const text = output(result);
  expect(result.exitCode).toBe(0);
  expect(text).toContain("stage:binaries\nstage:ui\nRESULT:STAGING-FAILED");
  expect(text).not.toContain("activate:");
  expect(text).not.toContain("POINTER:MOVED");
});

test("fresh setup rerun repairs an interrupted same-target activation", () => {
  const result = runSetupBootstrap("same-target-partial");
  const text = output(result);
  expect(result.exitCode).toBe(0);
  expect(text).toContain("PREFLIGHT:RESUME");
  expect(text).toContain("stage:binaries\nstage:ui\nactivate:binaries\nactivate:ui");
  expect(text).toContain("RESULT:REPAIRED");
});

test.each(["foreign-partial", "mixed-partial"])("fresh setup rejects %s pointers", (mode) => {
  const result = runSetupBootstrap(mode);
  const text = output(result);
  expect(result.exitCode).toBe(0);
  expect(text).toContain("RESULT:REJECTED");
  expect(text).not.toContain("RESULT:UNEXPECTED-ACCEPT");
});
