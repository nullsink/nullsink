import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION = fileURLToPath(new URL("../deploy/migrate-ledger-service.sh", import.meta.url));
const workdirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void | Promise<void> }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function workspace(withHold = false) {
  const root = mkdtempSync(join(tmpdir(), "nullsink-ledger-migration-"));
  workdirs.push(root);
  const etc = join(root, "etc");
  const state = join(root, "state");
  const systemd = join(root, "systemd");
  const binDir = join(root, "app-bin");
  const fakeBin = join(root, "fake-bin");
  const systemdState = join(root, "systemd-state");
  const systemctlLog = join(root, "systemctl.log");
  const oldState = join(state, "nullsink-proxy");
  const pendingState = join(state, "nullsink-payments");
  for (const dir of [etc, state, systemd, binDir, fakeBin, systemdState, oldState, pendingState])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(systemdState, "nullsink-ledger.stopped"), "");

  const user = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
  const group = Bun.spawnSync(["id", "-gn"]).stdout.toString().trim();

  executable(
    join(fakeBin, "id"),
    `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi
if [ "$#" -eq 1 ]; then exit 0; fi
exec /usr/bin/id "$@"
`,
  );
  for (const command of ["getent", "groupadd", "useradd", "usermod", "chown"])
    executable(join(fakeBin, command), "#!/bin/sh\nexit 0\n");
  executable(
    join(fakeBin, "install"),
    `#!/usr/bin/env bash
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "\${args[@]}"
`,
  );
  executable(
    join(fakeBin, "systemctl"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"
cmd="$1"; shift
case "$cmd" in
  is-active)
    [ "$1" = --quiet ] && shift
    [ ! -e "$FAKE_SYSTEMD_STATE/$1.stopped" ]
    ;;
  stop)
    for unit in "$@"; do : > "$FAKE_SYSTEMD_STATE/$unit.stopped"; done
    ;;
  start)
    for unit in "$@"; do
      [ "\${FAKE_FAIL_START:-}" != "$unit" ] || exit 1
      rm -f "$FAKE_SYSTEMD_STATE/$unit.stopped"
    done
    ;;
  show)
    printf '%s\n' "$FAKE_SERVICE_USER"
    ;;
  *) exit 0 ;;
