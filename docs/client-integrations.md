# Connect an API client

Start with a funded `0sink_…` token. If you do not have one, follow
[Make your first request](getting-started.md). Copy a current model id from the
[live catalog](https://nullsink.is/models/); the ids below are examples.

Anthropic clients take `https://nullsink.is` as their base URL because they append `/v1/messages`.
OpenAI-compatible clients take `https://nullsink.is/v1` because they append `/chat/completions` or
`/responses`.

## How do I connect Claude Code?

```sh
export ANTHROPIC_BASE_URL=https://nullsink.is
export ANTHROPIC_AUTH_TOKEN=0sink_YOUR_KEY
export ANTHROPIC_MODEL=claude-opus-4-8
claude
```

`ANTHROPIC_AUTH_TOKEN` is Claude Code's gateway credential and is sent as bearer authentication, which
nullsink accepts. See Anthropic's [LLM gateway configuration](https://docs.anthropic.com/en/docs/claude-code/llm-gateway).

## How do I connect Hermes?

Choose **Custom endpoint** in `hermes model`, using the values below, then start a chat.

```text
base url   https://nullsink.is/v1
api key    0sink_YOUR_KEY
model      gpt-5.5
```

```sh
hermes chat -q "hello"
```

See the [Hermes provider guide](https://hermes-agent.nousresearch.com/docs/integrations/providers/)
for the surrounding client workflow.

## How do I connect OpenClaw?

Override the two built-in provider endpoints in `~/.openclaw/openclaw.json`. Because these entries do not
replace the built-in model lists, OpenClaw retains its current model metadata.

OpenAI-compatible models:

```json5
{
  models: {
    providers: {
      openai: {
        baseUrl: "https://nullsink.is/v1",
        apiKey: "0sink_YOUR_KEY",
      },
    },
  },
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
}
```

Claude models:

```json5
{
  models: {
    providers: {
      anthropic: {
        baseUrl: "https://nullsink.is",
        apiKey: "0sink_YOUR_KEY",
      },
    },
  },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
}
```

OpenClaw may list built-in provider models that the current nullsink instance does not serve. Choose an id
present in nullsink's live catalog. See the
[OpenClaw provider guide](https://docs.openclaw.ai/concepts/model-providers#providers-via-modelsproviders-custombase-url).

## How do I connect Pi?

Override Pi's built-in OpenAI and Anthropic endpoints in `~/.pi/agent/models.json`. Omitting `models` keeps
Pi's maintained model definitions instead of copying context, cost, and output-limit metadata that will go
stale.

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://nullsink.is/v1",
      "apiKey": "0sink_YOUR_KEY"
    },
    "anthropic": {
      "baseUrl": "https://nullsink.is",
      "apiKey": "0sink_YOUR_KEY"
    }
  }
}
```

Pi may list built-in provider models that nullsink does not serve. Choose an id present in nullsink's live
catalog. See the [Pi custom-provider guide](https://pi.dev/docs/latest/custom-provider).

## How do I connect Open WebUI?

Open WebUI needs an OpenAI connection for OpenAI and open-weight models, plus a pipe function for Claude.
Follow [Connect Open WebUI](openwebui.md) for both parts.

## Why does a connected client reject a request?

Confirm all three details before changing the API request:

| Check | Required value |
| --- | --- |
| Anthropic-format base URL | `https://nullsink.is` |
| OpenAI-format base URL | `https://nullsink.is/v1` |
| Model selection | An id present in nullsink's live catalog |

A wrong base URL commonly produces a doubled path such as `/v1/v1/messages`. For API-level failures,
use the [model-request error table](getting-started.md#what-does-a-rejected-model-request-mean).
