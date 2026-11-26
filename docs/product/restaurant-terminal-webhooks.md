# Restaurant terminal webhooks

Send events to `/api/restaurant/webhooks/[source]` on the business's own host. Each enabled terminal provider configuration has its own signing key.

## Provision and rotate

In Restaurant Finance, select the branch and open Card terminal. Under Configured terminals, choose **Set signing key**. A business owner or active administrator with `restaurant:configure` calls the tRPC mutation `restaurantPayments.rotateTerminalWebhookSecret` with the branch ID and config ID. Use `restaurantPayments.getTerminalConfig` to list configuration IDs for the branch. Save the returned `secret` in the provider's secret store immediately. The rotation response is the only opportunity to read it. The previous configuration key works for 24 hours following rotation. A subsequent rotation replaces that previous key.

## Sign a delivery

- Set `x-webhook-timestamp` to Unix seconds as a 10-digit string. The receiver allows five minutes of clock skew in either direction.
- Set `x-webhook-config-id` to the configuration ID from provisioning. For terminal events the payload's `terminalId` must also match that configuration. The header can be omitted when the host, source and terminal identify one configuration. A non-terminal event without this header needs an unambiguous source.
- Construct the UTF-8 prefix with JavaScript's `JSON.stringify([timestamp, source, configId]) + '.'`, with all three values encoded as strings. Append the exact request body bytes, including any whitespace or byte order mark.
- Set `x-webhook-signature` to the hex HMAC-SHA256 of those bytes using the returned secret string as the UTF-8 key. The optional `sha256=` prefix is accepted.

A new verified event returns 202 and queues one job. A duplicate returns 200. Keep the same `externalEventId` on retries and refresh the timestamp and signature. The receiver rejects bodies over 256 KiB.

## Shared-key changeover

Until a configuration gets its first key, a sender may use the existing `RESTAURANT_TERMINAL_WEBHOOK_SECRET` and the original UTF-8 prefix `timestamp + '.' + source + '.'` followed by the exact raw bytes. Each successful legacy acceptance, including a duplicate, writes a `restaurant.webhook.legacy_key_accepted` audit entry with the business, configuration and event ID.

Set `RESTAURANT_TERMINAL_WEBHOOK_LEGACY_CUTOFF` to an absolute ISO 8601 timestamp with a timezone on every receiver, then restart or redeploy those instances. At that instant shared signatures expire. An invalid value refuses shared signatures. When unset, the window ends 30 days after this migration was deployed. Restarting or adding a provider does not extend the window.

Provisioning any key immediately and permanently retires shared-key signing for the entire business and source, including sibling terminals.
