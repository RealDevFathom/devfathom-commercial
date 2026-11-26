# Pharmacy WhatsApp

`PHARMACY_WHATSAPP_PROVIDER` selects the transport. The default `mock` prepares messages in memory. `meta` uses the existing tenant-bound Cloud API configuration, approved template names and live-send approval. Both keep the existing Meta webhook handshake and signature verification. `waha` uses one independently named session per organization on the operator's configured server.

## Local container and connection

The checked contract is the public `devlikeapro/waha:2026.10.1` release. The upstream engine matrix lists text, image and file sending for WEBJS, WPP, NOWEB and GOWS. The published media responses have an unspecified object shape. DevFathom requires a message ID for acceptance and holds an unconfirmed send for review. Engine-specific contact IDs, QR or passkey challenges, server availability and actual delivery still require verification on the intended installation. Older default-session-only editions cannot support this integration. A shared server requires named sessions and session-scoped keys with read, send and control permissions. [Pinned upstream release](https://github.com/devlikeapro/waha/tree/2026.10.1) · [Engine matrix](https://waha.devlike.pro/docs/how-to/engines/) · [API key scopes](https://waha.devlike.pro/docs/how-to/security/)

For an owner-authorized local installation, run the following in a private directory outside the application checkout. The initialization creates the WAHA environment file. Keep it private. The container binds its host port to loopback. The example uses port 3105 for the application and 3001 for WAHA. A container on Linux can reach a host-bound application through the host gateway when the application listens on that interface and the host firewall permits it. For production, follow upstream's persistent storage, network isolation, backup and TLS guidance. [Quick start](https://waha.devlike.pro/docs/overview/quick-start/) · [Installation](https://waha.devlike.pro/docs/how-to/install/)

```sh
umask 077
docker pull devlikeapro/waha:2026.10.1
docker run --rm -v "$PWD:/app/env" devlikeapro/waha:2026.10.1 init-waha /app/env >/dev/null
docker run -d --name pharmacy-waha --env-file .env \
  --log-driver=none -e WAHA_PRINT_QR=False \
  --add-host=host.docker.internal:host-gateway \
  -p 127.0.0.1:3001:3000 -v "$PWD/sessions:/app/.sessions" \
  devlikeapro/waha:2026.10.1
```

Configure these values on the application server. Use a secret manager for credentials. Keep HTTP request bodies, API headers, responses, QR images, environment files and callback query strings out of logs and captures. WAHA can include the original request in an error response.

| Application setting                                             | Purpose                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PHARMACY_WHATSAPP_PROVIDER=waha`                               | Select WAHA.                                                                                                                                                             |
| `PHARMACY_WAHA_BASE_URL=http://127.0.0.1:3001`                  | Operator-owned origin for the API. Use HTTPS beyond loopback. The client refuses redirects.                                                                              |
| `PHARMACY_WAHA_WEBHOOK_ORIGIN=http://host.docker.internal:3105` | Optional operator-owned callback origin reachable **from WAHA**. Without this, the application derives the callback from the business hostname. Use HTTPS between hosts. |
| `PHARMACY_WAHA_PROVISIONING_KEY`                                | Server-side WAHA administrator credential from the installation. Used for provisioning. Each business gets a separate non-admin sending key.                             |
| `PLATFORM_ENCRYPTION_KEY`                                       | Existing organization-secret facility. Keep this stable and backed up.                                                                                                   |

Sign in as the pharmacy owner and open **Pharmacy → Onboarding → Connect WhatsApp**, or `/pharmacy/settings/whatsapp`. Start the connection. On the intended phone, open **Linked devices** and scan the QR. Refresh status to see the connected number. Set a daily limit before sending. The default is zero, the minute limit starts at one, and portal codes start off. To test, enter an explicitly opted-in customer's number. The server chooses the fixed wording and applies normal checks. Disconnect asks for confirmation. Pairing, recipient details, portal codes and message text never belong in audit evidence.

## Approved wording and delivery

The operator supplies the approved WAHA wording in `PHARMACY_WAHA_<FLOW>_EN` or `_UR`. Use positional placeholders such as `{{1}}`. A missing body or a mismatched placeholder contract stops that flow. The table lists parameter meanings, without customer data.

| Flow            | Parameters                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REFILL`        | Due date only.                                                                                                                                                  |
| `KHATA`         | Values in the corresponding approved `PHARMACY_WHATSAPP_TEMPLATE_KHATA_REMINDER_EN_PARAMETERS` or `_UR_PARAMETERS` order.                                       |
| `RECEIPT`       | Branch, receipt number, total, payment method, expiring hosted receipt link. One file message delivers the caption and a PDF reference to the itemized receipt. |
| `BACK_IN_STOCK` | Branch, request date and opaque request reference.                                                                                                              |
| `PORTAL_CODE`   | Sign-in code only. Requires separate owner enablement, an eligible customer and the local sending window.                                                       |

The existing refill, khata, restock and receipt flows retain their own consent, deduplication and wording checks. The WAHA send guard also checks current customer opt-in, the workspace's 09:00–22:00 window, catalogue compliance for text and receipt captions, session status and rolling limits. Every attempt consumes capacity before network I/O. A business can start at most one send to recipients without inbound message history per two minutes. STOP updates the existing patient and customer consent records. Existing pseudonymous consent archiving remains in effect.

Refill and khata can enter the existing SMS fallback only through its independent organization binding and REMINDERS/SMS consent check. Current `develop` provides mock and disabled SMS modes. A mock preparation does not deliver an SMS. Other flows keep their own channel and show delivery problems to staff. An ambiguous send retains the claim and never triggers a second channel. Staff can continue making sales and issuing receipts.

## HTTP contract

All outbound requests use the fixed operator origin, `X-Api-Key` and JSON responses. Session creation and key issuance use the provisioning key. The business's encrypted session key is used for routine status, pairing, contacts, sending and disconnect. The operator-initiated start action can start the existing stopped session. The verifier uses the independent encrypted webhook secret. [OpenAPI reference](https://waha.devlike.pro/swagger/openapi.json) · [Instance Swagger and version-specific JSON](https://waha.devlike.pro/docs/how-to/swagger/)

| Operation            | Method and path                                                          | Request or fields consumed                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create session       | `POST /api/sessions`                                                     | `name`, `start`, `config.webhooks[]` with `url`, `events`, `hmac.key` and bounded retries.                                                                                   |
| Issue business key   | `POST /api/keys`                                                         | `session`, `isAdmin=false`, `isActive=true`, `actions`. The application verifies the returned session and key flags before encrypting the key.                               |
| Status and pairing   | `GET /api/sessions/{session}`, `GET /api/{session}/auth/qr?format=image` | Status, own account ID and restriction signals. QR response uses `mimetype` and base64 `data`.                                                                               |
| Start and disconnect | `POST /api/sessions/{session}/start`, `/logout`, `/stop`                 | Start and stop take no body. Logout takes an empty JSON object.                                                                                                              |
| Check recipient      | `GET /api/contacts/check-exists?phone=…&session=…`                       | Check before every send. Require `numberExists` and match the recipient's chat ID. A linked ID can be resolved through `GET /api/{session}/lids/{lid}` using `lid` and `pn`. |
| Text                 | `POST /api/sendText`                                                     | `session`, `chatId`, `text`, `linkPreview=false`.                                                                                                                            |
| Image or PDF         | `POST /api/sendImage`, `POST /api/sendFile`                              | `session`, `chatId`, `file.{mimetype,filename,data}` and an approved caption for receipts. Files are inline base64.                                                          |

[Sessions and restriction signals](https://waha.devlike.pro/docs/how-to/sessions/) · [Contacts](https://waha.devlike.pro/docs/how-to/contacts/) · [Send messages](https://waha.devlike.pro/docs/how-to/send-messages/)

WAHA calls `POST /api/pharmacy/whatsapp/webhook?endpoint=…`. The opaque selector chooses one candidate tenant key. The receiver rate limits requests, bounds the body to 256 KiB, and verifies `X-Webhook-Hmac-Algorithm: sha512` and the hexadecimal `X-Webhook-Hmac` against the exact raw bytes using a timing-safe comparison. Only then does it parse JSON and match the signed session to the business. The five-minute freshness check uses the unsigned Unix-millisecond `X-Webhook-Timestamp`. The unsigned `X-Webhook-Request-Id` only identifies a transport delivery within a signed event. Durable tenant-local identities suppress replay even when those headers change. The message log records direct replies and STOP. Delivered and read are separate transitions, and a delayed delivered tick cannot regress read. Status callbacks update only the verified session. [Events and HMAC](https://waha.devlike.pro/docs/how-to/events/) · [Pinned webhook sender](https://github.com/devlikeapro/waha/blob/2026.10.1/src/modules/waha-webhook/WebhookPlugin.sender.ts)

Upstream describes 463 as a reachout timelock and 475 as new-contact message capping. These may surface inside an upstream error on a connected session. There is no uniform HTTP-status mapping or automatic clearance guarantee across engines. The app latches either restriction, pauses all WAHA sends for that business and warns the owner. It never restarts or switches sessions to clear a pause. Upstream advises, “you should never initiate a conversation.” Owner consent and application caps do not guarantee a number will remain unrestricted. [Block-risk guidance](https://waha.devlike.pro/docs/overview/how-to-avoid-blocking/)

## Verification limits

Contract and workflow checks use fake WAHA, fake SMS, synthetic customers and restricted PostgreSQL 16. The browser QR is synthetic. A physical phone, engine-specific passkey pairing, receipt arrival on a handset and production webhook routing require a separately authorized installation. The number, deployment location, portal-code policy and initial daily cap belong to the owner.
