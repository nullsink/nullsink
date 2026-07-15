// End-to-end capture + validation against the REAL upstreams. Operator-run (needs real keys; spends a few
// cents). Routes each shape THROUGH createHandler with the real upstream fetch + an in-memory balance, so it
// exercises the whole path — the gate, our store:false / include_usage body mutations being ACCEPTED by the
// live API, the forward, parsing the REAL usage, and the actual billing debit — then saves the
// passed-through response bytes as a golden fixture for the offline replay test (test/fixtures.replay.test.ts).
//
// Run (set whichever keys you have; any provider can run alone):
//   ANTHROPIC_API_KEY=sk-ant-… OPENAI_API_KEY=sk-… TINFOIL_API_KEY=tk_… bun run scripts/e2e-capture.ts
// Then review + commit test/fixtures/*.json — the replay test then guards the parsers offline forever.
// Tinfoil joins the live --check canary + the disconnect check but writes NO committed fixture: it reuses the
// OpenAI-chat parser/scanner the openai fixtures already guard offline, so a fixture would add maintenance,
// not signal. Its live value is drift (does the Tinfoil API still return parseable usage → debit > 0).
//
// `--check` mode: same live calls + the SAME "a real 200 we couldn't bill" assertion (debit>0), but writes
// NO fixtures and runs no commit step — so it's safe to run on a schedule (cron / systemd timer) as a live
// USAGE-DRIFT CANARY. It catches the one residual cause of a content-for-free refund (refundedInFull) that
// no offline test can: the upstream renaming/moving a usage field so our parser reads nothing on a real
// 2xx. Exits non-zero on the first such shape, BEFORE that drift silently bills prod $0.
//   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… TINFOIL_API_KEY=… bun run scripts/e2e-capture.ts --check
//
// Spend: each shape uses a cheap model + a small output cap + a trivial prompt, so well under $0.01 each
// (reasoning shapes cap higher for headroom). Exits non-zero if any shape fails its checks.

import type { HandlerDeps, RailView } from "../test/support/handler-combined"; // type-only: erased at runtime, evaluates no module
import { mkdirSync, writeFileSync } from "node:fs";

// Neutralise the import-time prod DB singletons (db.ts/orders.ts open at import) BEFORE importing src — set
// :memory: then dynamic-import the runtime modules, so this never touches a real store regardless of the
// ambient DB_PATH (a dev shell often exports the prod path).
process.env.DB_PATH = ":memory:";
process.env.PENDING_DB_PATH = ":memory:";
const { createHandler } = await import("../test/support/handler-combined");
const { byteBoundHold } = await import("../src/hold");
const { openDb, hashToken } = await import("../src/ledger/db");
const { openOrderStore } = await import("../src/ledger/orders");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TINFOIL_API_KEY = process.env.TINFOIL_API_KEY;
const TINFOIL_BASE_URL = process.env.TINFOIL_BASE_URL ?? "https://inference.tinfoil.sh";
if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY && !TINFOIL_API_KEY) {
  console.error("set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or TINFOIL_API_KEY");
  process.exit(1);
}

// --check: live drift canary — make the calls + assert, but write no fixtures and skip the commit step.
const CHECK = process.argv.includes("--check");
const TOKEN = "0sink_e2e_capture"; // in-memory only, never persisted
const balances = openDb(":memory:");
balances.credit(hashToken(TOKEN), 1_000_000_000); // $1000 of headroom

