import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION = fileURLToPath(
  new URL("../deploy/migrate-service-isolation.sh", import.meta.url),
);
const LABEL_EXPORT = fileURLToPath(
  new URL("../deploy/backup-bitcoin-labels.sh", import.meta.url),
);
const workdirs: string[] = [];

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "nullsink-isolation-test-"));
  workdirs.push(root);
  const etc = join(root, "etc");
  const state = join(root, "state");
  const systemd = join(root, "systemd");
  const app = join(root, "app");
  const bin = join(root, "bin");
  const systemdState = join(root, "systemd-state");
  const chownLog = join(root, "chown.log");
  for (const dir of [etc, state, systemd, app, bin, systemdState]) mkdirSync(dir);

  const user = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
  const group = Bun.spawnSync(["id", "-gn"]).stdout.toString().trim();

  executable(
    join(bin, "id"),
    `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi
exec /usr/bin/id "$@"
`,
  );
  executable(join(bin, "getent"), "#!/bin/sh\nexit 0\n");
  executable(join(bin, "groupadd"), "#!/bin/sh\nexit 0\n");
  executable(join(bin, "useradd"), "#!/bin/sh\nexit 0\n");
  executable(join(bin, "usermod"), "#!/bin/sh\nexit 0\n");
  executable(
    join(bin, "chown"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_CHOWN_LOG"\n',
  );
  executable(
    join(bin, "install"),
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
    join(bin, "systemctl"),
    `#!/bin/sh
cmd="$1"; shift
for arg do unit="$arg"; done
case "$cmd" in
  is-active)
    [ ! -e "$FAKE_SYSTEMD_STATE/$unit.stopped" ]
    ;;
  stop)
    for unit in "$@"; do : > "$FAKE_SYSTEMD_STATE/$unit.stopped"; done
    ;;
  start)
    for unit in "$@"; do rm -f "$FAKE_SYSTEMD_STATE/$unit.stopped"; done
    ;;
  show)
    printf '%s\n' "$FAKE_SERVICE_USER"
    ;;
  *) exit 0 ;;
esac
`,
  );

  const legacy = join(state, "nullsink");
  mkdirSync(join(legacy, "backups"), { recursive: true });
  return {
    root,
    etc,
    state,
    systemd,
    app,
    bin,
    systemdState,
    chownLog,
    legacy,
    user,
    group,
  };
}

function seedQuietState(legacy: string, withHold = false): void {
  const balances = new Database(join(legacy, "balances.db"));
  balances.run("CREATE TABLE tokens (hash TEXT PRIMARY KEY, balance INTEGER NOT NULL)");
  balances.run("INSERT INTO tokens VALUES ('token-hash', 123456)");
  balances.run("CREATE TABLE holds (id TEXT PRIMARY KEY)");
  if (withHold) balances.run("INSERT INTO holds VALUES ('active')");
  balances.close();

  const pending = new Database(join(legacy, "pending.db"));
  pending.run("CREATE TABLE pending_orders (id TEXT PRIMARY KEY)");
  pending.run(`CREATE TABLE credit_outbox (
    idempotency_key TEXT PRIMARY KEY, hash TEXT NOT NULL, micros INTEGER NOT NULL,
    created_at INTEGER NOT NULL, acked_at INTEGER
  )`);
  pending.run("INSERT INTO credit_outbox VALUES ('done', '', 0, 1, 2)");
  pending.run("CREATE TABLE revenue (id INTEGER PRIMARY KEY)");
  pending.close();
}

function migrationEnv(w: ReturnType<typeof workspace>): Record<string, string> {
  return {
    ...process.env,
    PATH: `${w.bin}:${process.env.PATH}`,
    APP_DIR: w.app,
    NULLSINK_ETC_DIR: w.etc,
    NULLSINK_STATE_ROOT: w.state,
    NULLSINK_SYSTEMD_DIR: w.systemd,
    NULLSINK_ROOT_GROUP: w.group,
    NULLSINK_OPERATOR_USER: w.user,
    NULLSINK_PROXY_USER: w.user,
    NULLSINK_PAYMENTS_USER: w.user,
    NULLSINK_BACKUP_USER: w.user,
    NULLSINK_PROXY_READ_GROUP: w.group,
    NULLSINK_PAYMENTS_READ_GROUP: w.group,
    NULLSINK_BACKUP_GROUP: w.group,
    NULLSINK_CREDIT_GROUP: w.group,
    NULLSINK_EXPORT_USER: "nullsink-test-export-user-does-not-exist",
    NULLSINK_EXPORT_GROUP: w.group,
    FAKE_SYSTEMD_STATE: w.systemdState,
    FAKE_SERVICE_USER: w.user,
    FAKE_CHOWN_LOG: w.chownLog,
  };
}

