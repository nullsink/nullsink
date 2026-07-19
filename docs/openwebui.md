# Open WebUI

Open WebUI needs an OpenAI **connection** for GPT and open-weight models, plus a bundled **pipe
function** for Claude. One `0sink_` token serves both.

## How do I add GPT and open-weight models?

⚙️ **Admin Settings → Connections → OpenAI → ＋ Add Connection** — URL `https://nullsink.is/v1`, API Key `0sink_YOUR_KEY`. Or by env:

```sh
ENABLE_OPENAI_API=true
OPENAI_API_BASE_URLS=https://nullsink.is/v1
OPENAI_API_KEYS=0sink_YOUR_KEY
```

## How do I add Claude models?

Open WebUI connections speak the OpenAI wire format; Claude answers on nullsink's Anthropic path (`/v1/messages`). A [pipe function](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-functions) bridges that: a Python plugin whose models join the regular model picker.

Install [`openwebui-anthropic-pipe.py`](openwebui-anthropic-pipe.py) — a fork of [justinh-rahb's Anthropic Manifold Pipe](https://openwebui.com/f/justinrahb/anthropic) (MIT), pre-pointed at nullsink:

1. ⚙️ **Admin Settings → Functions → ＋**, paste the file's contents, **Save**.
2. Toggle the function **on**.
3. Gear icon next to it → `NULLSINK_API_KEY` → your `0sink_` key → **Save**. Self-hosters can set `NULLSINK_API_KEY` in the Open WebUI server environment instead; a saved valve wins when both are set.

Claude models appear in the picker as `anthropic/claude-…`.

Valves are stored per function in Open WebUI's database. Pasting updated code into the same function keeps the key; a freshly created function starts blank.

## How do I remove unusable duplicate model entries?

The connection lists every id from nullsink's `/v1/models`, including bare `claude-*` ids that answer only on the Anthropic path — picking one returns `unsupported_model`. Hide them in ⚙️ **Admin Settings → Models**, or restrict the connection's **Model IDs** allowlist to the OpenAI-format ids.

## Why is Open WebUI rejecting the request?

| Symptom | Fix |
| --- | --- |
| `unsupported_model` | A bare `claude-*` id from the connection. Chat with the `anthropic/claude-…` entries instead. |
| `HTTP 401: no API key provided …` | The pipe's `NULLSINK_API_KEY` valve is empty. Set it on the function you're chatting with — each installed copy keeps its own valves. |
| Claude models missing from the picker | Function toggled off, or its 5-minute model cache is stale — toggle it off and on to refresh. |
| `HTTP 400: \`temperature\` is deprecated for this model` | The newest Claude models reject `temperature`. Set it back to Default in the chat's Controls → Advanced Params. |
