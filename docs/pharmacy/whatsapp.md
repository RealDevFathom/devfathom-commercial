# Pharmacy WhatsApp channel (PH-B3)

Code: `src/lib/pharmacy/whatsapp/`. Routes: `POST|GET /api/pharmacy/whatsapp/webhook`,
`POST /api/pharmacy/whatsapp/reminders`. Migration: `20260929120000_pharmacy_whatsapp_channel`.

## Provider

`PHARMACY_WHATSAPP_PROVIDER` selects the adapter:

- `mock` (default) — records calls in memory, never touches the network. Tests and local runs use it.
- `meta` — Meta WhatsApp Cloud API (`POST https://graph.facebook.com/<version>/<phone-number-id>/messages`).

## Environment

| Variable                                     | Required           | Purpose                                                                                                   |
| -------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `PHARMACY_WHATSAPP_PROVIDER`                 | no                 | `meta` or `mock` (default `mock`).                                                                        |
| `PHARMACY_WHATSAPP_ACCESS_TOKEN`             | meta               | System-user access token for the Cloud API.                                                               |
| `PHARMACY_WHATSAPP_PHONE_NUMBER_ID`          | meta               | Sending phone-number id. Inbound messages addressed to another number id are ignored.                     |
| `PHARMACY_WHATSAPP_APP_SECRET`               | yes, for inbound   | Meta app secret. Verifies `X-Hub-Signature-256`. Without it every webhook POST is rejected (fail closed). |
| `PHARMACY_WHATSAPP_VERIFY_TOKEN`             | yes, for inbound   | Token Meta echoes in the subscription handshake (`GET ?hub.mode=subscribe`).                              |
| `PHARMACY_WHATSAPP_GRAPH_VERSION`            | no                 | Graph API version, default `v21.0`.                                                                       |
| `PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER` | yes, for reminders | Name of the approved refill-reminder template. The job does nothing while unset.                          |
| `PHARMACY_WHATSAPP_TEMPLATE_LANGUAGE`        | no                 | Template language code, default `en` (use `ur` for an Urdu template).                                     |
| `PHARMACY_WHATSAPP_REMINDER_LEAD_DAYS`       | no                 | Days before run-out to send the reminder, 0–30, default `3`.                                              |
| `CRON_SECRET`                                | yes, for reminders | Bearer token for the reminders route.                                                                     |

No token, number id or template name is hard-coded.

## Template approval (external)

Templates are approved in Meta Business Manager, not in this repository. Register one
**Utility** template and put its name in `PHARMACY_WHATSAPP_TEMPLATE_REFILL_REMINDER`.
The body must take exactly three positional parameters, in this order:

1. `{{1}}` customer display name
2. `{{2}}` medicine name (as captured by RX-07, e.g. `Panadol 500 mg`)
3. `{{3}}` expected run-out date, `YYYY-MM-DD`

Example body: `Assalam o Alaikum {{1}}, your {{2}} is expected to run out on {{3}}. Reply with the medicine and number of packs to reorder, or STOP to opt out.`

Free-text replies (order confirmation, pharmacist fallback, STOP/START acknowledgements)
are sent only inside the 24-hour customer-service window opened by the customer's own message,
so they need no template.

## Consent

- `pharmacy_customers."whatsappOptIn"` is nullable: `null` never asked, `true` opted in, `false` opted out.
- No message is sent unless the flag is `true`. Refill reminders additionally require the
  latest `REMINDERS` / `WHATSAPP` patient consent to be granted and not revoked.
- `STOP`, `STOP ALL`, `UNSUBSCRIBE`, `OPT OUT`, `band karo`, `بند`, `بند کریں` set the flag to `false`.
  `START`, `SUBSCRIBE`, `OPT IN`, `شروع` set it to `true`. The one-line acknowledgement of a
  STOP/START request is the only message sent regardless of the stored flag.

## Refill reminders

Staff capture a reminder with the existing `captureRefillReminder` (channel `WHATSAPP`).
The scheduler calls `POST /api/pharmacy/whatsapp/reminders` with `Authorization: Bearer $CRON_SECRET`
(body optional: `{"limit": 100}`). For each WhatsApp capture whose run-out date
(`deriveRefillSchedule`) is within `PHARMACY_WHATSAPP_REMINDER_LEAD_DAYS`, the job sends the
template once per patient × medicine × run-out date. The key
`refill:<patientId>:<medicineId>:<YYYY-MM-DD>` is claimed in `pharmacy_message_logs`
(unique per organization) **before** the send, so delivery is at most once: a crash between
claim and send leaves a `PENDING` row and is not retried; a provider error leaves `FAILED`.
Captures skipped for missing consent are re-checked on later runs until run-out.

## Inbound orders

Point the Meta app webhook at `https://<tenant-host>/api/pharmacy/whatsapp/webhook`. The tenant
comes only from the explicit tenant host (pharmacy vertical, not demo, accessible lifecycle).
Each text message is logged once by provider message id (Meta retries are ignored), then:

1. The sender is matched to exactly one active customer whose patient phone normalizes to the
   WhatsApp number (`03001234567`, `+92 300 1234567` → `923001234567`). Unknown or ambiguous
   senders get no reply.
2. Customers without `whatsappOptIn = true` get no reply.
3. The message is parsed as `<medicine> <quantity> [pack unit]` in English, Roman Urdu or Urdu
   script (Urdu digits and number words supported), e.g. `Panadol 2 packs`,
   `panadol ke 3 dabbe chahiye`, `مجھے پیناڈول کے ۲ پیکٹ چاہیے`. Strips/tablets, missing or
   multiple quantities, and quantities outside 1–100 are not parsed.
4. A parsed request is resolved against the branch storefront catalog (customer's last order
   branch, else the only active branch). A single match with enough stock is placed via
   `placeCustomerOrder` (the service behind `pharmacyOrdering.place`) as a `COLLECT` / `CASH`
   order acting as the customer's own linked user; the customer gets a confirmation.
5. Anything else — unparsed text, no linked user account, ambiguous or out-of-stock medicine,
   order rule rejection — gets: "A pharmacist will call you shortly".

## Message log

`pharmacy_message_logs` (RLS forced, tenant isolation) stores direction, kind, status,
dedupe key, last 4 phone digits only, template name, provider message id, and links to the
refill capture, customer, branch and order. Message bodies and full phone numbers are not stored.
