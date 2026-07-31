// Step 3 is intentionally deletion-first: workstation tools may read finalized reports, but no shipped
// operator surface may reopen either live SQLite database or quietly restore the retired nsk artifact.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("local CLI sources have no live ledger-store dependency", () => {
  const cliDir = `${CORE}/cli`;
  const sources = readdirSync(cliDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => [name, readFileSync(`${cliDir}/${name}`, "utf8")] as const);

  for (const [name, source] of sources) {
    const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports.filter((path) => /ledger\/(?:db|orders|sqlite)$|bun:sqlite/.test(path))).toEqual([]);
    expect(`${name}\n${source}`).not.toMatch(/process\.env\.(?:DB_PATH|PENDING_DB_PATH)/);
  }
});

test("release and deployment retire the nsk artifact", () => {
  const release = readFileSync(`${ROOT}/.github/workflows/release.yml`, "utf8");
  const library = readFileSync(`${CORE}/deploy/lib.sh`, "utf8");
  const deploy = readFileSync(`${CORE}/deploy/deploy.sh`, "utf8");
  const setup = readFileSync(`${CORE}/deploy/setup.sh`, "utf8");

  expect(release).not.toContain("nsk-linux-x64");
  expect(library).toContain("/usr/local/bin/nsk");
  expect(library).toContain("retire_legacy_operator_tools");
  expect(deploy).toContain("retire_legacy_operator_tools");
  expect(setup).toContain("retire_legacy_operator_tools");
  expect(existsSync(`${CORE}/cli/index.ts`)).toBe(false);
  expect(existsSync(`${CORE}/deploy/install-nsk.sh`)).toBe(false);
  expect(existsSync(`${CORE}/deploy/node-box-runbook.md`)).toBe(false);
});
