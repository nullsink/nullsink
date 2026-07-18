# Buy credit safely

## What does a payment quote lock?

A quote fixes four things for one order:

- the token hash that will receive credit;
- the USD credit requested;
- the coin/USD rate used for settlement; and
- the coin amount and single-use address to pay.

The quoted coin amount includes nullsink's margin. Settlement does not fetch a new rate. The response's
`expires_at` is the pay-by deadline, and `confirmations_required` is the selected coin's finality rule.
Use those returned values rather than assuming a fixed lifetime or confirmation count.

## How should I pay the quote?

1. Save the `0sink_…` token before opening a wallet. Losing it makes the resulting credit unusable.
2. Check the coin, amount, and first and last characters of the address in the wallet.
3. Send the quoted amount once, in one transaction, before the countdown expires.
4. Keep the purchase tab open until the balance is funded. If you must leave, save the token, address,
   amount, and deadline first; the site does not keep them in browser storage.
5. Treat the balance—not payment status alone—as confirmation that the credit is spendable.

> **Do not send a second payment to the same address.** The order is single-use and closes when a final
> payment is processed. A later transfer may not be credited automatically. To add credit, create a new
> quote, even when topping up the same token.

If a status check fails or appears stale after you paid, wait and check again. A failed read says nothing
about whether the transfer arrived.

## What does each payment status mean?

| State | What the server knows | What you should do |
| --- | --- | --- |
| `waiting` | The order is open and no inbound transfer has ever been observed. | If you have not paid, use the quote before it expires. If you already paid, do not resend; detection can lag. |
| `detected` | A transfer was durably observed, but live confirmation details are temporarily unavailable, usually after a service or wallet restart. | Wait. The state must not be interpreted as a failed payment. |
| `confirming` | A transfer is visible but has fewer than `required` confirmations. | Wait for the selected rail's finality depth. |
| `finalizing` | The displayed confirmation requirement is met, but the rail has not marked the transfer final or settlement has not closed the order yet. | Check again; do not resend. |
| `closed` | No matching open order remains. This can mean credited, expired/reaped, or never matched. | Check the token balance. `closed` alone is not proof of credit. |

`POST /order-status` is a progress view, not the money ledger. `GET /balance` with the raw token is the
authoritative spendable balance. For a top-up, compare it with the balance recorded before creating the
order.

## What happens if I send the wrong amount?

When a final payment is processed, it is credited in proportion to the locked quote:

```text
credited USD = requested credit × received coin / quoted coin
```

The result is rounded to the nearest micro-dollar.

- An underpayment receives less credit.
- An overpayment receives more credit.
- A second transaction is not a supported way to complete an underpayment. Create a new quote instead.

## What should I do when a quote expires?

If you have not paid, do not use the old address; create a new quote.

If you sent the transfer before the deadline, do not send again and keep the old tab or order details.
The backend has recovery time beyond the displayed deadline so a last-minute transfer can be detected,
but that grace is not an extended payment window. Once an order reaches its final backstop, the address is
no longer watched for automatic credit.

## Can I pay with a different cryptocurrency?

nullsink directly accepts only the rails returned by `GET /rails`. The purchase page may offer a third-party
swap into the selected rail. A swap sends the destination address and amount to the swap provider; its rates,
fees, data handling, and availability are outside nullsink. Credit is based on the amount of the destination
coin that actually arrives, so it may be slightly above or below the quote.

## What should I do when something fails?

| Situation | Is money known to have moved? | Safe action |
| --- | --- | --- |
| The quote request fails before showing an address | No usable payment instruction was returned. | Retry the quote request. |
| Payment status is unavailable | Unknown; the read does not affect settlement. | Do not resend. Retry the status check later. |
| Status is `detected`, `confirming`, or `finalizing` | A transfer has been seen. | Wait and keep the token safe. |
| Status is `closed`, but the balance is unchanged | Ambiguous: the order may be reaped or credit delivery may still be pending. | Do not resend. Retry the balance check; retain the transaction id if support is needed. |
| The quote expired before you paid | No, if you did not send. | Create a new quote and use only its address. |
| The quote expired after you sent | Possibly; detection or confirmation may still be in progress. | Keep checking the existing order. Do not pay either address again. |
| You lost the token | The service cannot prove ownership or move its balance. | There is no recovery path. |

