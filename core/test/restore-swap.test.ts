import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../deploy/restore-swap.sh", import.meta.url));
const ACTIVATION = fileURLToPath(new URL("../deploy/restore-activation.sh", import.meta.url));
const RESTORE = fileURLToPath(new URL("../deploy/restore.sh", import.meta.url));
const PROXY_UNIT = fileURLToPath(new URL("../deploy/nullsink-proxy.service", import.meta.url));
const PAYMENTS_UNIT = fileURLToPath(new URL("../deploy/nullsink-payments.service", import.meta.url));
const BACKUP_UNIT = fileURLToPath(new URL("../deploy/backup.service", import.meta.url));
const STATUS_CHECK_UNIT = fileURLToPath(new URL("../deploy/status-check.service", import.meta.url));

const HARNESS = String.raw`
set -euo pipefail
source "$1"
mode="$2"; work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
printf ORIGINAL > "$work/balances.db"
printf RESTORED > "$work/.balances.db.restoring"
preserve_copy() { cp "$1" "$2"; }
case "$mode" in
  first)
    restore_swap_db "$work" balances.db preserve_copy
    printf 'LIVE:%s\nPRE:%s\n' "$(cat "$work/balances.db")" "$(cat "$work/balances.db.prerestore")" ;;
  rerun)
    restore_swap_db "$work" balances.db preserve_copy
    printf RESTORED2 > "$work/.balances.db.restoring"
    restore_swap_db "$work" balances.db preserve_copy
    printf 'LIVE:%s\nPRE:%s\n' "$(cat "$work/balances.db")" "$(cat "$work/balances.db.prerestore")" ;;
  move_fail)
    preserve_fail() { return 77; }
    if restore_swap_db "$work" balances.db preserve_fail; then echo RESULT:UNSAFE; else echo RESULT:BLOCKED; fi
    printf 'LIVE:%s\nSTAGED:%s\n' "$(cat "$work/balances.db")" "$(cat "$work/.balances.db.restoring")" ;;
  activate_fail)
    mv() { return 77; }
    if restore_swap_db "$work" balances.db preserve_copy; then echo RESULT:UNSAFE; else echo RESULT:BLOCKED; fi
    unset -f mv
    if [ -e "$work/balances.db" ]; then echo AFTER_FAIL_LIVE:PRESENT; else echo AFTER_FAIL_LIVE:MISSING; fi
    printf 'AFTER_FAIL_PRE:%s\nAFTER_FAIL_STAGED:%s\n' \
      "$(cat "$work/balances.db.prerestore")" "$(cat "$work/.balances.db.restoring")"
    restore_swap_db "$work" balances.db preserve_copy
    printf 'RECOVERED_LIVE:%s\nRECOVERED_PRE:%s\n' \
      "$(cat "$work/balances.db")" "$(cat "$work/balances.db.prerestore")" ;;
esac
`;

const run = (mode: string) =>
  Bun.spawnSync({ cmd: ["bash", "-c", HARNESS, "harness", LIB, mode], stdout: "pipe", stderr: "pipe" });

const ACTIVATION_HARNESS = String.raw`
set -euo pipefail
source "$1"
source "$2"
mode="$3"; work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
trace="$work/trace"; health_ran=0; ledger_released=0

release_ledger_maintenance_lock() {
  ledger_released=1
  printf 'release ledger lock\n' >> "$trace"
}

systemctl() {
  local action="$1" unit
  shift
  case "$action" in
    start)
      printf 'start %s\n' "$*" >> "$trace"
      if [ "$*" = "status-check.service backup.service" ]; then
        [ "$ledger_released" -eq 1 ] || return 70
        [ ! -e "$work/.restore-activation-pending" ] || return 71
        printf 'status-check reached live probe\nbackup reached snapshot\n' >> "$trace"
      fi
      return 0 ;;
    is-active)
      [ "$1" = --quiet ]
      unit="$2"
      printf 'active %s\n' "$unit" >> "$trace"
      case "$mode:$unit:$health_ran" in
        skipped_proxy:app-proxy:*) return 1 ;;
        inactive_backup:backup.timer:*) return 1 ;;
        late_crash:app-payments:1) return 1 ;;
      esac
      return 0 ;;
    stop)
      printf 'stop %s\n' "$*" >> "$trace"
      return 0 ;;
    *) return 64 ;;
  esac
}

readiness() {
  printf 'readiness\n' >> "$trace"
  health_ran=1
  [ "$mode" != readiness_failure ]
}

restore_arm_guard "$work" pair-id
if restore_run_activation_phase \
  "$work" pair-id app-proxy app-payments readiness \
  app-proxy app-payments status-check.timer backup.timer; then
  echo RESULT:READY
else
  echo RESULT:BLOCKED
fi
if [ -f "$work/.restore-in-progress" ]; then
  printf 'SWAP_GUARD:%s\n' "$(cat "$work/.restore-in-progress")"
else
  echo SWAP_GUARD:NONE
fi
if [ -f "$work/.restore-activation-pending" ]; then
  printf 'ACTIVATION_GUARD:%s\n' "$(cat "$work/.restore-activation-pending")"
else
  echo ACTIVATION_GUARD:NONE
fi
cat "$trace"
`;

