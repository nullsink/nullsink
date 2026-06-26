// Unit tests for resolveProvider — the per-path, by-model provider resolution (native id first, then the
// `provider/model` prefix). Pure, so every branch is pinned directly with stub providers, including the
// native-first ordering (the headline of the fix) and the ambiguity guard that's unreachable through the
// real price table.
import { test, expect } from "bun:test";
import { resolveProvider, type Provider } from "../src/providers";

// resolveProvider touches only .id and .ownsModel.
const stub = (id: string, owns: (m: string) => boolean): Provider => ({ id, ownsModel: owns }) as unknown as Provider;

const openai = stub("openai", (m) => m.startsWith("gpt-") || m.startsWith("o1") || m === "gpt-5");
const tinfoil = stub("tinfoil", (m) => m === "deepseek-v4-pro" || m === "openai/gpt-oss-120b");
const KNOWN = new Set(["anthropic", "openai", "tinfoil"]);

function expectOk(r: ReturnType<typeof resolveProvider>, provider: Provider, model: string, prefixed: boolean) {
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.provider).toBe(provider);
  expect(r.model).toBe(model);
  expect(r.prefixed).toBe(prefixed);
}

test("a bare id routes to its unique owner, unprefixed", () => {
  expectOk(resolveProvider([openai, tinfoil], "deepseek-v4-pro", KNOWN), tinfoil, "deepseek-v4-pro", false);
  expectOk(resolveProvider([openai, tinfoil], "gpt-5", KNOWN), openai, "gpt-5", false);
});

test("native id wins over prefix parsing: an `openai/…` id OWNED by Tinfoil routes to Tinfoil, unstripped", () => {
  // The native-first headline. Prefix-first would strip `openai/` → `gpt-oss-120b` → OpenAI; native-first
  // keeps the verbatim id and routes to its real owner.
  expectOk(resolveProvider([openai, tinfoil], "openai/gpt-oss-120b", KNOWN), tinfoil, "openai/gpt-oss-120b", false);
});

test("a `provider/model` prefix routes + strips when no provider owns the verbatim id", () => {
  expectOk(resolveProvider([openai, tinfoil], "tinfoil/deepseek-v4-pro", KNOWN), tinfoil, "deepseek-v4-pro", true);
});

test("a prefix naming an unknown provider (or a leading slash) → unsupported_model", () => {
  expect(resolveProvider([openai, tinfoil], "foo/bar", KNOWN)).toEqual({ ok: false, error: "unsupported_model" });
  expect(resolveProvider([openai, tinfoil], "/leading", KNOWN)).toEqual({ ok: false, error: "unsupported_model" });
});

test("a prefix naming a provider not on this path → unsupported_model", () => {
  expect(resolveProvider([openai, tinfoil], "anthropic/claude-opus-4-8", KNOWN)).toEqual({ ok: false, error: "unsupported_model" });
});

test("a prefix whose provider doesn't own the bare model → unsupported_model", () => {
  expect(resolveProvider([openai, tinfoil], "tinfoil/gpt-5", KNOWN)).toEqual({ ok: false, error: "unsupported_model" });
  expect(resolveProvider([openai, tinfoil], "openai/deepseek-v4-pro", KNOWN)).toEqual({ ok: false, error: "unsupported_model" });
});

test("two verbatim owners → ambiguous_model (the guard for a future (provider,id) overlap)", () => {
  const a = stub("a", (m) => m === "shared");
  const b = stub("b", (m) => m === "shared");
  expect(resolveProvider([a, b], "shared", new Set(["a", "b"]))).toEqual({ ok: false, error: "ambiguous_model" });
});

test("an unknown bare id with no prefix → unsupported_model", () => {
  expect(resolveProvider([openai, tinfoil], "nope", KNOWN)).toEqual({ ok: false, error: "unsupported_model" });
});
