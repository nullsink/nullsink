// The deploy tree contains scripts executed by root one-shots. A release must drain those one-shots before
// replacing the tree, then either resume exactly the timers that were active or reconcile both after health.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../deploy/lib.sh", import.meta.url));

const HARNESS = String.raw`
set -euo pipefail
LIB="$1"; MODE="$2"; ACTIVE_TIMERS="$3"
# shellcheck source=/dev/null
source "$LIB"

systemctl() {
  local action="$1"
  shift
  if [ "$action" = is-active ]; then
    [ "$1" != --quiet ] || shift
    case ",$ACTIVE_TIMERS," in
      *",$1,"*) return 0 ;;
      *) return 3 ;;
    esac
  fi
  printf '%s' "$action"
  printf ' %s' "$@"
  printf '\n'
}

suspend_control_timers
case "$MODE" in
  restore) restore_control_timers ;;
  enable) enable_timers; restore_control_timers ;;
  *) exit 2 ;;
esac
printf 'suspended=%s active_count=%s\n' \
  "$CONTROL_TIMERS_SUSPENDED" "${"${"}#CONTROL_TIMERS_WERE_ACTIVE[@]}"
`;

function run(mode: "restore" | "enable", active: string) {
  return Bun.spawnSync({
    cmd: ["bash", "-c", HARNESS, "timer-harness", LIB, mode, active],
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("failure restoration starts only the timer that was active before suspension", () => {
  const result = run("restore", "status-check.timer");
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toBe(
    [
      "stop status-check.timer backup.timer",
      "stop status-check.service backup.service",
      "start status-check.timer",
      "suspended=0 active_count=0",
      "",
    ].join("\n"),
  );
});

test("successful reconciliation enables both timers without a duplicate restoration", () => {
  const result = run("enable", "status-check.timer,backup.timer");
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toBe(
    [
      "stop status-check.timer backup.timer",
      "stop status-check.service backup.service",
      "enable --now status-check.timer backup.timer",
      "suspended=0 active_count=0",
      "",
    ].join("\n"),
  );
});