test("service-isolation migration splits secrets and preserves both SQLite stores", () => {
  const w = workspace();
  seedQuietState(w.legacy);
  writeFileSync(join(w.legacy, "backups", "backup-20260806T000000Z.tar.age"), "ciphertext");
  writeFileSync(
    join(w.etc, "nullsink.env"),
    `ANTHROPIC_API_KEY=provider-secret
HOST=127.0.0.1
PORT=8080
PAYMENTS_PORT=8081
PAY_RAILS=bitcoin,monero
BITCOIN_RPC_URL=http://10.0.0.2:8332/wallet/nullsink
BITCOIN_RPC_USER=rpc-user
BITCOIN_RPC_PASSWORD=wallet-secret
BACKUP_AGE_RECIPIENT=age1recipient
BACKUP_KEEP=84
NULLSINK_DOMAIN=nullsink.example
TELEGRAM_BOT_TOKEN=alert-secret
`,
  );

  const result = Bun.spawnSync(["bash", MIGRATION, "--prepare"], {
    env: migrationEnv(w),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain("quiet gate holds=0 open_orders=0 unacked=0 partial_scrub=0");
  for (const secret of ["provider-secret", "wallet-secret", "alert-secret"]) {
    expect(output).not.toContain(secret);
  }

  const proxyEnv = readFileSync(join(w.etc, "nullsink-proxy.env"), "utf8");
  const paymentsEnv = readFileSync(join(w.etc, "nullsink-payments.env"), "utf8");
  const backupEnv = readFileSync(join(w.etc, "nullsink-backup.env"), "utf8");
  const monitorEnv = readFileSync(join(w.etc, "nullsink-monitor.env"), "utf8");
  expect(proxyEnv).toContain("ANTHROPIC_API_KEY=provider-secret");
  expect(proxyEnv).not.toContain("BITCOIN_RPC_");
  expect(paymentsEnv).toContain("BITCOIN_RPC_PASSWORD=wallet-secret");
  expect(paymentsEnv).not.toContain("ANTHROPIC_API_KEY");
  expect(backupEnv).toContain("BACKUP_AGE_RECIPIENT=age1recipient");
  expect(monitorEnv).toContain("TELEGRAM_BOT_TOKEN=alert-secret");
  expect(monitorEnv).not.toContain("BITCOIN_RPC_");
  for (const name of [
    "nullsink-proxy.env",
    "nullsink-payments.env",
    "nullsink-backup.env",
    "nullsink-monitor.env",
  ]) {
    expect(statSync(join(w.etc, name)).mode & 0o777).toBe(0o600);
  }
  expect(statSync(join(w.etc, "nullsink.env")).mode & 0o777).toBe(0o600);
  const chowns = readFileSync(w.chownLog, "utf8");
  for (const name of [
    "nullsink-proxy.env",
    "nullsink-payments.env",
    "nullsink-backup.env",
    "nullsink-monitor.env",
  ]) {
    expect(chowns).toContain(`root:${w.group} ${join(w.etc, name)}`);
  }

  const migratedBalances = join(w.state, "nullsink-proxy", "balances.db");
  const migratedPending = join(w.state, "nullsink-payments", "pending.db");
  expect(new Database(migratedBalances, { readonly: true }).query("SELECT balance FROM tokens").get()).toEqual({ balance: 123456 });
  expect(new Database(migratedPending, { readonly: true }).query("SELECT COUNT(*) AS n FROM credit_outbox").get()).toEqual({ n: 1 });
  expect(statSync(migratedBalances).mode & 0o777).toBe(0o640);
  expect(statSync(migratedPending).mode & 0o777).toBe(0o640);
  expect(existsSync(join(w.state, "nullsink-backup", "backup-20260806T000000Z.tar.age"))).toBe(true);
  expect(existsSync(join(w.etc, "nullsink-service-isolation.prepared"))).toBe(true);

  const second = Bun.spawnSync(["bash", MIGRATION, "--prepare"], {
    env: migrationEnv(w),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(second.exitCode, second.stderr.toString()).toBe(0);
  expect(second.stdout.toString()).toContain("already prepared");

  Bun.spawnSync([join(w.bin, "systemctl"), "start", "nullsink-proxy", "nullsink-payments"], {
    env: migrationEnv(w),
  });
  const finalized = Bun.spawnSync(["bash", MIGRATION, "--finalize"], {
    env: migrationEnv(w),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(finalized.exitCode, finalized.stderr.toString()).toBe(0);
  expect(existsSync(join(w.etc, "nullsink-service-isolation.finalized"))).toBe(true);
  expect(statSync(join(w.etc, "nullsink.env")).mode & 0o777).toBe(0o600);
  expect(statSync(join(w.legacy, "balances.db")).mode & 0o777).toBe(0o600);
});

test("service-isolation migration refuses active financial state and restarts the legacy units", () => {
  const w = workspace();
  seedQuietState(w.legacy, true);
  writeFileSync(join(w.etc, "nullsink.env"), "ANTHROPIC_API_KEY=provider-secret\n");
  const walletState = join(w.state, "nullsink-wallet");
  const tinfoilState = join(w.state, "tinfoil-proxy");
  mkdirSync(walletState);
  mkdirSync(tinfoilState);
  chmodSync(walletState, 0o755);
  chmodSync(tinfoilState, 0o755);
  const moneroEnv = join(w.etc, "monero-wallet-rpc.env");
  writeFileSync(moneroEnv, "MONERO_NODE=node.test:18081\n");
  chmodSync(moneroEnv, 0o644);

  const result = Bun.spawnSync(["bash", MIGRATION, "--prepare"], {
    env: migrationEnv(w),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("quiet gate holds=1");
  expect(output).toContain("migration refused");
  expect(existsSync(join(w.etc, "nullsink-service-isolation.prepared"))).toBe(false);
  expect(existsSync(join(w.state, "nullsink-proxy", "balances.db"))).toBe(false);
  for (const unit of ["nullsink-proxy", "nullsink-payments", "backup.timer", "status-check.timer"]) {
    expect(existsSync(join(w.systemdState, `${unit}.stopped`))).toBe(false);
  }
  expect(statSync(walletState).mode & 0o777).toBe(0o755);
  expect(statSync(tinfoilState).mode & 0o777).toBe(0o755);
  expect(statSync(moneroEnv).mode & 0o777).toBe(0o644);
});

test("service-isolation migration fails closed on an unclassified legacy setting", () => {
  const w = workspace();
  writeFileSync(
    join(w.etc, "nullsink.env"),
    "ANTHROPIC_API_KEY=provider-secret\nFUTURE_UNCLASSIFIED_SECRET=must-not-guess\n",
  );
  const result = Bun.spawnSync(["bash", MIGRATION, "--prepare"], {
    env: migrationEnv(w),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("unknown setting 'FUTURE_UNCLASSIFIED_SECRET'");
  expect(output).not.toContain("provider-secret");
  expect(existsSync(join(w.etc, "nullsink-proxy.env"))).toBe(false);
  expect(existsSync(join(w.etc, "nullsink-service-isolation.prepared"))).toBe(false);
});

test("Bitcoin label export is payments-owned data and remains best-effort", () => {
  const root = mkdtempSync(join(tmpdir(), "nullsink-label-export-test-"));
  workdirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const labels = join(root, "bitcoin-wallet-labels.json");
  const curlArgs = join(root, "curl.args");
  const curlStdin = join(root, "curl.stdin");
  executable(
    join(bin, "curl"),
    `#!/bin/sh
printf '%s\n' "$@" > "$FAKE_CURL_ARGS"
cat > "$FAKE_CURL_STDIN"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then out="$2"; shift 2; else shift; fi
done
printf '%s' "$FAKE_CURL_BODY" > "$out"
exit "\${FAKE_CURL_EXIT:-0}"
`,
  );
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    BITCOIN_LABELS_PATH: labels,
    PAY_RAILS: "bitcoin,monero",
    BITCOIN_RPC_URL: "http://node.test/wallet/nullsink",
    BITCOIN_RPC_USER: "rpc-user",
    BITCOIN_RPC_PASSWORD: "rpc-secret",
    FAKE_CURL_ARGS: curlArgs,
    FAKE_CURL_STDIN: curlStdin,
  };

  const body = '{"result":[{"address":"bc1qtest","label":"order:7"}],"error":null,"id":"backup"}';
  const success = Bun.spawnSync(["bash", LABEL_EXPORT], {
    env: { ...baseEnv, FAKE_CURL_BODY: body },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(success.exitCode, success.stderr.toString()).toBe(0);
  expect(readFileSync(labels, "utf8")).toBe(body);
  expect(statSync(labels).mode & 0o777).toBe(0o640);
  expect(readFileSync(curlArgs, "utf8")).not.toContain("rpc-secret");
  expect(readFileSync(curlArgs, "utf8")).not.toContain("rpc-user");
  expect(readFileSync(curlArgs, "utf8")).toContain("--config\n-\n");
  expect(readFileSync(curlStdin, "utf8")).toBe(
    'user = "rpc-user:rpc-secret"\n',
  );

  const invalid = Bun.spawnSync(["bash", LABEL_EXPORT], {
    env: { ...baseEnv, FAKE_CURL_BODY: '{"result":null,"error":{"code":-18}}' },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(invalid.exitCode).toBe(0);
  expect(invalid.stderr.toString()).toContain("money-DB backup continues without labels");
  expect(existsSync(labels)).toBe(false);

  writeFileSync(labels, "stale");
  const disabled = Bun.spawnSync(["bash", LABEL_EXPORT], {
    env: { ...baseEnv, PAY_RAILS: "monero", FAKE_CURL_BODY: body },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(disabled.exitCode).toBe(0);
  expect(existsSync(labels)).toBe(false);
});