const deps: HandlerDeps = {
  // byte bound → no extra count_tokens call per shape (cheaper, still sound)
  anthropic: { apiKey: ANTHROPIC_API_KEY ?? "absent", baseUrl: "https://api.anthropic.com", version: process.env.ANTHROPIC_VERSION ?? "2023-06-01", estimateHold: byteBoundHold },
  openai: OPENAI_API_KEY ? { apiKey: OPENAI_API_KEY, baseUrl: "https://api.openai.com", estimateHold: byteBoundHold } : undefined,
  tinfoil: TINFOIL_API_KEY ? { apiKey: TINFOIL_API_KEY, baseUrl: TINFOIL_BASE_URL, estimateHold: byteBoundHold } : undefined,
  upstreamTimeoutMs: 120_000,
  margin: 1.125,
  buyMinUsd: 5,
  buyMaxUsd: 2000,
  orderTtlMs: 14_400_000,
  orderTrackingMs: 16_200_000,
  maxOpenOrders: 1000,
  maxBuyBodyBytes: 4096,
  maxMessagesBodyBytes: 33_554_432,
  balances,
  orders: openOrderStore(":memory:"),
  upstreamFetch: fetch,
  rails: new Map<string, RailView>([
    ["monero", { name: "monero", createAddress: async () => ({ address: "x", orderIndex: 0 }), rateUsd: async () => 150, scale: 1_000_000_000_000, unit: "XMR", confirmations: 10, paymentUri: (a: string, amt: string) => `monero:${a}?tx_amount=${amt}` }],
  ]),
  defaultRail: "monero",
};
const handler = createHandler(deps);

type Shape = {
  name: string;
  provider: "anthropic" | "openai" | "tinfoil";
  endpoint: string;
  auth: "x-api-key" | "bearer";
  stream: boolean;
  body: any;
  expectReasoning?: boolean;
  noFixture?: boolean; // run live + assert, but don't persist bytes (tinfoil reuses the openai-chat parser)
};

// A prefix over the 4096-token min cacheable size (haiku/opus), so a cache_control write actually caches —
// used by the 1-hour-TTL capture below. Deterministic so a re-run hits the same bytes.
const CACHE_PREFIX = Array.from({ length: 260 }, (_, i) => `Reference clause ${i}: the quick brown fox jumps over the lazy dog near the riverbank at dawn.`).join("\n");

