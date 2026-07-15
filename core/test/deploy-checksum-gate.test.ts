// The deploy checksum gate is the ONLY thing between a corrupted/tampered release asset and an
// installed+activated binary — and on the split it guards BOTH the proxy and payments binaries the sealed
// tier attests. #79 fixed a silent bypass: install_binary/install_nsk/install_deploy_tree/install_client_ui
// are invoked as `if install_binary ...` in setup.sh/deploy.sh, and bash SUSPENDS `set -e` for the whole body
// of a function called in a condition, so a bare `sha256sum -c` failure would fall THROUGH to install + the
// `ln -sfn` activation while the function still returned success. The fix routes every gate through
// verify_sums with an explicit `|| return 1`. shellcheck can't catch the reintroduction (a bare `sha256sum -c`
// under `if` is valid shell), so this test does — driving the REAL lib.sh, not a reimplementation.
import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const LIB = fileURLToPath(new URL("../deploy/lib.sh", import.meta.url));

// A bash harness that sources the real lib.sh, plants a release asset + a matching SHA256SUMS, optionally
// tampers the asset, and exercises the gate. It prints structured RESULT:/IF:/ACTIVATED: lines we assert on.
const HARNESS = String.raw`
set -euo pipefail
LIB="$1"; MODE="$2"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
# shellcheck source=/dev/null
source "$LIB"

plant_good() {                     # a valid asset whose hash is recorded in SHA256SUMS
  printf 'GOOD-BINARY\n' > "$work/nullsink-proxy-linux-x64"
  ( cd "$work" && sha256sum nullsink-proxy-linux-x64 > SHA256SUMS )
}
tamper() { printf 'TAMPERED\n' > "$work/nullsink-proxy-linux-x64"; }   # now mismatches SHA256SUMS

case "$MODE" in
  good)
    plant_good
    if verify_sums "$work"; then echo RESULT:PASS; else echo RESULT:FAIL; fi ;;
  tampered)
    plant_good; tamper
    if verify_sums "$work"; then echo RESULT:FAIL; else echo RESULT:PASS; fi ;;
  under_if)
    # Reproduce install_binary's exact caller shape: a gate, then a sentinel "activation" that must NEVER run
    # on a checksum mismatch — invoked as \`if fake_install\`, which suspends set -e for the whole body.
    plant_good; tamper
    fake_install() {
      verify_sums "$1" || return 1
      touch "$1/ACTIVATED"         # the unverified-artifact activation the gate must prevent
    }
    if fake_install "$work"; then echo IF:REACHED_INSTALL; else echo IF:ABORTED; fi
    [ -e "$work/ACTIVATED" ] && echo ACTIVATED:YES || echo ACTIVATED:NO ;;
  missing_under_if)
    # A downloader can fail or claim success without producing a required file. Both cases must stop before
    # verify_sums --ignore-missing (which cannot itself prove that every requested asset was downloaded).
    fetch_asset() { return 0; }
    fake_install() {
      stage_binary_assets v9.9.9 "$work" || return 1
      touch "$work/ACTIVATED"
    }
    if fake_install; then echo IF:REACHED_INSTALL; else echo IF:ABORTED; fi
    [ -e "$work/ACTIVATED" ] && echo ACTIVATED:YES || echo ACTIVATED:NO ;;
  manifest_omits_required)
    fetch_asset() {
      case "$2" in
        nullsink-proxy-linux-x64|nullsink-payments-linux-x64) printf '%s\n' "$2" > "$3/$2" ;;
        SHA256SUMS) ( cd "$3" && sha256sum nullsink-payments-linux-x64 > SHA256SUMS ) ;;
      esac
    }
    fake_install() {
      stage_binary_assets v9.9.9 "$work" || return 1
      touch "$work/ACTIVATED"
    }
    if fake_install; then echo IF:REACHED_INSTALL; else echo IF:ABORTED; fi
    [ -e "$work/ACTIVATED" ] && echo ACTIVATED:YES || echo ACTIVATED:NO ;;
  shared_manifest)
    manifest_fetches=0
    fetch_asset() {
      local name hash
      if [ "$2" = SHA256SUMS ]; then
        manifest_fetches=$((manifest_fetches + 1))
        : > "$3/SHA256SUMS"
        for name in asset-one asset-two; do
          hash="$(printf '%s\n' "$name" | sha256sum | awk '{print $1}')"
          printf '%s  %s\n' "$hash" "$name" >> "$3/SHA256SUMS"
        done
      else
        printf '%s\n' "$2" > "$3/$2"
      fi
    }
    mkdir -p "$work/release"
    stage_release_manifest v9.9.9 "$work/release" || exit 1
    stage_release_assets v9.9.9 "$work/one" "$work/release/SHA256SUMS" asset-one || exit 1
    stage_release_assets v9.9.9 "$work/two" "$work/release/SHA256SUMS" asset-two || exit 1
    echo MANIFEST_FETCHES:"$manifest_fetches" ;;
esac
`;

