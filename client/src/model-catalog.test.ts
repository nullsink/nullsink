import { expect, test } from "bun:test";
import { TINFOIL_IDS } from "./flow/Api.tsx";
import models from "./models.json";

const tinfoil = models.providers.find((provider) => provider.id === "tinfoil");

test("Tinfoil examples stay in the priced catalog", () => {
  expect(tinfoil).toBeDefined();
  expect(TINFOIL_IDS.every((id) => tinfoil?.models.includes(id))).toBe(true);
  expect(TINFOIL_IDS).not.toContain("kimi-k2-6");
});

test("Kimi K3 is shown ahead of GLM 5.2", () => {
  expect(tinfoil).toBeDefined();
  expect(tinfoil!.models.indexOf("kimi-k3")).toBeLessThan(tinfoil!.models.indexOf("glm-5-2"));
});