const shapes: Shape[] = [];
if (ANTHROPIC_API_KEY) {
  shapes.push(
    { name: "anthropic-messages-buffered", provider: "anthropic", endpoint: "/v1/messages", auth: "x-api-key", stream: false,
      body: { model: "claude-haiku-4-5", max_tokens: 128, messages: [{ role: "user", content: "Reply with one short sentence." }] } },
    { name: "anthropic-messages-stream", provider: "anthropic", endpoint: "/v1/messages", auth: "x-api-key", stream: true,
      body: { model: "claude-haiku-4-5", max_tokens: 128, stream: true, messages: [{ role: "user", content: "Count to five." }] } },
    // Truncation: a tiny output cap on a long-answer prompt → stop_reason:max_tokens, usage PRESENT → must
    // bill the (small) actual, NOT refund. The "completed-but-truncated carries usage" path.
    { name: "anthropic-messages-truncated", provider: "anthropic", endpoint: "/v1/messages", auth: "x-api-key", stream: false,
      body: { model: "claude-haiku-4-5", max_tokens: 16, messages: [{ role: "user", content: "Write a long, detailed multi-paragraph essay about the ocean." }] } },
    // Prompt-cache 1-HOUR TTL write: a >4096-tok system block with cache_control ttl:"1h" → the response
    // reports cache_creation.ephemeral_1h_input_tokens, which the proxy bills at 2× input. Captures real
    // bytes so the replay cross-check validates the 1h split (it reads ephemeral_1h_input_tokens itself).
    { name: "anthropic-messages-cache-1h", provider: "anthropic", endpoint: "/v1/messages", auth: "x-api-key", stream: false,
      body: { model: "claude-haiku-4-5", max_tokens: 16, system: [{ type: "text", text: CACHE_PREFIX, cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "Reply ok." }] } },
  );
}
if (OPENAI_API_KEY) {
  shapes.push(
    { name: "openai-chat-buffered", provider: "openai", endpoint: "/v1/chat/completions", auth: "bearer", stream: false,
      body: { model: "gpt-4o-mini", max_completion_tokens: 128, messages: [{ role: "user", content: "Reply with one short sentence." }] } },
    { name: "openai-chat-stream", provider: "openai", endpoint: "/v1/chat/completions", auth: "bearer", stream: true,
      body: { model: "gpt-4o-mini", max_completion_tokens: 128, stream: true, messages: [{ role: "user", content: "Count to five." }] } },
    { name: "openai-chat-reasoning", provider: "openai", endpoint: "/v1/chat/completions", auth: "bearer", stream: false, expectReasoning: true,
      body: { model: "o4-mini", max_completion_tokens: 2000, messages: [{ role: "user", content: "What is 17*23? Think briefly, then give the number." }] } },
    { name: "openai-chat-tool", provider: "openai", endpoint: "/v1/chat/completions", auth: "bearer", stream: false,
      body: { model: "gpt-4o-mini", max_completion_tokens: 128, tools: [{ type: "function", function: { name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }], messages: [{ role: "user", content: "What's the weather in Paris? Call the tool." }] } },
    { name: "openai-responses-buffered", provider: "openai", endpoint: "/v1/responses", auth: "bearer", stream: false,
      body: { model: "gpt-4o-mini", max_output_tokens: 128, input: "Reply with one short sentence." } },
    { name: "openai-responses-stream", provider: "openai", endpoint: "/v1/responses", auth: "bearer", stream: true,
      body: { model: "gpt-4o-mini", max_output_tokens: 128, stream: true, input: "Count to five." } },
    { name: "openai-responses-reasoning", provider: "openai", endpoint: "/v1/responses", auth: "bearer", stream: false, expectReasoning: true,
      body: { model: "o4-mini", max_output_tokens: 2000, input: "What is 17*23? Think briefly, then give the number." } },
    // Truncation: a tiny output cap on a long-answer prompt. chat → finish_reason:"length"; responses →
    // status:"incomplete". Both carry usage → must bill the actual, NOT refund.
    { name: "openai-chat-truncated", provider: "openai", endpoint: "/v1/chat/completions", auth: "bearer", stream: false,
      body: { model: "gpt-4o-mini", max_completion_tokens: 16, messages: [{ role: "user", content: "Write a long, detailed multi-paragraph essay about the ocean." }] } },
    { name: "openai-responses-truncated", provider: "openai", endpoint: "/v1/responses", auth: "bearer", stream: false,
      body: { model: "gpt-4o-mini", max_output_tokens: 16, input: "Write a long, detailed multi-paragraph essay about the ocean." } },
  );
}
if (TINFOIL_API_KEY) {
  // Tinfoil shares /v1/chat/completions with OpenAI; the handler routes a bare tinfoil-owned id (gpt-oss-120b)
  // to Tinfoil. Canary-only (noFixture): the live value is whether Tinfoil still accepts our include_usage
  // forcing + store omission and returns parseable usage → debit > 0. A reasoning shape is omitted here —
  // open-weight reasoning is billed as visible output (no separate reasoning_tokens field to assert), and the
  // visible-reasoning disconnect is exercised below.
  shapes.push(
    { name: "tinfoil-chat-buffered", provider: "tinfoil", endpoint: "/v1/chat/completions", auth: "bearer", stream: false, noFixture: true,
      body: { model: "gpt-oss-120b", max_completion_tokens: 128, messages: [{ role: "user", content: "Reply with one short sentence." }] } },
    { name: "tinfoil-chat-stream", provider: "tinfoil", endpoint: "/v1/chat/completions", auth: "bearer", stream: true, noFixture: true,
      body: { model: "gpt-oss-120b", max_completion_tokens: 128, stream: true, messages: [{ role: "user", content: "Count to five." }] } },
  );
}

const FIXTURE_DIR = new URL("../test/fixtures/", import.meta.url);
if (!CHECK) mkdirSync(FIXTURE_DIR, { recursive: true });

// Pull the upstream's self-reported reasoning-token count out of a raw response, for the expectReasoning check.
function reasoningTokens(raw: string, stream: boolean): number | null {
  try {
    if (!stream) {
      const o = JSON.parse(raw);
      return o?.usage?.completion_tokens_details?.reasoning_tokens ?? o?.usage?.output_tokens_details?.reasoning_tokens ?? null;
    }
    // stream: scan for the last usage object in any data: frame
    let found: number | null = null;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      try {
        const e = JSON.parse(p);
        const u = e?.usage ?? e?.response?.usage;
        const r = u?.completion_tokens_details?.reasoning_tokens ?? u?.output_tokens_details?.reasoning_tokens;
        if (typeof r === "number") found = r;
      } catch {}
    }
    return found;
  } catch {
    return null;
  }
}

