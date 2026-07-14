import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const flagsScript = fileURLToPath(new URL("../../.github/scripts/release-create-flags.sh", import.meta.url));
const releaseWorkflow = fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url));
const releaseConfig = fileURLToPath(new URL("../../release-please-config.json", import.meta.url));

function releaseFlags(tag: string) {
  return Bun.spawnSync(["bash", flagsScript, tag], { stdout: "pipe", stderr: "pipe" });
}

describe("manual GitHub Release fallback", () => {
  test.each(["v1.8.3", "v0.1.0", "v2.0.0+build.7"])("keeps stable tag behavior for %s", (tag) => {
    const result = releaseFlags(tag);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  test.each(["v1.8.3-rc.1", "v2.0.0-beta", "v2.0.0-beta.2+build.7"])(
    "marks %s as a non-Latest prerelease",
    (tag) => {
      const result = releaseFlags(tag);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("--prerelease\n--latest=false\n");
    },
  );

  test.each(["", "1.8.3", "v1.8", "v01.2.3", "v1.2.3-", "v1.2.3-01"])("rejects invalid tag %p", (tag) => {
    const result = releaseFlags(tag);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("release-create-flags:");
  });

  test("feeds the helper's output to gh release create as a shell array", () => {
    const workflow = readFileSync(releaseWorkflow, "utf8");
    expect(workflow).toContain('release_flags_output="$(bash .github/scripts/release-create-flags.sh "$TAG")"');
    expect(workflow).toMatch(/gh release create "\$TAG" --title "\$TAG" \\\n\s+"\$\{release_flags\[@\]\}" \\/);
  });
});

test("release-please publishes dependency and chore entries under Maintenance", () => {
  const config = JSON.parse(readFileSync(releaseConfig, "utf8"));
  const deps = config["changelog-sections"].find((entry: { type: string }) => entry.type === "deps");
  const chore = config["changelog-sections"].find((entry: { type: string }) => entry.type === "chore");
  expect(deps).toEqual({ type: "deps", section: "Maintenance" });
  expect(chore).toEqual({ type: "chore", section: "Maintenance" });
});
