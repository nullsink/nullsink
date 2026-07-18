# nullsink

An anonymous, account-less metered reverse proxy for Anthropic and OpenAI, paid in
Monero or Bitcoin. Mint a bearer key in your browser,
fund it on-chain, and call it from the official Anthropic/OpenAI SDKs by overriding the
base URL. No account, no IP, no request logs.

Two Bun + TypeScript workspaces:

| Package | What it is |
| --- | --- |
| [`core/`](core/) | The metered proxy, payment rails, the `nsk` operator CLI, the box deploy machinery, and the billing ledger. Zero runtime dependencies. |
| [`client/`](client/) | The purchase UI (Vite + React), served at the edge as static files. |

## Start here

[Make your first request](docs/getting-started.md) covers creating and funding a token, checking its
balance, choosing a live model, making a runnable request, and fixing common errors.

For lookup rather than a walkthrough, use the live [API reference](https://nullsink.is/api/) and
[model catalog](https://nullsink.is/models/).

## Client integrations

These examples assume you already have a funded token. The base URLs and authentication rules are
explained once in the [getting-started guide](docs/getting-started.md#which-base-url-should-an-sdk-use).

### Claude Code

```sh
export ANTHROPIC_BASE_URL=https://nullsink.is       # root; the CLI appends /v1/messages
export ANTHROPIC_AUTH_TOKEN=0sink_YOUR_KEY          # AUTH_TOKEN, not API_KEY — a logged-in subscription shadows API_KEY
export ANTHROPIC_MODEL=claude-opus-4-8
claude
```

### Hermes agent

OpenAI-compatible custom endpoint ([Hermes docs](https://hermes-agent.nousresearch.com/docs/integrations/providers#general-setup)):

```sh
hermes model              # choose "Custom endpoint"
#   base url   https://nullsink.is/v1
#   api key    0sink_YOUR_KEY
#   model      gpt-5.5
hermes chat -q "hello"
```

### OpenClaw

OpenClaw ([docs](https://docs.openclaw.ai/concepts/model-providers#providers-via-modelsproviders-custombase-url)) speaks both formats — add one provider per format in `~/.openclaw/openclaw.json`.

OpenAI-compatible (OpenAI + open-weight):

```json5
{
  models: {
    providers: {
      nullsink: {
        baseUrl: "https://nullsink.is/v1",
        apiKey: "0sink_YOUR_KEY",
        api: "openai-completions",
        models: [{ id: "gpt-5.5", name: "gpt-5.5", reasoning: true }],
      },
    },
  },
  agents: { defaults: { model: { primary: "nullsink/gpt-5.5" } } },
}
```

Anthropic (Claude):

```json5
{
  models: {
    providers: {
      "nullsink-claude": {
        baseUrl: "https://nullsink.is",              // root — the client appends /v1/messages
        apiKey: "0sink_YOUR_KEY",
        api: "anthropic-messages",
        models: [
          {
            id: "claude-opus-4-8",
            name: "claude-opus-4-8",
            reasoning: true,
            thinkingLevelMap: { xhigh: "max" },
            compat: { forceAdaptiveThinking: true }, // REQUIRED for a custom Claude reasoning provider
          },
        ],
      },
    },
  },
  agents: { defaults: { model: { primary: "nullsink-claude/claude-opus-4-8" } } },
}
```

### Pi

Pi ([docs](https://pi.dev/docs/latest/custom-provider)) — the same two providers in `~/.pi/agent/models.json`.

OpenAI-compatible:

```json
{
  "providers": {
    "nullsink": {
      "baseUrl": "https://nullsink.is/v1",
      "api": "openai-completions",
      "apiKey": "0sink_YOUR_KEY",
      "models": [{ "id": "gpt-5.5", "reasoning": true }]
    }
  }
}
```

Anthropic (Claude):

```json
{
  "providers": {
    "nullsink-claude": {
      "baseUrl": "https://nullsink.is",
      "api": "anthropic-messages",
      "apiKey": "0sink_YOUR_KEY",
      "models": [
        {
          "id": "claude-opus-4-8",
          "name": "claude-opus-4-8",
          "reasoning": true,
          "thinkingLevelMap": { "xhigh": "max" },
          "compat": { "forceAdaptiveThinking": true }
        }
      ]
    }
  }
}
```

### Open WebUI

[Open WebUI](https://github.com/open-webui/open-webui) reaches gpt-5.5 and the open-weight models through an OpenAI connection — ⚙️ **Admin Settings → Connections → OpenAI → ＋ Add Connection** (URL `https://nullsink.is/v1`, key `0sink_YOUR_KEY`), or by env:

```sh
ENABLE_OPENAI_API=true
OPENAI_API_BASE_URLS=https://nullsink.is/v1
OPENAI_API_KEYS=0sink_YOUR_KEY
```

Claude rides a bundled pipe function. Full walkthrough — connection, pipe install, model-picker cleanup, troubleshooting: **[docs/openwebui.md](docs/openwebui.md)**.

### Gotchas

- A **reasoning** model needs `reasoning: true` on its entry, or the client treats it as non-reasoning and the thinking controls never appear.
- A **custom Claude** reasoning provider must set `compat.forceAdaptiveThinking: true`, or Opus 4.8 rejects the request with `thinking.type 'enabled' is not supported`. Built-in Claude models set this automatically; a custom nullsink provider does not.
- Anthropic-format base URL is the **root** (`https://nullsink.is`); OpenAI-format is `https://nullsink.is/v1`. Getting this wrong doubles the path (`/v1/v1/messages`).

## Docs

- [docs/getting-started.md](docs/getting-started.md) — fund a token and make the first model request
- [docs/architecture.md](docs/architecture.md) — how the pieces fit together
- [docs/trust-model.md](docs/trust-model.md) — the privacy and money-safety guarantees (and what's *not* covered)
- [docs/billing-model.md](docs/billing-model.md) — pricing, holds, settlement, no-overdraft
- [docs/invariants.md](docs/invariants.md) — review gates for money, credit delivery, and recovery

## Develop

Requires [Bun](https://bun.sh) 1.3.14 (the version CI builds and tests with).

```sh
bun install        # one hoisted node_modules + one root bun.lock for both packages

bun run dev        # run the client (vite); core watchers are per-process: cd core && bun run dev:proxy / dev:payments
bun run typecheck  # tsc across both packages
bun run test       # bun test across both packages
bun run lint       # shellcheck deploy scripts + validate/fmt the Caddyfile (needs shellcheck + caddy)
bun run build      # core service binaries (proxy + payments) + client static bundle
bun run build:nsk  # the nsk operator-CLI binary
```

Target one package with `bun --filter`, e.g. `bun --filter './client' dev`. To preview just the
purchase UI with no backend, run `bun --filter './client' dev:mock`.

Install the pre-push hook so the checks CI runs happen locally first:

```sh
git config core.hooksPath .githooks
```

## Deploy

Boxes run only verified release artifacts — no source, no Bun on the box. A git tag
(`vX.Y.Z`) triggers `.github/workflows/release.yml`, which builds the self-contained linux-x64
artifacts and publishes them as a GitHub Release:

- **`nullsink-proxy-linux-x64`** — the proxy trust domain: the metered `/v1` proxy and the balance ledger.
- **`nullsink-payments-linux-x64`** — the payments trust domain: `/buy`, the pay rails, and the settlement poller.
- **`nsk-linux-x64`** — the operator CLI (`issue` / `topup` / `balance` / `financials`).
- **`deploy-<tag>.tar.gz`** — the `core/deploy/` tree (systemd units, Caddyfile, deploy + backup scripts); the box extracts this instead of cloning source.
- **`nullsink-ui-<tag>.tar.gz`** — the static purchase UI (`client/dist`); Caddy serves it at the edge.
- **`SHA256SUMS`** — checksums over the five artifacts; the box verifies with `sha256sum -c` before installing.

On a box, `core/deploy/deploy.sh <tag>` fetches and checksum-verifies those artifacts,
atomically swaps both binary symlinks in lockstep plus the UI symlink, refreshes the
systemd units and Caddy config, restarts, and health-gates each service's `/healthz` —
rolling the symlinks back to the previous release if either service is unhealthy.
It deliberately does **not** install or upgrade Bitcoin Core, Monero, or `tinfoil-proxy`.
Pinned runtime dependency updates take effect only on a fresh setup or an applicable setup
rerun: `core/deploy/setup.sh` for an app box, and `core/deploy/setup-nodes.sh` for a dedicated
Bitcoin node box. First-time app bootstrap is `core/deploy/setup.sh`.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE) (each package carries a copy). As a hosted
network service, AGPL §13 applies: run a **modified** nullsink for others and you must
offer them your source.

See [TRADEMARK.md](TRADEMARK.md) for the name and marks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
Report security issues privately via [SECURITY.md](SECURITY.md).