let totalDebitMicros = 0;
let failures = 0;
console.log(`\n${CHECK ? `Checking ${shapes.length} shape(s) (live usage-drift canary; no fixtures written)` : `Capturing ${shapes.length} shape(s) → ${FIXTURE_DIR.pathname}`}\n`);

for (const s of shapes) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (s.auth === "x-api-key") headers["x-api-key"] = TOKEN;
  else headers["authorization"] = `Bearer ${TOKEN}`;
  const before = balances.getBalance(hashToken(TOKEN))!;
  let res: Response;
  try {
    res = await handler(new Request("https://proxy.local" + s.endpoint, { method: "POST", headers, body: JSON.stringify(s.body) }));
  } catch (err) {
    console.log(`  ✗ ${s.name}: handler threw — ${err instanceof Error ? err.message : String(err)}`);
    failures++;
    continue;
  }
  // Draining a streamed body to text drives the handler's pull loop to a clean close, which runs the billing
  // settle BEFORE this resolves — so the debit below is final. Buffered billing is synchronous.
  const raw = await res.text();
  const debit = before - balances.getBalance(hashToken(TOKEN))!;
  totalDebitMicros += debit;

  if (res.status !== 200) {
    console.log(`  ✗ ${s.name}: status ${res.status} — ${raw.slice(0, 300)}`);
    failures++;
    continue;
  }
  const checks: string[] = [];
  if (debit <= 0) {
    checks.push("debit was 0 (nothing billed — usage not parsed?)");
  }
  if (s.expectReasoning) {
    const r = reasoningTokens(raw, s.stream);
    if (r == null) checks.push("no reasoning_tokens field in usage");
    else if (r <= 0) checks.push("reasoning_tokens was 0 (not a reasoning response?)");
  }
  if (checks.length) {
    console.log(`  ✗ ${s.name}: ${checks.join("; ")}`);
    failures++;
    // still save it — useful to inspect what came back
  }

  if (!CHECK && !s.noFixture)
    writeFileSync(
      new URL(`${s.name}.json`, FIXTURE_DIR),
      JSON.stringify({ meta: { name: s.name, provider: s.provider, endpoint: s.endpoint, model: s.body.model, stream: s.stream, expectReasoning: !!s.expectReasoning }, raw }, null, 2) + "\n",
    );
  const tag = checks.length ? "✗" : "✓";
  console.log(`  ${tag} ${s.name}: status=200 debit=$${(debit / 1e6).toFixed(6)} bytes=${raw.length}${s.expectReasoning ? ` reasoning=${reasoningTokens(raw, s.stream)}` : ""}`);
}

console.log(`\nTotal spend this run: $${(totalDebitMicros / 1e6).toFixed(4)} across ${shapes.length} shape(s).`);

