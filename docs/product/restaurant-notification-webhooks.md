# Restaurant SOP notification webhooks

Inbound card-terminal webhooks are a separate contract: [Restaurant terminal webhooks](restaurant-terminal-webhooks.md).

Restaurant admins configure one organization-scoped HTTPS endpoint from **Restaurant → Notifications**. The signing secret is supplied by the receiver, encrypted at rest, never displayed again, and can be rotated by saving a new value.

## Request contract (version 1.0)

DevFathom sends `POST` with `Content-Type: application/json` and these headers:

- `X-DevFathom-Event-Id`: stable outbox event identifier.
- `X-DevFathom-Idempotency-Key`: the same stable identifier; store it and ignore duplicates.
- `X-DevFathom-Timestamp`: Unix seconds when the attempt was signed.
- `X-DevFathom-Signature`: `v1=<hex HMAC-SHA256>`.

The signed bytes are `<timestamp>.<exact raw request body>`. Verify the HMAC with the configured secret using a timing-safe comparison before parsing or acting on the payload. Reject timestamps outside the receiver's replay window (five minutes is recommended), then deduplicate by idempotency key.

```json
{
  "version": "1.0",
  "id": "rnow_…",
  "type": "restaurant.sop.notification",
  "occurredAt": "2026-08-30T07:00:00.000Z",
  "data": {
    "id": "rnot_…",
    "branchId": "branch_…",
    "category": "sop.escalation",
    "title": "SOP escalation",
    "body": "Opening checklist is late.",
    "entityType": "sopOccurrence",
    "entityId": "occurrence_…",
    "createdAt": "2026-08-30T07:00:00.000Z"
  }
}
```

Any `2xx` response is success. Other responses and network failures retry with capped exponential backoff and eventually become a visible dead letter. Keep responses small; DevFathom reads at most 16 KiB. Disabling or deleting the endpoint stops queued delivery. Admins can queue a test or retry a dead letter from the notifications page.