esac
`,
  );

  const balances = new Database(join(oldState, "balances.db"));
  balances.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
  balances.run("INSERT INTO tokens VALUES ('token-hash', 123456)");
  balances.run("CREATE TABLE holds (id TEXT PRIMARY KEY)");
  if (withHold) balances.run("INSERT INTO holds VALUES ('active')");
  balances.close();

  const pending = new Database(join(pendingState, "pending.db"));
  pending.run("CREATE TABLE pending_orders (id TEXT PRIMARY KEY)");
  pending.run(`CREATE TABLE credit_outbox (
    idempotency_key TEXT PRIMARY KEY, hash TEXT NOT NULL, micros INTEGER NOT NULL,
    created_at INTEGER NOT NULL, acked_at INTEGER
  )`);
  pending.close();

  writeFileSync(join(systemd, "nullsink-proxy.service"), "old proxy unit\n");
  writeFileSync(join(systemd, "nullsink-payments.service"), "old payments unit\n");
  writeFileSync(join(systemd, "backup.service"), "old backup unit\n");
  writeFileSync(join(systemd, "status-check.service"), "old status unit\n");
  executable(join(binDir, "nullsink-proxy-v1.13.0"), "#!/bin/sh\nexit 0\n");
  executable(join(binDir, "nullsink-payments-v1.13.0"), "#!/bin/sh\nexit 0\n");
  symlinkSync("nullsink-proxy-v1.13.0", join(binDir, "current-proxy"));
  symlinkSync("nullsink-payments-v1.13.0", join(binDir, "current-payments"));

  const meteringSock = join(root, "run", "ledger.sock");
  const creditSock = join(root, "run", "credit.sock");
  mkdirSync(join(root, "run"));
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    NULLSINK_ETC_DIR: etc,
    NULLSINK_STATE_ROOT: state,
    NULLSINK_SYSTEMD_DIR: systemd,
    NULLSINK_BIN_DIR: binDir,
    NULLSINK_ROOT_GROUP: group,
    NULLSINK_OPERATOR_USER: user,
    NULLSINK_PROXY_USER: user,
    NULLSINK_BACKUP_USER: user,
    NULLSINK_LEDGER_USER: user,
    NULLSINK_PROXY_READ_GROUP: group,
    NULLSINK_LEDGER_READ_GROUP: group,
    NULLSINK_LEDGER_PROXY_GROUP: group,
    NULLSINK_LEDGER_SOCK: meteringSock,
    NULLSINK_CREDIT_SOCK: creditSock,
    FAKE_SYSTEMD_STATE: systemdState,
    FAKE_SYSTEMCTL_LOG: systemctlLog,
    FAKE_SERVICE_USER: user,
  };
  return { root, etc, state, systemd, binDir, systemdState, systemctlLog, oldState, pendingState, meteringSock, creditSock, env };
}

function run(mode: string, env: Record<string, string | undefined>) {
  return Bun.spawnSync(["bash", MIGRATION, mode], { env, stdout: "pipe", stderr: "pipe" });
}

test("prepare copies the exact ledger only after draining admission, and rollback restores the old topology", () => {
  const w = workspace();
  const prepared = run("--prepare", w.env);
  const output = prepared.stdout.toString() + prepared.stderr.toString();
  expect(prepared.exitCode, output).toBe(0);
  expect(output).toContain(
    "stopped-state gate holds=0 open_orders=0 unacked=0 legacy_ack_payloads=0 partial_scrub=0",
  );
  expect(output).toContain("balances.db copied (integrity and logical fingerprint preserved)");

  const migrated = new Database(join(w.state, "nullsink-ledger", "balances.db"), { readonly: true });
  expect(migrated.query("SELECT balance FROM tokens").get()).toEqual({ balance: 123456 });
  migrated.close();
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.prepared"))).toBe(true);
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.activated"))).toBe(false);
  expect(readFileSync(join(w.etc, "nullsink-ledger-extraction.prepared"), "utf8")).toMatch(
    /state=existing\nsource_fingerprint=[0-9a-f]{64}\n/,
  );

  const log = readFileSync(w.systemctlLog, "utf8");
  expect(log.indexOf("stop caddy")).toBeLessThan(log.indexOf("stop nullsink-payments nullsink-proxy"));
  expect(log).toContain("stop backup.timer status-check.timer");

  writeFileSync(join(w.systemd, "nullsink-proxy.service"), "new proxy unit\n");
  writeFileSync(join(w.systemd, "nullsink-payments.service"), "new payments unit\n");
  writeFileSync(join(w.systemd, "nullsink-ledger.service"), "new ledger unit\n");
  writeFileSync(join(w.systemd, "backup.service"), "new backup unit\n");
  writeFileSync(join(w.systemd, "status-check.service"), "new status unit\n");
  rmSync(join(w.binDir, "current-proxy"));
  rmSync(join(w.binDir, "current-payments"));
  symlinkSync("nullsink-proxy-v1.14.0", join(w.binDir, "current-proxy"));
  symlinkSync("nullsink-payments-v1.14.0", join(w.binDir, "current-payments"));

  const rolledBack = run("--rollback", w.env);
  expect(rolledBack.exitCode, rolledBack.stderr.toString()).toBe(0);
  expect(readlinkSync(join(w.binDir, "current-proxy"))).toBe("nullsink-proxy-v1.13.0");
  expect(readlinkSync(join(w.binDir, "current-payments"))).toBe("nullsink-payments-v1.13.0");
  expect(readFileSync(join(w.systemd, "nullsink-proxy.service"), "utf8")).toBe("old proxy unit\n");
  expect(readFileSync(join(w.systemd, "nullsink-payments.service"), "utf8")).toBe("old payments unit\n");
  expect(readFileSync(join(w.systemd, "backup.service"), "utf8")).toBe("old backup unit\n");
  expect(readFileSync(join(w.systemd, "status-check.service"), "utf8")).toBe("old status unit\n");
  expect(existsSync(join(w.systemd, "nullsink-ledger.service"))).toBe(false);
  expect(existsSync(join(w.state, "nullsink-ledger"))).toBe(false);
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.prepared"))).toBe(false);
  expect(readFileSync(w.systemctlLog, "utf8")).toContain("disable nullsink-ledger");
});

test("a fresh box prepares the empty ledger identity without stopping any service", () => {
  const w = workspace();
  rmSync(join(w.oldState, "balances.db"));

  const prepared = run("--prepare", w.env);
  expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
  expect(prepared.stdout.toString()).toContain("prepared fresh ledger state");
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.prepared"))).toBe(true);
  expect(existsSync(join(w.state, "nullsink-ledger"))).toBe(true);
  expect(existsSync(w.systemctlLog)).toBe(false);
  expect(readFileSync(join(w.etc, "nullsink-ledger-extraction.prepared"), "utf8")).toContain(
    "state=fresh\nsource_fingerprint=none",
  );

  Bun.spawnSync(
    [join(w.root, "fake-bin", "systemctl"), "stop", "caddy", "nullsink-proxy", "nullsink-payments"],
    { env: w.env },
  );
  const repeated = run("--prepare", w.env);
  expect(repeated.exitCode, repeated.stderr.toString()).toBe(0);
  expect(repeated.stdout.toString()).toContain("already prepared");
});

test("activation marks the no-rollback boundary before attempting to reopen Caddy", () => {
  const w = workspace();
  expect(run("--prepare", w.env).exitCode).toBe(0);
  Bun.spawnSync([join(w.root, "fake-bin", "systemctl"), "start", "nullsink-ledger", "nullsink-proxy", "nullsink-payments"], { env: w.env });
  servers.push(Bun.serve({ unix: w.meteringSock, fetch: () => new Response("ok") }));
  servers.push(Bun.serve({ unix: w.creditSock, fetch: () => new Response("ok") }));

  const failed = run("--activate", { ...w.env, FAKE_FAIL_START: "caddy" });
  expect(failed.exitCode).toBe(1);
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.activated"))).toBe(true);
  const rollback = run("--rollback", w.env);
  expect(rollback.exitCode).toBe(1);
  expect(rollback.stderr.toString()).toContain("traffic was activated");
});

test("activation requires both sockets; finalization removes only the frozen pre-cutover copy", () => {
  const w = workspace();
  expect(run("--prepare", w.env).exitCode).toBe(0);
  Bun.spawnSync([join(w.root, "fake-bin", "systemctl"), "start", "nullsink-ledger", "nullsink-proxy", "nullsink-payments"], { env: w.env });

  const refused = run("--activate", w.env);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("metering socket is absent");
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.activated"))).toBe(false);

  servers.push(Bun.serve({ unix: w.meteringSock, fetch: () => new Response("ok") }));
  servers.push(Bun.serve({ unix: w.creditSock, fetch: () => new Response("ok") }));
  const activated = run("--activate", w.env);
  expect(activated.exitCode, activated.stderr.toString()).toBe(0);
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.activated"))).toBe(true);
  expect(readFileSync(w.systemctlLog, "utf8")).toContain("start caddy");

  const finalized = run("--finalize", w.env);
  expect(finalized.exitCode, finalized.stderr.toString()).toBe(0);
  expect(existsSync(w.oldState)).toBe(false);
  expect(existsSync(join(w.state, "nullsink-ledger-migration"))).toBe(false);
  expect(existsSync(join(w.state, "nullsink-ledger", "balances.db"))).toBe(true);
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.prepared"))).toBe(true);
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.activated"))).toBe(true);
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.finalized"))).toBe(true);

  const repeatedPrepare = run("--prepare", w.env);
  expect(repeatedPrepare.exitCode, repeatedPrepare.stderr.toString()).toBe(0);
  expect(repeatedPrepare.stdout.toString()).toContain("already activated");
  const repeatedActivate = run("--activate", w.env);
  expect(repeatedActivate.exitCode, repeatedActivate.stderr.toString()).toBe(0);
  expect(repeatedActivate.stdout.toString()).toContain("already activated");
  const validated = run("--validate", w.env);
  expect(validated.exitCode, validated.stderr.toString()).toBe(0);
  expect(validated.stdout.toString()).toContain("active state is complete");
});

test("a stopped-session hold is preserved for atomic recovery by the first ledger session", () => {
  const w = workspace(true);
  const result = run("--prepare", w.env);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("1 stopped-session hold(s) will be recovered atomically");
  const migrated = new Database(join(w.state, "nullsink-ledger", "balances.db"), { readonly: true });
  expect(migrated.query("SELECT COUNT(*) AS n FROM holds").get()).toEqual({ n: 1 });
  migrated.close();
});

test("prepare refuses rollback-unsafe payment state and restores the old topology", () => {
  const scenarios = [
    {
      name: "open payment order",
      mutate: (db: Database) => db.run("INSERT INTO pending_orders VALUES ('open')"),
      error: "open payment orders must settle or expire",
    },
    {
      name: "undelivered credit",
      mutate: (db: Database) =>
        db.run("INSERT INTO credit_outbox VALUES ('unacked', 'token', 7, 1, NULL)"),
      error: "undelivered credits must drain",
    },
    {
      name: "legacy acknowledged payload",
      mutate: (db: Database) =>
        db.run("INSERT INTO credit_outbox VALUES ('legacy', 'token', 7, 1, 2)"),
      error: "legacy acknowledged credit payloads must be scrubbed",
    },
  ];

  for (const scenario of scenarios) {
    const w = workspace();
    const pending = new Database(join(w.pendingState, "pending.db"));
    scenario.mutate(pending);
    pending.close();

    const result = run("--prepare", w.env);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, scenario.name).toBe(1);
    expect(output).toContain(scenario.error);
    expect(output).toContain("unchanged old topology was restored");
    expect(existsSync(join(w.etc, "nullsink-ledger-extraction.prepared"))).toBe(false);
    expect(existsSync(join(w.state, "nullsink-ledger", "balances.db"))).toBe(false);
    expect(existsSync(join(w.systemdState, "nullsink-proxy.stopped"))).toBe(false);
    expect(existsSync(join(w.systemdState, "nullsink-payments.stopped"))).toBe(false);
    expect(existsSync(join(w.systemdState, "caddy.stopped"))).toBe(false);
  }
});

test("prepared validation fails closed when migrated or rollback state is incomplete", () => {
  const missingLedger = workspace();
  expect(run("--prepare", missingLedger.env).exitCode).toBe(0);
  expect(run("--validate", missingLedger.env).exitCode).toBe(0);
  rmSync(join(missingLedger.state, "nullsink-ledger", "balances.db"));
  const ledgerResult = run("--validate", missingLedger.env);
  expect(ledgerResult.exitCode).toBe(1);
  expect(ledgerResult.stderr.toString()).toContain("migrated balances.db is absent");

  const missingRollback = workspace();
  expect(run("--prepare", missingRollback.env).exitCode).toBe(0);
  rmSync(join(missingRollback.state, "nullsink-ledger-migration", "nullsink-proxy.service"));
  const rollbackResult = run("--validate", missingRollback.env);
  expect(rollbackResult.exitCode).toBe(1);
  expect(rollbackResult.stderr.toString()).toContain(
    "rollback contract is incomplete: nullsink-proxy.service",
  );

  const changedSource = workspace();
  expect(run("--prepare", changedSource.env).exitCode).toBe(0);
  const balances = new Database(join(changedSource.oldState, "balances.db"));
  balances.run("UPDATE tokens SET balance = balance + 1");
  balances.close();
  const sourceResult = run("--validate", changedSource.env);
  expect(sourceResult.exitCode).toBe(1);
  expect(sourceResult.stderr.toString()).toContain("frozen source ledger fingerprint changed");
}, 15_000);

test("prepared validation refuses restarted services and newly created payment work", () => {
  const w = workspace();
  expect(run("--prepare", w.env).exitCode).toBe(0);

  for (const unit of ["caddy", "nullsink-proxy", "nullsink-payments", "nullsink-ledger"]) {
    Bun.spawnSync([join(w.root, "fake-bin", "systemctl"), "start", unit], { env: w.env });
    const activeResult = run("--validate", w.env);
    expect(activeResult.exitCode, unit).toBe(1);
    expect(activeResult.stderr.toString()).toContain(
      `prepared cutover requires ${unit} to remain stopped`,
    );
    Bun.spawnSync([join(w.root, "fake-bin", "systemctl"), "stop", unit], { env: w.env });
  }

  const pending = new Database(join(w.pendingState, "pending.db"));
  pending.run("INSERT INTO pending_orders VALUES ('created-after-prepare')");
  pending.close();

  const quietResult = run("--validate", w.env);
  expect(quietResult.exitCode).toBe(1);
  expect(quietResult.stderr.toString()).toContain("open payment orders must settle or expire");
}, 15_000);

test("a failed financial gate publishes no marker and automatically restores the old topology", () => {
  const w = workspace();
  const pending = new Database(join(w.pendingState, "pending.db"));
  pending.run("INSERT INTO credit_outbox VALUES ('partial', '', 7, 1, NULL)");
  pending.close();
  const result = run("--prepare", w.env);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("partially scrubbed rows");
  expect(result.stderr.toString()).toContain("unchanged old topology was restored");
  expect(existsSync(join(w.etc, "nullsink-ledger-extraction.prepared"))).toBe(false);
  expect(existsSync(join(w.state, "nullsink-ledger", "balances.db"))).toBe(false);
  expect(existsSync(join(w.systemdState, "nullsink-proxy.stopped"))).toBe(false);
  expect(existsSync(join(w.systemdState, "nullsink-payments.stopped"))).toBe(false);
  expect(existsSync(join(w.systemdState, "caddy.stopped"))).toBe(false);
});
