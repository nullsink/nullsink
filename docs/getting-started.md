# Make your first request

## How do I create and fund a token?

1. Open [nullsink.is](https://nullsink.is/#buy).
2. Leave the key field empty, choose a credit amount and payment coin, accept the terms, and select
   **mint key**.
3. Copy the new `0sink_…` token before continuing. Until you save it, it exists only in that browser
   tab. The service cannot recover or reset a lost token, or move its balance to another token.
4. Send the quoted amount to the displayed address before the quote expires.
5. Wait for the page to show **funded** before making a model request.

The payment address is single-use. Send one transfer only. If payment status is unavailable, do not
send again to the same address; check the existing order later. To add more credit, return to the buy
form, paste the existing token, and create a new order.

## How do I check that credit arrived?

Put the token into an environment variable without echoing it to the terminal:

```sh
printf 'Token: '
IFS= read -r -s NULLSINK_TOKEN
export NULLSINK_TOKEN
printf '\n'
```

Then check the balance:

```sh
curl -sS https://nullsink.is/balance \
  -H "x-api-key: $NULLSINK_TOKEN"
```

A funded token returns:

```json
{"balance_usd":10}
```

`401 {"error":"invalid_token"}` means the token is unknown. For a new purchase, it can also mean
the payment has not been credited yet. Check the purchase page before assuming the token was copied
incorrectly.

## Which models can I call?

Read the live catalog instead of copying a model id from an old example:

```sh
curl -sS https://nullsink.is/v1/models
```

Each entry gives an `id`, its `owned_by` provider, and prices in the response's
`usd_per_mtok` unit. Choose an Anthropic-owned model for `/v1/messages`; choose an OpenAI- or
Tinfoil-owned model for `/v1/chat/completions`.

## How do I call a model?

Choose the wire format your model uses. Set an explicit output limit so nullsink can reserve a maximum
charge before forwarding the request.

Anthropic Messages:

```sh
curl -sS https://nullsink.is/v1/messages \
  -H "x-api-key: $NULLSINK_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-haiku-4-5",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Reply with: connected"}]
  }'
```

OpenAI-compatible Chat Completions:

```sh
curl -sS https://nullsink.is/v1/chat/completions \
  -H "authorization: Bearer $NULLSINK_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "max_completion_tokens": 64,
    "messages": [{"role": "user", "content": "Reply with: connected"}]
  }'
```

The examples use model ids present in this repository's current price book. If the live catalog does
not list one, substitute a current id owned by the same provider.

## Which base URL should an SDK use?

| SDK format | Base URL | Authentication |
| --- | --- | --- |
| Anthropic | `https://nullsink.is` | Token as `x-api-key`; bearer authentication is also accepted |
| OpenAI-compatible | `https://nullsink.is/v1` | Token as `Authorization: Bearer`; `x-api-key` is also accepted |

The Anthropic base URL is the site root because its SDK appends `/v1/messages`. The OpenAI base URL
includes `/v1` because its SDK appends `/chat/completions` or `/responses`.

## What does a rejected model request mean?

Anthropic-format errors put the machine-readable reason in `error.message`. OpenAI-compatible errors
put it in `error.code`.

| HTTP | Reason | What to do |
| --- | --- | --- |
| 400 | `max_tokens_required` | Add `max_tokens`, `max_completion_tokens`, or `max_output_tokens`, matching the endpoint. |
| 400 | `unsupported_model` | Choose an id from `GET /v1/models` and use its matching endpoint. |
| 400 | `unsupported_option` or `unsupported_tool` | Remove premium tiers, server-side tools, multiple completions, or non-text features that cannot be priced by the flat token card. |
| 401 | `missing_api_key` | Send the token in the authentication header. |
| 401 | `invalid_token` | Check that the complete funded token was supplied. |
| 402 | `insufficient_balance` | Add credit or lower the output limit; the request reserves its maximum possible cost up front. |
| 413 | `payload_too_large` | Reduce the request body. |
| 429 | `rate_limited` | Respect `Retry-After` when present, then retry. |
| 502 or 504 | `upstream_unreachable` or `upstream_timeout` | The hold was refunded; retry later. |
| 503 | `service_unavailable` | The hold was refunded; retry later. The response deliberately does not expose the upstream account or provider failure. |

Pre-forward validation failures include `x-should-retry: false`. Transient upstream connection and
timeout failures include `x-should-retry: true`.

For endpoint shapes and the complete live model list, use the
[API reference](https://nullsink.is/api/) and [model catalog](https://nullsink.is/models/).