const run = (mode: string) =>
  Bun.spawnSync({ cmd: ["bash", "-c", HARNESS, "harness", LIB, mode], stdout: "pipe", stderr: "pipe" });

const out = (r: ReturnType<typeof run>) => r.stdout.toString() + r.stderr.toString();

test("verify_sums accepts an asset that matches SHA256SUMS", () => {
  const r = run("good");
  expect(out(r)).toContain("RESULT:PASS");
});

test("verify_sums rejects a tampered asset (checksum mismatch → non-zero)", () => {
  const r = run("tampered");
  expect(out(r)).toContain("RESULT:PASS"); // PASS == the gate returned non-zero, as it must
});

test("the gate holds when called under `if` with set -e suspended — the #79 bypass stays closed", () => {
  const r = run("under_if");
  const o = out(r);
  // The function must ABORT on mismatch and must NOT reach the activation, even though `if fake_install`
  // suspends set -e for its body. This is the exact regression #79 fixed.
  expect(o).toContain("IF:ABORTED");
  expect(o).not.toContain("IF:REACHED_INSTALL");
  expect(o).toContain("ACTIVATED:NO");
});

test("a missing required asset aborts under `if` before activation despite --ignore-missing", () => {
  const r = run("missing_under_if");
  const o = out(r);
  expect(o).toContain("IF:ABORTED");
  expect(o).toContain("ACTIVATED:NO");
  expect(o).not.toContain("IF:REACHED_INSTALL");
});

test("a checksum manifest that omits one required asset cannot authorize activation", () => {
  const r = run("manifest_omits_required");
  const o = out(r);
  expect(o).toContain("IF:ABORTED");
  expect(o).toContain("ACTIVATED:NO");
  expect(o).toContain("does not cover required asset nullsink-proxy-linux-x64");
});

test("multiple artifact stages can share one immutable manifest fetch", () => {
  const r = run("shared_manifest");
  expect(r.exitCode).toBe(0);
  expect(out(r)).toContain("MANIFEST_FETCHES:1");
});

test("every release installer routes through one fail-explicit staging/checksum gate", () => {
  const lib = readFileSync(LIB, "utf8");
  expect(lib).toContain('fetch_asset "$tag" "$asset" "$dest" || return 1');
  expect(lib).toContain('test -f "$dest/$asset" || return 1');
  expect(lib).toContain('fetch_asset "$tag" \'SHA256SUMS\' "$dest" || return 1');
  expect(lib).toContain('awk -v required="$asset"');
  expect(lib).toContain('verify_sums_against "$dest" "$manifest" || return 1');
  for (const asset of [
    "nullsink-proxy-linux-x64",
    "nsk-linux-x64",
    "deploy-${tag}.tar.gz",
    "nullsink-ui-${tag}.tar.gz",
  ]) {
    expect(lib).toContain(asset);
  }
  // And none may fall back to the bare form that #79 removed (the shape set -e suspension bypasses). Target the
  // install-site temp var ("$tmp") specifically: verify_sums's OWN body legitimately runs `cd "$1" && sha256sum
  // -c`, so a looser pattern would false-match the very helper this gate routes through.
  expect(lib).not.toMatch(/cd "\$tmp"\s*&&\s*sha256sum -c/);
});