const runActivation = (mode: string) =>
  Bun.spawnSync({
    cmd: ["bash", "-c", ACTIVATION_HARNESS, "activation-harness", LIB, ACTIVATION, mode],
    stdout: "pipe",
    stderr: "pipe",
  });

const INTERRUPT_HARNESS = String.raw`
set -euo pipefail
source "$1"
source "$2"
db_dir="$3"; trace="$4"; ready="$5"
systemctl() {
  local action="$1"
  shift
  printf '%s %s\n' "$action" "$*" >> "$trace"
  case "$action" in start|stop) return 0 ;; is-active) return 0 ;; *) return 64 ;; esac
}
readiness() {
  : > "$ready"
  while :; do sleep 1; done
}
restore_arm_guard "$db_dir" pair-id
restore_run_activation_phase "$db_dir" pair-id app-proxy app-payments readiness \
  app-proxy app-payments status-check.timer backup.timer
`;

async function waitForFile(path: string) {
  for (let i = 0; i < 200 && !existsSync(path); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(existsSync(path)).toBe(true);
}

function hasEffectiveRestoreGuard(unitText: string) {
  return Bun.spawnSync({
    cmd: [
      "bash",
      "-c",
      'source "$1"; restore_has_effective_negative_path_condition "$2" <<< "$3"',
      "condition-parser",
      LIB,
      "/var/lib/nullsink/.restore-in-progress",
      unitText,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("first restore preserves the original before activating staged data", () => {
  const result = run("first");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("LIVE:RESTORED\nPRE:ORIGINAL");
});

test("a restore retry never overwrites the first pre-restore copy", () => {
  const result = run("rerun");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("LIVE:RESTORED2\nPRE:ORIGINAL");
});

test("a new restore refuses stale prerestore files but a durably gated resume may reuse them", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-prerestore-slot-"));
  try {
    copyFileSync(import.meta.filename, join(dir, "balances.db.prerestore"));
    const harness = String.raw`
set -u
source "$1"
if restore_require_recovery_slots "$2" "$3"; then echo RESULT:ALLOWED; else echo RESULT:BLOCKED; fi
`;
    const fresh = Bun.spawnSync({
      cmd: ["bash", "-c", harness, "harness", LIB, dir, "0"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stdout.toString()).toContain("RESULT:BLOCKED");
    expect(fresh.stderr.toString()).toContain("verify/remove the prior restore's safety material");
    const resume = Bun.spawnSync({
      cmd: ["bash", "-c", harness, "harness", LIB, dir, "1"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(resume.exitCode).toBe(0);
    expect(resume.stdout.toString()).toContain("RESULT:ALLOWED");

    rmSync(join(dir, "balances.db.prerestore"));
    writeFileSync(join(dir, "pending.db.prerestore-unreadable.tar"), "forensic bytes");
    const rawArchive = Bun.spawnSync({
      cmd: ["bash", "-c", harness, "harness", LIB, dir, "0"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(rawArchive.exitCode).toBe(0);
    expect(rawArchive.stdout.toString()).toContain("RESULT:BLOCKED");
    expect(rawArchive.stderr.toString()).toContain("safety material");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit unreadable-ledger archive preserves raw main and WAL bytes without pretending they are a valid DB", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-unreadable-"));
  try {
    writeFileSync(join(dir, "balances.db"), "CORRUPT-MAIN");
    writeFileSync(join(dir, "balances.db-wal"), "CORRUPT-WAL");
    writeFileSync(join(dir, ".balances.db.restoring"), "RESTORED");
    const harness = String.raw`
set -euo pipefail
source "$1"
preserve_unreadable() { restore_archive_unreadable_db "$1" "$2-unreadable.tar"; }
restore_swap_db "$2" balances.db preserve_unreadable
printf 'LIVE:%s\n' "$(cat "$2/balances.db")"
printf 'MODE:%s\n' "$(stat -c '%a' "$2/balances.db.prerestore-unreadable.tar" 2>/dev/null || stat -f '%Lp' "$2/balances.db.prerestore-unreadable.tar")"
tar -C "$2" -xf "$2/balances.db.prerestore-unreadable.tar" -O balances.db
printf '\n'
tar -C "$2" -xf "$2/balances.db.prerestore-unreadable.tar" -O balances.db-wal
printf '\n'
`;
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", harness, "harness", LIB, dir],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("LIVE:RESTORED\nMODE:600\nCORRUPT-MAIN\nCORRUPT-WAL\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the durable restore guard binds every resume to the exact same backup pair", () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-identity-"));
  try {
    const pairA = join(dir, "pair-a");
    const pairB = join(dir, "pair-b");
    const live = join(dir, "live");
    mkdirSync(pairA);
    mkdirSync(pairB);
    mkdirSync(live);
    writeFileSync(join(pairA, "balances.db"), "A-balances");
    writeFileSync(join(pairA, "pending.db"), "A-pending");
    writeFileSync(join(pairB, "balances.db"), "B-balances");
    writeFileSync(join(pairB, "pending.db"), "B-pending");
    const harness = String.raw`
set -euo pipefail
source "$1"
a="$(restore_pair_identity "$2")"
b="$(restore_pair_identity "$3")"
restore_arm_guard "$4" "$a"
restore_guard_matches "$4" "$a"
if restore_guard_matches "$4" "$b"; then echo MIXED:ALLOWED; else echo MIXED:BLOCKED; fi
printf 'MODE:%s\n' "$(stat -c '%a' "$4/.restore-in-progress" 2>/dev/null || stat -f '%Lp' "$4/.restore-in-progress")"
`;
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", harness, "harness", LIB, pairA, pairB, live],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("MIXED:BLOCKED\nMODE:600\n");
    expect(result.stderr.toString()).toContain("different/unknown backup pair");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the corrupt-live break-glass path is explicit and refuses to bypass a readable ledger", () => {
  const restore = readFileSync(RESTORE, "utf8");
  expect(restore).toContain("--apply --archive-unreadable-live <artifact>");
  const preserve = restore.slice(
    restore.indexOf("service_preserve_db()"),
    restore.indexOf("restore_require_matched_pair"),
  );
  expect(preserve.indexOf("restore_preserve_sqlite")).toBeLessThan(
    preserve.indexOf('archive_unreadable_live" -eq 1'),
  );
  expect(preserve.indexOf("PRAGMA quick_check")).toBeLessThan(
    preserve.indexOf("restore_archive_unreadable_db"),
  );
  expect(preserve).toContain("logical preservation failed for another reason");
});

test("a failed WAL-aware preservation blocks activation and leaves live plus staged data intact", () => {
  const result = run("move_fail");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("RESULT:BLOCKED\nLIVE:ORIGINAL\nSTAGED:RESTORED");
});

test("a failed staged activation is recoverable without losing the preserved original", () => {
  const result = run("activate_fail");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain(
    "RESULT:BLOCKED\n" +
      "AFTER_FAIL_LIVE:PRESENT\n" +
      "AFTER_FAIL_PRE:ORIGINAL\n" +
      "AFTER_FAIL_STAGED:RESTORED\n" +
      "RECOVERED_LIVE:RESTORED\n" +
      "RECOVERED_PRE:ORIGINAL",
  );
});

test("the pre-restore recovery copy includes committed rows that exist only in WAL", () => {
  expect(Bun.which("sqlite3"), "restore contract tests require sqlite3").not.toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-wal-"));
  try {
    const sourceDir = join(dir, "abrupt-writer");
    mkdirSync(sourceDir);
    const sourcePath = join(sourceDir, "balances.db");
    const livePath = join(dir, "balances.db");
    const stagedPath = join(dir, ".balances.db.restoring");
    const live = new Database(sourcePath, { create: true });
    live.run("PRAGMA journal_mode=WAL");
    live.run("PRAGMA wal_autocheckpoint=0");
    live.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
    live.run("INSERT INTO tokens VALUES ('committed-in-wal', 7)");
    expect(readFileSync(`${sourcePath}-wal`).byteLength).toBeGreaterThan(0);
    // Copy the quiescent file set before the clean close checkpoints the source. The copy models files left
    // by an abruptly killed writer: its main DB alone has no newest frames, but main+WAL is recoverable.
    copyFileSync(sourcePath, livePath);
    copyFileSync(`${sourcePath}-wal`, `${livePath}-wal`);
    live.close();

    const staged = new Database(stagedPath, { create: true });
    staged.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
    staged.close();
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; preserve() { restore_preserve_sqlite sqlite3 "$1" "$2"; }; restore_swap_db "$2" balances.db preserve',
        "harness",
        LIB,
        dir,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const previous = Bun.spawnSync({
      cmd: ["sqlite3", join(dir, "balances.db.prerestore"), "SELECT balance FROM tokens WHERE hash = 'committed-in-wal';"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(previous.exitCode, previous.stderr.toString()).toBe(0);
    expect(previous.stdout.toString().trim()).toBe("7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  [
    "a base-unit guard",
    `[Unit]\nConditionPathExists=!/var/lib/nullsink/.restore-in-progress\n[Service]\nType=simple`,
    true,
  ],
  [
    "a later same-type reset",
    `[Unit]\nConditionPathExists=!/var/lib/nullsink/.restore-in-progress\n` +
      `# /etc/systemd/system/example.service.d/zz-reset.conf\n[Unit]\nConditionPathExists=`,
    false,
  ],
  [
    "a later different Condition reset",
    `[Unit]\nConditionPathExists=!/var/lib/nullsink/.restore-in-progress\n` +
      `[Unit]\nConditionKernelCommandLine=`,
    false,
  ],
  [
    "a guard re-added after reset",
    `[Unit]\nConditionPathExists=!/var/lib/nullsink/.restore-in-progress\nConditionPathExists=\n` +
      `ConditionPathExists = !/var/lib/nullsink/.restore-in-progress`,
    true,
  ],
  [
    "an irrelevant Service-section reset",
    `[Unit]\nConditionPathExists=!/var/lib/nullsink/.restore-in-progress\n` +
      `[Service]\nConditionPathExists=`,
    true,
  ],
  [
    "a trigger-form guard",
    `[Unit]\nConditionPathExists=|!/var/lib/nullsink/.restore-in-progress`,
    false,
  ],
] as const)("ordered condition parsing handles %s", (_label, unitText, expected) => {
  const result = hasEffectiveRestoreGuard(unitText);
  expect(result.exitCode === 0).toBe(expected);
});

test("restore apply uses ordered Condition reset parsing rather than a stale-line grep", () => {
  const restore = readFileSync(RESTORE, "utf8");
  expect(restore).toContain("restore_has_effective_negative_path_condition");
  expect(restore).not.toContain(
    "grep -Fq 'ConditionPathExists=!/var/lib/nullsink/.restore-in-progress'",
  );
});

test("a durable restore marker blocks both ledgers and backups until post-swap validation", () => {
  for (const unit of [PROXY_UNIT, PAYMENTS_UNIT, BACKUP_UNIT, STATUS_CHECK_UNIT])
    expect(readFileSync(unit, "utf8")).toContain("ConditionPathExists=!/var/lib/nullsink/.restore-in-progress");
  for (const unit of [BACKUP_UNIT, STATUS_CHECK_UNIT])
    expect(readFileSync(unit, "utf8")).toContain(
      "ConditionPathExists=!/var/lib/nullsink/.restore-activation-pending",
    );
  const restore = readFileSync(RESTORE, "utf8");
  const arm = restore.indexOf('restore_arm_guard "$DB_DIR" "$restore_pair_id"');
  const firstSwap = restore.indexOf('restore_swap_db "$DB_DIR"');
  const validate = restore.indexOf('check_tombstone_pair "$DB_DIR/pending.db"');
  const activate = restore.indexOf("restore_run_activation_phase", validate);
  const activation = readFileSync(ACTIVATION, "utf8");
  const armActivation = activation.indexOf('restore_arm_activation_guard "$db_dir" "$pair_id"');
  const disarmSwap = activation.indexOf('restore_disarm_guard "$db_dir"', armActivation);
  const start = activation.indexOf('restore_activate_or_fail_closed', disarmSwap);
  expect(arm).toBeGreaterThan(-1);
  expect(firstSwap).toBeGreaterThan(arm);
  expect(validate).toBeGreaterThan(firstSwap);
  expect(activate).toBeGreaterThan(validate);
  expect(disarmSwap).toBeGreaterThan(armActivation);
  expect(start).toBeGreaterThan(disarmSwap);
});

test("restore activation starts every participant, proves readiness, and checks they stayed active", () => {
  const result = runActivation("healthy");
  const output = result.stdout.toString();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(output).toContain(
    "RESULT:READY\nSWAP_GUARD:NONE\nACTIVATION_GUARD:NONE\n",
  );
  expect(output).toContain(
    "start app-proxy app-payments status-check.timer backup.timer\n" +
      "active app-proxy\n" +
      "active app-payments\n" +
      "active status-check.timer\n" +
      "active backup.timer\n" +
      "readiness\n" +
      "active app-proxy\n" +
      "active app-payments\n" +
      "active status-check.timer\n" +
      "active backup.timer\n" +
      "stop status-check.service backup.service\n" +
      "release ledger lock\n" +
      "start status-check.service backup.service\n" +
      "status-check reached live probe\n" +
      "backup reached snapshot\n",
  );
});

test("restore readiness probes both configured localhost application ports", () => {
  const harness = String.raw`
set -euo pipefail
source "$1"
ENV_FILE="$2"
trace="$3"
curl() { printf '%s\n' "$*" >> "$trace"; }
restore_health_ok_app
cat "$trace"
`;
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-health-"));
  try {
    const envFile = join(dir, "nullsink.env");
    writeFileSync(envFile, "PORT=19080\nPAYMENTS_PORT=19081\n");
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", harness, "health-harness", ACTIVATION, envFile, join(dir, "trace")],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(
      "-fsS --max-time 3 http://127.0.0.1:19080/healthz\n" +
        "-fsS --max-time 3 http://127.0.0.1:19081/healthz\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TERM during readiness durably re-gates and stops the complete activation set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-activation-term-"));
  const trace = join(dir, "trace");
  const ready = join(dir, "ready");
  const child = Bun.spawn({
    cmd: ["bash", "-c", INTERRUPT_HARNESS, "interrupt", LIB, ACTIVATION, dir, trace, ready],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForFile(ready);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    expect(readFileSync(join(dir, ".restore-in-progress"), "utf8").trim()).toBe(
      "restore-v2 pair-id",
    );
    expect(readFileSync(join(dir, ".restore-activation-pending"), "utf8").trim()).toBe(
      "restore-activation-v1 pair-id",
    );
    expect(readFileSync(trace, "utf8")).toContain(
      "stop backup.timer status-check.timer backup.service status-check.service app-payments app-proxy",
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL leaves an exact-pair activation resume that never re-swaps the live ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nullsink-restore-activation-kill-"));
  const trace = join(dir, "trace");
  const ready = join(dir, "ready");
  writeFileSync(join(dir, "balances.db"), "RESTORED-LIVE");
  writeFileSync(join(dir, "balances.db.prerestore"), "ORIGINAL-RECOVERY");
  writeFileSync(join(dir, ".balances.db.restoring"), "STALE-STAGED-COPY");
  const child = Bun.spawn({
    cmd: ["bash", "-c", INTERRUPT_HARNESS, "interrupt", LIB, ACTIVATION, dir, trace, ready],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForFile(ready);
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    expect(existsSync(join(dir, ".restore-in-progress"))).toBe(false);
    expect(readFileSync(join(dir, ".restore-activation-pending"), "utf8").trim()).toBe(
      "restore-activation-v1 pair-id",
    );

    // Model a valid post-restore write made by the activated app before the operator resumes. Reapplying the
    // artifact here would erase it; activation-only resume must preserve it and the first recovery copy.
    writeFileSync(join(dir, "balances.db"), "POST-RESTORE-WRITE");
    const mismatch = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'source "$1"; source "$2"; restore_recovery_phase "$3" wrong-pair',
        "mismatch",
        LIB,
        ACTIVATION,
        dir,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(mismatch.exitCode).not.toBe(0);
    expect(mismatch.stderr.toString()).toContain("different/unknown backup pair");
    expect(readFileSync(join(dir, "balances.db"), "utf8")).toBe("POST-RESTORE-WRITE");
    expect(readFileSync(join(dir, "balances.db.prerestore"), "utf8")).toBe(
      "ORIGINAL-RECOVERY",
    );

    const resumeHarness = String.raw`
set -euo pipefail
source "$1"
source "$2"
db_dir="$3"; trace="$4"; ledger_released=0
systemctl() {
  local action="$1"
  shift
  printf '%s %s\n' "$action" "$*" >> "$trace"
  case "$action" in
    start|stop) return 0 ;;
    is-active) return 0 ;;
    *) return 64 ;;
  esac
}
readiness() { printf 'readiness\n' >> "$trace"; }
release_ledger_maintenance_lock() { ledger_released=1; printf 'release ledger lock\n' >> "$trace"; }
[ "$(restore_recovery_phase "$db_dir" pair-id)" = activation ]
restore_prepare_activation_resume "$db_dir" pair-id app-proxy app-payments
restore_run_activation_phase "$db_dir" pair-id app-proxy app-payments readiness \
  app-proxy app-payments status-check.timer backup.timer
printf 'LIVE:%s\nPRE:%s\nSTAGED:%s\n' \
  "$(cat "$db_dir/balances.db")" "$(cat "$db_dir/balances.db.prerestore")" \
  "$(cat "$db_dir/.balances.db.restoring")"
`;
    const resume = Bun.spawnSync({
      cmd: ["bash", "-c", resumeHarness, "resume", LIB, ACTIVATION, dir, trace],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(resume.exitCode, resume.stderr.toString()).toBe(0);
    expect(resume.stdout.toString()).toContain(
      "LIVE:POST-RESTORE-WRITE\n" +
        "PRE:ORIGINAL-RECOVERY\n" +
        "STAGED:STALE-STAGED-COPY\n",
    );
    expect(existsSync(join(dir, ".restore-in-progress"))).toBe(false);
    expect(existsSync(join(dir, ".restore-activation-pending"))).toBe(false);
    expect(readFileSync(trace, "utf8")).toContain(
      "stop backup.timer status-check.timer backup.service status-check.service app-payments app-proxy",
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ["a Condition-skipped application service", "skipped_proxy", "app-proxy did not remain active"],
  ["an inactive backup timer", "inactive_backup", "backup.timer did not remain active"],
  ["an application readiness failure", "readiness_failure", "did not pass /healthz readiness"],
  ["an application that exits immediately after readiness", "late_crash", "app-payments did not remain active"],
] as const)("restore activation fails closed for %s", (_label, mode, diagnostic) => {
  const result = runActivation(mode);
  const output = result.stdout.toString();
  const error = result.stderr.toString();
  expect(result.exitCode, error).toBe(0);
  expect(output).toContain(
    "RESULT:BLOCKED\n" +
      "SWAP_GUARD:restore-v2 pair-id\n" +
      "ACTIVATION_GUARD:restore-activation-v1 pair-id\n",
  );
  expect(output).toContain(
    "stop backup.timer status-check.timer backup.service status-check.service app-payments app-proxy\n",
  );
  expect(error).toContain(diagnostic);
  expect(error).toContain("restore guard is re-armed and the partial stack is stopped");
});
