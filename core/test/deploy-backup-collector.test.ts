import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTOR = fileURLToPath(new URL("../deploy/backup-collector/pull.sh", import.meta.url));
const VERIFY = fileURLToPath(new URL("../deploy/backup-collector/verify-store.py", import.meta.url));
const SERVICE = fileURLToPath(
  new URL("../deploy/backup-collector/nullsink-backup-pull.service", import.meta.url),
);
const TIMER = fileURLToPath(
  new URL("../deploy/backup-collector/nullsink-backup-pull.timer", import.meta.url),
);
const SETUP_EXPORT = fileURLToPath(
  new URL("../deploy/backup-collector/setup-export.sh", import.meta.url),
);
const workdirs: string[] = [];

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "nullsink-collector-test-"));
  workdirs.push(root);
  const store = join(root, "store");
  const state = join(root, "state");
  mkdirSync(store);
  mkdirSync(state);
  return { root, store, state };
}

function stamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".000", "");
}

function report(artifact: string, createdAt: string) {
  return {
    schema_version: 1,
    snapshot: {
      created_at: createdAt,
      artifact,
      validation: "restore-dry-run-ok",
    },
    finance: {
      revenue_by_day_asset: [
        {
          date: "2026-07-23",
          asset: "bitcoin",
          sales: 1,
          credited_micros: "8000000",
          gross_micros: "8800487",
        },
      ],
      liability: { outstanding_micros: "3405787" },
    },
    operations: {
      open_orders: { count: 0, credit_micros: "0", payment_seen: 0 },
      undelivered_credits: { count: 0, micros: "0", oldest_age_seconds: null },
    },
  };
}

function pair(store: string, epochSeconds: number, mutate?: (value: any) => void) {
  const pairStamp = stamp(epochSeconds);
  const artifact = `backup-${pairStamp}.tar.age`;
  const reportName = `report-${pairStamp}.json`;
  const value = report(artifact, new Date(epochSeconds * 1000).toISOString().replace(".000", ""));
  mutate?.(value);
  writeFileSync(join(store, artifact), "age-encrypted-bytes");
  writeFileSync(join(store, reportName), JSON.stringify(value));
  return { artifact, reportName };
}

function verify(store: string, state: string, now: number, maxAgeHours = 6, retentionDays = 90) {
  return Bun.spawnSync({
    cmd: [
      "python3",
      VERIFY,
      "--store",
      store,
      "--state-dir",
      state,
      "--max-age-hours",
      String(maxAgeHours),
      "--retention-days",
      String(retentionDays),
      "--now-epoch",
      String(now),
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("collector validates the strict report pair, prunes expired pairs, and records freshness", () => {
  const w = workspace();
  const now = Math.floor(Date.now() / 1000);
  const latest = pair(w.store, now - 60);
  const old = pair(w.store, now - 100 * 86400);

  const result = verify(w.store, w.state, now);
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  expect(output).toContain(`latest=${latest.artifact}`);
  expect(Bun.file(join(w.store, old.artifact)).size).toBe(0);
  expect(Bun.file(join(w.store, old.reportName)).size).toBe(0);

  const marker = JSON.parse(readFileSync(join(w.state, "last-success.json"), "utf8"));
  expect(marker.schema_version).toBe(1);
  expect(marker.latest_artifact).toBe(latest.artifact);
  expect(marker.age_seconds).toBe(60);
  expect(JSON.stringify(marker)).not.toContain("8000000");
});

test("collector rejects an expanded report schema and leaves success unrecorded", () => {
  const w = workspace();
  const now = Math.floor(Date.now() / 1000);
  pair(w.store, now - 60, (value) => {
    value.finance.token_hash = "private-link";
  });

  const result = verify(w.store, w.state, now);
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).toBe(1);
  expect(output).toContain("report.finance keys must be exactly");
  expect(Bun.file(join(w.state, "last-success.json")).size).toBe(0);
});

test("collector rejects a stale newest artifact", () => {
  const w = workspace();
  const now = Math.floor(Date.now() / 1000);
  pair(w.store, now - 7 * 3600);

  const result = verify(w.store, w.state, now);
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).toBe(1);
  expect(output).toContain("newest snapshot is stale");
});

test("pull path requests only encrypted artifacts and aggregate reports", () => {
  const w = workspace();
  const now = Math.floor(Date.now() / 1000);
  const fixture = join(w.root, "fixture");
  const bin = join(w.root, "bin");
  const argsFile = join(w.root, "rsync-args");
  const key = join(w.root, "id_ed25519");
  const knownHosts = join(w.root, "known_hosts");
  mkdirSync(fixture);
  mkdirSync(bin);
  pair(fixture, now - 60);
  writeFileSync(key, "test-key");
  writeFileSync(knownHosts, "production.example ssh-ed25519 AAAAtest");

  const fakeRsync = join(bin, "rsync");
  writeFileSync(
    fakeRsync,
    `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_RSYNC_ARGS"
for last do :; done
cp "$FAKE_RSYNC_FIXTURE"/backup-*.tar.age "$last"
cp "$FAKE_RSYNC_FIXTURE"/report-*.json "$last"
`,
  );
  chmodSync(fakeRsync, 0o755);

  const result = Bun.spawnSync({
    cmd: ["bash", COLLECTOR],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BACKUP_SOURCE: "nullsink-backup-export@production.example:/",
      BACKUP_STORE: w.store,
      BACKUP_STATE_DIR: w.state,
      BACKUP_SSH_KEY: key,
      BACKUP_KNOWN_HOSTS: knownHosts,
      BACKUP_MAX_AGE_HOURS: "6",
      BACKUP_RETENTION_DAYS: "90",
      FAKE_RSYNC_ARGS: argsFile,
      FAKE_RSYNC_FIXTURE: fixture,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  const args = readFileSync(argsFile, "utf8").split("\n");
  expect(args).toContain("--include=/backup-*.tar.age");
  expect(args).toContain("--include=/report-*.json");
  expect(args).toContain("--exclude=*");
  expect(args).not.toContain("--delete");
});

test("collector systemd contract is pull-only, hardened, and hourly", () => {
  const service = readFileSync(SERVICE, "utf8");
  const timer = readFileSync(TIMER, "utf8");
  const exportSetup = readFileSync(SETUP_EXPORT, "utf8");
  expect(service).toContain("User=nullsink-backup");
  expect(service).toContain("ProtectSystem=strict");
  expect(service).toContain("ReadWritePaths=/srv/nullsink-backups");
  expect(service).not.toContain("age.key");
  expect(timer).toContain("OnCalendar=hourly");
  expect(timer).toContain("Persistent=true");
  expect(exportSetup).toContain('restrict,command="%s -ro %s"');
  expect(exportSetup).toContain("BACKUP_AGE_RECIPIENT must be set");
});