If an on-chain payment is final but the balance remains unchanged after repeated checks, keep the payment
address, amount, transaction id, and token hash and contact
[admin@nullsink.is](mailto:admin@nullsink.is). Never send the raw bearer token to support. Manual correction
is not guaranteed.

## Can I automate a top-up?

Use the purchase page to create the original token: the `/buy` endpoint accepts a hash but cannot verify
that you possess its preimage. A mistyped hash can therefore receive permanently unusable credit.

For an existing valid token loaded into `NULLSINK_TOKEN` as shown in the
[getting-started guide](getting-started.md#how-do-i-check-that-credit-arrived), compute its lowercase
SHA-256 hash locally. On macOS:

```sh
TOKEN_HASH=$(printf '%s' "$NULLSINK_TOKEN" | shasum -a 256 | awk '{print $1}')
```

On Linux:

```sh
TOKEN_HASH=$(printf '%s' "$NULLSINK_TOKEN" | sha256sum | awk '{print $1}')
```

Discover the active rails:

```sh
curl -sS https://nullsink.is/rails
```

Request a quote for the net USD credit you want:

```sh
curl -sS https://nullsink.is/buy \
  -H 'content-type: application/json' \
  -d "{\"hash\":\"$TOKEN_HASH\",\"credit_usd\":10,\"rail\":\"monero\"}"
```

Omit `rail` to use the response from `/rails` named by `default`. A successful quote returns:

| Field | Meaning |
| --- | --- |
| `pay_to` | Single-use destination address |
| `pay_uri` | Wallet URI containing the address and amount |
| `amount` | Exact coin amount as a decimal string |
| `unit` | Display ticker, such as `XMR` or `BTC` |
| `rate_usd` | Locked coin/USD rate |
| `confirmations_required` | Finality depth for this order |
| `expires_at` | Pay-by deadline as Unix epoch milliseconds |

Poll the specific order by including both its hash and returned address:

```sh
PAY_TO='address returned by /buy'

curl -sS https://nullsink.is/order-status \
  -H 'content-type: application/json' \
  -d "{\"hash\":\"$TOKEN_HASH\",\"address\":\"$PAY_TO\"}"
```

Including `address` matters when one token has several open top-up orders. Without it, the endpoint returns
the best open-order match rather than a specific quote.

## What do purchase errors mean?

Purchase endpoints use the compact shape `{"error":"code"}`.

| HTTP | Code | Meaning and action |
| --- | --- | --- |
| 400 | `invalid_json` | Send a valid JSON object. |
| 400 | `invalid_hash` | Supply exactly 64 lowercase hexadecimal SHA-256 characters. Do not pay until the hash is corrected. |
| 400 | `invalid_address` | For status reads, `address` must be a string no longer than 128 characters; normally use the exact `pay_to` returned by `/buy`. |
| 400 | `invalid_amount` | `credit_usd` is outside the deployment's configured range or is not a finite number. |
| 400 | `unknown_rail` | Refresh `GET /rails` and choose an active rail. |
| 413 | `payload_too_large` | Reduce the JSON body; purchase and status bodies are limited to 4 KiB. |
| 429 | `rate_limited` | No quote was returned. Respect `Retry-After`, then request a new quote. |
| 500 | `payments_error` | The payments service hit an unexpected failure. If no address was returned, retry later. |
| 502 | `wallet_unavailable` | No payable quote was returned. Retry later. |
| 503 | `rate_unavailable` or `busy_try_later` | No payable quote was returned. Retry later. |

For what payment and credit-delivery records remain after settlement, see the
[privacy policy](https://nullsink.is/privacy/) and
[money/reliability invariants](invariants.md#why-are-acknowledged-outbox-rows-kept).
