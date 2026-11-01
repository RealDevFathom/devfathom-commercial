# Restaurant terminal webhooks

Card-terminal providers POST events to `/api/restaurant/webhooks/[source]`. The tenant comes from the request host. This contract is separate from the outbound SOP notification webhook, which uses `X-DevFathom-Timestamp` and signs `<timestamp>.<body>`.

## Headers

- `x-webhook-timestamp`: Unix seconds, exactly 10 digits. The server rejects the request when this instant is more than five minutes away from the server clock, in either direction.
- `x-webhook-signature`: hex HMAC-SHA256. An optional `sha256=` prefix is stripped before the compare.

## Signing format

The signed bytes are the timestamp, the `[source]` path segment, and the exact raw request body, joined with dots:

```text
HMAC-SHA256(RESTAURANT_TERMINAL_WEBHOOK_SECRET, "<unix-seconds>.<source>.<raw body>")
```

The compare checks that the decoded digest is the same length as the expected digest, then uses `crypto.timingSafeEqual`. A missing secret, a missing or non-canonical timestamp, or a bad signature returns 401 and writes nothing.

A new `externalEventId` is stored under the unique `(organization, source, externalEventId)` inbox constraint and returns 202. A repeat of that event id returns 200 and does not enqueue another job.