// --- Live mid-stream DISCONNECT checks (not a fixture — a lifecycle property a frozen capture can't
// prove). Start a real stream, read a couple of chunks, cancel the client side, and assert the partial
// bill is sane: > 0 (the prompt the upstream already ingested is billed via the content-token fallback)
// and <= the up-front hold (the clamp). Synthetic tests stub cancel(); this exercises a REAL upstream. ---
async function disconnectCheck(name: string, endpoint: string, auth: "x-api-key" | "bearer", model: string, body: any): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth === "x-api-key") headers["x-api-key"] = TOKEN;
  else headers["authorization"] = `Bearer ${TOKEN}`;
  const before = balances.getBalance(hashToken(TOKEN))!;
  const res = await handler(new Request("https://proxy.local" + endpoint, { method: "POST", headers, body: JSON.stringify(body) }));
  if (res.status !== 200 || !res.body) {
    console.log(`  ✗ ${name}: status ${res.status} (expected a 200 stream)`);
    failures++;
    return;
  }
  const reader = res.body.getReader();
  await reader.read(); // first SSE chunk
  await reader.read(); // a little content
  await reader.cancel(); // client disconnects mid-stream → handler cancels upstream + settles the partial
  const billed = before - balances.getBalance(hashToken(TOKEN))!;
  const hold = byteBoundHold({ model, raw: JSON.stringify(body), body, maxTokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens }).micros;
  const ok = billed > 0 && billed <= hold;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}: billed=$${(billed / 1e6).toFixed(6)} (0 < billed <= hold=$${(hold / 1e6).toFixed(6)})${billed > hold ? " — OVERDRAFT" : billed <= 0 ? " — nothing billed (input leak)" : ""}`);
}

console.log(`\nLive mid-stream disconnect checks:`);
if (OPENAI_API_KEY) {
  await disconnectCheck("openai-chat disconnect", "/v1/chat/completions", "bearer", "gpt-4o-mini", { model: "gpt-4o-mini", max_completion_tokens: 512, stream: true, messages: [{ role: "user", content: "Write a long detailed essay about the ocean." }] });
  // Reasoning-model disconnect — quantifies the known residual: reasoning tokens burn server-side but
  // aren't streamed as text, so the content estimate can't see them (bounded by the hold; never overdrafts).
  await disconnectCheck("openai-chat reasoning disconnect", "/v1/chat/completions", "bearer", "o4-mini", { model: "o4-mini", max_completion_tokens: 2000, stream: true, messages: [{ role: "user", content: "Think step by step about prime factorizations, then list the primes under 50." }] });
}
if (ANTHROPIC_API_KEY) {
  await disconnectCheck("anthropic disconnect", "/v1/messages", "x-api-key", "claude-haiku-4-5", { model: "claude-haiku-4-5", max_tokens: 512, stream: true, messages: [{ role: "user", content: "Write a long detailed essay about the ocean." }] });
}
if (TINFOIL_API_KEY) {
  // Tinfoil's open-weight reasoning streams as visible text (delta.reasoning), so the partial bill comes from
  // the content estimate — no hidden-reasoning cap, and still clamped to the hold (no overdraft). Bare
  // gpt-oss-120b routes to Tinfoil (it owns the priced id; OpenAI doesn't claim it).
  await disconnectCheck("tinfoil-chat disconnect", "/v1/chat/completions", "bearer", "gpt-oss-120b", { model: "gpt-oss-120b", max_completion_tokens: 512, stream: true, messages: [{ role: "user", content: "Think step by step about prime factorizations, then list the primes under 50." }] });
}

// Final gate: run the offline replay cross-check over the fixtures we just wrote. The per-shape checks
// above (status / debit>0 / reasoning present) are loose — they'd still pass a MAPPING bug (e.g. a cached
// double-count) that bills a nonzero-but-wrong amount. The replay test compares our mapped usage against
// the upstream's OWN reported numbers (read independently), so catching such a bug HERE — before commit —
// is the real bar. Reuses that test rather than duplicating its comparison. The --check canary skips this:
// it writes no fixtures, and CI already runs the replay over the committed ones — its job is the LIVE signal.
let replayOk = true;
if (!CHECK) {
  const repoRoot = new URL("..", import.meta.url).pathname;
  console.log(`\nValidating fixtures with the offline replay cross-check…`);
  const replay = Bun.spawnSync({ cmd: ["bun", "test", "test/fixtures.replay.test.ts"], cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  replayOk = replay.exitCode === 0;
}

if (failures || !replayOk) {
  if (CHECK) {
    // See the per-shape ✗ lines for which kind: a 200 we couldn't bill (debit==0) IS the usage-shape drift
    // this canary exists to catch (the content-for-free path); a non-200 is our key / the upstream, not drift.
    console.log(`\n${failures} live shape check(s) failed (see the ✗ lines above): a 200 we couldn't bill = usage-shape drift — the parser vs the upstream's current response shape; a non-200 = our key or the upstream, not drift. Investigate before this reaches prod.`);
  } else {
    const why = [failures ? `${failures} shape check failure(s)` : "", replayOk ? "" : "replay cross-check failed"].filter(Boolean).join(" + ");
    console.log(`\n${why} — review the output above before committing fixtures.`);
  }
  process.exit(1);
}
console.log(CHECK ? `\nAll shapes billed cleanly — no usage-shape drift on live traffic.` : `\nAll shapes captured + cross-checked. Review and commit test/fixtures/*.json.`);
