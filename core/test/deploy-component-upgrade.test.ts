import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../deploy/lib.sh", import.meta.url));
const SETUP = fileURLToPath(new URL("../deploy/setup.sh", import.meta.url));
const UPGRADER = fileURLToPath(new URL("../deploy/upgrade-component.sh", import.meta.url));

const VERSION_HARNESS = String.raw`
set -euo pipefail
LIB="$1"; MODE="$2"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
# shellcheck source=/dev/null
source "$LIB"
cat > "$work/version-tool" <<'TOOL'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_VERSION"
TOOL
chmod +x "$work/version-tool"

case "$MODE" in
  bitcoin_target)
    export FAKE_VERSION="Bitcoin Core daemon version v${"${"}BITCOIN_VERSION}.0 bitcoind"
    bitcoin_binary_matches_pin "$work/version-tool" ;;
  bitcoin_prefix_collision)
    export FAKE_VERSION="Bitcoin Core daemon version v${"${"}BITCOIN_VERSION}0.0 bitcoind"
    ! bitcoin_binary_matches_pin "$work/version-tool" ;;
  monero_target)
    export FAKE_VERSION="Monero test (v${"${"}MONERO_VERSION}-release)"
    monero_wallet_binary_matches_pin "$work/version-tool" ;;
  monero_prefix_collision)
    export FAKE_VERSION="Monero test (v${"${"}MONERO_VERSION}0-release)"
    ! monero_wallet_binary_matches_pin "$work/version-tool" ;;
esac
`;

for (const mode of [
  "bitcoin_target",
  "bitcoin_prefix_collision",
  "monero_target",
  "monero_prefix_collision",
]) {
  test(`component pin matcher: ${mode}`, () => {
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", VERSION_HARNESS, "harness", LIB, mode],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });
}

test("bootstrap and day-two upgrades read one shared set of component pins", () => {
  const lib = readFileSync(LIB, "utf8");
  const setup = readFileSync(SETUP, "utf8");
  for (const name of ["BITCOIN_VERSION", "MONERO_VERSION", "TINFOIL_PROXY_VERSION"]) {
    expect(lib).toMatch(new RegExp(`^${name}=`, "m"));
    expect(setup).not.toMatch(new RegExp(`^${name}=`, "m"));
  }
});

test("activation is staged before downtime and remains rollback-armed through its health gate", () => {
  const source = readFileSync(UPGRADER, "utf8");
  expect(source).toContain('flock -n 9 || { echo "another component upgrade is already running"');
  expect(source).toContain(
    'component_healthy ||\n  { echo "refusing: $unit is active but not healthy; recover it before attempting an upgrade"',
  );
  const activation = source.slice(source.indexOf('echo "staging and verifying'));
  const inOrder = [
    'stage_component "$staged"',
    "staged_is_pinned",
    "component_healthy ||",
    'install -m755 "$BIN_DIR/$name" "$rollback_dir/$name"',
    "rollback_armed=1",
    'systemctl stop "$unit"',
    'install -m755 "$staged/$name" "$BIN_DIR/$name"',
    'systemctl start "$unit"',
    "live_is_pinned",
    "wait_healthy",
    "rollback_armed=0",
  ];
  let cursor = -1;
  for (const marker of inOrder) {
    const next = activation.indexOf(marker, cursor + 1);
    expect(next, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }

  const cleanup = source.slice(source.indexOf("cleanup() {"), source.indexOf("trap cleanup EXIT"));
  expect(cleanup).toContain('install -m755 "$rollback_dir/$name" "$BIN_DIR/$name"');
  expect(cleanup.indexOf('install -m755 "$rollback_dir/$name"')).toBeLessThan(
    cleanup.indexOf('systemctl start "$unit"'),
  );
  expect(cleanup).toContain("wait_healthy || rollback_ok=0");
});
