// Exercise the real deploy-tree installer with local release fixtures. Extraction must complete and validate
// away from the live root-script path; a malformed but correctly checksummed archive leaves that path intact.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../deploy/lib.sh", import.meta.url));

const HARNESS = String.raw`
set -euo pipefail
LIB="$1"; MODE="$2"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
fixture="$work/fixture"; build="$work/build"; dest="$work/dest"
mkdir -p "$fixture" "$build/deploy" "$dest/deploy"
printf 'old\n' > "$dest/deploy/live-sentinel"

# shellcheck source=/dev/null
source "$LIB"
chown() { printf 'CHOWN:%s\n' "$*"; }
fetch_asset() { cp "$fixture/$2" "$3/$2"; }

for required in deploy.sh lib.sh status-check.sh; do
  printf '%s\n' "$required" > "$build/deploy/$required"
done
if [ "$MODE" = good ]; then
  printf 'backup\n' > "$build/deploy/backup.sh"
  printf 'new\n' > "$build/deploy/new-sentinel"
fi
tar -czf "$fixture/deploy-vtest.tar.gz" -C "$build" deploy
(
  cd "$fixture"
  sha256sum deploy-vtest.tar.gz > SHA256SUMS
)

if install_deploy_tree vtest "$dest"; then result=installed; else result=refused; fi
printf 'result=%s\n' "$result"
printf 'old_present=%s\n' "$([ -e "$dest/deploy/live-sentinel" ] && echo yes || echo no)"
printf 'new_present=%s\n' "$([ -e "$dest/deploy/new-sentinel" ] && echo yes || echo no)"
printf 'stage_present=%s\n' "$([ -e "$dest/.deploy-vtest.new" ] && echo yes || echo no)"
printf 'previous_present=%s\n' "$([ -e "$dest/.deploy.previous" ] && echo yes || echo no)"
`;

function run(mode: "good" | "bad") {
  return Bun.spawnSync({
    cmd: ["bash", "-c", HARNESS, "deploy-tree-harness", LIB, mode],
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("a complete verified tree replaces the live directory only after root normalization", () => {
  const result = run("good");
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain("CHOWN:-R root:root");
  expect(output).toContain("result=installed");
  expect(output).toContain("old_present=no");
  expect(output).toContain("new_present=yes");
  expect(output).toContain("stage_present=no");
  expect(output).toContain("previous_present=no");
});

test("a checksummed tree missing a required root script leaves the live directory untouched", () => {
  const result = run("bad");
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain("missing deploy/backup.sh");
  expect(output).toContain("result=refused");
  expect(output).toContain("old_present=yes");
  expect(output).toContain("new_present=no");
  expect(output).toContain("stage_present=no");
  expect(output).toContain("previous_present=no");
});
